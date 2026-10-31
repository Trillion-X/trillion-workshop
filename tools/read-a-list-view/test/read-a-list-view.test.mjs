// read-a-list-view on a made-up bakery's list of chores: a refresh writes a row source's rows as the list's records,
// changing only what changed and removing what the source no longer has; a read is records only (no tool runs), paged
// with no row lost or repeated; the bounds a list keeps; a view's rules decided by the rule filter and its sort; the
// door over HTTP keeping its key. The documents source is played by a folder of recipes, answered in pages the way
// tool:read-documents-as-list-rows answers ({ rows, next }, under the run's `result`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readListView, refreshRowSources } from '../read-data/list-view.mjs';
import { openDoor } from '../read-data/door.mjs';
import { readDocumentRows } from '../../documents-as-list-rows/read-data/rows.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import data from '../read-data/list-view.json' with { type: 'json' };

const { limits } = data;

const NAMES = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}', view_type: 'list-view' };
const recipe = (name, minutes) => ({ id: `/${name}.md`, title: name, values: { 'note.chore': `bake ${name}`, 'note.minutes': minutes } });

function bakery({ sources = [{ source: 'documents', of: '/recipes' }], folder = [recipe('bread', 40), recipe('buns', 25), recipe('scones', 15), recipe('tart', 55)] } = {}) {
  const records = new Map([
    ['list:chores', { label: 'Chores', row_type: 'chore', title_field: 'chore', fields: [{ id: 'chore', kind: 'text' }, { id: 'minutes', kind: 'number' }], row_sources: sources }],
    ['list-view:quick', { list_id: 'chores', view: { rules: { kind: 'rule', field: 'minutes', operator: 'less_than', params: { value: 30 } }, sort: [{ field: 'minutes', direction: 'desc' }] } }],
    ['list-view:by-cook', { list_id: 'chores', view: { rules: { kind: 'rule', field: 'cook', operator: 'is_any_of', params: { values: ['Ada'] } } } }],
    ['record:chore:sweep', { chore: 'sweep the floor', minutes: 10 }],
    ['record:chore:mop', { chore: 'mop', minutes: 20 }],
  ]);
  const runs = [], writes = [];
  const door = {
    read: async (type, id) => (records.has(id) ? records.get(id) : null),
    // Greatest id first, like the door with no order; `after` is the last id shown.
    list: async ({ type, limit, after, prefix = `${type}:` }) => {
      const ids = [...records.keys()].filter(id => id.startsWith(`${type}:`) && id.startsWith(prefix)).sort().reverse().filter(id => !after || id < after);
      const shown = ids.slice(0, limit);
      return { records: shown.map(id => ({ id, type, value: records.get(id) })), next: shown.length < ids.length ? shown.at(-1) : null };
    },
    run: async (tool, input) => {
      runs.push({ tool, input });
      if (tool !== 'tool:read-documents-as-list-rows') throw new Error(`no tool ${tool}`);
      const rest = folder.filter(row => !input.after || row.id > input.after);
      const rows = rest.slice(0, input.limit);
      return { exit_code: 0, result: { rows, next: rows.length < rest.length ? rows.at(-1).id : null } };
    },
    write: async (rows, { key }) => {
      writes.push({ rows, key });
      for (const row of rows) {
        if (row.value === null) records.delete(row.id);
        else records.set(row.id, row.value);
      }
      return { changed: true, write_count: rows.length };
    },
  };
  return { door, records, runs, writes, folder };
}

const read = (door, input) => readListView({ names: NAMES, ...input }, door);
const refresh = (door, input) => refreshRowSources({ names: NAMES, list: 'chores', ...input }, door);

test('a refresh writes each source row as a record of the list, its id <source>~<its id> and its values whole', async () => {
  const { door, records } = bakery();
  const answer = await refresh(door);
  assert.deepEqual(answer.sources, [{ source: 'documents', rows: 4, written: 4, removed: 0, unchanged: 0, refused: [] }]);
  assert.deepEqual(records.get('record:chore:documents~%2Fbread.md'), { 'note.chore': 'bake bread', 'note.minutes': 40 });
});

