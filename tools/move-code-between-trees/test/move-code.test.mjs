// The mover on two made-up code trees in throwaway git repositories: a plan places each file once, apply moves the bytes
// and deletes the originals, the files that stay import the moved ones from the destination package, rows follow their
// files, provider calls are swapped or hold their group, and check proves the move and catches a changed byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { moveCode } from '../do-work/move-code.mjs';

const git = (folder, ...args) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' });
const json = value => `${JSON.stringify(value, null, 2)}\n`;

function repository(files) {
  const folder = mkdtempSync(join(tmpdir(), 'move-code-'));
  git(folder, 'init', '-q', '-b', 'main');
  git(folder, 'config', 'user.email', 'maker@example.invalid');
  git(folder, 'config', 'user.name', 'Maker');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  git(folder, 'add', '-A');
  git(folder, 'commit', '-q', '-m', 'start');
  return folder;
}

const sourceFiles = () => ({
  'package.json': json({ name: 'old-app', type: 'module', imports: { '#words': './src/words.mjs' }, dependencies: { 'tiny-thing': '1.2.3' } }),
  'capabilities.json': json({ about: 'made up', capabilities: [
    { capability: 'count the beans', owner: ['src/beans.mjs'], entry: 'src/beans.mjs', evidence: 'src/beans.mjs:1', moves_to: 'tools/count-beans' },
    { capability: 'weigh the beans', owner: ['src/weigh.mjs'], entry: 'src/weigh.mjs', evidence: 'The weighing reads the shared scale and answers grams.', moves_to: 'tools/weigh-beans' },
    { capability: 'guard the door', owner: ['src/door-guard.mjs'], entry: 'src/door-guard.mjs', evidence: 'The guard reads the kept lock and answers yes or no.', moves_to: 'tools/guard-door' },
    { capability: 'read a secret', owner: ['src/secret-user.mjs'], entry: 'src/secret-user.mjs', evidence: 'The reader takes a key from the environment binding.', moves_to: 'tools/read-secret' },
    { capability: 'serve the app', owner: ['src/app.mjs'], entry: 'src/app.mjs', evidence: 'The app imports the beans and shows them.' },
  ] }),
  'src/beans.mjs': "// Count beans.\nimport { scale } from '../lib/scale.mjs';\nimport { word } from '#words';\nimport { helper } from './helper.mjs';\nexport async function count(env, door, key) {\n  const kept = await env.BEANS_KV.get(key, { type: 'json' });\n  return { kept, beans: helper(scale(3)), word };\n}\n",
  'src/helper.mjs': "export const helper = n => n + 1;\n",
  'src/words.mjs': "export const word = 'bean';\n",
  'src/weigh.mjs': "import { scale } from '../lib/scale.mjs';\nexport const weigh = n => scale(n) * 2;\n",
  'lib/scale.mjs': "export const scale = n => n * 10;\n",
  'src/door-guard.mjs': "import { lock } from './lock.mjs';\nexport const guard = () => lock;\n",
  'src/lock.mjs': "export const lock = true;\n",
  'src/secret-user.mjs': "export const key = env => env.PRICE_TOKEN;\n",
  'src/app.mjs': "import { count } from './beans.mjs';\nimport { weigh } from './weigh.mjs';\nconst table = new URL('./helper.mjs', import.meta.url);\nexport const show = () => [count, weigh, table];\n",
  'test/beans.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { count } from '../src/beans.mjs';\ntest('beans', async () => { const door = { read: async () => 7 }; assert.deepEqual(await count({}, door, 'k'), { kept: 7, beans: 31, word: 'bean' }); });\n",
});

const destinationFiles = () => ({
  'package.json': json({ name: 'tool-box', type: 'module', exports: { './tools/*': './tools/*' } }),
  'capabilities.json': json({ about: 'made up', capabilities: [] }),
  'tools/existing/README.md': '# existing\n',
});

