import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { workshopShellHomes, workshopShellImportsPlugin } from 'trillion-workshop/tools/workspace-pieces/scripts/workshop-shell-imports.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const relative = 'src/workspace/first-answers.json';
const workshop = 'tools/keep-and-wake-ai-sessions-on-this-computer/src/workspace/first-answers.json';
const fixturePackage = 'trillion-workshop'; // A synthetic package identity, never another repository's code.
const homes = 'web/scripts/workshop-shell-homes.json';
const owner = 'tools/workspace-screens/web/src/workspace/first-answers.json'; // The one copy: the Workshop's tool that holds the screens.
const current = JSON.stringify({ paths: { initial_setup: '/work/api/screens/get-started' } }); // Synthetic current data.

function fixture(t) {
  // No .git or neighbouring checkout: candidate/export reads must use their own declarations.
  const base = realpathSync(tempFolder(join(tmpdir(), 'first-answers-owner-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const put = (name, text) => { mkdirSync(dirname(join(base, name)), { recursive: true }); writeFileSync(join(base, name), text); };
  put(homes, JSON.stringify({ rows: [{ workshop, shell: relative, why: 'Synthetic web DATA the web shell holds a newer copy of' }] }));
  put('web/package.json', '{"type":"module"}');
  put(`web/${relative}`, current);
  put(relative, current);
  const old = JSON.parse(current); // Construct the obsolete preload locally.
  old.paths.initial_hold = '/work/api/needs-you-hold';
  const oldBytes = JSON.stringify(old);
  put(`node_modules/trillion-workshop/${workshop}`, oldBytes);
  put(`web/node_modules/trillion-workshop/${workshop}`, oldBytes);
  put('web/entry.mjs', `import direct from '${fixturePackage}/${workshop}';
import relative from './node_modules/${fixturePackage}/tools/keep-and-wake-ai-sessions-on-this-computer/src/entry.mjs';
globalThis.answer = {direct, relative};`);
  put('web/node_modules/trillion-workshop/tools/keep-and-wake-ai-sessions-on-this-computer/src/entry.mjs',
    "import answer from './workspace/first-answers.json'; export default answer;");
  return { base, put, oldBytes };
}

async function bundled(base) {
  const result = await build({ absWorkingDir: join(base, 'web'), entryPoints: ['entry.mjs'], bundle: true, write: false,
    format: 'iife', platform: 'browser', logLevel: 'silent', plugins: [workshopShellImportsPlugin(join(base, 'web'))] });
  // The fixture is fully synthetic and invokes both production resolution paths.
  return new Function(`${result.outputFiles[0].text}; return globalThis.answer;`)();
}

test('actual direct and relative Workshop bundles use the declared web owner in an export', async t => {
  const { base, put, oldBytes } = fixture(t);
  const answer = await bundled(base);
  assert.deepEqual(answer.direct, answer.relative);
  assert.equal('initial_hold' in answer.direct.paths, false);
  assert.equal(answer.direct.paths.initial_setup, '/work/api/screens/get-started');
  put(relative, oldBytes);
  assert.deepEqual(await bundled(base), answer, 'a stale former root copy cannot replace the web owner');
  assert.equal(readFileSync(join(base, relative), 'utf8'), oldBytes, 'the bundler never rewrites former carried paths');
  assert.equal(readFileSync(join(base, 'node_modules/trillion-workshop', workshop), 'utf8'), oldBytes);
  assert.deepEqual(await bundled(base), answer, 'repeated resolution reads the same current web owner');
});

test('a missing or refused declared Apps home never falls back to the old preload', async t => {
  const { base, put } = fixture(t);
  unlinkSync(join(base, 'web', relative));
  await assert.rejects(bundled(base), /first-answers/);
  put(homes, '{broken');
  assert.throws(() => workshopShellHomes(join(base, 'web')), SyntaxError);
  await assert.rejects(bundled(base), /JSON|position|property/i);
  unlinkSync(join(base, homes));
  assert.throws(() => workshopShellHomes(join(base, 'web')), /ENOENT/);
  await assert.rejects(bundled(base), /workshop-shell-homes/);
});

test('the actual resolver refuses escaping, duplicate and ambiguous declarations', async t => {
  const { base, put } = fixture(t);
  const declaration = { workshop, shell: relative, why: 'Synthetic product DATA adaptation' };
  for (const bad of [
    [{ ...declaration, shell: '../outside.json' }],
    [{ ...declaration, shell: '/outside.json' }],
    [{ ...declaration, shell: 'node_modules/outside.json' }],
    [{ ...declaration, home: workshop }],
    [declaration, declaration],
  ]) {
    put(homes, JSON.stringify({ rows: bad }));
    assert.throws(() => workshopShellHomes(join(base, 'web')), /confined|repeated/);
    await assert.rejects(bundled(base), /confined|repeated/);
  }
  put(homes, JSON.stringify({ rows: [declaration] }));
  put('outside.json', '{}');
  unlinkSync(join(base, 'web', relative));
  symlinkSync(join(base, 'outside.json'), join(base, 'web', relative));
  assert.throws(() => workshopShellHomes(join(base, 'web')), /leaves the source tree/);
  await assert.rejects(bundled(base), /leaves the source tree/);
});

function homeFixture(t) {
  const made = fixture(t);
  const home = 'tools/current/first-answers.json';
  made.put(homes, JSON.stringify({ rows: [{ workshop, home, why: 'Synthetic Workshop relocation' }] }));
  made.put(`web/node_modules/trillion-workshop/${home}`, '{"current":true}');
  made.put(`node_modules/trillion-workshop/${home}`, '{"current":true}');
  made.put(relative, '{"current":true}');
  return { ...made, home };
}

test('actual direct and relative bundles refuse a home symlink outside the declared package', async t => {
  const { base, put, home } = homeFixture(t);
  put('outside.json', '{"escaped":true}');
  const target = join(base, 'web/node_modules/trillion-workshop', home);
  unlinkSync(target);
  symlinkSync(join(base, 'outside.json'), target);
  await assert.rejects(bundled(base), /leaves the Workshop package/);
  assert.throws(() => workshopShellHomes(join(base, 'web')), /leaves the Workshop package/);
});

test('the active declared package refuses a home escape without changing the web source', async t => {
  const { base, put, home } = homeFixture(t);
  const before = readFileSync(join(base, 'web', relative), 'utf8');
  put('outside.json', '{"escaped":true}');
  const target = join(base, 'web/node_modules/trillion-workshop', home);
  unlinkSync(target);
  symlinkSync(join(base, 'outside.json'), target);
  assert.throws(() => workshopShellHomes(join(base, 'web')), /leaves the Workshop package/);
  await assert.rejects(bundled(base), /leaves the Workshop package/);
  assert.equal(readFileSync(join(base, 'web', relative), 'utf8'), before);
});

test('whole dependency-root symlinks preserve contained declared home bundles', async t => {
  const { base, put } = homeFixture(t);
  for (const [installed, kept] of [['web/node_modules/trillion-workshop', 'web-package'], ['node_modules/trillion-workshop', 'root-package']]) {
    renameSync(join(base, installed), join(base, kept));
    symlinkSync(join(base, kept), join(base, installed));
  }
  assert.deepEqual(await bundled(base), { direct: { current: true }, relative: { current: true } });
  put(relative, '{"stale":true}');
  assert.deepEqual(await bundled(base), { direct: { current: true }, relative: { current: true } });
  assert.equal(readFileSync(join(base, relative), 'utf8'), '{"stale":true}', 'resolution never rewrites inactive root copies');
});

for (const kind of ['home', 'shell']) {
  function heldFixture(t) {
    const made = fixture(t);
    const target = kind === 'home' ? 'tools/example/original.json.held' : 'src/workspace/original.json.held';
    made.put(homes, JSON.stringify({ rows: [{ workshop, [kind]: target, why: 'Synthetic held-source countercase' }] }));
    made.put(kind === 'home' ? `web/node_modules/trillion-workshop/${target}` : `web/${target}`, '{"historical":true}');
    if (kind === 'home') made.put(`node_modules/trillion-workshop/${target}`, '{"historical":true}');
    made.put(relative, '{"live":true}');
    return { ...made, target };
  }
  test(`${kind} redirect to held bytes cannot replace the live web source`, t => {
    const { base } = heldFixture(t);
    const before = readFileSync(join(base, relative), 'utf8');
    let refused;
    try { workshopShellHomes(join(base, 'web')); } catch (error) { refused = error; }
    assert.equal(readFileSync(join(base, relative), 'utf8'), before, 'refused held-source redirect preserves live bytes');
    assert.match(refused?.message ?? 'resolution accepted the held source', /held historical snapshot/);
    assert.throws(() => workshopShellHomes(join(base, 'web')), /held historical snapshot/);
  });
  test(`${kind} redirect to held bytes is refused by the registry and actual bundler`, async t => {
    const { base, put, target } = heldFixture(t);
    assert.throws(() => workshopShellHomes(join(base, 'web')), /held historical snapshot/);
    await assert.rejects(bundled(base), /held historical snapshot/);
    const active = target.slice(0, -'.held'.length);
    const prefix = kind === 'home' ? 'web/node_modules/trillion-workshop' : 'web';
    symlinkSync(join(base, prefix, target), join(base, prefix, active));
    put(homes, JSON.stringify({ rows: [{ workshop, [kind]: active, why: 'Synthetic held-source link countercase' }] }));
    assert.throws(() => workshopShellHomes(join(base, 'web')), /held historical snapshot/);
    await assert.rejects(bundled(base), /held historical snapshot/);
  });
}

test('active package symlinks to held bytes are refused without rewriting the web owner', async t => {
  const { base, put, home } = homeFixture(t);
  const before = readFileSync(join(base, 'web', relative), 'utf8');
  const target = join(base, 'web/node_modules/trillion-workshop', home);
  const held = `${home}.held`;
  put(`web/node_modules/trillion-workshop/${held}`, '{"historical":true}');
  unlinkSync(target);
  symlinkSync(join(base, 'web/node_modules/trillion-workshop', held), target);
  assert.throws(() => workshopShellHomes(join(base, 'web')), /held historical snapshot/);
  await assert.rejects(bundled(base), /held historical snapshot/);
  assert.equal(readFileSync(join(base, 'web', relative), 'utf8'), before);
});
