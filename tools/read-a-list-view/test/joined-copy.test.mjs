// One file made from many rows (read-data/joined-copy.mjs), on a made-up bakery whose house rules are rows any of its
// AIs reads through the door, and whose kitchen app reads only a file at start. The door is the real one (door.mjs)
// over HTTP to a stand-in records door; the documents tools run through local_tools over a real folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDoor } from '../read-data/door.mjs';
import { writeJoinedCopy } from '../read-data/joined-copy.mjs';

const rule = (order, text) => ({ value: { order, text } });

async function bakery(rows) {
  const root = await mkdtemp(join(tmpdir(), 'joined-copy-'));
  const records = new Map(Object.entries(rows));
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      const { input } = call.params.arguments;
      const ids = [...records.keys()].filter(id => id.startsWith(input.prefix) && (!input.after || id > input.after)).sort();
      const shown = ids.slice(0, input.limit);
      const answer = { records: shown.map(id => ({ id, type: input.type, value: records.get(id) })), next: shown.length < ids.length ? shown.at(-1) : null };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { structuredContent: answer } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const door = await openDoor({ transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { keychain_item: 'made-up' } },
    records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list' },
    tools: { address: '@workshop-tools', run_method: 'tools:run' },
    local_tools: {
      'tool:read-documents-as-list-rows': { module: 'documents-as-list-rows/read-data/rows.mjs', export: 'readDocumentRows' },
      'tool:change-a-document-row': { module: 'documents-as-list-rows/read-data/rows.mjs', export: 'changeDocumentRows' },
    } }, { keyOf: async () => 'made-up-key' });
  const spec = { root, name: '/HOUSE.md', type: 'setting', prefixes: ['setting:rule:house-', 'setting:rule:all-'], text_at: 'value.text',
    order_at: 'value.order', header: '<!-- Made from the house rules; change the rows. -->', most_bytes: 400 };
  return { root, records, door, spec, file: () => readFile(join(root, 'HOUSE.md'), 'utf8'),
    done: async () => { server.close(); await rm(root, { recursive: true, force: true }); } };
}

test('the file is the header and every row of the prefixes in order, and a second run writes nothing', async () => {
  const b = await bakery({ 'setting:rule:house-ovens': rule(20, 'Ovens off at night.'), 'setting:rule:all-hands': rule(10, 'Wash hands.'),
    'setting:rule:other': rule(1, 'Not ours.') });
  try {
    const first = await writeJoinedCopy(b.spec, b.door);
    assert.deepEqual([first.rows, first.written], [2, true]);
    assert.equal(await b.file(), '<!-- Made from the house rules; change the rows. -->\n\nWash hands.\n\nOvens off at night.\n');
    const again = await writeJoinedCopy(b.spec, b.door);
    assert.equal(again.written, false);
    b.records.set('setting:rule:house-ovens', rule(20, 'Ovens off at ten.'));
    assert.equal((await writeJoinedCopy(b.spec, b.door)).written, true);
    assert.match(await b.file(), /Ovens off at ten\./);
  } finally { await b.done(); }
});

test('a copy over its budget, or with no rows, is refused and the file is left as it was', async () => {
  const b = await bakery({ 'setting:rule:house-long': rule(1, 'x'.repeat(500)) });
  try {
    await writeFile(join(b.root, 'HOUSE.md'), 'kept\n');
    await assert.rejects(writeJoinedCopy(b.spec, b.door), /more than its 400/);
    await assert.rejects(writeJoinedCopy({ ...b.spec, prefixes: ['setting:rule:none-'] }, b.door), /not written from nothing/);
    assert.equal(await b.file(), 'kept\n');
  } finally { await b.done(); }
});

test('a dry run writes nothing, and a bad spec is refused', async () => {
  const b = await bakery({ 'setting:rule:house-ovens': rule(1, 'Ovens off.') });
  try {
    const planned = await writeJoinedCopy({ ...b.spec, dry_run: true }, b.door);
    assert.deepEqual([planned.rows, planned.written], [1, false]);
    await assert.rejects(b.file());
    await assert.rejects(writeJoinedCopy({ ...b.spec, name: '../out.md' }, b.door), /name is the copy/);
    await assert.rejects(writeJoinedCopy({ ...b.spec, most_bytes: 0 }, b.door), /most_bytes/);
  } finally { await b.done(); }
});
