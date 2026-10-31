// read-a-list-view on a made-up bakery's list of chores: own rows first and then a row source's rows, paged across the
// two with no row lost or repeated; the bounds a list keeps; a view's rules decided by the rule filter and its sort; the
// door over HTTP keeping its key. The documents source is played by a fixed folder of four recipes, answered in pages
// the way tool:read-documents-as-list-rows answers ({ rows, next }, under the run's `result`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readListView } from '../read-data/list-view.mjs';
import { openDoor } from '../read-data/door.mjs';
import data from '../read-data/list-view.json' with { type: 'json' };

const { limits } = data;

const NAMES = { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}', view_type: 'list-view' };
const FILTER = 'tool:keep-rows';
const RECIPES = [['bread', 40], ['buns', 25], ['scones', 15], ['tart', 55]]
  .map(([name, minutes]) => ({ id: `/${name}.md`, title: name, values: { 'note.chore': `bake ${name}`, 'note.minutes': minutes } }));

function bakery({ sources = [{ source: 'documents', of: '/recipes' }] } = {}) {
  const records = new Map([
    ['list:chores', { label: 'Chores', row_type: 'chore', title_field: 'chore', fields: [{ id: 'chore', kind: 'text' }, { id: 'minutes', kind: 'number' }], row_sources: sources }],
    ['list-view:quick', { list_id: 'chores', view: { rules: { kind: 'rule', field: 'minutes', op: 'less_than', value: 30 }, sort: [{ field: 'minutes', direction: 'asc' }] } }],
    ['record:chore:sweep', { chore: 'sweep the floor', minutes: 10 }],
    ['record:chore:mop', { chore: 'mop', minutes: 20 }],
  ]);
  const runs = [];
  const door = {
    read: async (type, id) => (records.has(id) ? records.get(id) : null),
    // Greatest id first, like the door with no order; `after` is the last id shown.
    list: async ({ type, limit, after }) => {
      const ids = [...records.keys()].filter(id => id.startsWith(`${type}:`)).sort().reverse().filter(id => !after || id < after);
      const shown = ids.slice(0, limit);
      return { records: shown.map(id => ({ id, type, value: records.get(id) })), next: shown.length < ids.length ? shown.at(-1) : null };
    },
    run: async (tool, input) => {
      runs.push({ tool, input });
      if (tool === 'tool:read-documents-as-list-rows') {
        const rest = RECIPES.filter(row => !input.after || row.id > input.after);
        const rows = rest.slice(0, input.limit);
        return { exit_code: 0, result: { rows, next: rows.length < rest.length ? rows.at(-1).id : null } };
      }
      if (tool === FILTER) {
        const minutes = row => row.value.minutes ?? row.value['note.minutes'];
        return { exit_code: 0, result: { matches: input.records.flatMap((row, at) => (minutes(row) < 30 ? [at] : [])), incomplete: [] } };
      }
      throw new Error(`no tool ${tool}`);
    },
  };
  return { door, runs };
}

const read = (door, input) => readListView({ names: NAMES, ...input }, door);

test('a page holds own rows first, then the source rows, and a cursor goes on across them with nothing lost or repeated', async () => {
  const { door } = bakery();
  const seen = [];
  let after = null, pages = 0;
  do {
    const page = await read(door, { list: 'chores', after, limit: 3 });
    assert.ok(page.rows.length <= 3);
    seen.push(...page.rows.map(row => row.id));
    after = page.next;
    pages += 1;
  } while (after);
  assert.deepEqual(seen, ['sweep', 'mop', 'documents~/bread.md', 'documents~/buns.md', 'documents~/scones.md', 'documents~/tart.md']);
  assert.equal(pages, 2);
});

test('a source row carries its values and its source, and the source tool gets the list\'s folder and the page bounds', async () => {
  const { door, runs } = bakery();
  const page = await read(door, { list: 'chores', limit: 10 });
  const bread = page.rows.find(row => row.id === 'documents~/bread.md');
  assert.equal(bread.source, 'documents');
  assert.equal(bread.values['note.chore'], 'bake bread');
  assert.equal(page.rows[0].title, 'sweep the floor');
  assert.deepEqual(runs[0].input, { folder: '/recipes', limit: 8 });
});

