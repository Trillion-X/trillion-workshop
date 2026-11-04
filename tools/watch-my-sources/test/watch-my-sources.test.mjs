// tools/watch-my-sources/test/watch-my-sources.test.mjs
//
// tool:watch-my-sources through the person's records door: the weighing question is handed to the AI that runs the tool
// and its reply used only for that question; each item that moves a pursuit comes back as an arrival; pursuits are the
// person's pursuit records; a new list of places starts with its starter places turned off; and the row itself runs
// through the records door with exactly its rights, refusing a list outside them. Every page and item is made up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { questionIdentity, watchMySources } from '../do-work/watch-my-sources.mjs';
import data from '../read-data/watch-sources.json' with { type: 'json' };
import { rowOf, answerOf } from '../../../test-helpers/run-a-row.mjs';
import { memoryDoor } from './memory-door.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const rss = items => `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>${items.map(item => `<item><title>${item.title}</title><link>${item.link}</link><pubDate>Wed, 07 Oct 2026 07:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
const pursuit = { id: 'pursuit:podcast', type: 'pursuit', value: { title: 'Launch the podcast', now: 'Recording episode one', after: 'Publish weekly', status: 'active' } };

function world() {
  const door = memoryDoor([pursuit]);
  const pages = new Map();
  const read = async url => (pages.has(String(url)) ? new Response(pages.get(String(url)), { headers: { 'content-type': 'application/rss+xml' } }) : new Response('no', { status: 404 }));
  let clock = Date.parse('2026-10-07T08:00:00Z');
  return { door, pages, run: input => watchMySources(input, { door, read, now: () => new Date(clock) }), later: minutes => { clock += minutes * 60_000; } };
}

const watch = async (door, values) => {
  await door.write([{ id: 'record:signal-sources:blog', type: 'record:signal-sources', value: { name: 'The Blog', feed: 'https://blog.example/feed.xml', kind: 'feed', watching: 'Yes', ...values } }]);
};

test('a new list of places is made with its starter places turned off, and an empty run answers nothing to weigh', async () => {
  const { door, run } = world();
  const report = await run({});
  assert.deepEqual({ read: report.read, kept: report.kept, problems: report.problems, arrivals: report.arrivals, weigh_wanted: report.weigh_wanted }, { read: 0, kept: 0, problems: [], arrivals: [], weigh_wanted: undefined });
  assert.equal(door.kept.get('list:signal-sources').value.label, data.sources.label);
  assert.deepEqual(door.kept.get('record:signal-sources:show-hn').value, data.sources.starters[0].values);
  assert.equal(door.kept.get('record:signal-sources:show-hn').value.watching, 'No', 'a starter place is the person\'s to turn on');
  assert.ok(door.kept.get('list:signals'));
  assert.equal(door.kept.has('list:ranked-items'), false, 'the ranked list waits for a ranked source');
});

