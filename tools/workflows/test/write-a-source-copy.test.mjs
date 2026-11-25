// tools/workflows: the source-copy writer makes a repository's files, commit dates and a stamp for the person's own
// files at /source-copies/<root>/, where the citation resolver reads them. The run reads and writes no store: here the
// person's files are an in-memory map, handed in as stored.files and changed by applying each run's keep, as a store
// would (refusing a keep whose expected identity is not the file's). The folder the writer may write is derived from
// the resolver DATA (citation-resolvers.json), not listed again.
import { rightsOf } from '../../../test-helpers/run-a-row.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { resolveItem, RESOLVERS } from '../read-data/citation-resolvers.mjs';
import { writeASourceCopy } from '../read-data/write-a-source-copy.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const HEAD = 'a1'.repeat(20);
const HEAD2 = 'b2'.repeat(20);

// The person's files: name -> bytes. handed() is what a caller reads and hands in; keepAll applies a run's keep.
function myFiles() {
  const stored = new Map();
  const calls = [];
  return {
    stored, calls,
    handed: () => Object.fromEntries([...stored].map(([name, bytes]) => [name, { base64: bytes.toString('base64') }])),
    keepAll(keep) {
      for (const item of keep) {
        const now = stored.has(item.file) ? makeHashCodeHexFromBytes(stored.get(item.file)) : null;
        if (now !== item.expected) throw new Error(`${item.file} moved`);
        const bytes = Buffer.from(item.base64, 'base64');
        assert.equal(item.identity, makeHashCodeHexFromBytes(bytes));
        stored.set(item.file, bytes);
        calls.push(item.file);
      }
    },
  };
}

const input = (extra = {}) => ({ root: 'madeup', ref: 'origin/main', head: HEAD, files: [{ path: 'src/a.txt', text: 'first line\nthe store keeps rows in one file\n' }, { path: 'b.txt', text: 'x\n' }], dates: { [HEAD]: '2026-11-10T10:00:00Z' }, ...extra });
// One run: the caller hands in the files it holds, the run answers keep, the caller keeps it.
const run = async (files, body, task = { request_key: 'k', at: '2026-11-13T00:00:00Z' }) => {
  const done = await writeASourceCopy({ input: { ...body, stored: { files: files.handed() } }, task });
  files.keepAll(done.keep);
  const { keep, ...shown } = done;
  return shown;
};
const stamp = files => JSON.parse(files.stored.get('/source-copies/madeup/.source-copy.json').toString('utf8'));
const resolvers = { resolvers: RESOLVERS.resolvers.filter(row => row.kind !== 'row').map(row => ({ ...row, roots: { madeup: { sources: [{ files: '/source-copies/madeup' }] } } })) };
const named = kind => resolvers.resolvers.find(row => row.kind === kind).resolver;

test('the tool row writes only where the resolver reads', () => {
  const row = ROWS.find(item => item.id === 'tool:write-a-source-copy');
  const folders = RESOLVERS.resolvers.flatMap(entry => Object.values(entry.roots ?? {})).flatMap(root => root.sources ?? []).filter(source => source.files).map(source => source.files);
  assert.ok(folders.length > 0);
  const right = rightsOf(row).find(item => typeof item.files === 'string');
  for (const folder of folders) assert.ok(`${folder}/`.startsWith(right.files), `${folder} is under the right ${right.files}`);
  assert.deepEqual(rightsOf(row).filter(item => item.kind), [], 'no records kinds');
  assert.ok(rightsOf(row).every(item => item.operations === undefined), 'no door operations');
  assert.equal(row.invoke.argv[1], '/opt/workflows/do-work/run-a-function.mjs');
  // uses_tools is the generated closure of every tool the row's runner may reach, not what the row mounts or names.
  const { uses_tools: _closure, ...mounted } = row;
  assert.ok(!JSON.stringify(mounted).includes('records-door'), 'the row mounts and names no records door');
});