const row = {
  id: 'move:old-app-to-tool-box',
  source: { name: 'old-app', test_folders: ['test'], owner_index: { file: 'capabilities.json', rows: 'capabilities', owner: 'owner', entry: 'entry', evidence: 'evidence', drop_fields: ['moves_to'] } },
  destination: { name: 'tool-box', package: 'tool-box', shared_folder: 'tools/shared-code', owner_index: { file: 'capabilities.json', rows: 'capabilities', fields: ['capability', 'owner', 'entry', 'evidence'] } },
  groups_from: { index: 'capabilities.json', rows: 'capabilities', owner: 'owner', to: 'moves_to', label: 'capability' },
  keep: ['src/lock.mjs'],
  provider_calls: [{ id: 'kv', find: '(?<![.\\w$])env\\.[A-Z][A-Z0-9_]*_KV\\b' }, { id: 'env-binding', find: '(?<![.\\w$])env\\.[A-Z][A-Z0-9_]+\\b' }],
  calls: [{ id: 'kv-get-json', means: 'a KV read becomes a records read', find: "(?<![.\\w$])env\\.([A-Z][A-Z0-9_]*_KV)\\.get\\(\\s*([^,()]+?)\\s*,\\s*\\{\\s*type:\\s*'json'\\s*\\}\\s*\\)", replace: "door.read('$1', $2)" }],
};

test('a plan places each file once, moves the test with its group, and holds what it must', () => {
  const source = repository(sourceFiles());
  const destination = repository(destinationFiles());
  try {
    const plan = moveCode({ step: 'plan', row, source_folder: source, destination_folder: destination });
    const group = id => plan.groups.find(item => item.id === id);
    assert.deepEqual(group('count-beans').held, []);
    assert.deepEqual(group('count-beans').tests, ['test/beans.test.mjs']);
    assert.deepEqual(group('weigh-beans').held, []);
    assert.match(group('guard-door').held[0], /imports src\/lock\.mjs, which stays in the source \(keep row src\/lock\.mjs\)/);
    assert.match(group('read-secret').held[0], /still calls env-binding \(env\.PRICE_TOKEN\)/);
    const to = Object.fromEntries(plan.files.map(file => [file.from, file.to]));
    assert.equal(to['lib/scale.mjs'], 'tools/shared-code/lib/scale.mjs', 'two groups need it: the shared folder');
    assert.equal(to['src/beans.mjs'], 'tools/count-beans/src/beans.mjs');
    assert.equal(to['src/words.mjs'], 'tools/count-beans/src/words.mjs');
    assert.equal(to['src/lock.mjs'], undefined, 'a held group moves nothing');
    const beans = plan.files.find(file => file.from === 'src/beans.mjs');
    assert.deepEqual(beans.swaps, [{ id: 'kv-get-json', count: 1, lines: [6] }]);
    assert.deepEqual(beans.import_changes.map(change => [change.was, change.specifier]), [['../lib/scale.mjs', '../../shared-code/lib/scale.mjs'], ['#words', './words.mjs']]);
    const app = plan.importers.find(item => item.path === 'src/app.mjs');
    assert.deepEqual(app.changes.map(change => change.specifier), ['tool-box/tools/count-beans/src/beans.mjs', 'tool-box/tools/weigh-beans/src/weigh.mjs', "new URL(import.meta.resolve('tool-box/tools/count-beans/src/helper.mjs'))"]);
  } finally { rmSync(source, { recursive: true, force: true }); rmSync(destination, { recursive: true, force: true }); }
});