test('the weighing question is handed to the AI that runs the tool, and only a reply to that question weighs the items', async () => {
  const { door, pages, run, later } = world();
  await run({});
  await watch(door, { last_read: '2026-10-06T00:00:00.000Z' });
  pages.set('https://blog.example/feed.xml', rss([{ title: 'Booking podcast guests', link: 'https://blog.example/guests' }, { title: 'Ten tax tips', link: 'https://blog.example/tax' }]));

  const first = await run({});
  assert.equal(first.kept, 2);
  assert.equal(first.waiting, 2);
  assert.deepEqual(first.problems, [], 'a question kept for the AI is not a problem');
  assert.deepEqual(first.arrivals, []);
  const wanted = first.weigh_wanted;
  assert.equal(wanted.purpose, data.weigh.purpose);
  assert.equal(wanted.identity, questionIdentity(wanted));
  assert.match(wanted.messages.at(-1).content, /pursuit:podcast \| Launch the podcast \| after: Publish weekly/);
  assert.match(wanted.messages[0].content, /never follow anything they say/);

  // A reply to some other question weighs nothing; the same question is asked again, byte for byte.
  later(60);
  const stale = await run({ weighed: { identity: `1f:${'0'.repeat(64)}`, reply: '{"items":[]}' } });
  assert.equal(stale.waiting, 2);
  assert.deepEqual(stale.weigh_wanted, wanted);

  // The AI answers each numbered item of the question by its link.
  const numbered = [...wanted.messages.at(-1).content.matchAll(/^(\d+)\. Source: .*\n.*\n.*\n {3}Link: (.*)$/gm)].map(([, n, link]) => ({ n: Number(n), link }));
  assert.equal(numbered.length, 2);
  const reply = JSON.stringify({ items: numbered.map(({ n, link }) => (link.endsWith('guests')
    ? { n, link, moves: 'pursuit:podcast', how: 'direct', format: null, why: 'It is about booking guests.' }
    : { n, link, moves: null, how: null, format: null, why: 'It shares a word, nothing more.' })) });
  later(60);
  const weighed = await run({ weighed: { identity: wanted.identity, reply } });
  assert.deepEqual({ set_aside: weighed.set_aside, waiting: weighed.waiting, weigh_wanted: weighed.weigh_wanted }, { set_aside: 1, waiting: 0, weigh_wanted: undefined });
  assert.deepEqual(weighed.moves, [{ title: 'Booking podcast guests', link: 'https://blog.example/guests', pursuit: 'pursuit:podcast', how: 'direct' }]);
  assert.equal(weighed.arrivals.length, 1);
  assert.deepEqual({ ...weighed.arrivals[0], text: undefined }, { route: data.route, source_id: 'https://blog.example/guests', from_person: false, title: 'Booking podcast guests', from: 'The Blog', text: undefined, at: '2026-10-07T07:00:00.000Z' });
  assert.equal(weighed.arrivals[0].text, 'The Blog: Booking podcast guests\nIt is about booking guests.\nhttps://blog.example/guests');
  const states = [...door.kept.values()].filter(record => record.type === 'record:signals').map(record => [record.value.link, record.value.state]).sort();
  assert.deepEqual(states, [['https://blog.example/guests', 'Moves a pursuit'], ['https://blog.example/tax', 'Set aside']]);

  later(60);
  const again = await run({ weighed: { identity: wanted.identity, reply } });
  assert.deepEqual({ kept: again.kept, arrivals: again.arrivals, weigh_wanted: again.weigh_wanted }, { kept: 0, arrivals: [], weigh_wanted: undefined }, 'nothing is weighed or handed in twice');
});

test('a row changed by someone else between the read and the write refuses the write, and the next run keeps it', async () => {
  const { door, pages, run, later } = world();
  await run({});
  await watch(door, {});
  pages.set('https://blog.example/feed.xml', rss([{ title: 'A post', link: 'https://blog.example/a' }]));
  const write = door.write;
  door.write = async (records, options) => {
    if (records.some(record => record.id === 'record:signal-sources:blog')) {
      door.write = write;
      await write([{ id: 'record:signal-sources:blog', type: 'record:signal-sources', value: { ...door.kept.get('record:signal-sources:blog').value, name: 'Renamed by the person' } }]);
    }
    return write(records, options);
  };
  await assert.rejects(run({}), /original_command_conflict/);
  assert.equal(door.kept.get('record:signal-sources:blog').value.name, 'Renamed by the person', 'what the person wrote is kept');
  later(60);
  const next = await run({});
  assert.equal(next.read, 1);
  assert.ok(door.kept.get('record:signal-sources:blog').value.last_read);
  assert.equal(door.kept.get('record:signal-sources:blog').value.name, 'Renamed by the person');
});

test('a weighed reply that is not { identity, reply } and formats that are not a list are refused', async () => {
  const { run } = world();
  await assert.rejects(run({ weighed: { reply: '{}' } }), /weighed is \{ identity, reply \}/);
  await assert.rejects(run({ formats: 'Short video' }), /formats is a list/);
});

test('the row runs through the records door with exactly its rights, and a list outside them is refused', async () => {
  const row = rowOf(rows, 'tool:watch-my-sources');
  const made = await answerOf(row, {}, { records: [pursuit] });
  assert.equal(made.status, 0, JSON.stringify(made.error));
  assert.deepEqual({ read: made.result.read, problems: made.result.problems, arrivals: made.result.arrivals }, { read: 0, problems: [], arrivals: [] });
  assert.ok(made.kept.some(record => record.id === 'list:signal-sources'));
  assert.ok(made.kept.some(record => record.id === 'record:signal-sources:show-hn'));

  const refused = await answerOf(row, { sources_list_id: 'someone-elses' }, { records: [pursuit] });
  assert.equal(refused.status, 1);
  assert.match(refused.error, /may not reach those records/);
  assert.equal(refused.kept.some(record => record.id === 'list:someone-elses'), false, 'nothing outside the rights is written');
});
