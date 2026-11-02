// A list that is the original and a folder that is its copy (read-data/list-copy.mjs), on a made-up bakery's notes:
// the cooks' notes in a folder, and a list any of the bakery's AIs writes to. The door is the real one (door.mjs) over
// HTTP to a stand-in records door that keeps every version of a record with its time, as the person's door does
// (records:history); the documents tools run on this computer through local_tools over a real folder, the way a
// person's hook runs them. So each case is the whole road: a list row becomes a file, a file becomes rows, a change on
// one side reaches the other, a change on both keeps both, and a removal on either side reaches the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshRowSources } from '../read-data/list-view.mjs';
import { openDoor } from '../read-data/door.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const NAMES = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}' };
const TYPE = 'record:note';
const recordOf = name => `${TYPE}:documents~${encodeURIComponent(name)}`;
const KEY = 'made-up-key-for-the-bakery';

async function bakery({ partBytes = 4000, files = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'list-copy-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, 'notes', name.split('/')[0]), { recursive: true });
    await writeFile(join(root, 'notes', name), text);
  }
  const source = { source: 'documents', of: '/notes', match: '*/*.md', root, original: 'list', adopt_own_rows: true,
    copy_name: '{note.by}/{note.name}.md', content: { field: 'document.text', part_bytes: partBytes } };
  const records = new Map([['list:notes', { label: 'Notes', row_type: 'note', row_sources: [source] }]]);
  const versions = new Map();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const writes = [];
  const keep = (id, value) => {
    if (value === null) records.delete(id); else records.set(id, value);
    versions.set(id, [{ value, deleted: value === null, at: new Date(clock).toISOString() }, ...(versions.get(id) ?? [])]);
  };
  const answer = ({ method, input }) => {
    if (method === 'records:read') return { id: input.id, type: input.type, value: records.get(input.id) ?? null };
    if (method === 'records:history') return { versions: (versions.get(input.id) ?? []).slice(0, input.limit) };
    if (method === 'records:write') {
      writes.push(input.records);
      for (const row of input.records) keep(row.id, row.value);
      return { changed: true, write_count: input.records.length };
    }
    const prefix = input.prefix ?? `${input.type}:`;
    const ids = [...records.keys()].filter(id => id.startsWith(`${input.type}:`) && id.startsWith(prefix) && (!input.after || id > input.after)).sort();
    const shown = ids.slice(0, input.limit);
    return { records: shown.map(id => ({ id, type: input.type, value: records.get(id) })), next: shown.length < ids.length ? shown.at(-1) : null };
  };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { structuredContent: answer(call.params.arguments) } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const door = await openDoor({ transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { keychain_item: 'made-up' } },
    records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list', write_method: 'records:write', history_method: 'records:history' },
    tools: { address: '@workshop-tools', run_method: 'tools:run' },
    local_tools: {
      'tool:read-documents-as-list-rows': { module: 'documents-as-list-rows/read-data/rows.mjs', export: 'readDocumentRows', input: { root } },
      'tool:change-a-document-row': { module: 'documents-as-list-rows/read-data/rows.mjs', export: 'changeDocumentRows', input: { root } },
    } }, { keyOf: async () => KEY });
  const sync = extra => refreshRowSources({ names: NAMES, list: 'notes', ...extra }, door).then(found => found.sources[0]);
  const file = name => readFile(join(root, 'notes', name), 'utf8');
  const rowsOf = name => [...records.entries()].filter(([id, value]) => id.startsWith(TYPE) && value['document.parent'] === `/notes/${name}`)
    .sort(([, x], [, y]) => x['document.part'] - y['document.part']);
  // What any AI writes into the list: a new version of a row, at the stand-in door's clock.
  const edit = (name, change) => { const id = recordOf(`/notes/${name}`); keep(id, change({ ...records.get(id) })); };
  return { root, records, versions, writes, door, sync, file, rowsOf, edit, keep, setClock: ms => { clock = ms; },
    done: async () => { server.close(); await rm(root, { recursive: true, force: true }); } };
}

const NOTE = (name, words) => `---\nname: ${name}\ndescription: ${words}\n---\n\n${words}\n`;
const textOf = rows => rows.map(([, value]) => value['document.text']).join('');

test('a folder that has never been read reaches the list, and a second run writes nothing', async () => {
  const b = await bakery({ files: { 'ada/rye.md': NOTE('rye', 'Rye wants a long proof.'), 'bo/oven.md': NOTE('oven', 'The left oven runs hot.') } });
  try {
    const first = await b.sync();
    assert.equal(first.pushed, 2);
    assert.equal(textOf(b.rowsOf('ada/rye.md')), NOTE('rye', 'Rye wants a long proof.'));
    const writes = b.writes.length;
    const again = await b.sync();
    assert.deepEqual([again.unchanged, again.pushed, again.pulled, b.writes.length], [2, 0, 0, writes]);
  } finally { await b.done(); }
});

