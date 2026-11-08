// tools/free-what-the-list-says-can-be-got-back: every rule, on made-up folders and a made-up git repository with an
// upstream, a stand-in source, and the command run the way the engine runs it (granted folder in argv, request on stdin).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { askedAddress, judgeRow, movePathToTrash, run, shapeOf, sourceAnswers } from '../do-work/free-what-the-list-says-can-be-got-back.mjs';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'tool-rows.json'), 'utf8')).records.map(record => record.payload);
const SAVED = 'Way back is saved: Mac copy can be freed';
const shape = shapeOf();
const OLD = new Date(Date.now() - 48 * 3600 * 1000);

const gitEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), LC_ALL: 'C' });
function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { env: gitEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

async function keptOnRealRun(work, candidate, reason, deps = {}) {
  const before = readFileSync(join(work, 'scratch', 'dough-1.bin'));
  let disposals = 0;
  const out = await run(work, { rows: [candidate], dry_run: false }, { answers, ...deps, trash: () => { disposals++; } });
  assert.equal(out.rows[0].eligible_for_trash, false, JSON.stringify(out));
  assert.match(out.rows[0].reason, reason);
  assert.equal(disposals, 0);
  assert.equal(out.rows[0].next_value, undefined);
  assert.equal(out.trashed_count, 0);
  assert.deepEqual(readFileSync(join(work, 'scratch', 'dough-1.bin')), before);
  return out;
}

/** A bakery folder that is a git repository with an upstream: a recipe file (pushed), big scratch files and a kept loaf. */
function bakery(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'free-')));
  if (process.platform === 'darwin') t.after(() => movePathToTrash(root));
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
  const trash = join(root, 'trash');
  mkdirSync(trash);
  // Synthetic stand-in: refuse existing destinations; retain the bytes for explicit recovery assertions.
  const dispose = path => {
    const destination = join(trash, path.split('/').at(-1));
    if (existsSync(destination)) throw new Error('Trash destination already exists');
    renameSync(path, destination);
  };
  return { root, work, trash, dispose };
}

const row = (work, path, value = {}) => ({ id: 'kept:' + path, value: { name: path, kind: 'render', state: SAVED, mac_path: join(work, path), frees: 'folder', recipe_files: 'bake.json', bytes: 4000, ...value } });
const answers = async () => true;

test('a folder whose recipe is tracked, unchanged and pushed is eligible; a dry run moves nothing', async t => {
  const { work } = bakery(t);
  const out = await run(work, { rows: [row(work, 'scratch')] });
  assert.equal(out.dry_run, true);
  assert.equal(out.rows[0].eligible_for_trash, true);
  assert.equal(out.eligible_count, 1);
  assert.ok(out.eligible_path_bytes > 0);
  assert.equal(out.trashed_count, 0);
  assert.equal(out.freed_bytes, null);
  assert.ok(existsSync(join(work, 'scratch', 'dough-1.bin')));
});

test('a real run moves to recoverable Trash, returns the moved state, and claims no physical space freed', async t => {
  const { work, trash, dispose } = bakery(t);
  const original = readFileSync(join(work, 'scratch', 'dough-1.bin'));
  const out = await run(work, { rows: [row(work, 'scratch')], dry_run: false }, { trash: dispose });
  assert.equal(out.rows[0].trashed, true);
  assert.equal(existsSync(join(work, 'scratch')), false);
  assert.equal(out.rows[0].next_value.state, 'Mac copy moved to Trash');
  assert.equal(out.trashed_count, 1);
  assert.ok(out.trashed_path_bytes > 0);
  assert.equal(out.freed_bytes, null);
  assert.deepEqual(readFileSync(join(trash, 'scratch', 'dough-1.bin')), original);
  renameSync(join(trash, 'scratch'), join(work, 'scratch'));
  assert.deepEqual(readFileSync(join(work, 'scratch', 'dough-1.bin')), original);
  assert.ok(existsSync(join(work, 'bake.json')), 'the recipe stays');
});

test('a real run moves only rows whose check passed; a held row stays without a moved state', async t => {
  const { work, dispose } = bakery(t);
  mkdirSync(join(work, 'kept'));
  writeFileSync(join(work, 'kept', 'loaf.bin'), 'k');
  utimesSync(join(work, 'kept', 'loaf.bin'), OLD, OLD); utimesSync(join(work, 'kept'), OLD, OLD);
  const out = await run(work, { rows: [row(work, 'scratch'), row(work, 'kept', { hold_reason: 'needs the originals' })], dry_run: false }, { trash: dispose });
  assert.equal(out.rows[0].trashed, true);
  assert.equal(out.rows[1].eligible_for_trash, false);
  assert.equal(out.rows[1].next_value, undefined);
  assert.ok(existsSync(join(work, 'kept', 'loaf.bin')));
});

