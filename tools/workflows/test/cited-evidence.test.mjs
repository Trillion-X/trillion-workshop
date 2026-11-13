// tools/workflows: a `cites-resolve` check opens what a finding cites. A code line must hold the quoted text at the
// repository's ref, a commit must exist and be dated after the complaint, a row must exist; the submit refuses an
// answer whose citation does not resolve and names it. The repository here is made up in a temp folder and every
// field name is made up: the roots and patterns are the resolver DATA the test hands in.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveItem, RESOLVERS } from '../read-data/citation-resolvers.mjs';
import { submitARecipeStep } from '../read-data/submit-a-recipe-step.mjs';
import { recipeProblems } from '../read-data/recipe-problems.mjs';

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
    { ...RESOLVERS.resolvers.find(row => row.kind === 'row'), pattern: '\\brecord:note:[A-Za-z0-9:_#.-]*[A-Za-z0-9_]', types: ['record:note'] },
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
function door() {
  const held = new Map([[run, { id: run, value: { kind: 'ai-job', status: 'taken', row: 'workflow:made-up', label: 'Made up', job: [step], input: {} } }],
    ['record:note:done-1', { id: 'record:note:done-1', value: { text: 'a row' } }]]);
  return { held, read: async (_kind, id) => held.get(id)?.value ?? null, async *list() {}, write: async records => { for (const record of records) held.set(record.id, record); } };
}
const submit = (d, findings, key = 's1') => submitARecipeStep({ input: { run, step: 'look', answer: { findings } }, task: { request_key: key } }, { door: d, resolvers });

test('a real line, a commit after the complaint and an existing row pass, and the answer is kept', async () => {
  const d = door();
  assert.equal((await submit(d, [finding('f1')])).status, 'kept');
  assert.ok(d.held.has(`${run}#answer:look`));
});

test('a made-up line is refused and named: a wrong quote, a line past the end, a file that is not there', async () => {
  for (const [bad, why] of [[{ quote: 'a thing the line never said' }, /does not hold the quoted text/], [{ evidence: 'madeup/src/a.txt:99' }, /has 4 lines/], [{ evidence: 'madeup/src/none.txt:1' }, /is not in madeup/], [{ evidence: 'nowhere/src/a.txt:1' }, /no repository named nowhere/], [{ evidence: 'no citation here' }, /cites 0, needs 1/]]) {
    await assert.rejects(submit(door(), [finding('f1', bad)]), error => /f1\.evidence/.test(error.message) && why.test(error.message), JSON.stringify(bad));
  }
});

test('a commit from before the complaint, a commit that does not exist and a row that does not exist are refused and named', async () => {
  await assert.rejects(submit(door(), [finding('f1', { work_since: `fixed in ${OLD}` })]), error => error.message.includes(`${OLD}`) && /not after/.test(error.message));
  await assert.rejects(submit(door(), [finding('f1', { work_since: 'fixed in 0123456789abcdef' })]), /no such commit/);
  await assert.rejects(submit(door(), [finding('f1', { work_since: 'recorded in record:note:missing-9' })]), /record:note:missing-9 \(no such row\)/);
  assert.equal((await submit(door(), [finding('f1', { work_since: 'none found; searched the log' })], 's2')).status, 'kept', 'a finding that cites nothing has nothing to resolve unless the check wants some');
});

test('a repository that is not on this computer cannot be judged, and the answer is refused rather than kept unchecked', async () => {
  const away = { resolvers: resolvers.resolvers.map(row => (row.kind === 'file-line' ? { ...row, roots: { madeup: { sources: [{ folder: join(folder, 'gone'), ref: 'HEAD' }] } } } : row)) };
  await assert.rejects(submitARecipeStep({ input: { run, step: 'look', answer: { findings: [finding('f1')] } }, task: { request_key: 's3' } }, { door: door(), resolvers: away }), /cannot be judged here.*not on this computer/);
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
const filesDoor = (inner, held) => ({
  ...inner,
  files: async (method, { name_or_identity: name, offset = 0, length = 1 << 20 }) => {
    const text = held[name.replace('/source-copies/madeup/', '')];
    if (!name.startsWith('/source-copies/madeup/') || text === undefined) throw new Error('no such file');
    if (method === 'find_file') return { names: [name] };
    const bytes = Buffer.from(text).subarray(offset, offset + length);
    return { content: bytes.toString('utf8'), encoding: 'utf8', byte_length: Buffer.byteLength(text), bytes_returned: bytes.length };
  },
});
const copyResolvers = { resolvers: resolvers.resolvers.map(row => (row.roots ? { ...row, roots: { madeup: { sources: [{ folder: join(folder, 'gone'), ref: 'HEAD' }, { files: '/source-copies/madeup' }] } } } : row)) };
const submitFrom = (d, findings, key) => submitARecipeStep({ input: { run, step: 'look', answer: { findings } }, task: { request_key: key } }, { door: d, resolvers: copyResolvers });

test('with no checkout, the copy in the person\'s files answers: a real line and a commit after the complaint pass, a made-up line and an early commit are refused', async () => {
  const d = filesDoor(door(), copy({}));
  assert.equal((await submitFrom(d, [finding('f1')], 'k1')).status, 'kept');
  await assert.rejects(submitFrom(filesDoor(door(), copy({})), [finding('f1', { quote: 'never said' })], 'k2'), /f1\.evidence.*does not hold the quoted text/);
  await assert.rejects(submitFrom(filesDoor(door(), copy({})), [finding('f1', { work_since: `fixed in ${OLD}` })], 'k3'), /not after/);
  await assert.rejects(submitFrom(filesDoor(door(), copy({})), [finding('f1', { work_since: 'fixed in 0123456789abcdef' })], 'k4'), /no such commit/);
});

test('with neither a checkout nor a copy, or with no files right, the answer is refused as not judged, never kept', async () => {
  await assert.rejects(submitFrom(filesDoor(door(), {}), [finding('f1')], 'k5'), /cannot be judged here.*no copy of it is in the files/);
  await assert.rejects(submitFrom(door(), [finding('f1')], 'k6'), /cannot be judged here/);
});

test('a row of a type the resolver may not read is not judged here, and a row the door will not read is not judged either', async () => {
  const d = door();
  const noRead = { ...d, read: async (kind, id) => { if (kind === 'record:note') throw new Error('not granted'); return d.read(kind, id); } };
  await assert.rejects(submitFrom(filesDoor(noRead, copy({})), [finding('f1')], 'k7'), /cannot be judged here.*could not be read/);
});

test('the shipped tool row declares a files read right on the copy folders and a records read right for exactly the row types the resolver may read', async () => {
  const { readFileSync } = await import('node:fs');
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
  const { invoke } = rows.records.map(entry => entry.payload).find(row => row.id === 'tool:submit-a-recipe-step');
  const types = RESOLVERS.resolvers.find(row => row.kind === 'row').types;
  const read = invoke.records.rights.filter(right => right.kind && right.operations.includes('records:read')).map(right => right.kind).sort();
  assert.deepEqual(read, [...new Set(['ai-job', ...types])].sort());
  const folders = [...new Set(RESOLVERS.resolvers.flatMap(row => Object.values(row.roots ?? {})).flatMap(root => root.sources).filter(source => source.files).map(source => source.files))];
  assert.ok(folders.length > 0);
  for (const folder of folders) assert.ok(invoke.records.rights.some(right => right.files && folder.startsWith(right.files) && right.operations.includes('read_file')), folder);
});
