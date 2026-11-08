// A list that is the original and a folder that is its copy (read-data/list-copy.mjs), on a made-up bakery's notes:
// the cooks' notes in a folder, and a list any of the bakery's AIs writes to. The door is the real one (door.mjs) over
// HTTP to a stand-in records door that keeps every version of a record with its time, as the person's door does
// (records:history); the documents tools run on this computer through local_tools over a real folder, the way a
// person's hook runs them. So each case is the whole road: a list row becomes a file, a file becomes rows, a change on
// one side reaches the other, a change on both keeps both, and a removal on either side reaches the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { refreshRowSources } from '../read-data/list-view.mjs';
import { openDoor } from '../read-data/door.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const NAMES = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}' };
const TYPE = 'record:note';
const recordOf = name => `${TYPE}:documents~${encodeURIComponent(name)}`;
const KEY = 'made-up-key-for-the-bakery';

async function bakery({ partBytes = 4000, files = {}, rowRecords, sourceChanges = {}, nestedRuntimeRoot = false, writeResponse } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'list-copy-'));
  const localRoot = nestedRuntimeRoot ? join(root, 'host-owner') : root;
  await mkdir(localRoot, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, 'notes', name.split('/')[0]), { recursive: true });
    await writeFile(join(root, 'notes', name), text);
  }
  const source = { source: 'documents', of: '/notes', match: '*/*.md', root, original: 'list', adopt_own_rows: true,
    copy_name: '{note.by}/{note.name}.md', content: { field: 'document.text', part_bytes: partBytes }, ...sourceChanges };
  const records = new Map([['list:notes', { label: 'Notes', row_type: 'note', row_sources: [source], ...(rowRecords ? { row_records: rowRecords } : {}) }]]);
  const versions = new Map();
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const writes = [];
  const keep = (id, value) => {
    if (value === null) records.delete(id); else records.set(id, value);
    versions.set(id, [{ value, deleted: value === null, at: new Date(clock).toISOString() }, ...(versions.get(id) ?? [])]);
  };
  const answer = ({ method, input, request_key }) => {
    if (method === 'records:read') return { id: input.id, type: input.type, value: records.get(input.id) ?? null };
    if (method === 'records:history') return { versions: (versions.get(input.id) ?? []).slice(0, input.limit) };
    if (method === 'records:write') {
      writes.push(input.records);
      const overridden = writeResponse?.({ input, request_key });
      if (overridden) return overridden;
      if (input.records.some(row => Object.hasOwn(row, 'expected') && (row.expected === null ? records.has(row.id)
        : row.expected.type !== row.type || !isDeepStrictEqual(row.expected.value, records.get(row.id))))) {
        return { isError: true, structuredContent: { code: 'original_command_conflict', outcome: 'not_started' } };
      }
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
      const value = answer(call.params.arguments);
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: value.isError ? value : { structuredContent: value } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const door = await openDoor({ transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { keychain_item: 'made-up' } },
    records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list', write_method: 'records:write', history_method: 'records:history' },
    tools: { address: '@workshop-tools', run_method: 'tools:run' },
    local_tools: {
      'tool:read-documents-as-list-rows': { module: 'documents-as-list-rows/read-data/rows.mjs', export: 'readDocumentRows', input: { root: localRoot } },
      'tool:change-a-document-row': { module: 'documents-as-list-rows/read-data/rows.mjs', export: 'changeDocumentRows', input: { root: localRoot } },
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

const sourcePart = (name, text, part, parts, identity) => ({ id: `${name}#${part}`, values: {
  'document.parent': name, 'document.text': text, 'document.part': part, 'document.parts': parts,
  'file.identity': identity,
} });
const answerSource = (b, pages) => {
  const run = b.door.run;
  b.door.run = async (tool, input) => tool === 'tool:read-documents-as-list-rows'
    ? { result: { rows: pages[input.after ? Number(input.after) : 0],
      next: (input.after ? Number(input.after) : 0) + 1 < pages.length ? String((input.after ? Number(input.after) : 0) + 1) : null } }
    : run(tool, input);
};

test('a source part cannot take an original record id owned by a different document and then delete it', async () => {
  for (const partId of ['/b.json', 'opaque-record-key']) {
    const b = await bakery({ sourceChanges: { require_atomic: true, adopt_own_rows: false } });
    try {
      const old = { ...sourcePart('/b.json', 'KEEP-B', 1, 1,
        makeHashCodeHexFromBytes(new TextEncoder().encode('KEEP-B'))), id: partId };
      const incoming = { ...sourcePart('/a.json', 'SOURCE-A', 1, 1,
        makeHashCodeHexFromBytes(new TextEncoder().encode('SOURCE-A'))), id: partId };
      b.keep(recordOf(partId), structuredClone(old.values));
      answerSource(b, [[incoming]]);
      const run = b.door.run;
      let fileChanges = 0;
      b.door.run = async (tool, input) => {
        if (tool === 'tool:change-a-document-row') fileChanges += 1;
        return run(tool, input);
      };
      const report = await b.sync();
      assert.equal(report.refused.length, 1, partId);
      assert.deepEqual([report.pushed, report.pulled, report.removed_rows, report.removed_files, report.adopted], [0, 0, 0, 0, 0]);
      assert.equal(b.writes.length, 0);
      assert.equal(fileChanges, 0);
      assert.deepEqual(b.records.get(recordOf(partId)), old.values);
    } finally { await b.done(); }
  }
});

test('an opaque part id can update its existing document without changing ownership', async () => {
  const b = await bakery({ sourceChanges: { require_atomic: true, adopt_own_rows: false } });
  try {
    const old = { ...sourcePart('/b.json', 'KEEP-B', 1, 1,
      makeHashCodeHexFromBytes(new TextEncoder().encode('KEEP-B'))), id: 'opaque-record-key' };
    const incoming = { ...sourcePart('/b.json', 'SOURCE-B', 1, 1,
      makeHashCodeHexFromBytes(new TextEncoder().encode('SOURCE-B'))), id: old.id };
    b.keep(recordOf(old.id), structuredClone(old.values));
    answerSource(b, [[incoming]]);
    const report = await b.sync();
    assert.equal(report.refused.length, 0);
    assert.deepEqual([report.pushed, report.removed_rows], [1, 0]);
    assert.deepEqual(b.records.get(recordOf(old.id))['document.text'], 'SOURCE-B');
    assert.deepEqual(b.writes[0][0].expected, { type: TYPE, value: old.values });
  } finally { await b.done(); }
});

test('an adoption readback cannot take a part id reserved by an existing original', async () => {
  const b = await bakery();
  try {
    const old = { ...sourcePart('/b.json', 'KEEP-B', 1, 1,
      makeHashCodeHexFromBytes(new TextEncoder().encode('KEEP-B'))), id: 'opaque-record-key' };
    b.keep(recordOf(old.id), structuredClone(old.values));
    const ownId = `${TYPE}:from-a-chat`, own = { 'note.by': 'bo', 'note.name': 'new', 'document.text': 'New adopted text' };
    b.keep(ownId, structuredClone(own));
    const run = b.door.run;
    b.door.run = async (tool, input) => {
      if (tool === 'tool:read-documents-as-list-rows') return { result: { rows: input.paths
        ? [{ ...sourcePart(input.paths[0], own['document.text'], 1, 1, 'new-generation'), id: old.id }]
        : [old], next: null } };
      return run(tool, input);
    };
    const report = await b.sync();
    assert.equal(report.refused.length, 1);
    assert.deepEqual([report.adopted, report.removed_rows], [0, 0]);
    assert.equal(b.writes.length, 0);
    assert.deepEqual(b.records.get(recordOf(old.id)), old.values);
    assert.deepEqual(b.records.get(ownId), own);
  } finally { await b.done(); }
});

test('an incomplete folder multipart document retains both valid original rows without any effects', async () => {
  const name = 'ada/ledger.md', path = `/notes/${name}`, identity = makeHashCodeHexFromBytes(new TextEncoder().encode('AB'));
  const b = await bakery({ files: { [name]: 'AB' }, sourceChanges: { adopt_own_rows: false } });
  try {
    const originals = [sourcePart(path, 'A', 1, 2, identity), sourcePart(path, 'B', 2, 2, identity)];
    for (const row of originals) b.keep(recordOf(row.id), structuredClone(row.values));
    answerSource(b, [[originals[0]]]);
    const report = await b.sync();
    assert.equal(report.refused.length, 1);
    assert.deepEqual([report.pushed, report.pulled, report.removed_rows, report.removed_files, report.adopted], [0, 0, 0, 0, 0]);
    assert.equal(b.writes.length, 0);
    for (const row of originals) assert.deepEqual(b.records.get(recordOf(row.id)), row.values);
    assert.equal(await b.file(name), 'AB');
  } finally { await b.done(); }
});

test('a complete-count folder document with mixed generations never creates list rows', async () => {
  const name = 'ada/ledger.md', path = `/notes/${name}`;
  const b = await bakery({ files: { [name]: 'Keep the file' }, sourceChanges: { adopt_own_rows: false } });
  try {
    answerSource(b, [[sourcePart(path, 'OLD-', 1, 2, 'generation-A'), sourcePart(path, 'NEW', 2, 2, 'generation-B')]]);
    const report = await b.sync();
    assert.equal(report.refused.length, 1);
    assert.deepEqual([report.pushed, report.pulled, report.removed_rows, report.removed_files, report.adopted], [0, 0, 0, 0, 0]);
    assert.equal(b.writes.length, 0);
    assert.equal(b.rowsOf(name).length, 0);
    assert.equal(await b.file(name), 'Keep the file');
  } finally { await b.done(); }
});

test('identifiable invalid folder frames retain originals, including duplicate parts on a later page', async () => {
  const name = 'ada/ledger.md', path = `/notes/${name}`, identity = makeHashCodeHexFromBytes(new TextEncoder().encode('AB'));
  const originals = [sourcePart(path, 'A', 1, 2, identity), sourcePart(path, 'B', 2, 2, identity)];
  const cases = {
    'late duplicate': [[...originals], [originals[0]]],
    'inconsistent counts': [[originals[0], { ...originals[1], values: { ...originals[1].values, 'document.parts': 3 } }]],
    'zero count': [[{ ...originals[0], values: { ...originals[0].values, 'document.parts': 0 } }]],
    'invalid index': [[{ ...originals[0], values: { ...originals[0].values, 'document.part': 0 } }, originals[1]]],
    'missing text': [[originals[0], { ...originals[1], values: { ...originals[1].values, 'document.text': null } }]],
    'missing identity': [[...originals.map(row => ({ ...row, values: { ...row.values, 'file.identity': undefined } }))]],
  };
  for (const [label, pages] of Object.entries(cases)) {
    const b = await bakery({ files: { [name]: 'AB' } });
    try {
      for (const row of originals) b.keep(recordOf(row.id), structuredClone(row.values));
      const absent = sourcePart('/notes/bo/missing.md', 'C', 1, 1, makeHashCodeHexFromBytes(new TextEncoder().encode('C')));
      b.keep(recordOf(absent.id), structuredClone(absent.values));
      const ownId = `${TYPE}:new-own-row`, own = { 'note.by': 'bo', 'note.name': 'new', 'document.text': 'Adopt me' };
      b.keep(ownId, structuredClone(own));
      answerSource(b, [[sourcePart('/notes/co/new.md', 'NEW', 1, 1, 'new-generation')], ...pages]);
      const report = await b.sync();
      assert.equal(report.refused.length, 1, label);
      assert.deepEqual([report.pushed, report.pulled, report.removed_rows, report.removed_files, report.adopted], [0, 0, 0, 0, 0], label);
      assert.equal(b.writes.length, 0, label);
      for (const row of originals) assert.deepEqual(b.records.get(recordOf(row.id)), row.values, label);
      assert.deepEqual(b.records.get(recordOf(absent.id)), absent.values, label);
      assert.deepEqual(b.records.get(ownId), own, label);
      await assert.rejects(stat(join(b.root, 'notes/bo/new.md')), { code: 'ENOENT' });
      assert.equal(await b.file(name), 'AB', label);
    } finally { await b.done(); }
  }
});

test('an unidentifiable source frame refuses the whole read before any earlier complete document has effects', async () => {
  const name = 'ada/ledger.md', path = `/notes/${name}`, identity = makeHashCodeHexFromBytes(new TextEncoder().encode('AB'));
  const originals = [sourcePart(path, 'A', 1, 2, identity), sourcePart(path, 'B', 2, 2, identity)];
  const malformed = [
    { ...originals[0], values: { ...originals[0].values, 'document.parent': undefined } },
    { ...originals[0], values: { ...originals[0].values, 'document.parent': undefined, 'document.parts': undefined,
      'document.part': undefined, 'file.identity': undefined } },
    { ...originals[0], values: { ...originals[0].values, 'document.parent': '' } },
    { ...originals[0], values: { ...originals[0].values, 'document.parent': null } },
    { ...originals[0], id: '/notes/bo/new.md#1' },
    { ...originals[0], id: '' },
  ];
  for (const row of malformed) {
    const b = await bakery({ files: { [name]: 'AB' }, sourceChanges: { adopt_own_rows: false } });
    try {
      for (const original of originals) b.keep(recordOf(original.id), structuredClone(original.values));
      const earlier = sourcePart('/notes/bo/new.md', 'NEW', 1, 1, 'new-generation');
      answerSource(b, [[earlier], [row]]);
      await assert.rejects(b.sync(), error => error.code === 'source_unanswered');
      assert.equal(b.writes.length, 0);
      for (const original of originals) assert.deepEqual(b.records.get(recordOf(original.id)), original.values);
      assert.equal(await b.file(name), 'AB');
    } finally { await b.done(); }
  }
});

test('an empty or mixed-generation publication readback retains originals and never completes adoption', async () => {
  for (const adopting of [false, true]) for (const mixed of [false, true]) {
    const name = 'ada/ledger.md';
    const b = await bakery({ files: { [name]: 'Original file' } });
    try {
      await b.sync();
      const id = adopting ? `${TYPE}:from-a-chat` : recordOf(`/notes/${name}`);
      if (adopting) b.keep(id, { 'note.by': 'bo', 'note.name': 'new', 'document.text': 'New adopted text' });
      else b.edit(name, value => ({ ...value, 'document.text': 'Edited original' }));
      const original = structuredClone(b.records.get(id)), before = b.writes.length, run = b.door.run;
      b.door.run = async (tool, input) => {
        if (tool === 'tool:read-documents-as-list-rows' && input.paths) {
          const path = input.paths[0];
          return { result: { rows: mixed ? [sourcePart(path, 'OLD-', 1, 2, 'generation-A'),
            sourcePart(path, 'NEW', 2, 2, 'generation-B')] : [], next: null } };
        }
        return run(tool, input);
      };
      const report = await b.sync();
      assert.equal(report.refused.length, 1);
      assert.deepEqual([report.pulled, report.adopted, report.removed_rows], [0, 0, 0]);
      assert.equal(b.writes.length, before);
      assert.deepEqual(b.records.get(id), original);
    } finally { await b.done(); }
  }
});

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

test('a complete registry original uses its runtime root and preserves opaque keys and unknown declarations', async () => {
  const original = { about: 'Synthetic engine declarations', unknown: { keep: ['complete', 'shape'] },
    capabilities: [{ id: 'keep-files', capability: 'Keep a Namespace', entry: 'src/namespace.rs',
      owner: ['src/namespace.rs', 'src/namespace'], protocol_literals: ['unchanged-protocol'] }] };
  const name = 'engine/capabilities.json';
  const b = await bakery({ nestedRuntimeRoot: true, files: { [name]: `${JSON.stringify(original, null, 2)}\n` },
    sourceChanges: { root: '..', match: '*/*.json', paths: [`/notes/${name}`], text_extensions: ['json'], adopt_own_rows: false } });
  try {
    assert.deepEqual((await b.door.run('tool:read-documents-as-list-rows')).result.rows, [], 'omitted input retains the local default root');
    const first = await b.sync();
    assert.equal(first.pushed, 1, JSON.stringify(first));
    const id = recordOf(`/notes/${name}`);
    const changed = structuredClone(original);
    Object.assign(changed.capabilities[0], { capability: 'Keep account files', entry: 'src/account_files/mod.rs',
      owner: ['src/account_files/mod.rs', 'src/account_files'] });
    b.edit(name, row => ({ ...row, 'document.text': `${JSON.stringify(changed, null, 2)}\n` }));
    const pulled = await b.sync();
    assert.equal(pulled.pulled, 1, JSON.stringify(pulled));
    assert.deepEqual(JSON.parse(await b.file(name)), changed);
    assert.deepEqual(b.rowsOf(name).map(([rowId]) => rowId), [id], 'the complete original retains its existing record');
    assert.equal(JSON.parse(await b.file(name)).capabilities[0].id, 'keep-files');
    assert.equal((await b.sync()).unchanged, 1);

    const latest = structuredClone(changed);
    latest.capabilities[0].entry = 'src/account_files/entry.rs';
    b.edit(name, row => ({ ...row, 'document.text': `${JSON.stringify(latest, null, 2)}\n` }));
    const concurrent = { ...changed, unknown: { keep: ['another writer'] } };
    const run = b.door.run;
    let arrived = false;
    b.door.run = async (tool, input) => {
      if (!arrived && tool === 'tool:change-a-document-row') {
        arrived = true;
        await writeFile(join(b.root, 'notes', name), `${JSON.stringify(concurrent, null, 2)}\n`);
      }
      return run(tool, input);
    };
    const refused = await b.sync();
    assert.equal(arrived, true);
    assert.equal(refused.refused.length, 1, 'the real document owner refuses the stale source identity');
    assert.deepEqual(JSON.parse(await b.file(name)), concurrent, 'the competing file bytes survive');
    assert.equal(JSON.parse(b.records.get(id)['document.text']).capabilities[0].entry, latest.capabilities[0].entry,
      'the list original is retained when its file write was refused');
  } finally { await b.done(); }
});

test('a relative local source refuses an unresolved runtime base before reading a folder', async () => {
  const door = await openDoor({ transport: { url: 'http://127.0.0.1:9/mcp', credential: { keychain_item: 'synthetic' } },
    records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list' },
    tools: { address: '@workshop-tools', run_method: 'tools:run' },
    local_tools: { 'tool:read-documents-as-list-rows': { module: 'documents-as-list-rows/read-data/rows.mjs',
      export: 'readDocumentRows', input: { root: '.' } } } }, { keyOf: async () => KEY });
  await assert.rejects(door.run('tool:read-documents-as-list-rows', { root: '../elsewhere' }),
    error => error.code === 'bad_config' && /resolved absolute default root/.test(error.message));
});

test('a declared description content field belongs to the copy and never restores stale source text', async () => {
  const name = 'engine/capabilities.json';
  const old = '{"entry":"src/old.rs","unknown":{"keep":true}}\n';
  const next = '{"entry":"src/new.rs","unknown":{"keep":true}}\n';
  const b = await bakery({ files: { [name]: old }, sourceChanges: { match: '*/*.json',
    paths: [`/notes/${name}`], text_extensions: ['json'], adopt_own_rows: false,
    content: { field: 'description', part_bytes: 4000 } } });
  try {
    await b.sync();
    const id = recordOf(`/notes/${name}`);
    assert.equal(b.records.get(id).description, old);
    await writeFile(join(b.root, 'notes', name), next);
    await b.sync();
    assert.equal(b.records.get(id).description, next, 'fresh source content must not be overlaid by list metadata');
    await b.sync();
    assert.equal(await b.file(name), next, 'another refresh cannot restore stale source bytes');
  } finally { await b.done(); }
});

test('a relative source refuses nonexistent and symlink runtime bases instead of manufacturing authority', async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-root-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'target'));
  await mkdir(join(root, 'actual-base'));
  await writeFile(join(root, 'target', 'capabilities.json'), '{"must_not_be_read":true}\n');
  await symlink(join(root, 'actual-base'), join(root, 'linked-base'));
  for (const base of [join(root, 'not-existing'), join(root, 'linked-base')]) {
    const door = await openDoor({ transport: { url: 'http://127.0.0.1:9/mcp', credential: { keychain_item: 'synthetic' } },
      records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list' },
      tools: { address: '@workshop-tools', run_method: 'tools:run' },
      local_tools: { 'tool:read-documents-as-list-rows': { module: 'documents-as-list-rows/read-data/rows.mjs',
        export: 'readDocumentRows', input: { root: base } } } }, { keyOf: async () => KEY });
    await assert.rejects(door.run('tool:read-documents-as-list-rows', { root: '../target', paths: ['/capabilities.json'],
      text_extensions: ['json'], content: true }), error => error.code === 'bad_config' && /existing canonical/.test(error.message));
  }
});

test('a concurrent destination edit refuses a list-copy push with the original exact expected value', async () => {
  const name = 'ada/ledger.md';
  const b = await bakery({ files: { [name]: 'Old file\n' } });
  try {
    await b.sync();
    const id = recordOf(`/notes/${name}`);
    const previous = structuredClone(b.records.get(id));
    await writeFile(join(b.root, 'notes', name), 'New file\n');
    const competing = { ...previous, 'document.text': 'Independent list edit\n', peer: 'retain' };
    const write = b.door.write;
    let expectedSeen;
    let arrived = false;
    b.door.write = async (rows, options) => {
      if (!arrived && rows.some(row => row.id === id)) {
        arrived = true;
        expectedSeen = rows.find(row => row.id === id).expected;
        b.keep(id, competing);
      }
      return write(rows, options);
    };
    const report = await b.sync();
    assert.equal(arrived, true);
    assert.deepEqual(expectedSeen, { type: TYPE, value: previous });
    assert.deepEqual(b.records.get(id), competing);
    assert.equal(report.refused.length, 1);
    assert.equal(report.pushed, 0);
  } finally { await b.done(); }
});

test('a strict original with Library content fields retains edits and refuses unsupported file effects', async () => {
  const name = 'engine/capabilities.json', original = '{"entry":"src/old.rs"}\n';
  const b = await bakery({ nestedRuntimeRoot: true, files: { [name]: original }, sourceChanges: {
    root: '..', paths: [`/notes/${name}`], match: '*/*.json', text_extensions: ['json'], original: 'list',
    require_atomic: true, adopt_own_rows: false, content: { field: 'description', part_bytes: 4000 } } });
  try {
    assert.equal((await b.sync()).pushed, 1, 'reading into a fresh original has only guarded record effects');
    const id = recordOf(`/notes/${name}`);
    b.keep(id, { ...b.records.get(id), description: '{"entry":"src/new.rs"}\n' });
    const refused = await b.sync();
    assert.equal(refused.refused.length, 1);
    assert.match(refused.refused[0].because, /cannot provide atomic confined publication/);
    assert.equal(refused.pulled, 0);
    assert.equal(await b.file(name), original);
    assert.equal(b.records.get(id).description, '{"entry":"src/new.rs"}\n');

    await unlink(join(b.root, 'notes', name));
    const missing = await b.sync();
    assert.equal(missing.refused.length, 1);
    assert.equal(missing.pulled, 0);
    await assert.rejects(b.file(name), error => error.code === 'ENOENT');

    await writeFile(join(b.root, 'notes', name), original);
    b.keep(id, null);
    const removal = await b.sync();
    assert.equal(removal.refused.length, 1);
    assert.equal(removal.removed_files, 0);
    assert.equal(await b.file(name), original);
    assert.equal(b.records.has(id), false, 'a refused file publication does not reverse the original list deletion');
  } finally { await b.done(); }
});

test('list-copy creation and removal fence competing destination changes without reporting success', async () => {
  for (const removing of [false, true]) {
    const name = 'ada/ledger.md';
    const b = await bakery({ files: { [name]: 'Source file\n' } });
    try {
      if (removing) await b.sync();
      const id = recordOf(`/notes/${name}`);
      const previous = b.records.get(id) ? structuredClone(b.records.get(id)) : null;
      if (removing) await unlink(join(b.root, 'notes', name));
      const competing = { ...(previous ?? {}), 'document.text': 'Keep the competing row\n', peer: true };
      const write = b.door.write;
      let attempted = false;
      b.door.write = async (rows, options) => {
        if (!attempted && rows.some(row => row.id === id)) {
          attempted = true;
          assert.deepEqual(rows.find(row => row.id === id).expected, removing ? { type: TYPE, value: previous } : null);
          b.keep(id, competing);
        }
        return write(rows, options);
      };
      const report = await b.sync();
      assert.equal(attempted, true);
      assert.deepEqual(b.records.get(id), competing);
      assert.equal(report.refused.length, 1);
      assert.equal(report.pushed, 0);
      assert.equal(report.removed_rows, 0);
    } finally { await b.done(); }
  }
});

test('a multipart original with mixed source identities is refused without writing its assembled text', async () => {
  const name = 'ada/ledger.md', original = 'A complete original with several separate parts.\n'.repeat(4);
  const b = await bakery({ partBytes: 32, files: { [name]: original } });
  try {
    await b.sync();
    const rows = b.rowsOf(name);
    assert.ok(rows.length > 1);
    const [id, row] = rows[1];
    b.keep(id, { ...row, 'file.identity': 'another-source-generation', 'document.text': 'Incomplete competing text' });
    const before = b.writes.length;
    const report = await b.sync();
    assert.equal(report.refused.length, 1);
    assert.equal(b.writes.length, before);
    assert.equal(await b.file(name), original);
  } finally { await b.done(); }
});

test('an unknown conditional response retries only the same original tuple and never splits or refreshes it', { timeout: 15000 }, async () => {
  let armed = false;
  const requests = [];
  const name = 'ada/ledger.md';
  const b = await bakery({ files: { [name]: 'Original file\n' }, writeResponse: request => {
    if (!armed) return null;
    requests.push(structuredClone(request));
    return { isError: true, structuredContent: { code: 'original_command_conflict', outcome: 'unknown' } };
  } });
  try {
    await b.sync();
    const id = recordOf(`/notes/${name}`), previous = structuredClone(b.records.get(id));
    await writeFile(join(b.root, 'notes', name), 'New file\n');
    armed = true;
    await assert.rejects(b.sync(), error => error.code === 'original_command_conflict' && error.outcome === 'unknown');
    assert.ok(requests.length > 1, 'the transport actually retried the unknown result');
    for (const request of requests) assert.deepEqual(request, requests[0]);
    assert.deepEqual(requests[0].input.records[0].expected, { type: TYPE, value: previous });
    assert.deepEqual(b.records.get(id), previous);
  } finally { await b.done(); }
});

test('a list-original copy uses its declared native prefix for reads and writes', async () => {
  const b = await bakery({ rowRecords: { type: 'entry', prefix: 'entry:project:' }, files: { 'ada/rye.md': NOTE('rye', 'Let it rise.') } });
  try {
    const first = await b.sync();
    assert.equal(first.pushed, 1);
    const id = `entry:project:documents~${encodeURIComponent('/notes/ada/rye.md')}`;
    assert.ok(b.records.has(id));
    assert.equal(b.records.has(recordOf('/notes/ada/rye.md')), false);
    const again = await b.sync();
    assert.equal(again.unchanged, 1);
    assert.equal(again.pushed, 0);
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

test('a restore from an older copy never removes: newer files come back up and rows without files stay', async () => {
  const files = { 'ada/rye.md': NOTE('rye', 'one'), 'bo/oven.md': NOTE('oven', 'two'), 'bo/tray.md': NOTE('tray', 'three') };
  const b = await bakery({ files });
  try {
    b.setClock(Date.parse('2026-10-25T21:00:00Z'));
    await b.sync();
    // The older copy the account is restored from: the list had removed oven, and the folder lost rye after it.
    b.keep(recordOf('/notes/bo/oven.md'), null);
    await unlink(join(b.root, 'notes/ada/rye.md'));
    // Meanwhile the folder kept a newer copy of tray than the restored rows.
    await writeFile(join(b.root, 'notes/bo/tray.md'), NOTE('tray', 'written after the copy the account came back from'));
    b.setClock(Date.parse('2026-11-03T19:57:00Z'));
    b.keep('setting:restore-generation', { value: { generation: 2, restored_at: '2026-11-03T19:57:00Z' } });
    b.setClock(Date.parse('2026-11-03T20:30:00Z'));
    const run = await b.sync();
    assert.equal(run.removed_files, 0);
    assert.equal(run.removed_rows, 0);
    assert.equal(run.carried_after_restore, 1);
    assert.equal(run.kept_after_restore, 1);
    assert.equal(await b.file('bo/oven.md'), files['bo/oven.md'], 'the file the older copy had removed is kept');
    assert.equal(textOf(b.rowsOf('bo/oven.md')), files['bo/oven.md'], 'and it is back in the list');
    assert.equal(textOf(b.rowsOf('bo/tray.md')), NOTE('tray', 'written after the copy the account came back from'));
    assert.equal(textOf(b.rowsOf('ada/rye.md')), files['ada/rye.md'], 'a row whose file is gone keeps its rows');
    // A removal made in the list after the restore is judged as always.
    b.keep(recordOf('/notes/bo/oven.md'), null);
    const after = await b.sync();
    assert.equal(after.removed_files, 1);
    await assert.rejects(stat(join(b.root, 'notes/bo/oven.md')));
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