test('a scoped refresh fully reconciles only selected sources and refuses unknown or empty selections', async () => {
  const { door, records, runs, writes, folder } = bakery({ sources: [
    { source: 'documents', id: 'selected', of: '/selected' }, { source: 'documents', id: 'other', of: '/other' },
  ] });
  await refresh(door);
  const unrelated = new Map([...records].filter(([id]) => id.startsWith('record:chore:other~')));
  folder.pop();
  folder[0].values['note.minutes'] = 99;
  runs.length = writes.length = 0;
  const listings = [];
  const selectedDoor = { ...door, list: input => { listings.push(input); return door.list(input); } };
  const result = await refresh(selectedDoor, { source_ids: ['selected'] });
  assert.deepEqual(result.sources.map(source => source.source), ['selected']);
  assert.equal(result.sources[0].written, 1);
  assert.equal(result.sources[0].removed, 1, 'selected source deletion still requires its successful terminal page');
  assert.ok(runs.every(run => run.input.folder === '/selected'));
  assert.ok(listings.every(input => input.prefix === 'record:chore:selected~'));
  for (const [id, value] of unrelated) assert.deepEqual(records.get(id), value);
  assert.ok(writes.flatMap(write => write.rows).every(row => row.id.startsWith('record:chore:selected~')));
  for (const source_ids of [[], ['missing'], ['selected', 'selected'], 'selected']) {
    const before = writes.length;
    await assert.rejects(refresh(door, { source_ids }), /source_ids/);
    assert.equal(writes.length, before);
  }
});

test('a read runs no tool and pages over own and source rows with nothing lost or repeated', async () => {
  const { door, runs } = bakery();
  await refresh(door);
  runs.length = 0;
  const seen = [];
  let after = null;
  do {
    const page = await read(door, { list: 'chores', after, limit: 4 });
    assert.ok(page.rows.length <= 4);
    seen.push(...page.rows.map(row => row.id));
    after = page.next;
  } while (after);
  assert.deepEqual(seen.sort(), ['documents~%2Fbread.md', 'documents~%2Fbuns.md', 'documents~%2Fscones.md', 'documents~%2Ftart.md', 'mop', 'sweep']);
  assert.equal(runs.length, 0);
  const bread = (await read(door, { list: 'chores', limit: 10 })).rows.find(row => row.id === 'documents~%2Fbread.md');
  assert.equal(bread.source, 'documents');
  assert.equal(bread.record_id, 'record:chore:documents~%2Fbread.md');
});

test('a second refresh writes only what changed and removes the rows the source no longer has', async () => {
  const { door, records, writes, folder } = bakery();
  await refresh(door);
  folder.splice(0, folder.length, recipe('bread', 45), recipe('buns', 25), recipe('scones', 15));
  writes.length = 0;
  const answer = await refresh(door);
  assert.deepEqual(answer.sources, [{ source: 'documents', rows: 3, written: 1, removed: 1, unchanged: 2, refused: [] }]);
  assert.deepEqual(writes.flatMap(write => write.rows.map(row => [row.id, row.value?.['note.minutes'] ?? null])),
    [['record:chore:documents~%2Fbread.md', 45], ['record:chore:documents~%2Ftart.md', null]]);
  assert.ok(records.has('record:chore:sweep'), 'own rows are never touched by a refresh');
});

