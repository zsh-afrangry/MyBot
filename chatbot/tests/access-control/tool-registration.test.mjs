// Offline registration checks for plugin manifests and Agent allowlists (docs/24).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {MEMBER_TOOLS, PERMISSIONS, toolPermission} from '../../packages/access-control/index.js';

const pluginRoot = fileURLToPath(new URL('../../plugins/', import.meta.url));
const runtimeConfig = new URL('../../../config/runtime.config.json', import.meta.url);

const mappingInputs = new Map([
  ['automations', [{action: 'list'}]],
  ['e7_data', [{action: 'codes'}]],
  ['kurumi_access', [{action: 'list'}]],
  ['kurumi_host_admin', [{action: 'list'}]],
  ['kurumi_files', [{action: 'roots'}]],
  ['kurumi_lease', [{action: 'list'}]],
  ['kurumi_code', [{action: 'list'}]],
  ['kurumi_document', [{action: 'list'}]],
  ['kurumi_memory', [{action: 'list'}]],
  ['kurumi_memory_raw', [{action: 'search'}]],
  ['kurumi_memory_records', [{action: 'search'}]],
  ['kurumi_proactive', [{action: 'status'}]],
  ['kurumi_task', [{action: 'list'}]],
  ['kurumi_translate', [{action: 'list'}]],
  ['personal_confirmation', [{action: 'list', domain: 'personal_reminder'}]],
  ['personal_reminder_list_manage', [{action: 'add'}]],
  ['knowledge_bill_import', [{action: 'preview'}, {action: 'commit'}, {action: 'status'}, {action: 'batches'}]],
  // Probe every current action of these exempt tools to catch even a partial mapping.
  ['kurumi_paper', [{action: 'fetch'}, {action: 'text'}, {action: 'page'}]],
  ['kurumi_project_git', [{action: 'status'}, {action: 'diff'}, {action: 'branch'}, {action: 'commit'}]],
]);

const manifestExceptions = new Map([
  ['kurumi-research/kurumi_paper', 'Researcher only. Trusted background policy checks tasks.research and the researcher allowlist.'],
  ['kurumi-tasks/kurumi_project_check', 'Legacy project checks only. The project Agent has its own tasks.code gate, and codeEnabled=false disables new legacy coding tasks.'],
  ['kurumi-tasks/kurumi_project_git', 'Legacy project Git only. The project Agent has its own tasks.code gate, and codeEnabled=false disables new legacy coding tasks.'],
  ['kurumi-qq/kurumi_test_wait', 'Only registered for the named test session with testIngress enabled. The checked-in runtime config has testIngress=false.'],
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hasPermissionMapping(name) {
  const inputs = mappingInputs.get(name) ?? [{}];
  return inputs.some(params => PERMISSIONS.includes(toolPermission(name, params)));
}

function readToolDeclarations() {
  const declarations = new Map();
  for (const dir of fs.readdirSync(pluginRoot, {withFileTypes: true})) {
    if (!dir.isDirectory()) continue;
    const file = path.join(pluginRoot, dir.name, 'openclaw.plugin.json');
    if (!fs.existsSync(file)) continue;

    const {id, contracts} = readJson(file);
    const names = contracts?.tools;
    if (names === undefined) continue;
    assert.ok(typeof id === 'string' && id.trim(), `${file}: expected a plugin id`);
    assert.ok(Array.isArray(names) && names.every(name => typeof name === 'string' && name.trim()),
      `${file}: expected contracts.tools to be an array of tool names`);
    for (const name of names) declarations.set(`${id}/${name}`, name);
  }
  return declarations;
}

test('Every declared plugin tool has a permission mapping or a current manifest exception', () => {
  const declarations = readToolDeclarations();
  const problems = [];
  for (const [key, name] of declarations) {
    if (!manifestExceptions.has(key) && !hasPermissionMapping(name)) {
      problems.push(`${key}: missing permission mapping`);
    }
  }
  for (const [key, reason] of manifestExceptions) {
    assert.ok(typeof reason === 'string' && reason.trim(), `${key}: exception needs a reason`);
    if (!declarations.has(key)) {
      problems.push(`${key}: stale exception, tool no longer declared`);
    } else if (hasPermissionMapping(declarations.get(key))) {
      problems.push(`${key}: stale exception, tool has a permission mapping`);
    }
  }
  assert.deepEqual(problems.sort(), [], 'Plugin tool registration differs from permission mappings and exceptions');
});

test('Main alsoAllow and MEMBER_TOOLS require permission mappings for every tool', () => {
  const {alsoAllow} = readJson(runtimeConfig).agents.entries.main.tools;
  for (const [scope, tools] of [['main.tools.alsoAllow', alsoAllow], ['MEMBER_TOOLS', MEMBER_TOOLS]]) {
    const unmapped = tools.filter(name => !hasPermissionMapping(name));
    assert.deepEqual(unmapped, [], `${scope} contains tools without permission mappings`);
  }
});
