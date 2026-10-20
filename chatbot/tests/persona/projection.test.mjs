// docs/25 P1: offline projection, ownership and invalid-config regressions.
// Temporary files and synthetic identities only; no production writes, model or QQ network.
// Evidence: docs/verification/persona-memory-2026-10-19/node-tests.txt
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {personaFiles, applyPersonaFile} from '../../packages/access-control/workspaces.js';
import {ownerPolicy, memberRow, OWNER, MEMBER, OTHER} from '../access-control/fixtures.mjs';

const source = fileURLToPath(new URL('../../../', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-persona-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo'), state = path.join(root, 'state');
  const persona = JSON.parse(fs.readFileSync(path.join(source, 'config/persona.json'), 'utf8'));
  const policy = ownerPolicy(); policy.subjects.push(memberRow(), memberRow(OTHER));
  const sources = [persona.roleFile, ...Object.values(persona.relationshipFiles),
    'scripts/fusion/templates/AGENTS.md', 'scripts/fusion/templates/MEMBER_AGENTS.md', 'config/runtime.config.json'];
  for (const relative of sources) {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), {recursive: true});
    fs.copyFileSync(path.join(source, relative), path.join(repo, relative));
  }
  const save = () => fs.writeFileSync(path.join(repo, 'config/persona.json'), JSON.stringify(persona));
  save(); fs.writeFileSync(path.join(repo, 'config/access-control.json'), JSON.stringify(policy));
  return {root, repo, state, persona, policy, save};
}

test('Shared identity is identical; owner relationship and private facts never enter member payloads', t => {
  const f = fixture(t);
  f.persona.userFile += '\nOWNER_PRIVATE_FACT_SENTINEL\n'; f.save();
  const projected = personaFiles(f.repo, f.state).files;
  assert.equal(projected.size, 12);
  const owner = path.join(f.state, 'workspace');
  assert.match(projected.get(path.join(owner, 'USER.md')), /persona-relationship-owner-v1/u);
  for (const id of [MEMBER, OTHER]) {
    const workspace = path.join(f.state, 'users', id, 'workspace');
    for (const name of ['SOUL.md', 'IDENTITY.md']) {
      assert.equal(projected.get(path.join(workspace, name)), projected.get(path.join(owner, name)));
    }
    const payload = [...projected].filter(([file]) => file.startsWith(workspace + path.sep)).map(([, text]) => text).join('\n');
    assert.match(projected.get(path.join(workspace, 'USER.md')), /普通朋友/u);
    assert(!payload.includes('persona-relationship-owner-v1'));
    assert(!payload.includes('OWNER_PRIVATE_FACT_SENTINEL'));
    assert(!payload.includes('2026年3月13') && !payload.includes('2026-03-13'));
    assert.match(projected.get(path.join(workspace, 'AGENTS.md')), /kurumi-isolated-member-v1/u);
  }
  assert.equal([...projected.keys()].filter(file => !/\/(SOUL|IDENTITY|AGENTS|USER)\.md$/u.test(file)).length, 0);
});

test('Applying projection preserves memories, histories and unrelated files and writes private modes', t => {
  const f = fixture(t), sentinels = new Map();
  for (const prefix of ['workspace', `users/${MEMBER}/workspace`, `users/${OTHER}/workspace`]) {
    for (const relative of ['MEMORY.md', 'memory/mood.json', 'session-history.jsonl']) {
      const file = path.join(f.state, prefix, relative), bytes = Buffer.from(`UNCHANGED ${prefix}/${relative}\n`);
      fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, bytes); sentinels.set(file, bytes);
    }
  }
  for (const [file, content] of personaFiles(f.repo, f.state).files) applyPersonaFile(file, content);
  for (const [file, bytes] of sentinels) assert.deepEqual(fs.readFileSync(file), bytes);
  for (const file of personaFiles(f.repo, f.state).files.keys()) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert(!fs.existsSync(path.join(f.state, 'users', OWNER)));
});

test('Only enabled chat identities receive persona files', t => {
  const f = fixture(t); f.policy.subjects.find(row => row.qq === OTHER).enabled = false;
  fs.writeFileSync(path.join(f.repo, 'config/access-control.json'), JSON.stringify(f.policy));
  const projected = personaFiles(f.repo, f.state).files;
  assert.equal(projected.size, 8);
  assert([...projected.keys()].every(file => !file.includes(`/users/${OTHER}/`)));
});