test('the reader\'s own bounds hold: too many or unknown sources are refused, no request asks for more than a page', async () => {
  const many = bakery({ sources: ['/a', '/b', '/c', '/d', '/e'].map(of => ({ source: 'documents', of })) });
  await assert.rejects(read(many.door, { list: 'chores' }), new RegExp(`at most ${limits.row_sources_per_list} row sources`));
  const unknown = bakery({ sources: [{ source: 'weather' }] });
  await assert.rejects(read(unknown.door, { list: 'chores' }), /No tool serves the row source "weather"/);
  const { door, runs } = bakery();
  const asked = [];
  const counting = { ...door, list: async query => { asked.push(query.limit); return door.list(query); } };
  const page = await read(counting, { list: 'chores', limit: limits.rows_per_read + 1 });
  assert.equal(page.rows.length, 6);
  assert.ok([...asked, ...runs.map(run => run.input.limit)].every(limit => limit <= limits.read_page_rows));
});

test('a sort orders values by their canonical JSON bytes, as the view publish did, and a view says how many rows it read', async () => {
  const { door } = bakery();
  const records = new Map([['list:tins', { row_type: 'tin', fields: [] }], ['list-view:by-size', { list_id: 'tins', view: { sort: [{ field: 'size' }] } }],
    ['record:tin:a', { size: 9 }], ['record:tin:b', { size: 10 }], ['record:tin:c', {}]]);
  const tins = { ...door, read: async (type, id) => records.get(id) ?? null,
    list: async ({ type }) => ({ records: [...records.keys()].filter(id => id.startsWith(`${type}:`)).map(id => ({ id, type, value: records.get(id) })), next: null }) };
  const page = await read(tins, { view: 'list-view:by-size' });
  assert.deepEqual(page.rows.map(row => row.record_id), ['record:tin:b', 'record:tin:a', 'record:tin:c']);
  assert.equal(page.of, 3);
});

test('a source is told the room its answer has, and a short page from it is filled by asking again from its next', async () => {
  const { door, runs } = bakery();
  const short = { ...door, run: async (tool, input) => door.run(tool, { ...input, limit: Math.min(input.limit, 1) }) };
  const page = await read(short, { list: 'chores', limit: 5, source_answer_bytes: 28000 });
  assert.deepEqual(page.rows.map(row => row.id), ['sweep', 'mop', 'documents~/bread.md', 'documents~/buns.md', 'documents~/scones.md']);
  assert.ok(runs.every(run => run.input.most_bytes === 28000));
  assert.equal(runs.length, 3);
});

test('a source that answers no rows is refused, never shown as empty', async () => {
  const { door } = bakery();
  const broken = { ...door, run: async () => ({ exit_code: 0, result: { said: 'nothing' } }) };
  await assert.rejects(read(broken, { list: 'chores', limit: 10 }), /answered no rows/);
});

test('a view keeps the rows its rules keep, as the rule filter says, in its sort, sending only the fields the rules read', async () => {
  const { door, runs } = bakery();
  const page = await read(door, { view: 'list-view:quick', limit: 10, filter: { tool: FILTER } });
  assert.deepEqual(page.rows.map(row => row.id), ['sweep', 'mop']);
  const sent = runs.find(run => run.tool === FILTER).input;
  assert.deepEqual(sent.fields.map(field => field.id), ['minutes']);
  assert.ok(sent.records.every(record => Object.keys(record.value).every(key => key === 'minutes')));
  await assert.rejects(read(door, { view: 'list-view:quick' }), /needs filter/);
});

test('the door sends the key only in the header and refuses an answer that holds it', async () => {
  const KEY = 'made-up-key-0123456789';
  const heard = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const call = JSON.parse(body);
      heard.push({ auth: request.headers.authorization, body });
      const { input } = call.params.arguments;
      const answer = { id: input.id, type: input.type, value: input.id === 'leak' ? { said: KEY } : { label: 'Chores' } };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { structuredContent: answer } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const door = await openDoor({ transport: { url, credential: { keychain_item: 'made-up' } }, records: { address: '@own-records', read_method: 'records:read', list_method: 'records:list' },
    tools: { address: '@workshop-tools', run_method: 'tools:run' } }, { keyOf: async () => KEY });
  assert.deepEqual(await door.read('list', 'list:chores'), { label: 'Chores' });
  await assert.rejects(door.read('list', 'leak'), /held the key/);
  assert.ok(heard.every(one => one.auth === `Bearer ${KEY}` && !one.body.includes(KEY)));
  server.close();
});