test('apply moves the bytes and deletes the originals; check proves it, and a changed byte fails it', () => {
  const source = repository(sourceFiles());
  const destination = repository(destinationFiles());
  try {
    const done = moveCode({ step: 'apply', row, source_folder: source, destination_folder: destination });
    assert.equal(done.applied.moved, 6);
    assert.equal(done.applied.rows_moved, 2);
    for (const gone of ['src/beans.mjs', 'src/helper.mjs', 'src/words.mjs', 'src/weigh.mjs', 'lib/scale.mjs', 'test/beans.test.mjs']) assert.ok(!existsSync(join(source, gone)), `${gone} left the source`);
    assert.ok(existsSync(join(source, 'src/lock.mjs')) && existsSync(join(source, 'src/secret-user.mjs')), 'held groups stay');
    assert.equal(readFileSync(join(destination, 'tools/count-beans/src/helper.mjs'), 'utf8'), sourceFiles()['src/helper.mjs'], 'byte for byte');
    assert.match(readFileSync(join(destination, 'tools/count-beans/src/beans.mjs'), 'utf8'), /await door\.read\('BEANS_KV', key\)/);
    assert.match(readFileSync(join(source, 'src/app.mjs'), 'utf8'), /from 'tool-box\/tools\/count-beans\/src\/beans\.mjs'/);
    const sourceRows = JSON.parse(readFileSync(join(source, 'capabilities.json'), 'utf8')).capabilities.map(item => item.capability);
    assert.deepEqual(sourceRows, ['guard the door', 'read a secret', 'serve the app']);
    const moved = JSON.parse(readFileSync(join(destination, 'capabilities.json'), 'utf8')).capabilities;
    assert.deepEqual(moved.find(item => item.capability === 'count the beans'), { capability: 'count the beans', owner: ['tools/count-beans/src/beans.mjs'], entry: 'tools/count-beans/src/beans.mjs', evidence: 'tools/count-beans/src/beans.mjs:1' });
    assert.deepEqual(JSON.parse(readFileSync(join(destination, 'tools/count-beans/part.json'), 'utf8')), { imported_by: ['old-app'] });
    assert.equal(JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8')).dependencies, undefined, 'nothing imported a package');
    git(destination, 'add', '-A'); git(destination, 'commit', '-q', '-m', 'moved');

    const proof = moveCode({ step: 'check', row, source_folder: source, destination_folder: destination, source_after_folder: source });
    assert.equal(proof.ok, true, JSON.stringify(proof, null, 2));
    const beans = proof.folders.find(item => item.folder === 'tools/count-beans');
    assert.equal(beans.tests.pass, 1);
    assert.equal(beans.loads.failed.length, 0);

    writeFileSync(join(destination, 'tools/count-beans/src/helper.mjs'), 'export const helper = n => n + 2;\n');
    const caught = moveCode({ step: 'check', row, source_folder: source, destination_folder: destination, folders: ['tools/count-beans'], run: false });
    assert.equal(caught.ok, false);
    assert.ok(caught.folders[0].problems.some(problem => /helper\.mjs is not the bytes its receipt names/.test(problem)));
  } finally { rmSync(source, { recursive: true, force: true }); rmSync(destination, { recursive: true, force: true }); }
});

test('a second lane carries out only its own groups, and the shared file still lands in the shared folder', () => {
  const source = repository(sourceFiles());
  const destination = repository(destinationFiles());
  try {
    const done = moveCode({ step: 'apply', row, source_folder: source, destination_folder: destination, apply_groups: ['weigh-beans'] });
    assert.ok(existsSync(join(destination, 'tools/shared-code/lib/scale.mjs')));
    assert.ok(existsSync(join(destination, 'tools/weigh-beans/src/weigh.mjs')));
    assert.ok(!existsSync(join(destination, 'tools/count-beans')), 'the other group waits');
    assert.equal(done.applied.moved, 2);
    // beans.mjs stayed, so it now imports the shared scale from the package; moved later, it imports it by path again.
    assert.match(readFileSync(join(source, 'src/beans.mjs'), 'utf8'), /from 'tool-box\/tools\/shared-code\/lib\/scale\.mjs'/);
    git(source, 'add', '-A'); git(source, 'commit', '-q', '-m', 'lane one');
    git(destination, 'add', '-A'); git(destination, 'commit', '-q', '-m', 'lane one');
    moveCode({ step: 'apply', row, source_folder: source, destination_folder: destination, apply_groups: ['count-beans'] });
    assert.match(readFileSync(join(destination, 'tools/count-beans/src/beans.mjs'), 'utf8'), /from '\.\.\/\.\.\/shared-code\/lib\/scale\.mjs'/);
    git(destination, 'add', '-A'); git(destination, 'commit', '-q', '-m', 'lane two');
    const proof = moveCode({ step: 'check', row, source_folder: source, destination_folder: destination, run: false });
    assert.equal(proof.ok, true, JSON.stringify(proof.folders.map(item => item.problems)));
  } finally { rmSync(source, { recursive: true, force: true }); rmSync(destination, { recursive: true, force: true }); }
});

test('refusals say what to do', () => {
  assert.throws(() => moveCode({ step: 'move' }), /step is plan/);
  assert.throws(() => moveCode({ step: 'plan', source_folder: '/x', destination_folder: '/y' }), /Name the move row/);
  assert.throws(() => moveCode({ step: 'plan', row: { ...row, destination: {} }, source_folder: '.', destination_folder: '.' }), /shared_folder/);
});