test('a run reads only what is handed in and answers keep with what each file was', async () => {
  const first = await writeASourceCopy({ input: input({ final: false }), task: {} });
  assert.deepEqual(first.keep.map(item => [item.file, item.expected]), [['/source-copies/madeup/src/a.txt', null], ['/source-copies/madeup/b.txt', null]]);
  const old = Buffer.from('y\n');
  const again = await writeASourceCopy({ input: input({ final: false, stored: { files: { '/source-copies/madeup/b.txt': { base64: old.toString('base64') }, '/source-copies/madeup/src/a.txt': null } } }), task: {} });
  assert.deepEqual(again.keep.map(item => [item.file, item.expected]), [['/source-copies/madeup/src/a.txt', null], ['/source-copies/madeup/b.txt', makeHashCodeHexFromBytes(old)]]);
  await assert.rejects(writeASourceCopy({ input: input({ stored: { files: [] } }), task: {} }), /stored.files/);
});

test('a written copy is read by the resolver: a file line and a commit', async () => {
  const mine = myFiles();
  assert.deepEqual(await run(mine, input()), { root: 'madeup', head: HEAD, written: 2, bytes: mine.stored.get('/source-copies/madeup/src/a.txt').length + 2 + mine.stored.get('/source-copies/madeup/.commit-dates.json').length + mine.stored.get('/source-copies/madeup/.source-copy.json').length });
  const line = await resolveItem({ resolver: named('file-line'), field: 'e', quote: 'q' }, { e: 'madeup/src/a.txt:2', q: 'keeps rows in one file' }, { resolvers, files: mine.handed() });
  assert.deepEqual(line.map(one => one.ok), [true]);
  assert.match(line[0].against, new RegExp(HEAD));
  const missing = await resolveItem({ resolver: named('file-line'), field: 'e' }, { e: 'madeup/src/none.txt:1' }, { resolvers, files: mine.handed() });
  assert.equal(missing[0].ok, null, 'a copy that is not complete cannot say a file is absent');
  const found = await resolveItem({ resolver: named('commit'), field: 'c', after: 'd' }, { c: `fixed in ${HEAD.slice(0, 12)}`, d: '2026-11-05T00:00:00Z' }, { resolvers, files: mine.handed() });
  assert.deepEqual(found.map(one => one.ok), [true]);
});

test('the stamp is written last, after every file and the dates', async () => {
  const mine = myFiles();
  await run(mine, input());
  assert.deepEqual(mine.calls, ['/source-copies/madeup/src/a.txt', '/source-copies/madeup/b.txt', '/source-copies/madeup/.commit-dates.json', '/source-copies/madeup/.source-copy.json']);
});

test('a bad root, path, size, count or field is refused and nothing is written', async () => {
  const bad = [
    input({ root: 'Bad/Root' }), input({ root: '-x' }),
    input({ files: [{ path: '../x', text: 'a' }] }), input({ files: [{ path: 'a/../x', text: 'a' }] }), input({ files: [{ path: './x', text: 'a' }] }),
    input({ files: [{ path: 'a//x', text: 'a' }] }), input({ files: [{ path: '/x', text: 'a' }] }), input({ files: [{ path: 'a\\x', text: 'a' }] }),
    input({ files: [{ path: 'ok.txt', text: 'a' }, { path: '..', text: 'a' }] }),
    input({ files: Array.from({ length: 65 }, (_, at) => ({ path: `f${at}`, text: 'a' })) }),
    input({ files: [{ path: 'big', text: 'a'.repeat(4 * 1024 * 1024 + 1) }] }),
    input({ surprise: 1 }),
  ];
  for (const body of bad) {
    const mine = myFiles();
    await assert.rejects(run(mine, body), Error);
    assert.equal(mine.stored.size, 0);
  }
});

