import test from 'node:test';
import assert from 'node:assert/strict';
import { boardThing, subjectBoardMethods } from '../src/subject-boards.mjs';
import settings from '../src/subject-boards.json' with { type: 'json' };
import tools from '../../keep-and-wake-ai-sessions-on-this-computer/records/workshop-account-tool-records.json' with { type: 'json' };
import rules from '../../starting-set/starting-rules.json' with { type: 'json' };

const FILE = `1f:${'a'.repeat(64)}`;

// A store with spaces kept the way src/spaces.mjs keeps them: one item per contributor and source.
function account({ pursuitSpaces } = {}) {
  const facts = new Map();
  const spaces = pursuitSpaces ? Object.values(pursuitSpaces).map(row => ({ space_id: row.space_id, title: row.title })) : [];
  const items = new Map();
  const network = {
    async spaces() { return { spaces }; },
    async createMembership({ title, label }) {
      const space_id = `membership:${spaces.length + 1}`;
      spaces.push({ space_id, title, label });
      return { membership_id: space_id };
    },
    async addSpaceItems({ space_id, items: sent }) {
      const added = [];
      const ids = sent.map(item => {
        const key = `${space_id}|${item.source_ref}`;
        if (!items.has(key)) { items.set(key, { id: `item:${items.size + 1}`, space_id, ...item, facts: {} }); added.push(items.get(key).id); }
        return items.get(key).id;
      });
      return { added, already_there: sent.length - added.length, ids };
    },
    async setSpaceItemFacts({ item_id, facts: set }) {
      const item = [...items.values()].find(one => one.id === item_id);
      Object.assign(item.facts, set);
      return { item_id, facts: item.facts };
    },
  };
  const store = {
    ...subjectBoardMethods,
    ctx: { id: { toString: () => 'person:proof' } },
    fact: name => facts.get(name),
    setFact: (name, value) => facts.set(name, structuredClone(value)),
    network: () => network,
    relay: () => 'relay:proof',
    async shareInto(space_id, { file }) {
      const key = `${space_id}|file:${file}`;
      if (items.has(key)) return { item_id: items.get(key).id, shared: true, updated: true };
      items.set(key, { id: `item:${items.size + 1}`, space_id, kind: 'file', body: { identity: file }, facts: {} });
      return { item_id: items.get(key).id, shared: true };
    },
  };
  return { store, spaces, items, facts };
}

test('a subject gets one board, each thing lands once in its section, and a repeat adds nothing', async () => {
  const { store, spaces, items, facts } = account();
  const things = [
    { section: 'Inspiration', url: 'https://example.com/reference', title: 'A reference' },
    { section: 'Work', text: 'The first version keeps every row in time order.' },
    { section: 'Versions', file: FILE, title: 'Before' },
  ];
  const first = await store.keepABoard({ subject: 'case:alpha', title: 'Alpha', items: things });
  assert.equal(first.made, true);
  assert.equal(first.added, 3);
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0].title, 'Alpha');
  assert.deepEqual([...items.values()].map(item => item.facts.section), ['Inspiration', 'Work', 'Versions']);
  assert.deepEqual([...items.values()].map(item => item.facts.section_order), [0, 1, 2], 'each section keeps the place it came in');
  assert.deepEqual(facts.get('subject_boards')['case:alpha'].space_id, first.space_id);
  const again = await store.keepABoard({ subject: 'case:alpha', items: things });
  assert.equal(again.made, false);
  assert.equal(again.added, 0);
  assert.equal(again.space_id, first.space_id);
  assert.equal(items.size, 3);
  assert.match(again.said, /already has/);
});

test('a pursuit keeps its board in its own room', async () => {
  const { store, spaces } = account({ pursuitSpaces: { 'pursuit:pottery': { space_id: 'membership:pottery', title: 'Pottery school' } } });
  const asked = [];
  store.pursuitRoom = async id => { asked.push(id); return { pursuit_id: id, space_id: 'membership:pottery' }; };
  const kept = await store.keepABoard({ subject: 'pursuit:pottery', items: [{ section: 'Lessons', text: 'Serve drill' }] });
  assert.deepEqual(asked, ['pursuit:pottery'], 'the pursuit\'s room comes from the one owner, src/pursuit-rooms.mjs');
  assert.equal(kept.space_id, 'membership:pottery');
  assert.equal(kept.made, false);
  assert.equal(spaces.length, 1);
});

test('two runs for one new subject at once make one space', async () => {
  const { store, spaces } = account();
  await Promise.all([
    store.keepABoard({ subject: 'plan:garden', items: [{ section: 'Ideas', text: 'Raised beds' }] }),
    store.keepABoard({ subject: 'plan:garden', items: [{ section: 'Ideas', text: 'Drip watering' }] }),
  ]);
  assert.equal(spaces.length, 1);
});