test('a refresh asks each source page for at most read_page_rows and each listing for at most door_page_rows, and writes in bounded batches', async () => {
  const many = Array.from({ length: 130 }, (_, at) => recipe(`loaf-${String(at).padStart(3, '0')}`, at));
  const { door, runs, writes } = bakery({ folder: many });
  const asked = [];
  const counting = { ...door, list: async query => { asked.push(query.limit); return door.list(query); } };
  await refreshRowSources({ names: NAMES, list: 'chores', source_answer_bytes: 28000 }, counting);
  assert.ok(asked.length > 0 && asked.every(limit => limit <= limits.door_page_rows));
  assert.ok(runs.every(run => run.input.limit <= limits.read_page_rows));
  assert.ok(runs.every(run => run.input.most_bytes === 28000 && run.input.folder === '/recipes'));
  assert.ok(runs.every(run => !Object.hasOwn(run.input, 'root')), 'an absent source root leaves the local tool default unchanged');
  const bytes = rows => rows.reduce((sum, row) => sum + new TextEncoder().encode(JSON.stringify(row)).length, 0);
  assert.ok(writes.every(write => write.rows.length <= limits.write_rows && bytes(write.rows) <= limits.write_bytes));
  assert.ok(writes.length >= Math.ceil(130 / limits.write_rows));
  assert.equal(writes.flatMap(write => write.rows).length, 130);
  assert.equal(new Set(writes.map(write => write.key)).size, writes.length);
});

test('a write refused for one row is sent again row by row: the others are written and the refused one is named', async () => {
  const { door, records } = bakery();
  const strict = { ...door, write: async (rows, options) => {
    if (rows.some(row => row.value?.['note.minutes'] === 15)) throw Object.assign(new Error('refused'), { code: 'original_input_refused' });
    return door.write(rows, options);
  } };
  const answer = await refresh(strict);
  assert.deepEqual(answer.sources[0], { source: 'documents', rows: 4, written: 3, removed: 0, unchanged: 0, refused: ['record:chore:documents~%2Fscones.md'] });
  assert.ok(!records.has('record:chore:documents~%2Fscones.md') && records.has('record:chore:documents~%2Ftart.md'));
});

test('a refresh streams beyond the view row bound, while a missing rows answer writes nothing', async () => {
  const big = bakery({ folder: Array.from({ length: limits.rows_per_read + 1 }, (_, at) => recipe(`r${String(at).padStart(5, '0')}`, at)) });
  const done = await refresh(big.door);
  assert.equal(done.sources[0].rows, limits.rows_per_read + 1);
  assert.equal(done.sources[0].written, limits.rows_per_read + 1);
  assert.ok(big.runs.every(run => run.input.limit === limits.read_page_rows));
  assert.ok(big.writes.every(write => write.rows.length <= limits.write_rows));
  big.writes.length = 0;
  const repeated = await refresh(big.door);
  assert.equal(repeated.sources[0].unchanged, limits.rows_per_read + 1);
  assert.equal(big.writes.length, 0);
  const { door, writes } = bakery();
  const broken = { ...door, run: async () => ({ exit_code: 0, result: { said: 'nothing' } }) };
  await assert.rejects(refresh(broken), /answered no rows/);
  assert.equal(writes.length, 0);
});

test('same-kind sources have disjoint identities, values projections keep source fields, and content stays JSON', async () => {
  const content = { field: 'document.text', part_bytes: 12000 };
  const sources = [
    { source: 'documents', id: 'recipes', of: '/recipes', content, values: { statement: { row: 'title' },
      description: { from: 'document.text' }, site: { const: ['recipe-files'] } } },
    { source: 'documents', id: 'orders', root: '/a-scoped-folder', of: '/orders', content: true, exclude: ['archive/**', 'draft.md'] },
  ];
  const { door, records, runs } = bakery({ sources });
  const rows = { '/recipes': [{ id: '/shared.md', title: 'Recipe', values: { 'document.text': 'Knead.\n', original: 1 } }],
    '/orders': [{ id: '/shared.md', title: 'Order', values: { 'document.text': 'Two loaves.\n' } }] };
  const selected = { ...door, run: async (tool, input) => {
    runs.push({ tool, input });
    return { result: { rows: rows[input.folder], next: null } };
  } };
  await refresh(selected);
  assert.deepEqual(records.get('record:chore:recipes~%2Fshared.md'), {
    'document.text': 'Knead.\n', original: 1, statement: 'Recipe', description: 'Knead.\n', site: ['recipe-files'],
  });
  assert.deepEqual(records.get('record:chore:orders~%2Fshared.md'), { 'document.text': 'Two loaves.\n' });
  assert.deepEqual(runs.map(run => run.input.content), [content, true]);
  assert.ok(!Object.hasOwn(runs[0].input, 'root'));
  assert.equal(runs[1].input.root, '/a-scoped-folder');
  assert.deepEqual(runs[1].input.exclude, ['archive/**', 'draft.md']);
  rows['/recipes'] = [];
  const again = await refresh(selected);
  assert.equal(again.sources[0].removed, 1);
  assert.equal(again.sources[1].unchanged, 1);
  assert.ok(records.has('record:chore:orders~%2Fshared.md'));
  const readBack = await read(selected, { list: 'chores', limit: 20 });
  assert.equal(readBack.rows.find(row => row.id === 'orders~%2Fshared.md').source, 'orders');
  assert.ok(records.has('record:chore:sweep'));
});