test('a later run with another head and fewer files keeps the earlier files in the stamp unless complete is true', async () => {
  const mine = myFiles();
  await run(mine, input());
  await run(mine, input({ head: HEAD2, files: [{ path: 'c.txt', text: 'c\n' }], dates: { [HEAD2]: '2026-11-11T10:00:00Z' } }));
  assert.deepEqual(stamp(mine), { ref: 'origin/main', head: HEAD2, copied_at: '2026-11-13T00:00:00Z', files: ['b.txt', 'c.txt', 'src/a.txt'], complete: false });
  await run(mine, input({ head: HEAD2, files: [{ path: 'c.txt', text: 'c\n' }], dates: { [HEAD2]: '2026-11-11T10:00:00Z' }, complete: true }));
  assert.deepEqual(stamp(mine).files, ['c.txt']);
  assert.equal(stamp(mine).complete, true);
});

test('an unreadable earlier stamp is treated as none, and a retry with the same input writes the same bytes', async () => {
  const mine = myFiles();
  mine.stored.set('/source-copies/madeup/.source-copy.json', Buffer.from('not json'));
  await run(mine, input());
  assert.deepEqual(stamp(mine).files, ['b.txt', 'src/a.txt']);
  const before = new Map([...mine.stored].map(([name, bytes]) => [name, bytes.toString('utf8')]));
  await run(mine, input());
  assert.deepEqual(new Map([...mine.stored].map(([name, bytes]) => [name, bytes.toString('utf8')])), before);
});

test('a non-final run writes only its files: no dates and no stamp', async () => {
  const mine = myFiles();
  const done = await run(mine, input({ final: false }));
  assert.deepEqual(done, { root: 'madeup', head: HEAD, written: 2, bytes: mine.stored.get('/source-copies/madeup/src/a.txt').length + 2, final: false });
  assert.deepEqual(mine.calls, ['/source-copies/madeup/src/a.txt', '/source-copies/madeup/b.txt']);
  assert.equal(mine.stored.has('/source-copies/madeup/.source-copy.json'), false);
  assert.equal(mine.stored.has('/source-copies/madeup/.commit-dates.json'), false);
});

test('a final run lists the also_held paths in the stamp', async () => {
  const mine = myFiles();
  await run(mine, input({ final: false }));
  await run(mine, input({ files: [{ path: 'c.txt', text: 'c\n' }], also_held: ['src/a.txt', 'b.txt'], complete: true }));
  assert.deepEqual(stamp(mine).files, ['b.txt', 'c.txt', 'src/a.txt']);
  assert.equal(stamp(mine).head, HEAD);
});

test('a bad also_held path, a non-boolean final or too many paths is refused and nothing is written', async () => {
  for (const body of [input({ also_held: ['../x'] }), input({ also_held: ['/x'] }), input({ also_held: ['a//b'] }), input({ also_held: [3] }), input({ also_held: ['.source-copy.json'] }), input({ also_held: 'x' }), input({ final: 'no' }), input({ also_held: Array.from({ length: 257 }, (_, at) => `f${at}`) })]) {
    const mine = myFiles();
    await assert.rejects(run(mine, body), Error);
    assert.equal(mine.stored.size, 0);
  }
});

test('the same files sent twice at one head are kept once and answer both times', async () => {
  const mine = myFiles();
  const first = await run(mine, input());
  const writes = mine.calls.length;
  const again = await run(mine, input());
  assert.equal(mine.calls.length, writes, 'nothing is written the second time');
  assert.deepEqual({ ...again, bytes: 0 }, { ...first, bytes: 0 });
  assert.equal(again.bytes, 0);
  assert.deepEqual(stamp(mine).files, ['b.txt', 'src/a.txt']);
});

test('a file sent again with other text at the same head is kept', async () => {
  const mine = myFiles();
  await run(mine, input());
  await run(mine, input({ files: [{ path: 'b.txt', text: 'changed\n' }, { path: 'src/a.txt', text: 'first line\nthe store keeps rows in one file\n' }] }));
  assert.equal(mine.stored.get('/source-copies/madeup/b.txt').toString('utf8'), 'changed\n');
});
