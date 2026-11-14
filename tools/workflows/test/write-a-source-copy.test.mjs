// tools/workflows: the source-copy writer puts a repository's files, commit dates and a stamp into the person's own
// files at /source-copies/<root>/, where the citation resolver reads them. The files door here is a made-up in-memory
// one; the folder the writer may write is derived from the resolver DATA (citation-resolvers.json), not listed again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveItem, RESOLVERS } from '../read-data/citation-resolvers.mjs';
import { writeASourceCopy } from '../read-data/write-a-source-copy.mjs';

const ROWS = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const HEAD = 'a1'.repeat(20);
const HEAD2 = 'b2'.repeat(20);

function filesDoor() {
  const stored = new Map();
  const uploads = new Map();
  const calls = [];
  const door = {
    stored, calls,
    files: async (method, input) => {
      if (method === 'find_file') {
        if (!stored.has(input.name_or_identity)) throw new Error('no such file');
        return { name: input.name_or_identity };
      }
      if (method === 'read_file') {
        const bytes = stored.get(input.name_or_identity);
        if (!bytes) throw new Error('no such file');
        const part = bytes.subarray(input.offset, input.offset + input.length);
        return { content: part.toString('utf8'), encoding: 'utf8', byte_length: bytes.length, bytes_returned: part.length };
      }
      if (method === 'write_file_start') { uploads.set(input.upload_id, { name: input.name, parts: [] }); return { next_offset: 0 }; }
      if (method === 'write_file_piece') { uploads.get(input.upload_id).parts.push(Buffer.from(input.content_base64, 'base64')); return {}; }
      if (method === 'write_file_finish') {
        const upload = uploads.get(input.upload_id);
        stored.set(upload.name, Buffer.concat(upload.parts));
        calls.push(upload.name);
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return door;
}

const input = (extra = {}) => ({ root: 'madeup', ref: 'origin/main', head: HEAD, files: [{ path: 'src/a.txt', text: 'first line\nthe store keeps rows in one file\n' }, { path: 'b.txt', text: 'x\n' }], dates: { [HEAD]: '2026-11-10T10:00:00Z' }, ...extra });
const run = (door, body, task = { request_key: 'k', at: '2026-11-13T00:00:00Z' }) => writeASourceCopy({ input: body, task }, { door });
const stamp = door => JSON.parse(door.stored.get('/source-copies/madeup/.source-copy.json').toString('utf8'));
const resolvers = { resolvers: RESOLVERS.resolvers.filter(row => row.kind !== 'row').map(row => ({ ...row, roots: { madeup: { sources: [{ files: '/source-copies/madeup' }] } } })) };
const named = kind => resolvers.resolvers.find(row => row.kind === kind).resolver;

test('the tool row writes only where the resolver reads', () => {
  const row = ROWS.find(item => item.id === 'tool:write-a-source-copy');
  const folders = RESOLVERS.resolvers.flatMap(entry => Object.values(entry.roots ?? {})).flatMap(root => root.sources ?? []).filter(source => source.files).map(source => source.files);
  assert.ok(folders.length > 0);
  const right = row.invoke.records.rights.find(item => typeof item.files === 'string');
  for (const folder of folders) assert.ok(`${folder}/`.startsWith(right.files), `${folder} is under the right ${right.files}`);
  assert.deepEqual(row.invoke.records.rights.filter(item => item.kind), [], 'no records kinds');
  assert.ok(row.invoke.records.rights.every(item => item.operations.every(op => /^(find_file|read_file|write_file_(start|piece|finish))$/.test(op))));
});

test('a written copy is read by the resolver: a file line and a commit', async () => {
  const door = filesDoor();
  assert.deepEqual(await run(door, input()), { root: 'madeup', head: HEAD, written: 2, bytes: door.stored.get('/source-copies/madeup/src/a.txt').length + 2 + door.stored.get('/source-copies/madeup/.commit-dates.json').length + door.stored.get('/source-copies/madeup/.source-copy.json').length });
  const line = await resolveItem({ resolver: named('file-line'), field: 'e', quote: 'q' }, { e: 'madeup/src/a.txt:2', q: 'keeps rows in one file' }, { resolvers, door });
  assert.deepEqual(line.map(one => one.ok), [true]);
  assert.match(line[0].against, new RegExp(HEAD));
  const missing = await resolveItem({ resolver: named('file-line'), field: 'e' }, { e: 'madeup/src/none.txt:1' }, { resolvers, door });
  assert.equal(missing[0].ok, null, 'a copy that is not complete cannot say a file is absent');
  const found = await resolveItem({ resolver: named('commit'), field: 'c', after: 'd' }, { c: `fixed in ${HEAD.slice(0, 12)}`, d: '2026-11-05T00:00:00Z' }, { resolvers, door });
  assert.deepEqual(found.map(one => one.ok), [true]);
});

test('the stamp is written last, after every file and the dates', async () => {
  const door = filesDoor();
  await run(door, input());
  assert.deepEqual(door.calls, ['/source-copies/madeup/src/a.txt', '/source-copies/madeup/b.txt', '/source-copies/madeup/.commit-dates.json', '/source-copies/madeup/.source-copy.json']);
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
    const door = filesDoor();
    await assert.rejects(run(door, body), Error);
    assert.equal(door.stored.size, 0);
  }
});

test('a later run with another head and fewer files keeps the earlier files in the stamp unless complete is true', async () => {
  const door = filesDoor();
  await run(door, input());
  await run(door, input({ head: HEAD2, files: [{ path: 'c.txt', text: 'c\n' }], dates: { [HEAD2]: '2026-11-11T10:00:00Z' } }));
  assert.deepEqual(stamp(door), { ref: 'origin/main', head: HEAD2, copied_at: '2026-11-13T00:00:00Z', files: ['b.txt', 'c.txt', 'src/a.txt'], complete: false });
  await run(door, input({ head: HEAD2, files: [{ path: 'c.txt', text: 'c\n' }], dates: { [HEAD2]: '2026-11-11T10:00:00Z' }, complete: true }));
  assert.deepEqual(stamp(door).files, ['c.txt']);
  assert.equal(stamp(door).complete, true);
});

test('an unreadable earlier stamp is treated as none, and a retry with the same input writes the same bytes', async () => {
  const door = filesDoor();
  door.stored.set('/source-copies/madeup/.source-copy.json', Buffer.from('not json'));
  await run(door, input());
  assert.deepEqual(stamp(door).files, ['b.txt', 'src/a.txt']);
  const before = new Map([...door.stored].map(([name, bytes]) => [name, bytes.toString('utf8')]));
  await run(door, input());
  assert.deepEqual(new Map([...door.stored].map(([name, bytes]) => [name, bytes.toString('utf8')])), before);
});