test('a thing with nothing in it is refused before anything is written', async () => {
  const { store, spaces } = account();
  assert.equal(boardThing({ section: 'Empty' }), null);
  await assert.rejects(store.keepABoard({ subject: 'x', items: [{ section: 'Empty' }] }), /one of text, url or file/);
  assert.equal(spaces.length, 0);
});

test('the Workshop row runs the store action, and the board for each decided build ships turned off', () => {
  const row = tools.records.find(record => record.payload.id === 'tool:keep-a-board')?.payload;
  assert.equal(row.invoke.action, 'keep-a-board');
  assert.deepEqual(row.placements, ['placement:this-account']);
  const keeping = rules.every_account.filter(record => JSON.stringify(record).includes('tool:keep-a-board'));
  assert.equal(keeping.length, 1, 'one default can give a decided build its board');
  assert.equal(keeping[0].enabled, false, 'a space per decision only fills the list, so the default ships off');
  assert.deepEqual(keeping[0].when.where.map(test => test.field), ['status', 'method.id']);
  assert.equal(keeping[0].then.input.items, undefined, 'the decision page already shows what was decided; the board does not copy it');
});

test('a feed puts each new item on the board of the subject it names, once, with its picture kept in the files', async () => {
  const { store, spaces, items, facts } = account();
  const kept = [];
  store.namespaceFiles = () => ({ async keep(file) { kept.push(file.name); return { identity: `1f:${String(kept.length).padStart(64, '0')}` }; } });
  const rows = [
    { id: 'a', title: 'Boards place notes', board: { subject: 'feature:boards', title: 'Boards' }, picture: '/pictures/a.webp' },
    { id: 'b', title: 'Lists fill themselves', summary: 'A list keeps itself filled.' },
  ];
  const read = async url => {
    const address = String(url);
    if (address.endsWith('/feed.json')) return new Response(JSON.stringify({ rows }), { headers: { 'content-type': 'application/json' } });
    if (address.endsWith('/pictures/a.webp')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/webp' } });
    return new Response('', { status: 404 });
  };
  const feed = { url: 'https://example.com/feed.json', values: { title: '$.title', text: '$.summary', picture: '$.picture', subject: '$.board.subject', subject_title: '$.board.title' } };
  const first = await store.subjectBoardsFromFeed({ subject: 'product:all', title: 'Every version', feed, read });
  assert.equal(first.boards.length, 2);
  assert.deepEqual(spaces.map(space => space.title).sort(), ['Boards', 'Every version']);
  assert.equal(kept.length, 1, 'the picture is kept once in the files');
  assert.ok([...items.values()].every(item => item.facts.section === 'Versions'));
  assert.equal([...items.values()].find(item => item.kind === 'note').body, 'A list keeps itself filled.');
  const again = await store.subjectBoardsFromFeed({ subject: 'product:all', feed, read });
  assert.equal(again.boards.length, 0);
  assert.equal(kept.length, 1, 'an item read once is never fetched again');
  assert.deepEqual(facts.get('subject_boards_read')['https://example.com/feed.json'].sort(), ['a', 'b']);
  await assert.rejects(store.subjectBoardsFromFeed({ subject: 'x', feed: { url: 'http://example.com/feed.json' }, read }), /https/);
});

test('a feed takes most_per_run new items a run, and the rest wait for the next run', async () => {
  const { store, items } = account();
  const count = settings.feed.most_per_run + 1;
  const rows = Array.from({ length: count }, (_, index) => ({ id: `row${index}`, summary: `Note ${index}` }));
  const read = async () => new Response(JSON.stringify({ rows }), { headers: { 'content-type': 'application/json' } });
  const feed = { url: 'https://example.com/long.json', values: { text: '$.summary' } };
  const first = await store.subjectBoardsFromFeed({ subject: 'product:all', feed, read });
  assert.equal(first.boards[0].added, settings.feed.most_per_run);
  assert.equal(first.waiting, 1);
  const second = await store.subjectBoardsFromFeed({ subject: 'product:all', feed, read });
  assert.equal(second.boards[0].added, 1, 'the item that waited is placed');
  assert.equal(second.waiting, 0);
  assert.equal(items.size, count);
});

test('two feeds on one board keep their items apart when both call an item key1', async () => {
  const { store, items } = account();
  const notes = { 'https://example.com/a.json': 'First feed note', 'https://example.com/b.json': 'Second feed note' };
  const read = async url => new Response(JSON.stringify({ rows: [{ id: 'key1', summary: notes[String(url)] }] }), { headers: { 'content-type': 'application/json' } });
  for (const url of Object.keys(notes)) await store.subjectBoardsFromFeed({ subject: 'product:all', feed: { url, values: { text: '$.summary' } }, read });
  assert.deepEqual([...items.values()].map(item => item.body).sort(), ['First feed note', 'Second feed note']);
});