test('Legacy persona without relationshipFiles remains compatible', t => {
  const f = fixture(t); delete f.persona.relationshipFiles; f.persona.userFile = 'LEGACY_OWNER_USER'; f.save();
  const projected = personaFiles(f.repo, f.state).files;
  assert.equal(projected.get(path.join(f.state, 'workspace/USER.md')), 'LEGACY_OWNER_USER');
  assert(!projected.get(path.join(f.state, 'users', MEMBER, 'workspace/USER.md')).includes('LEGACY_OWNER_USER'));
});

test('Incomplete, unknown and non-object relationship configurations fail before any write', async t => {
  for (const value of [null, [], {}, {owner: 'roles/relationships/本人恋人.md'},
    {owner: 'roles/relationships/本人恋人.md', member: 'roles/relationships/普通朋友.md', unknown: 'roles/世凪.md'}]) {
    await t.test(JSON.stringify(value), t => {
      const f = fixture(t); f.persona.relationshipFiles = value; f.save();
      assert.throws(() => personaFiles(f.repo, f.state), /invalid_persona_relationship_files/u);
      assert(!fs.existsSync(f.state));
    });
  }
});

test('Source traversal and symlink escape are rejected', async t => {
  for (const relative of ['/tmp/role.md', 'roles/../private.md', 'config/persona.json', 'roles\\role.md']) {
    await t.test(relative, t => {
      const f = fixture(t); f.persona.relationshipFiles.member = relative; f.save();
      assert.throws(() => personaFiles(f.repo, f.state), /invalid_persona_role_path/u);
    });
  }
  await t.test('symlink to an external relationship', t => {
    const f = fixture(t), file = path.join(f.repo, f.persona.relationshipFiles.member);
    fs.writeFileSync(path.join(f.root, 'private.md'), 'PRIVATE'); fs.unlinkSync(file);
    fs.symlinkSync(path.join(f.root, 'private.md'), file);
    assert.throws(() => personaFiles(f.repo, f.state), /persona_role_symlink_rejected/u);
  });
});

test('Unresolved placeholders and empty relationship content fail before projection', async t => {
  for (const value of ['{{用户名}}是我的朋友', '   \n']) await t.test(JSON.stringify(value), t => {
    const f = fixture(t); fs.writeFileSync(path.join(f.repo, f.persona.relationshipFiles.member), value);
    assert.throws(() => personaFiles(f.repo, f.state), /invalid_persona_role_content/u);
  });
});

test('Owner template drift is explicit and replacement text is literal', async t => {
  for (const content of ['NO_EXPECTED_HEADER', '你是 Kurumi，用户的中文个人助手。\n你是 Kurumi，用户的中文个人助手。']) {
    await t.test(content.slice(0, 20), t => {
      const f = fixture(t); fs.writeFileSync(path.join(f.repo, 'scripts/fusion/templates/AGENTS.md'), content);
      assert.throws(() => personaFiles(f.repo, f.state), /persona_agents_substitution_mismatch/u);
    });
  }
  await t.test('literal dollar replacement', t => {
    const f = fixture(t); f.persona.agentsSubstitution.to = 'LITERAL $& $`'; f.save();
    assert(personaFiles(f.repo, f.state).files.get(path.join(f.state, 'workspace/AGENTS.md')).includes('LITERAL $& $`'));
  });
});

test('Current sources fit native per-file budgets and owner identity is no longer Kurumi/whale', t => {
  const f = fixture(t), projected = personaFiles(f.repo, f.state).files;
  for (const [file, text] of projected) {
    assert(text.length < (file.endsWith('/USER.md') ? 4000 : 20000), `bootstrap budget ${file}`);
    assert(!/\{\{[^}]*\}\}/u.test(text), `placeholder ${file}`);
    if (file.endsWith('/IDENTITY.md')) assert.match(text, /Name: 世凪/u);
  }
  const ownerRules = projected.get(path.join(f.state, 'workspace/AGENTS.md'));
  assert(ownerRules.includes('你是SOUL.md中的世凪'));
  assert(!ownerRules.includes('当前临时使用SOUL.md中的小鲸鱼'));
});

test('Owner USER points facts to continuity memory, not the MEMORY.md notice', t => {
  const f = fixture(t), user = personaFiles(f.repo, f.state).files.get(path.join(f.state, 'workspace/USER.md'));
  assert(!user.includes('MEMORY.md'), 'P2 MEMORY.md holds only a notice');
  assert(user.includes('kurumi_memory') && user.includes('KURUMI_PERSONAL_MEMORY_V2'));
});

test('Projection destination symlinks cannot redirect persona writes', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(f.state); fs.symlinkSync(outside, path.join(f.state, 'workspace'));
  assert.throws(() => applyPersonaFile(path.join(f.state, 'workspace/SOUL.md'), 'X'), /workspace_symlink_rejected/u);
  assert(!fs.existsSync(path.join(outside, 'SOUL.md')));
});