test('source input templates preserve exact JSON values and fixed nonstring DATA without coercion', async () => {
  const served = data.row_sources.documents.input;
  const original = { ...served };
  const { door, runs } = bakery({ sources: [{ source: 'documents', of: '/recipes', root: null }] });
  try {
    served.fixed = { mode: 'bounded' };
    served.label = 'folder:{of}';
    await refresh(door);
    assert.equal(runs[0].input.root, null);
    assert.deepEqual(runs[0].input.fixed, { mode: 'bounded' });
    assert.equal(runs[0].input.label, 'folder:/recipes');
  } finally {
    for (const key of Object.keys(served)) delete served[key];
    Object.assign(served, original);
  }
});

test('exact source paths remain an array and invalid path declarations are refused before a run or write', async () => {
  const paths = ['skills/one/SKILL.md', 'skills/two/SKILL.md'];
  const { door, runs } = bakery({ sources: [{ source: 'documents', id: 'selected', root: '/admitted', of: '/', paths, text_extensions: ['md', 'py'] }] });
  await refresh(door);
  assert.deepEqual(runs[0].input.paths, paths);
  assert.equal(Array.isArray(runs[0].input.paths), true);
  assert.deepEqual(runs[0].input.text_extensions, ['md', 'py']);
  for (const invalid of [null, 'one.md', {}, [1], [''], ['one.md', null]]) {
    const bad = bakery({ sources: [{ source: 'documents', paths: invalid }] });
    await assert.rejects(refresh(bad.door), /Source paths must be an array/);
    assert.equal(bad.runs.length, 0);
    assert.equal(bad.writes.length, 0);
  }
  for (const invalid of [null, 'py', {}, [1], [null]]) {
    const bad = bakery({ sources: [{ source: 'documents', paths, text_extensions: invalid }] });
    await assert.rejects(refresh(bad.door), /Source text_extensions must be an array/);
    assert.equal(bad.runs.length, 0);
    assert.equal(bad.writes.length, 0);
  }
});

