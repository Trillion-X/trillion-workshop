// test/tool-row-install-scripts.test.mjs
//
// A package that runs an install script is laid out for a tool row only when the row declares it by name (its invoke.packages,
// or a packages item of its package_files): the owner chose it by declaring it. A package the row only imports is refused, and
// the refusal is listed by refusedModules (the generator prints it), never dropped silently. The fixture is a throwaway
// repository holding the walker, the lockfile and one row whose program imports one scripted package.
import { tempFolder } from '../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageFilesByRow, refusedModules } from '../test-helpers/tool-row-imports.mjs';

const repo = resolve(import.meta.dirname, '..');
const KEY = 'node_modules/fake-scripted';
const REFUSAL = 'tool:app fake-scripted: node_modules/fake-scripted runs an install script, and nothing the engine fetches runs one';

function fixture({ declared }) {
  const root = tempFolder(join(tmpdir(), 'tool-row-install-scripts-'));
  cpSync(join(repo, 'test-helpers'), join(root, 'test-helpers'), { recursive: true });
  cpSync(join(repo, 'tools', 'content-identity'), join(root, 'tools', 'content-identity'), { recursive: true });
  mkdirSync(join(root, 'tools', 'app', 'do-work'), { recursive: true });
  writeFileSync(join(root, 'tools', 'app', 'do-work', 'main.mjs'), "import scripted from 'fake-scripted';\nexport default scripted;\n");
  const row = {
    kind: 'ai-tool-descriptor', id: 'tool:app', status: 'Active',
    invoke: { argv: ['/opt/app/do-work/main.mjs'], files: { package_files: [{ package: 'app', paths: ['do-work'], at: '/opt/app' }] } },
  };
  if (declared) row.invoke.packages = { 'fake-scripted': { version: '1.0.0' } };
  writeFileSync(join(root, 'tools', 'app', 'tool-rows.json'), JSON.stringify({ records: [{ payload: row }] }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { '': {}, [KEY]: { version: '1.0.0', resolved: 'https://registry.npmjs.org/fake-scripted/-/fake-scripted-1.0.0.tgz', integrity: 'sha512-AAAA', hasInstallScript: true } },
  }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.test', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.test' };
  delete env.GIT_INDEX_FILE;
  const git = args => execFileSync('git', ['-C', root, ...args], { env, maxBuffer: 2 ** 30 }).toString().trim();
  git(['init', '-q']);
  git(['add', '-A', '-f', '.']);
  git(['commit', '-q', '-m', 'fixture']);
  return { root, ref: git(['rev-parse', 'HEAD']) };
}

test('a package with an install script that the row only imports is refused, and the refusal is listed', () => {
  const { root, ref } = fixture({ declared: false });
  assert.deepEqual(refusedModules({ repo: root, ref }), [REFUSAL]);
  const items = packageFilesByRow({ repo: root, ref })['tool:app'];
  assert.ok(!items.some(item => (item.packages ?? []).includes(KEY)), 'the refused package is not laid out');
});

test('a package with an install script that the row declares by name is laid out, and no refusal is printed', () => {
  const { root, ref } = fixture({ declared: true });
  assert.deepEqual(refusedModules({ repo: root, ref }), []);
  const items = packageFilesByRow({ repo: root, ref })['tool:app'];
  assert.ok(items.some(item => (item.packages ?? []).includes(KEY) && item.at === '/opt/node_modules/fake-scripted'), 'the declared package is laid out at its lockfile folder');
});

test('a package the row lays out under its own name is not laid out again by a module tree that needs it', () => {
  const root = tempFolder(join(tmpdir(), 'tool-row-placed-once-'));
  cpSync(join(repo, 'test-helpers'), join(root, 'test-helpers'), { recursive: true });
  cpSync(join(repo, 'tools', 'content-identity'), join(root, 'tools', 'content-identity'), { recursive: true });
  mkdirSync(join(root, 'tools', 'app', 'do-work'), { recursive: true });
  writeFileSync(join(root, 'tools', 'app', 'do-work', 'main.mjs'), "import kit from 'kit';\nexport default kit;\n");
  const row = {
    kind: 'ai-tool-descriptor', id: 'tool:app', status: 'Active',
    invoke: { argv: ['/opt/app/do-work/main.mjs'], packages: { shared: { version: '1.0.0' } }, files: { package_files: [
      { package: 'app', paths: ['do-work'], at: '/opt/app' },
      { packages: ['shared'], at: '/opt/node_modules/shared' },
    ] } },
  };
  writeFileSync(join(root, 'tools', 'app', 'tool-rows.json'), JSON.stringify({ records: [{ payload: row }] }));
  const at = name => ({ version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity: 'sha512-AAAA' });
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/kit': { ...at('kit'), dependencies: { shared: '^1' } }, 'node_modules/shared': at('shared') },
  }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'check', GIT_AUTHOR_EMAIL: 'check@example.test', GIT_COMMITTER_NAME: 'check', GIT_COMMITTER_EMAIL: 'check@example.test' };
  delete env.GIT_INDEX_FILE;
  const git = args => execFileSync('git', ['-C', root, ...args], { env, maxBuffer: 2 ** 30 }).toString().trim();
  git(['init', '-q']);
  git(['add', '-A', '-f', '.']);
  git(['commit', '-q', '-m', 'fixture']);
  const items = packageFilesByRow({ repo: root, ref: git(['rev-parse', 'HEAD']) })['tool:app'];
  const places = items.map(item => item.at);
  assert.equal(places.filter(place => place === '/opt/node_modules/shared').length, 1, 'one folder is laid out once');
  assert.ok(places.includes('/opt/node_modules/kit'), 'the module itself is laid out');
});
