import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ts = createRequire(new URL('../../packages/personal-domains/package.json', import.meta.url))('typescript');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const packages = path.join(repo, 'chatbot/packages');
const plugins = path.join(repo, 'chatbot/plugins');
const domainScripts = path.join(repo, 'chatbot/scripts');
const deployment = path.join(repo, 'scripts/fusion');
const skippedDirectories = new Set(['dist', 'node_modules', 'vendor', 'test', 'tests', 'python']);
const deploymentPath = /(?:^|[\s/\\'"])scripts[/\\]+fusion(?=$|[\s/\\'"])/u;

function contains(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function* sources(directory) {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !skippedDirectories.has(entry.name)) yield* sources(file);
    if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name) && !entry.name.includes('.test.')) yield file;
  }
}

function exportTargets(value) {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(exportTargets) : [];
}

function publicEntries(root, exports) {
  const subpaths = Object.keys(exports ?? {}).some(key => key.startsWith('.'));
  const entries = subpaths ? Object.entries(exports) : [['.', exports]];
  return new Map(entries.map(([name, value]) => {
    const targets = exportTargets(value);
    assert(!name.includes('*') && targets.every(target => target.startsWith('./') && !target.includes('*')
      && contains(root, path.resolve(root, target))),
      `${path.relative(repo, root)} must declare explicit public files in exports`);
    return [name, targets.map(target => path.resolve(root, target))];
  }));
}

function modules(directory, kind) {
  return fs.readdirSync(directory, {withFileTypes: true}).filter(entry => entry.isDirectory() && !skippedDirectories.has(entry.name)).map(entry => {
    const root = path.join(directory, entry.name);
    const manifest = path.join(root, 'package.json');
    const pkg = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : {};
    if (kind === 'package') assert(typeof pkg.name === 'string' && pkg.exports,
      `${path.relative(repo, root)} must declare its public API in package.json`);
    const entries = kind === 'package' ? publicEntries(root, pkg.exports) : new Map();
    return {root, kind, name: pkg.name ?? entry.name, entries, publicFiles: new Set([...entries.values()].flat())};
  });
}

const units = [...modules(packages, 'package'), ...modules(plugins, 'plugin')];
const unitsByName = new Map(units.map(unit => [unit.name, unit]));
const unitAt = file => units.find(unit => contains(unit.root, file));
const distEntrypoints = new Map([
  ['personal-weather', 'weather'], ['personal-profile', 'profile'],
  ['personal-planning', 'planning'], ['personal-reminders', 'reminder'],
].map(([plugin, kind]) => [path.join(plugins, plugin, 'index.js'), path.join(packages, 'personal-domains/dist', `${kind}-plugin.js`)]));

function moduleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isExternalModuleReference(node)) return node.expression;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  if (!ts.isCallExpression(node)) return;
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) return node.arguments[0];
  if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve') {
    const receiver = callee.expression;
    if ((ts.isIdentifier(receiver) && receiver.text === 'require')
      || (ts.isMetaProperty(receiver) && receiver.keywordToken === ts.SyntaxKind.ImportKeyword)) return node.arguments[0];
  }
}

function staticText(node, unknown) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression, unknown);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left, unknown), right = staticText(node.right, unknown);
    return left === undefined || right === undefined ? unknown : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let result = node.head.text;
    for (const span of node.templateSpans) {
      const value = staticText(span.expression, unknown);
      if (value === undefined) return;
      result += value + span.literal.text;
    }
    return result;
  }
  return unknown;
}

function runtimePath(node) {
  const unknown = '?';
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && callee.name.text;
    if (name === 'join' || name === 'resolve') return node.arguments.map(argument => staticText(argument, unknown)).join('/');
    return '';
  }
  return staticText(node, unknown);
}