test('an extensionless positive source refreshes through the actual document reader with complete text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'list-extensionless-'));
  try {
    const literal = '*literal* text and a final line.\n';
    await writeFile(join(root, 'LICENSE'), literal);
    await writeFile(join(root, 'one.md'), '# One\n');
    const { door, records } = bakery({ sources: [{ source: 'documents', id: 'selected', root, of: '/',
      paths: ['/LICENSE', '/one.md'], text_extensions: ['', 'md'], content: { part_bytes: 6000 } }] });
    door.run = async (tool, input) => {
      assert.equal(tool, 'tool:read-documents-as-list-rows');
      return { exit_code: 0, result: await readDocumentRows(input) };
    };
    const answer = await refreshRowSources({ names: NAMES, list: 'chores', source_answer_bytes: 28000 }, door);
    assert.equal(answer.sources[0].written, 2);
    assert.equal(records.get('record:chore:selected~%2FLICENSE')['document.text'], literal);
    assert.equal(records.get('record:chore:selected~%2Fone.md')['document.text'], '# One\n');
    assert.ok(records.has('record:chore:sweep'), 'manual rows remain outside source ownership');
    assert.equal((await refresh(door)).sources[0].unchanged, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed later source page preserves unread old rows, and a retry completes without rewriting equal values', async () => {
  const old = Array.from({ length: limits.read_page_rows + 2 }, (_, at) => recipe(`r${String(at).padStart(5, '0')}`, at));
  const { door, records, folder, writes } = bakery({ folder: old });
  await refresh(door);
  folder[0] = recipe('r00000', 999);
  folder.splice(limits.read_page_rows);
  // Keep a continuation after the first page to model a tool whose next page fails.
  const failed = { ...door, run: async (tool, input) => {
    if (input.after) throw Object.assign(new Error('source unavailable'), { code: 'unavailable' });
    const answer = await door.run(tool, input);
    return { result: { ...answer.result, next: '/next-page' } };
  } };
  await assert.rejects(refresh(failed), /source unavailable/);
  assert.equal(records.get('record:chore:documents~%2Fr00000.md')['note.minutes'], 999);
  assert.ok(records.has('record:chore:documents~%2Fr00050.md'), 'unread existing row survives the failed pass');
  assert.ok(records.has('record:chore:documents~%2Fr00051.md'));
  writes.length = 0;
  const retried = await refresh(door);
  assert.equal(retried.sources[0].unchanged, limits.read_page_rows);
  assert.equal(retried.sources[0].written, 0);
  assert.equal(retried.sources[0].removed, 2);
  assert.ok(writes.flatMap(write => write.rows).every(row => row.value === null));
});

test('stalled cursors, duplicate source rows and unsafe or duplicate source ids refuse without deleting old rows', async () => {
  for (const sources of [
    [{ source: 'documents', id: 'a~b' }], [{ source: 'documents', id: 'a/b' }],
    [{ source: 'documents', id: 'a\\b' }], [{ source: 'documents', id: 'a\n' }],
    [{ source: 'documents', id: '' }], [{ source: 'documents' }, { source: 'documents' }],
    [{ source: 'documents', id: 'same' }, { source: 'documents', id: 'same' }],
  ]) {
    const { door, writes } = bakery({ sources });
    await assert.rejects(refresh(door), error => error.code === 'bad_list');
    assert.equal(writes.length, 0);
  }
  const { door, records } = bakery();
  await refresh(door);
  const stalled = { ...door, run: async () => ({ result: { rows: [recipe('new', 1)], next: 'same-cursor' } }) };
  await assert.rejects(refresh(stalled), /did not advance/);
  assert.ok(records.has('record:chore:documents~%2Ftart.md'));
  const duplicate = { ...door, run: async () => ({ result: { rows: [recipe('new', 1), recipe('new', 2)], next: null } }) };
  await assert.rejects(refresh(duplicate), /row id twice/);
  assert.ok(records.has('record:chore:documents~%2Ftart.md'));
  const incomplete = { ...door, run: async () => ({ result: { rows: [] } }) };
  await assert.rejects(refresh(incomplete), /no continuation or terminal null/);
  assert.ok(records.has('record:chore:documents~%2Ftart.md'), 'missing completion is not an empty completed source');
});

test('a multi-page document keeps every ordered text part, including children sharing the same source kind', async () => {
  const body = '😀 Rye bread.\n'.repeat(1200);
  const pieces = Array.from({ length: 3 }, (_, index) => ({
    id: index ? `/bread.md#text-part-${String(index + 1).padStart(8, '0')}` : '/bread.md',
    values: { 'document.parent': '/bread.md', 'document.part': index + 1, 'document.parts': 3,
      'document.text': body.slice(index * (body.length / 3), (index + 1) * (body.length / 3)) },
  }));
  const { door, records } = bakery({ sources: [{ source: 'documents', id: 'text', of: '/recipes', content: true }] });
  const paged = { ...door, run: async (tool, input) => {
    const index = input.after ? Number(input.after) : 0;
    return { result: { rows: [pieces[index]], next: index < 2 ? String(index + 1) : null } };
  } };
  await refresh(paged);
  const saved = [...records.entries()].filter(([id]) => id.startsWith('record:chore:text~'))
    .map(([, value]) => value).sort((a, b) => a['document.part'] - b['document.part']);
  assert.equal(saved.map(row => row['document.text']).join(''), body);
  assert.deepEqual(saved.map(row => row['document.parts']), [3, 3, 3]);
});

test('cancellation after a source read prevents writes and obsolete-row deletion', async () => {
  const { door, records, writes } = bakery();
  await refresh(door);
  writes.length = 0;
  const controller = new AbortController();
  const stopped = { ...door, run: async () => {
    controller.abort(new Error('refresh cancelled'));
    return { result: { rows: [], next: null } };
  } };
  await assert.rejects(refresh(stopped, { signal: controller.signal }), /refresh cancelled/);
  assert.equal(writes.length, 0);
  assert.ok(records.has('record:chore:documents~%2Ftart.md'));
});

test('a declared path catalogue is forwarded as a path and invalid catalogue values refuse', async () => {
  const chosen = bakery({ sources: [{ source: 'documents', of: '/', paths_file: '/catalogue.json' }] });
  await refresh(chosen.door);
  assert.equal(chosen.runs[0].input.paths_file, '/catalogue.json');
  for (const paths_file of ['', null, 42, {}]) {
    const invalid = bakery({ sources: [{ source: 'documents', of: '/', paths_file }] });
    await assert.rejects(refresh(invalid.door), /Source paths_file/);
  }
});

test('the reader\'s own bounds hold: too many or unknown sources are refused, no listing asks for more than the door\'s page', async () => {
  const many = bakery({ sources: Array.from({ length: limits.row_sources_per_list + 1 }, (_, index) => ({ source: 'documents', id: `source-${index}`, of: `/document-${index}` })) });
  await assert.rejects(read(many.door, { list: 'chores' }), new RegExp(`at most ${limits.row_sources_per_list} row sources`));
  const unknown = bakery({ sources: [{ source: 'weather' }] });
  await assert.rejects(refresh(unknown.door), /No tool serves the row source "weather"/);
  const inherited = bakery({ sources: [{ source: '__proto__' }] });
  await assert.rejects(refresh(inherited.door), /No tool serves the row source "__proto__"/);
  const { door } = bakery();
  await refresh(door);
  const asked = [];
  const counting = { ...door, list: async query => { asked.push(query.limit); return door.list(query); } };
  const page = await read(counting, { list: 'chores', limit: limits.rows_per_read + 1 });
  assert.equal(page.rows.length, 6);
  assert.ok(asked.length > 0 && asked.every(limit => limit <= limits.door_page_rows));
});

test('a sort orders values by their canonical JSON bytes, as the view publish did, and a view says how many rows it read', async () => {
  const records = new Map([['list:tins', { row_type: 'tin', fields: [] }], ['list-view:by-size', { list_id: 'tins', view: { sort: [{ field: 'size' }] } }],
    ['record:tin:a', { size: 9 }], ['record:tin:b', { size: 10 }], ['record:tin:c', {}], ['record:tin:d', { size: 'ￚ' }], ['record:tin:e', { size: '\u{1F600}' }]]);
  const tins = { read: async (type, id) => records.get(id) ?? null,
    list: async ({ type }) => ({ records: [...records.keys()].filter(id => id.startsWith(`${type}:`)).map(id => ({ id, type, value: records.get(id) })), next: null }) };
  const page = await read(tins, { view: 'list-view:by-size' });
  // By UTF-8 bytes U+FFDA (EF BF 9A) comes before U+1F600 (F0 9F 98 80), though a string comparison puts it after; a
  // text's quote (22) comes before a digit, "10" before "9", and the empty value last.
  assert.deepEqual(page.rows.map(row => row.record_id), ['record:tin:d', 'record:tin:e', 'record:tin:b', 'record:tin:a', 'record:tin:c']);
  assert.equal(page.of, 5);
});

test('a view keeps the rows its rules keep, decided in the same process by the formulas rule filter, in its sort', async () => {
  const { door, runs } = bakery();
  const page = await read(door, { view: 'list-view:quick', limit: 10 });
  assert.deepEqual(page.rows.map(row => row.id), ['mop', 'sweep']);
  assert.deepEqual([page.of, page.complete], [2, true]);
  assert.equal(runs.length, 0);
  // A rule on a field the list does not declare is one the filter cannot use: refused, never an empty view.
  await assert.rejects(read(door, { view: 'list-view:by-cook' }), /rules the filter could not use/);
});

test('the door sends the key only in the header, refuses an answer that holds it, and writes with the key it is given', async () => {
  const KEY = 'made-up-key-0123456789';
  const heard = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      heard.push({ auth: request.headers.authorization, body, args: call.params.arguments });
      const { input } = call.params.arguments;
      let answer = input.records ? { changed: true, write_count: input.records.length }
        : { id: input.id, type: input.type, value: input.id === 'leak' ? { said: KEY } : { label: 'Chores' } };
      // A record too big for one message comes as pages of its own bytes, 256 at a time.
      if (input.id === 'big') {
        const whole = Buffer.from(JSON.stringify({ id: 'big', type: input.type, value: { words: 'rye '.repeat(200) } }));
        const offset = input.after_byte ?? 0, part = whole.subarray(offset, offset + 256);
        answer = { byte_page: { total: whole.length, blake3: makeHashCodeHexFromBytes(whole).slice(3), offset, length: part.length,
          base64: part.toString('base64'), next_after_byte: offset + part.length < whole.length ? offset + part.length : null } };
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { structuredContent: answer } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const door = await openDoor({ transport: { url, credential: { keychain_item: 'made-up' } },
    records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list', write_method: 'records:write' },
    tools: { address: '@workshop-tools', run_method: 'tools:run' } }, { keyOf: async () => KEY });
  assert.deepEqual(await door.read('list', 'list:chores'), { label: 'Chores' });
  await assert.rejects(door.read('list', 'leak'), /held the key/);
  assert.equal((await door.read('list', 'big')).words, 'rye '.repeat(200));
  assert.deepEqual(heard.filter(one => one.args.input.id === 'big').map(one => one.args.input.after_byte ?? 0), [0, 256, 512, 768]);
  assert.deepEqual(await door.write([{ id: 'record:chore:x', type: 'record:chore', value: { chore: 'x' } }], { key: 'refresh:chores:documents:1:0' }), { changed: true, write_count: 1 });
  assert.equal(heard.at(-1).args.request_key, 'refresh:chores:documents:1:0');
  assert.ok(heard.every(one => one.auth === `Bearer ${KEY}` && !one.body.includes(KEY)));
  server.close();
});

test('a tool the config lists in local_tools runs on the computer, with its fixed input, and answers as a run', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bakery-'));
  await writeFile(join(folder, 'bread.md'), '---\nchore: bake bread\nminutes: 40\n---\nKnead.\n');
  await writeFile(join(folder, 'buns.md'), '---\nchore: bake buns\nminutes: 25\n---\nShape.\n');
  const door = await openDoor({ transport: { url: 'http://127.0.0.1:9/mcp', credential: { keychain_item: 'made-up' } },
    records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list' }, tools: { address: '@workshop-tools', run_method: 'tools:run' },
    local_tools: { 'tool:read-documents-as-list-rows': { module: 'documents-as-list-rows/read-data/rows.mjs', export: 'readDocumentRows', input: { root: folder } } } },
  { keyOf: async () => 'made-up-key' });
  const answer = await door.run('tool:read-documents-as-list-rows', { folder: '/', limit: 10 });
  assert.deepEqual(answer.result.rows.map(row => [row.id, row.values['note.minutes']]), [['/bread.md', 40], ['/buns.md', 25]]);
  await assert.rejects(openDoor({ transport: { url: 'http://127.0.0.1:9/mcp', credential: {} }, records: { address: 'a', read_method: 'r', list_method: 'l' }, tools: { address: 't', run_method: 'run' },
    local_tools: { 'tool:x': { module: 'documents-as-list-rows/read-data/rows.mjs', export: 'nothingLikeThis' } } }, { keyOf: async () => 'k' }).then(one => one.run('tool:x', {})), /exports no nothingLikeThis/);
  await rm(folder, { recursive: true });
});