test('a row written by any AI under its own id becomes a file named from its values, and then one row', async () => {
  const b = await bakery({ files: { 'ada/rye.md': NOTE('rye', 'Rye wants a long proof.') } });
  try {
    await b.sync();
    b.keep(`${TYPE}:from-a-web-chat-1`, { 'note.name': 'Flour order', 'note.by': 'web-chat', 'note.description': 'When flour is ordered', 'document.text': 'Order flour on Mondays.\n' });
    const run = await b.sync();
    assert.equal(run.adopted, 1);
    const made = await b.file('web-chat/flour-order.md');
    assert.match(made, /^---\nname: Flour order\n/);
    assert.match(made, /description: When flour is ordered/);
    assert.match(made, /Order flour on Mondays\./);
    assert.equal(b.records.has(`${TYPE}:from-a-web-chat-1`), false, 'the AI\'s own id is replaced by the file\'s row');
    assert.equal(b.rowsOf('web-chat/flour-order.md').length, 1);
    const again = await b.sync();
    assert.deepEqual([again.adopted, again.pulled, again.pushed], [0, 0, 0]);
  } finally { await b.done(); }
});

test('a row another sync already made into its file is adopted into that file, never a second copy', async () => {
  // Two syncs at once (a turn's end and a commit's): the other one wrote this row's file a moment ago and this one
  // still holds the row the AI wrote. The file is exactly that row's values and text.
  const b = await bakery({ files: { 'phone/yeast.md': '---\nname: Yeast\nby: phone\n---\nKeep the yeast cold.\n' } });
  try {
    b.keep(`${TYPE}:from-a-phone`, { 'note.name': 'Yeast', 'note.by': 'phone', 'document.text': 'Keep the yeast cold.\n' });
    const run = await b.sync();
    assert.deepEqual([run.adopted, run.refused], [1, []]);
    await assert.rejects(stat(join(b.root, 'notes/phone/yeast-2.md')), 'no second copy');
    assert.equal(b.records.has(`${TYPE}:from-a-phone`), false);
    assert.equal(b.rowsOf('phone/yeast.md').length, 1);
    // A different memory under the same name is a different document: it gets the next name.
    b.keep(`${TYPE}:from-a-phone-2`, { 'note.name': 'Yeast', 'note.by': 'phone', 'document.text': 'Buy more yeast.\n' });
    await b.sync();
    assert.match(await b.file('phone/yeast-2.md'), /Buy more yeast\./);
  } finally { await b.done(); }
});

test('a row that cannot be named a file stays in the list and is named in the answer; a taken name gets the next', async () => {
  const b = await bakery({ files: { 'web-chat/sugar.md': NOTE('sugar', 'Sugar is fine.') } });
  try {
    await b.sync();
    b.keep(`${TYPE}:no-author`, { 'note.name': 'Salt', 'document.text': 'Salt is low.\n' });
    b.keep(`${TYPE}:same-name`, { 'note.name': 'Sugar', 'note.by': 'web-chat', 'document.text': 'Sugar is low.\n' });
    const run = await b.sync();
    assert.equal(run.adopted, 1);
    assert.match(run.refused[0].because, /no note\.by/);
    assert.equal(b.records.has(`${TYPE}:no-author`), true);
    assert.equal(await b.file('web-chat/sugar.md'), NOTE('sugar', 'Sugar is fine.'), 'an existing file is never overwritten');
    assert.match(await b.file('web-chat/sugar-2.md'), /Sugar is low\./);
  } finally { await b.done(); }
});

test('a list edit of one part of a long document reaches the file; a file edit reaches the list', async () => {
  const long = NOTE('ledger', 'Ledger.') + 'line of flour accounts\n'.repeat(60);
  const b = await bakery({ partBytes: 400, files: { 'ada/ledger.md': long } });
  try {
    await b.sync();
    const parts = b.rowsOf('ada/ledger.md');
    assert.ok(parts.length > 2);
    const [second, value] = parts[1];
    b.keep(second, { ...value, 'document.text': value['document.text'].replace('flour', 'RYE') });
    const pulled = await b.sync();
    assert.equal(pulled.pulled, 1);
    const now = await b.file('ada/ledger.md');
    assert.equal((now.match(/RYE/g) ?? []).length, 1);
    assert.equal(now.length, long.length - 'flour'.length + 'RYE'.length);
    assert.equal(b.rowsOf('ada/ledger.md')[0][1]['file.identity'], makeHashCodeHexFromBytes(Buffer.from(now)));
    await writeFile(join(b.root, 'notes/ada/ledger.md'), `${now}one more line\n`);
    const pushed = await b.sync();
    assert.equal(pushed.pushed, 1);
    assert.equal(textOf(b.rowsOf('ada/ledger.md')), `${now}one more line\n`);
  } finally { await b.done(); }
});

