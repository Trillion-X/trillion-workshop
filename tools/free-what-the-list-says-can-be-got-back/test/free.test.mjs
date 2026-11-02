// tools/free-what-the-list-says-can-be-got-back: every rule, on made-up folders and a made-up git repository with an
// upstream, a stand-in source, and the command run the way the engine runs it (granted folder in argv, request on stdin).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { askedAddress, judgeRow, run, shapeOf, sourceAnswers } from '../do-work/free-what-the-list-says-can-be-got-back.mjs';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const SAVED = 'Way back is saved: Mac copy can be freed';
const shape = shapeOf();
const OLD = new Date(Date.now() - 48 * 3600 * 1000);

function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

/** A bakery folder that is a git repository with an upstream: a recipe file (pushed), big scratch files and a kept loaf. */
function bakery(t) {
  const root = mkdtempSync(join(tmpdir(), 'free-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  mkdirSync(work);
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(work, 'init', '-b', 'main');
  git(work, 'config', 'user.email', 'maker@example.test');
  git(work, 'config', 'user.name', 'Maker');
  writeFileSync(join(work, 'bake.json'), '{"steps":["mix","proof","bake"]}\n');
  mkdirSync(join(work, 'scratch'));
  writeFileSync(join(work, 'scratch', 'dough-1.bin'), 'x'.repeat(2000));
  writeFileSync(join(work, 'scratch', 'dough-2.bin'), 'y'.repeat(2000));
  writeFileSync(join(work, 'tracked.txt'), 'kept in git\n');
  writeFileSync(join(work, '.gitignore'), 'scratch/\n*.bin\n');
  git(work, 'add', 'bake.json', 'tracked.txt', '.gitignore');
  git(work, 'commit', '-m', 'recipe');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-u', 'origin', 'main');
  for (const p of [join(work, 'scratch', 'dough-1.bin'), join(work, 'scratch', 'dough-2.bin'), join(work, 'scratch')]) utimesSync(p, OLD, OLD);
  return { root, work, trash: join(root, 'trash') };
}

const row = (work, path, value = {}) => ({ id: 'kept:' + path, value: { name: path, kind: 'render', state: SAVED, mac_path: join(work, path), frees: 'folder', recipe_files: 'bake.json', bytes: 4000, ...value } });
const answers = async () => true;

test('a folder whose recipe is tracked, unchanged and pushed can be freed; a dry run moves nothing', async t => {
  const { work } = bakery(t);
  const out = await run(work, { rows: [row(work, 'scratch')] });
  assert.equal(out.dry_run, true);
  assert.equal(out.rows[0].free, true);
  assert.equal(out.can_free_count, 1);
  assert.ok(out.can_free_bytes > 0);
  assert.equal(out.freed_count, 0);
  assert.ok(existsSync(join(work, 'scratch', 'dough-1.bin')));
});

test('a real run moves the folder into the trash and returns the row with its state freed', async t => {
  const { work, trash } = bakery(t);
  const out = await run(work, { rows: [row(work, 'scratch')], dry_run: false }, { trash });
  assert.equal(out.rows[0].freed, true);
  assert.equal(existsSync(join(work, 'scratch')), false);
  assert.ok(existsSync(out.rows[0].moved_to));
  assert.equal(out.rows[0].next_value.state, 'Mac copy freed');
  assert.equal(out.freed_count, 1);
});

test('every refusal leaves the path where it is and says why', async t => {
  const { work } = bakery(t);
  const cases = [
    [{ state: 'Mac copy is the only copy' }, 'does not say the way back is saved'],
    [{ hold_reason: 'needs the originals' }, 'held back: needs the originals'],
    [{ frees: 'none' }, 'a group'],
    [{ recipe_files: '' }, 'nothing to check'],
    [{ recipe_files: 'missing.json' }, 'recipe file is not tracked'],
    [{ frees: 'file' }, 'frees a file but the path is not one'],
    [{ mac_path: join(work, '..', 'elsewhere') }, 'outside the granted folder'],
    [{ mac_path: join(work, 'nothing-here') }, 'already gone'],
  ];
  for (const [change, why] of cases) {
    const verdict = await judgeRow(row(work, 'scratch', change), { folder: work, shape, answers });
    assert.equal(verdict.free, false, why);
    assert.match(verdict.reason, new RegExp(why));
  }
  assert.ok(existsSync(join(work, 'scratch', 'dough-1.bin')));
});

test('git-tracked files, links, changed recipes, unpushed commits and recent changes keep a path', async t => {
  const { work } = bakery(t);
  assert.match((await judgeRow(row(work, 'tracked.txt', { frees: 'file' }), { folder: work, shape, answers })).reason, /git tracks/);
  symlinkSync(join(work, 'scratch'), join(work, 'linked'));
  assert.match((await judgeRow(row(work, 'linked'), { folder: work, shape, answers })).reason, /link/);
  writeFileSync(join(work, 'scratch', 'dough-3.bin'), 'z');
  assert.match((await judgeRow(row(work, 'scratch'), { folder: work, shape, answers })).reason, /changed in the last 6 hours/);
  utimesSync(join(work, 'scratch', 'dough-3.bin'), OLD, OLD); utimesSync(join(work, 'scratch'), OLD, OLD);
  writeFileSync(join(work, 'bake.json'), '{"steps":["mix"]}\n');
  assert.match((await judgeRow(row(work, 'scratch'), { folder: work, shape, answers })).reason, /recipe file changed since its last commit: bake\.json/);
  git(work, 'commit', '-am', 'change');
  assert.match((await judgeRow(row(work, 'scratch'), { folder: work, shape, answers })).reason, /not pushed/);
  git(work, 'push');
  assert.equal((await judgeRow(row(work, 'scratch'), { folder: work, shape, answers })).free, true);
});

test('a source that does not answer keeps the path; one that does lets it go', async t => {
  const { work } = bakery(t);
  const withSource = row(work, 'scratch', { recipe_files: '', source_url: 'https://source.example.test/loaf' });
  assert.match((await judgeRow(withSource, { folder: work, shape, answers: async () => false })).reason, /source does not answer: https:\/\/source\.example\.test\/loaf/);
  assert.equal((await judgeRow(withSource, { folder: work, shape, answers: async () => true })).free, true);
});

test('sources are asked at the address the url-checks DATA names, and only a 2xx or 3xx answers', async () => {
  assert.match(askedAddress('https://www.youtube.com/watch?v=abc'), /^https:\/\/www\.youtube\.com\/oembed\?format=json&url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3Dabc$/);
  assert.equal(askedAddress('https://source.example.test/a'), 'https://source.example.test/a');
  assert.equal(askedAddress('ftp://source.example.test/a'), null);
  const seen = [];
  const fetcher = status => async (url, options) => { seen.push(options.method); return { status: options.method === 'HEAD' ? 405 : status }; };
  assert.equal(await sourceAnswers('https://source.example.test/a', fetcher(200)), true);
  assert.deepEqual(seen, ['HEAD', 'GET']);
  assert.equal(await sourceAnswers('https://source.example.test/a', fetcher(404)), false);
  assert.equal(await sourceAnswers('https://source.example.test/a', async () => { throw new Error('down'); }), false);
});

test('a caller whose list uses other names sends only those names', async t => {
  const { work } = bakery(t);
  const other = { id: 'x', value: { where: join(work, 'scratch'), status: 'ok-to-free', proof: 'bake.json', removes: 'folder' } };
  const custom = { fields: { path: 'where', state: 'status', recipe_files: 'proof', frees: 'removes', source_urls: [] }, states: { saved: 'ok-to-free' } };
  const out = await run(work, { rows: [other], shape: custom });
  assert.equal(out.rows[0].free, true);
});

test('the request is checked: no rows, too many rows', async t => {
  const { work } = bakery(t);
  await assert.rejects(run(work, { rows: [] }), /1 to 100/);
  await assert.rejects(run(work, {}), /1 to 100/);
});

test('the command runs as the engine runs the row: folder in argv, request on stdin, answer on the last line', t => {
  const { work } = bakery(t);
  const request = { rows: [row(work, 'scratch', { recipe_files: '', source_url: 'ftp://source.example.test/x' })] };
  const ran = spawnSync(process.execPath, [resolve(folder, 'do-work', 'free-what-the-list-says-can-be-got-back.mjs'), work], { input: JSON.stringify(request), encoding: 'utf8' });
  const answer = JSON.parse(ran.stdout.trim().split('\n').at(-1));
  assert.equal(answer.result.dry_run, true);
  assert.match(answer.result.rows[0].reason, /source does not answer/);
  const bad = spawnSync(process.execPath, [resolve(folder, 'do-work', 'free-what-the-list-says-can-be-got-back.mjs'), work], { input: '{"rows":[]}', encoding: 'utf8' });
  assert.match(JSON.parse(bad.stdout.trim().split('\n').at(-1)).error, /1 to 100/);
});

test('the row asks for the folder grant and the internet, runs on the person\'s computer, and names the fields it reads', () => {
  const [tool] = rows;
  assert.equal(tool.id, 'tool:free-what-the-list-says-can-be-got-back');
  assert.deepEqual(tool.invoke.capabilities, ['change-a-folder']);
  assert.equal(tool.invoke.internet, true);
  assert.deepEqual(tool.placements, ['placement:your-computer']);
  assert.equal(tool.input_schema.properties.dry_run.type, 'boolean');
  assert.equal(shape.states.saved, SAVED);
});