test('the disposal route cannot permanently delete or empty Trash', () => {
  const code = readFileSync(resolve(folder, 'do-work', 'free-what-the-list-says-can-be-got-back.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /execFileSync\('\/usr\/bin\/trash'/);
  assert.doesNotMatch(code, /rmSync|unlinkSync|rmdirSync|\/bin\/rm|emptyTrash/);
});

test('a denied or ineffective Trash move preserves eligibility separately and never marks the row moved', async t => {
  const { work } = bakery(t);
  for (const trash of [() => { throw new Error('synthetic permission denial'); }, () => {}]) {
    const out = await run(work, { rows: [row(work, 'scratch')], dry_run: false }, { trash });
    assert.equal(out.rows[0].eligible_for_trash, true);
    assert.equal(out.rows[0].trashed, false);
    assert.equal(out.rows[0].next_value, undefined);
    assert.equal(out.trashed_count, 0);
    assert.equal(out.freed_bytes, null);
    assert.match(out.rows[0].reason, /not confirmed/);
    assert.equal(readFileSync(join(work, 'scratch', 'dough-1.bin'), 'utf8'), 'x'.repeat(2000));
  }
});

test('an existing Trash destination is never overwritten and both originals remain', async t => {
  const { work, trash, dispose } = bakery(t);
  mkdirSync(join(trash, 'scratch'));
  writeFileSync(join(trash, 'scratch', 'prior.bin'), 'prior');
  const out = await run(work, { rows: [row(work, 'scratch')], dry_run: false }, { trash: dispose });
  assert.equal(out.rows[0].trashed, false);
  assert.equal(out.rows[0].next_value, undefined);
  assert.equal(readFileSync(join(trash, 'scratch', 'prior.bin'), 'utf8'), 'prior');
  assert.ok(existsSync(join(work, 'scratch', 'dough-1.bin')));
});

test('a path replaced during its source check is kept even with old modification times', async t => {
  const { work } = bakery(t);
  let moves = 0;
  const out = await run(work, { rows: [row(work, 'scratch', { source_url: 'https://source.example.test/a' })], dry_run: false }, {
    answers: async () => {
      renameSync(join(work, 'scratch'), join(work, 'prior-scratch'));
      mkdirSync(join(work, 'scratch'));
      writeFileSync(join(work, 'scratch', 'new.bin'), 'new');
      utimesSync(join(work, 'scratch', 'new.bin'), OLD, OLD);
      utimesSync(join(work, 'scratch'), OLD, OLD);
      return true;
    },
    trash: () => { moves++; },
  });
  assert.equal(out.rows[0].eligible_for_trash, false);
  assert.match(out.rows[0].reason, /path changed/);
  assert.equal(moves, 0);
  assert.equal(readFileSync(join(work, 'scratch', 'new.bin'), 'utf8'), 'new');
  assert.ok(existsSync(join(work, 'prior-scratch', 'dough-1.bin')));
});

test('native macOS Trash accepts two synthetic files with the same name and the real runner confirms a synthetic folder move', async t => {
  if (process.platform !== 'darwin') return t.skip('requires the macOS native Trash API');
  const { root, work } = bakery(t);
  const name = `workshop-trash-synthetic-${root.split('/').at(-1)}.txt`;
  const places = [join(root, 'first'), join(root, 'second')];
  for (const [index, place] of places.entries()) {
    mkdirSync(place);
    const file = join(place, name);
    writeFileSync(file, `synthetic ${index}`);
    movePathToTrash(file);
    assert.equal(existsSync(file), false);
  }
  const out = await run(work, { rows: [row(work, 'scratch')], dry_run: false });
  assert.equal(out.rows[0].eligible_for_trash, true);
  assert.equal(out.rows[0].trashed, true);
  assert.equal(out.rows[0].next_value.state, 'Mac copy moved to Trash');
  assert.equal(out.freed_bytes, null);
  assert.equal(existsSync(join(work, 'scratch')), false);
  t.diagnostic(`Synthetic native consumer readback: ${JSON.stringify({ eligible_for_trash: out.rows[0].eligible_for_trash, trashed: out.rows[0].trashed, state: out.rows[0].next_value.state, trashed_count: out.trashed_count, freed_bytes: out.freed_bytes })}`);
});

test('a supplied native sandbox DATA profile keeps the synthetic source when Trash is outside the grant', t => {
  const dataPath = process.env.TRASH_PROOF_SANDBOX_DATA;
  if (process.platform !== 'darwin' || !dataPath) return t.skip('set TRASH_PROOF_SANDBOX_DATA to the current native owner DATA on macOS');
  const { root, work } = bakery(t);
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  const granted = data.capabilities.find(c => c.id === 'change-a-folder');
  const fill = rule => rule.replaceAll('{private}', root).replaceAll('{folder}', work);
  // Native header/base/grant composition, executing the operation itself. No added destination or service allow.
  const profile = '(version 1)(deny default)(allow process-exec file-read* (literal "/usr/bin/trash"))'
    + data.base.map(fill).join('') + granted.sandbox.map(fill).join('');
  const path = join(work, 'synthetic-contained.txt');
  writeFileSync(path, 'synthetic source remains on denial');
  const readable = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', path], { encoding: 'utf8', timeout: 10000 });
  assert.equal(readable.status, 0, readable.stderr);
  assert.equal(readable.stdout, 'synthetic source remains on denial');
  const attempt = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/trash', '-s', path], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(attempt.status, 0, 'the supplied folder grant must not silently gain Trash destination access');
  assert.equal(readFileSync(path, 'utf8'), 'synthetic source remains on denial');
  t.diagnostic(`Native sandbox Trash status=${attempt.status}; ${attempt.stderr.trim()}`);
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

test('an actual git status failure cannot prove that a recipe is unchanged', async t => {
  const { work } = bakery(t);
  git(work, 'config', 'status.showUntrackedFiles', 'not-a-mode');
  assert.ok(git(work, 'rev-parse', '--show-toplevel'));
  assert.ok(git(work, 'ls-files', '--error-unmatch', '--', 'bake.json'));
  assert.throws(() => git(work, 'status', '--porcelain', '--', 'bake.json'), error => {
    assert.notEqual(error.status, 0);
    assert.match(String(error.stderr), /untracked files mode|Invalid|invalid/);
    return true;
  });
  await keptOnRealRun(work, row(work, 'scratch'), /could not check whether the recipe file changed/);
});

test('an actual ls-files failure cannot prove that a URL-backed path is untracked', async t => {
  const { work } = bakery(t);
  writeFileSync(join(work, '.git', 'index'), 'synthetic corrupt index');
  assert.ok(git(work, 'rev-parse', '--show-toplevel'));
  assert.throws(() => git(work, 'ls-files', '--', 'scratch'), error => {
    assert.notEqual(error.status, 0);
    assert.match(String(error.stderr), /index/);
    return true;
  });
  await keptOnRealRun(work, row(work, 'scratch', { recipe_files: '', source_url: 'https://source.example.test/a' }), /could not check which files.*tracked/);
});

test('failed rev-parse on malformed configuration or a broken gitfile is unreadable, not outside Git', async t => {
  for (const kind of ['configuration', 'gitfile']) {
    const { work } = bakery(t);
    if (kind === 'configuration') writeFileSync(join(work, '.git', 'config'), 'synthetic invalid config\n');
    else {
      renameSync(join(work, '.git'), join(work, '.git-held'));
      writeFileSync(join(work, '.git'), 'gitdir: absent-synthetic-git-directory\n');
    }
    assert.throws(() => git(work, 'rev-parse', '--show-toplevel'), error => error.status === 128);
    await keptOnRealRun(work, row(work, 'scratch', { recipe_files: '', source_url: 'https://source.example.test/a' }), /could not establish the repository/);
  }
});

test('Git non-repository output with a corrupt .git directory does not establish outside-Git', async t => {
  const { work } = bakery(t);
  renameSync(join(work, '.git'), join(work, '.git-held'));
  mkdirSync(join(work, '.git'));
  assert.throws(() => git(work, 'rev-parse', '--show-toplevel'), error => {
    assert.equal(error.status, 128);
    assert.match(String(error.stderr), /not a git repository/);
    return true;
  });
  await keptOnRealRun(work, row(work, 'scratch', { recipe_files: '', source_url: 'https://source.example.test/a' }), /metadata is present but could not be read/);
});

test('an unreadable Git configuration is refused rather than treated as outside-Git', async t => {
  if (process.getuid?.() === 0) return t.skip('root bypasses the synthetic POSIX read denial');
  const { work } = bakery(t);
  const config = join(work, '.git', 'config');
  chmodSync(config, 0o000);
  try {
    assert.throws(() => git(work, 'rev-parse', '--show-toplevel'), error => {
      assert.equal(error.status, 128);
      assert.match(String(error.stderr), /Permission denied/);
      return true;
    });
    await keptOnRealRun(work, row(work, 'scratch', { recipe_files: '', source_url: 'https://source.example.test/a' }), /could not establish the repository/);
  } finally { chmodSync(config, 0o600); }
});

test('an actual Git dubious-ownership refusal cannot become outside-Git success', async t => {
  const { work } = bakery(t);
  const original = childProcess.execFileSync;
  let refusals = 0;
  // Force Git's own ownership opponent after the production environment sanitation. No invented output/result:
  // the installed Git executes and raises its real dubious-ownership refusal, which production must classify.
  const instrument = t.mock.method(childProcess, 'execFileSync', (program, args, options) => {
    if (program !== 'git' || !args.includes('rev-parse')) return original(program, args, options);
    try { return original(program, args, { ...options, env: { ...options.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } }); }
    catch (error) {
      assert.equal(error.status, 128);
      assert.match(String(error.stderr), /dubious ownership/);
      refusals++;
      throw error;
    }
  });
  syncBuiltinESMExports();
  try {
    await keptOnRealRun(work, row(work, 'scratch', { recipe_files: '', source_url: 'https://source.example.test/a' }), /could not establish the repository/);
    assert.ok(refusals > 0);
  } finally { instrument.mock.restore(); syncBuiltinESMExports(); }
});

test('a genuinely outside-Git URL-backed file remains eligible, while outside-Git recipes remain unproved', async t => {
  const { root } = bakery(t);
  const work = join(root, 'outside');
  mkdirSync(work);
  const file = join(work, 'download.bin');
  writeFileSync(file, 'synthetic downloaded bytes'); utimesSync(file, OLD, OLD);
  const candidate = row(work, 'download.bin', { frees: 'file', recipe_files: '', source_url: 'https://source.example.test/a' });
  const verdict = await judgeRow(candidate, { folder: work, shape, answers });
  assert.equal(verdict.free, true, JSON.stringify(verdict));
  const cannotProve = await judgeRow({ ...candidate, value: { ...candidate.value, recipe_files: 'bake.json' } }, { folder: work, shape, answers });
  assert.equal(cannotProve.free, false);
  assert.match(cannotProve.reason, /not inside a git repository/);
  assert.equal(readFileSync(file, 'utf8'), 'synthetic downloaded bytes');
});

test('ambient Git repository, index, config, discovery and ownership selectors cannot redirect proof reads', async t => {
  const { work } = bakery(t);
  const foreign = bakery(t);
  const changes = {
    GIT_DIR: join(foreign.work, '.git'), GIT_COMMON_DIR: join(foreign.work, '.git'), GIT_WORK_TREE: foreign.work,
    GIT_INDEX_FILE: join(foreign.root, 'absent.index'), GIT_CEILING_DIRECTORIES: work, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'status.showUntrackedFiles', GIT_CONFIG_VALUE_0: 'not-a-mode',
  };
  const prior = Object.fromEntries(Object.keys(changes).map(name => [name, process.env[name]]));
  Object.assign(process.env, changes);
  try {
    const verdict = await judgeRow(row(work, 'scratch'), { folder: work, shape, answers });
    assert.equal(verdict.free, true, JSON.stringify(verdict));
    const tracked = await judgeRow(row(work, 'tracked.txt', { frees: 'file', recipe_files: '', source_url: 'https://source.example.test/a' }), { folder: work, shape, answers });
    assert.equal(tracked.free, false);
    assert.match(tracked.reason, /git tracks files/);
  } finally {
    for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('literal pathspecs and repository paths ending in spaces preserve the actual path identity', async t => {
  const fixture = bakery(t);
  const work = fixture.work + ' with trailing space ';
  renameSync(fixture.work, work);
  assert.equal((await judgeRow(row(work, 'scratch'), { folder: work, shape, answers })).free, true);
  const named = 'kept[1].bin';
  writeFileSync(join(work, named), 'synthetic tracked bytes'); utimesSync(join(work, named), OLD, OLD);
  git(work, '--literal-pathspecs', 'add', '-f', '--', named);
  const verdict = await judgeRow(row(work, named, { frees: 'file', recipe_files: '', source_url: 'https://source.example.test/a' }), { folder: work, shape, answers });
  assert.equal(verdict.free, false);
  assert.match(verdict.reason, /git tracks files/);
  assert.equal(readFileSync(join(work, named), 'utf8'), 'synthetic tracked bytes');
});

test('Git tracking changes during a source check and a missing upstream both preserve the source', async t => {
  const { work } = bakery(t);
  await keptOnRealRun(work, row(work, 'scratch', { recipe_files: '', source_url: 'https://source.example.test/a' }), /git tracks files/, {
    answers: async () => { git(work, 'add', '-f', '--', 'scratch'); return true; },
  });
  const other = bakery(t);
  git(other.work, 'branch', '--unset-upstream');
  await keptOnRealRun(other.work, row(other.work, 'scratch'), /no upstream/);
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
  assert.equal(out.rows[0].eligible_for_trash, true);
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