function moduleIssue(file, owner, specifier) {
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  const local = relative || path.isAbsolute(specifier) || specifier.startsWith('file:');
  const target = local ? fileURLToPath(new URL(specifier, pathToFileURL(file))) : undefined;
  const packageName = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
  const unit = target ? unitAt(target) : unitsByName.get(packageName);

  if (target && contains(deployment, target)) return 'imports a deployment script';
  if (owner?.kind === 'package' && target && contains(domainScripts, target)) return 'shared package imports a domain script';
  if (unit?.kind === 'plugin' && owner && owner !== unit) return 'imports another plugin';
  if (unit?.kind === 'package' && owner !== unit) {
    const subpath = '.' + (specifier.slice(packageName.length) || '');
    const exported = target ? unit.publicFiles.has(target) : unit.entries.get(subpath)?.length;
    if (!exported && (!target || distEntrypoints.get(file) !== target)) return 'imports a private shared-package file';
  }
  if (owner?.kind === 'package' && relative && !fs.existsSync(target) && !fs.existsSync(target.replace(/\.([cm]?)js$/u, '.$1ts'))) {
    return 'imports a missing relative module';
  }
}

function inspect(file, contents) {
  const sourceFile = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  const owner = unitAt(file), violations = [];
  function report(node, reason, reference) {
    const {line} = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push(`${path.relative(repo, file)}:${line + 1} ${reason}: ${reference}`);
  }
  function visit(node) {
    const specifierNode = moduleSpecifier(node);
    const specifier = specifierNode && staticText(specifierNode);
    const issue = specifier && moduleIssue(file, owner, specifier);
    if (issue) report(specifierNode, issue, specifier);
    else {
      const reference = runtimePath(node);
      if (deploymentPath.test(reference)) {
        report(node, 'references a deployment path', reference);
        return;
      }
    }
    ts.forEachChild(node, child => { if (!issue || child !== specifierNode) visit(child); });
  }
  visit(sourceFile);
  return violations;
}

test('runtime sources use declared package exports and respect dependency direction', () => {
  assert.equal(unitsByName.size, units.length, 'workspace package names must be unique');
  const errors = [];
  for (const root of [packages, plugins, domainScripts]) {
    const files = [...sources(root)];
    assert(files.length > 0, `${path.relative(repo, root)} source scan is empty`);
    for (const file of files) errors.push(...inspect(file, fs.readFileSync(file, 'utf8')));
  }
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('architecture audit rejects forbidden imports and deployment paths', () => {
  const cases = [
    ['packages/access-control/index.js', "export * from '../../plugins/kurumi-qq/index.js'", 'imports another plugin'],
    ['plugins/kurumi-logs/index.js', "require('@kurumi/qq-channel/src/inbound.js')", 'imports another plugin'],
    ['plugins/kurumi-logs/index.js', "await import('../../packages/access-control/config.js')", 'imports a private shared-package file'],
    ['plugins/kurumi-logs/index.js', "import type {View} from '@kurumi/log-query/log-query-views.mjs'", 'imports a private shared-package file'],
    ['plugins/kurumi-logs/index.js', `import '${pathToFileURL(path.join(packages, 'access-control/config.js')).href}'`, 'imports a private shared-package file'],
    ['plugins/personal-profile/index.js', "import '../../packages/personal-domains/dist/weather-plugin.js'", 'imports a private shared-package file'],
    ['plugins/kurumi-logs/index.js', "import '../../../scripts/fusion/health.mjs'", 'imports a deployment script'],
    ['plugins/kurumi-logs/query.js', "spawn(node, [path.join(root, 'scripts', 'fusion', script)])", 'references a deployment path'],
    ['scripts/log-query.mjs', 'spawn(node, [`${root}/scripts/fusion/${script}`])', 'references a deployment path'],
  ];
  for (const [source, code, reason] of cases) {
    const errors = inspect(path.join(repo, 'chatbot', source), code);
    assert.equal(errors.length, 1, `${code}: ${errors.join('\n')}`);
    assert(errors[0].includes(reason), errors[0]);
  }
});

test('architecture audit accepts public entries, local imports, comments and each domain wrapper', () => {
  const file = path.join(plugins, 'kurumi-logs/query.js');
  assert.deepEqual(inspect(file, `
    // Operator entrypoint: scripts/fusion/health.mjs.
    export {runCli} from '@kurumi/log-query';
    import {createToolTrace} from '../../packages/observability/tool-trace.js';
    import {queryOptions} from './policy.js';
    spawn(node, [path.join(root, 'chatbot', 'scripts', 'log-query.mjs')]);
  `), []);
  for (const [wrapper, target] of distEntrypoints) {
    const specifier = path.relative(path.dirname(wrapper), target);
    assert.deepEqual(inspect(wrapper, `export {default} from '${specifier}';`), []);
  }
});
