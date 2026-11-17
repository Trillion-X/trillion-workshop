// tools/workflows: a `cites-resolve` check opens what a finding cites. A code line must hold the quoted text at the
// repository's ref, a commit must exist and be dated after the complaint, a row must exist; the submit refuses an
// answer whose citation does not resolve and names it. The repository here is made up in a temp folder and every
// field name is made up: the roots and patterns are the resolver DATA the test hands in.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { resolveItem, RESOLVERS } from '../read-data/citation-resolvers.mjs';
import { submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';
import { keep, readRow, readJson, runRowIn, startDatabase } from '../test-helpers/rows-in-sql.mjs';

const folder = mkdtempSync(join(tmpdir(), 'made-up-repo-'));
const git = (env, ...args) => execFileSync('git', ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
git({}, 'init', '-q');
mkdirSync(join(folder, 'src'));
writeFileSync(join(folder, 'src/a.txt'), 'first line\nthe store keeps rows in one file\nthird line\n');
git({}, 'add', '.');
git({ GIT_COMMITTER_DATE: '2026-11-01T10:00:00Z', GIT_AUTHOR_DATE: '2026-11-01T10:00:00Z' }, 'commit', '-qm', 'old work');
const OLD = git({}, 'rev-parse', '--short=10', 'HEAD');
writeFileSync(join(folder, 'src/a.txt'), 'first line\nthe store keeps rows in one file\nthird line\nfourth line\n');
git({}, 'commit', '-qam', 'new work', '--date=2026-11-10T10:00:00Z');
git({ GIT_COMMITTER_DATE: '2026-11-10T10:00:00Z' }, 'commit', '-q', '--amend', '--no-edit', '--date=2026-11-10T10:00:00Z');
const NEW = git({}, 'rev-parse', '--short=10', 'HEAD');

const resolvers = {
  resolvers: [
    { ...RESOLVERS.resolvers.find(row => row.kind === 'file-line'), roots: { madeup: { sources: [{ folder, ref: 'HEAD' }] } } },
    { ...RESOLVERS.resolvers.find(row => row.kind === 'commit'), roots: { madeup: { sources: [{ folder, ref: 'HEAD' }] } } },
    { ...RESOLVERS.resolvers.find(row => row.kind === 'row'), pattern: '\\brecord:note:[A-Za-z0-9:_#.-]*[A-Za-z0-9_]', tables: [{ prefix: 'record:note:', table: 'note', strip_prefix: false }] },
  ],
};
const named = kind => resolvers.resolvers.find(row => row.kind === kind).resolver;
const checks = [
  { kind: 'cites-resolve', path: ['this', 'findings', '*'], field: 'evidence', resolver: named('file-line'), quote: 'quote', at_least: 1, says: 'The cited line holds the quoted text' },
  { kind: 'cites-resolve', path: ['this', 'findings', '*'], field: 'work_since', resolver: named('commit'), after: 'complaint_date', says: 'Each cited commit exists and is after the complaint' },
  { kind: 'cites-resolve', path: ['this', 'findings', '*'], field: 'work_since', resolver: named('row'), says: 'Each cited row exists' },
];
const step = { id: 'look', title: 'Look', do: 'Look.', submit: { type: 'object' }, checks };
const finding = (id, extra = {}) => ({ id, complaint_date: '2026-11-05T00:00:00Z', evidence: 'madeup/src/a.txt:2', quote: 'keeps rows in one file', work_since: `fixed in ${NEW} and recorded in record:note:done-1`, ...extra });
const run = 'ai-job:workflow:made-up:k1';
let db;
before(async () => { db = await startDatabase(); });
after(async () => { await db.stop(); });
beforeEach(async () => {
  await db.reset();
  await db.sql('insert into ai_job (id, value) values ($1, $2::jsonb)', [run, JSON.stringify({ kind: 'ai-job', status: 'taken', row: 'workflow:made-up', label: 'Made up', job: [step], input: {} })]);
  await keep(db.sql, 'note', 'record:note:done-1', { text: 'a row' });
});
// No answer is kept yet when a submit starts, so each call is judged on its own; `door` is the files door alone, or none.
const answerRow = () => readRow(db.sql, 'ai_job', `${run}#answer:look`);
const submitWith = async (findings, key, withResolvers, door) => {
  await db.sql('delete from ai_job where id = $1', [`${run}#answer:look`]);
  return submitARecipeStep({ input: { run, step: 'look', answer: { findings } }, task: { request_key: key } }, { sql: db.sql, door, resolvers: withResolvers });
};
const submit = (findings, key = 's1') => submitWith(findings, key, resolvers);

test('a real line, a commit after the complaint and an existing row pass, and the answer is kept', async () => {
  assert.equal((await submit([finding('f1')])).status, 'kept');
  assert.ok(await answerRow());
});

test('a made-up line is refused and named: a wrong quote, a line past the end, a file that is not there', async () => {
  for (const [bad, why] of [[{ quote: 'a thing the line never said' }, /does not hold the quoted text/], [{ evidence: 'madeup/src/a.txt:99' }, /has 4 lines/], [{ evidence: 'madeup/src/none.txt:1' }, /is not in madeup/], [{ evidence: 'nowhere/src/a.txt:1' }, /no repository named nowhere/], [{ evidence: 'no citation here' }, /cites 0, needs 1/]]) {
    await assert.rejects(submit([finding('f1', bad)]), error => /f1\.evidence/.test(error.message) && why.test(error.message), JSON.stringify(bad));
  }
});

test('a commit from before the complaint, a commit that does not exist and a row that does not exist are refused and named', async () => {
  await assert.rejects(submit([finding('f1', { work_since: `fixed in ${OLD}` })]), error => error.message.includes(`${OLD}`) && /not after/.test(error.message));
  await assert.rejects(submit([finding('f1', { work_since: 'fixed in 0123456789abcdef' })]), /no such commit/);
  await assert.rejects(submit([finding('f1', { work_since: 'recorded in record:note:missing-9' })]), /record:note:missing-9 \(no such row\)/);
  assert.equal((await submit([finding('f1', { work_since: 'none found; searched the log' })], 's2')).status, 'kept', 'a finding that cites nothing has nothing to resolve unless the check wants some');
});

test('a repository that is not on this computer cannot be judged, and the answer is refused rather than kept unchecked', async () => {
  const away = { resolvers: resolvers.resolvers.map(row => (row.kind === 'file-line' ? { ...row, roots: { madeup: { sources: [{ folder: join(folder, 'gone'), ref: 'HEAD' }] } } } : row)) };
  await assert.rejects(submitWith([finding('f1')], 's3', away), /cannot be judged here.*not on this computer/);
});

test('resolveItem answers each citation of an item, and the check is valid in a recipe', async () => {
  const found = await resolveItem(checks[1], finding('f1', { work_since: `${OLD} then ${NEW}` }), { resolvers });
  assert.deepEqual(found.map(one => [one.cite, one.ok]), [[OLD, false], [NEW, true]]);
  assert.deepEqual(recipeProblems({ kind: 'workflow-recipe', id: 'workflow:made-up', label: 'Made up', job: 'Made up.', steps: [step] }), []);
});

// The same step judged where there is no checkout: the source is a copy in the person's own files, read through the files
// door the run is handed (the road a container run has), with the row types it may read declared as DATA.
const copy = (files, extra = {}) => ({
  '.source-copy.json': JSON.stringify({ ref: 'HEAD', copied_at: '2026-11-13T00:00:00Z' }),
  '.commit-dates.json': JSON.stringify({ [`${OLD}aaaaaaaa`]: '2026-11-01T10:00:00Z', [`${NEW}bbbbbbbb`]: '2026-11-10T10:00:00Z' }),
  'src/a.txt': 'first line\nthe store keeps rows in one file\nthird line\n', ...extra, ...files });
const filesDoor = held => ({
  files: async (method, { name_or_identity: name, offset = 0, length = 1 << 20 }) => {
    const text = held[name.replace('/source-copies/madeup/', '')];
    if (!name.startsWith('/source-copies/madeup/') || text === undefined) throw new Error('no such file');
    if (method === 'find_file') return { names: [name] };
    const bytes = Buffer.from(text).subarray(offset, offset + length);
    return { content: bytes.toString('utf8'), encoding: 'utf8', byte_length: Buffer.byteLength(text), bytes_returned: bytes.length };
  },
});
const copyResolvers = { resolvers: resolvers.resolvers.map(row => (row.roots ? { ...row, roots: { madeup: { sources: [{ folder: join(folder, 'gone'), ref: 'HEAD' }, { files: '/source-copies/madeup' }] } } } : row)) };
const submitFrom = (d, findings, key) => submitWith(findings, key, copyResolvers, d);

test('with no checkout, the copy in the person\'s files answers: a real line and a commit after the complaint pass, a made-up line and an early commit are refused', async () => {
  const d = filesDoor(copy({}));
  assert.equal((await submitFrom(d, [finding('f1')], 'k1')).status, 'kept');
  await assert.rejects(submitFrom(filesDoor(copy({})), [finding('f1', { quote: 'never said' })], 'k2'), /f1\.evidence.*does not hold the quoted text/);
  await assert.rejects(submitFrom(filesDoor(copy({})), [finding('f1', { work_since: `fixed in ${OLD}` })], 'k3'), /not after/);
  await assert.rejects(submitFrom(filesDoor(copy({})), [finding('f1', { work_since: 'fixed in 0123456789abcdef' })], 'k4'), /cannot be judged here.*holds no date for that commit/);
});

test('with neither a checkout nor a copy, or with no files right, the answer is refused as not judged, never kept', async () => {
  await assert.rejects(submitFrom(filesDoor({}), [finding('f1')], 'k5'), /cannot be judged here.*no copy of it is in the files/);
  await assert.rejects(submitFrom(undefined, [finding('f1')], 'k6'), /cannot be judged here/);
});

test('a row of a table the resolver may not read is not judged here, and a table the database will not read is not judged either', async () => {
  const other = { resolvers: resolvers.resolvers.map(row => (row.kind === 'row' ? { ...row, tables: [{ prefix: 'record:other:', table: 'other', strip_prefix: false }] } : row)) };
  await assert.rejects(submitWith([finding('f1')], 'k7', other, filesDoor(copy({}))), /cannot be judged here.*starts with no prefix of a table this check may read/);
  const missing = { resolvers: resolvers.resolvers.map(row => (row.kind === 'row' ? { ...row, tables: [{ prefix: 'record:note:', table: 'no_such_table', strip_prefix: false }] } : row)) };
  await assert.rejects(submitWith([finding('f1')], 'k8', missing, filesDoor(copy({}))), /cannot be judged here.*could not be read/);
});

test('the shipped submit rows declare a files read right on the copy folders, and the `row` resolver reads exactly the tables its DATA names', () => {
  const rows = readJson('workflows/tool-rows.json').records.map(entry => entry.payload);
  for (const id of ['tool:submit-a-recipe-step', 'tool:submit-a-step-that-slots-rows']) {
    const { invoke } = rows.find(row => row.id === id);
    const folders = [...new Set(RESOLVERS.resolvers.flatMap(row => Object.values(row.roots ?? {})).flatMap(root => root.sources).filter(source => source.files).map(source => source.files))];
    assert.ok(folders.length > 0);
    for (const folder of folders) assert.ok(invoke.records.rights.some(right => folder.startsWith(right.files) && right.operations.includes('read_file')), `${id} ${folder}`);
  }
  const tables = RESOLVERS.resolvers.find(row => row.kind === 'row').tables.map(entry => entry.table);
  assert.deepEqual(tables, ['ai_job', 'calendar_task', 'workflow_step', 'workflow_recipe']);
});

test('the shipped submit row, run as the engine runs it, keeps an answer whose step has no citation to open, with no files door at all', async () => {
  const submitRow = readJson('workflows/tool-rows.json').records.map(entry => entry.payload).find(row => row.id === 'tool:submit-a-recipe-step');
  const plain = { id: 'look', title: 'Look', do: 'Look.', submit: { type: 'object' }, checks: [] };
  await db.sql('update ai_job set value = jsonb_set(value, \'{job}\', $1::jsonb) where id = $2', [JSON.stringify([plain]), run]);
  const ran = await runRowIn(submitRow, { input: { run, step: 'look', answer: { findings: [] } }, task: { request_key: 'r1' } }, { connection: db.connection });
  assert.equal(ran.code, 0, ran.stderr + ran.out);
  assert.equal(ran.last.result.status, 'kept');
  assert.equal((await answerRow()).step, 'look');
});

test('a kept answer names the source and head each citation was judged against, and a copy with no recorded head says so', async () => {
  const kept = await submit([finding('f1')]);
  assert.ok(kept.judged_against.some(name => name.startsWith('madeup at HEAD at ') || /^madeup at HEAD at [0-9a-f]{12}$/.test(name)), kept.judged_against.join('|'));
  assert.deepEqual((await answerRow()).judged_against, kept.judged_against, 'the kept row carries it');
  const stamped = filesDoor(copy({ '.source-copy.json': JSON.stringify({ ref: 'HEAD', head: 'abc123def456', copied_at: '2026-11-13T00:00:00Z' }) }));
  assert.ok((await submitFrom(stamped, [finding('f1')], 'h1')).judged_against.some(name => name.endsWith('at abc123def456')));
  const unstamped = (await submitFrom(filesDoor(copy({})), [finding('f1')], 'h2')).judged_against;
  assert.ok(unstamped.some(name => name.endsWith('head not recorded')), unstamped.join('|'));
});

// What a copy may not do: turn a failure to read into a verdict about the repository.
test('a copy that cannot read is never a verdict: a failed read, a stamp that is not JSON, dates that are not JSON and a path with .. are each handled', async () => {
  const flaky = (inner, failing) => ({ ...inner, files: async (method, args) => { if (failing.some(name => args.name_or_identity.endsWith(name))) throw new Error('door fell over'); return inner.files(method, args); } });
  await assert.rejects(submitFrom(flaky(filesDoor(copy({})), ['src/a.txt']), [finding('f1')], 'u1'), /cannot be judged here.*could not be read from madeup/);
  assert.doesNotMatch(await submitFrom(flaky(filesDoor(copy({})), ['src/a.txt']), [finding('f1')], 'u2').catch(error => error.message), /is not in madeup/);
  await assert.rejects(submitFrom(filesDoor(copy({ '.source-copy.json': '{not json' })), [finding('f1')], 'u3'), /cannot be judged here.*no copy of it is in the files/);
  await assert.rejects(submitFrom(filesDoor(copy({ '.commit-dates.json': '{not json' })), [finding('f1')], 'u4'), /cannot be judged here.*holds no date for that commit/);
  await assert.rejects(submitFrom(filesDoor(copy({})), [finding('f1', { evidence: 'madeup/../outside/a.txt:1' })], 'u5'), /f1\.evidence.*is not a path inside madeup/);
});

test('a copy that lists the paths it holds says a file is absent only when the list is the whole repository', async () => {
  const listed = complete => copy({ '.source-copy.json': JSON.stringify({ ref: 'HEAD', head: 'abc123def456', files: ['src/a.txt'], complete }) });
  assert.equal((await submitFrom(filesDoor(listed(false)), [finding('f1')], 'l1')).status, 'kept');
  const other = { evidence: 'madeup/src/other.txt:1' };
  await assert.rejects(submitFrom(filesDoor(listed(true)), [finding('f1', other)], 'l2'), /is not in madeup/);
  await assert.rejects(submitFrom(filesDoor(listed(false)), [finding('f1', other)], 'l3'), /cannot be judged here.*could not be read from madeup/);
});