test('both sides changed: the later change wins and the other is the row\'s previous version', async () => {
  const b = await bakery({ files: { 'ada/rye.md': NOTE('rye', 'Rye wants a long proof.') } });
  try {
    await b.sync();
    const id = recordOf('/notes/ada/rye.md');
    // The file changes first (its time an hour back), then an AI changes the list.
    await writeFile(join(b.root, 'notes/ada/rye.md'), NOTE('rye', 'Rye wants a cold proof.'));
    const hourAgo = new Date(Date.now() - 3600_000);
    await utimes(join(b.root, 'notes/ada/rye.md'), hourAgo, hourAgo);
    b.setClock(Date.now());
    b.edit('ada/rye.md', value => ({ ...value, 'document.text': NOTE('rye', 'Rye wants a warm proof.') }));
    const run = await b.sync();
    assert.equal(run.conflicts[0].kept, 'list');
    assert.equal(await b.file('ada/rye.md'), NOTE('rye', 'Rye wants a warm proof.'));
    const history = b.versions.get(id).map(version => version.value?.['document.text']);
    assert.ok(history.includes(NOTE('rye', 'Rye wants a cold proof.')), 'the file\'s text is kept as a version');
    // Now the list changes first (an hour back) and the file after: the file wins.
    b.setClock(Date.now() - 3600_000);
    b.edit('ada/rye.md', value => ({ ...value, 'document.text': NOTE('rye', 'list words') }));
    await writeFile(join(b.root, 'notes/ada/rye.md'), NOTE('rye', 'file words'));
    const second = await b.sync();
    assert.equal(second.conflicts[0].kept, 'file');
    assert.equal(b.records.get(id)['document.text'], NOTE('rye', 'file words'));
    assert.ok(b.versions.get(id).some(version => version.value?.['document.text'] === NOTE('rye', 'list words')));
  } finally { await b.done(); }
});

test('a removal on either side reaches the other; a file changed after the list removed it comes back', async () => {
  const b = await bakery({ files: { 'ada/rye.md': NOTE('rye', 'one'), 'bo/oven.md': NOTE('oven', 'two'), 'bo/tray.md': NOTE('tray', 'three') } });
  try {
    await b.sync();
    await unlink(join(b.root, 'notes/ada/rye.md'));
    b.keep(recordOf('/notes/bo/oven.md'), null);
    b.keep(recordOf('/notes/bo/tray.md'), null);
    await writeFile(join(b.root, 'notes/bo/tray.md'), NOTE('tray', 'changed after the list removed it'));
    const run = await b.sync();
    assert.deepEqual([run.removed_rows, run.removed_files], [1, 1]);
    assert.equal(b.rowsOf('ada/rye.md').length, 0);
    await assert.rejects(stat(join(b.root, 'notes/bo/oven.md')));
    assert.equal(await b.file('bo/tray.md'), NOTE('tray', 'changed after the list removed it'));
    assert.equal(b.rowsOf('bo/tray.md').length, 1);
  } finally { await b.done(); }
});

test('a value only the list changed goes into the frontmatter, and a field the list added stays on the row', async () => {
  const b = await bakery({ files: { 'ada/rye.md': NOTE('rye', 'Rye wants a long proof.') } });
  try {
    await b.sync();
    b.edit('ada/rye.md', value => ({ ...value, 'note.description': 'Proofing rye', seen_by: 'phone' }));
    const run = await b.sync();
    assert.equal(run.pulled, 1);
    assert.match(await b.file('ada/rye.md'), /description: Proofing rye/);
    const [[, row]] = b.rowsOf('ada/rye.md');
    assert.equal(row.seen_by, 'phone');
    assert.equal(row['note.description'], 'Proofing rye');
  } finally { await b.done(); }
});

test('paths settles only the named document, and a dry run writes nothing', async () => {
  const b = await bakery({ files: { 'ada/rye.md': NOTE('rye', 'one'), 'bo/oven.md': NOTE('oven', 'two') } });
  try {
    const planned = await b.sync({ dry_run: true });
    assert.deepEqual(planned.planned.map(one => one.action), ['push', 'push']);
    assert.equal(b.writes.length, 0);
    const one = await b.sync({ paths: ['/notes/bo/oven.md'] });
    assert.equal(one.documents, 1);
    assert.equal(b.rowsOf('ada/rye.md').length, 0);
    assert.equal(b.rowsOf('bo/oven.md').length, 1);
    await assert.rejects(refreshRowSources({ names: NAMES, list: 'notes', paths: ['relative.md'] }, b.door), /paths is a nonempty array/);
  } finally { await b.done(); }
});
