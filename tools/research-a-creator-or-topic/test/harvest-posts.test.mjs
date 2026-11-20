// tools/research-a-creator-or-topic/test/harvest-posts.test.mjs
//
// tool:keep-public-posts-by-link against a stand-in mirror (a function standing for fetch); the rows it builds
// over come in as held and go back as keep. Every user, post and word here is made up.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepPublicPostsByLink as keep, readPostLink, readRequest } from '../do-work/harvest-posts.mjs';
import { readSettings } from '../do-work/harvest-parts.mjs';

const shipped = readSettings();
const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload)
  .find(payload => payload.id === 'tool:keep-public-posts-by-link');
const MIRROR = 'https://mirror.example';
const settingsWith = (changes = {}) => ({
  ...shipped,
  posts: { ...shipped.posts, mirror_base: MIRROR },
  seconds_between_requests: { least: 0, most: 0 },
  ...changes,
});
const link = (user, id) => `https://x.com/${user}/status/${id}`;
const A = link('baker_one', '1001');
const B = link('baker_two', '1002');
const C = link('baker_one', '1003');

// A mirror that answers from a plan keyed by its address; `calls` lists the addresses asked, in order.
function mirror(plan) {
  const calls = [];
  const fetchPage = async (address, { headers }) => {
    calls.push({ address: String(address), headers });
    const answer = plan[String(address)];
    if (!answer) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  };
  return { fetchPage, calls };
}
const post = (id, text, more = {}) => ({ tweet: { id, text, likes: 3, author: { screen_name: 'baker_one' }, media: { photos: [{ url: 'https://pics.example/1.jpg' }] }, secret_extra: 'dropped', ...more } });
const plan = {
  [`${MIRROR}/baker_one/status/1001`]: { body: post('1001', 'Proofing for an hour') },
  [`${MIRROR}/baker_two/status/1002`]: { body: { code: 404 } },
  [`${MIRROR}/baker_one/status/1003`]: { body: post('1003', 'Scoring the loaf') },
};
const lines = out => readFileSync(join(out, 'posts.jsonl'), 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text));
const fresh = () => join(tempFolder(join(tmpdir(), 'posts-')), 'out');

test('each link is asked of the mirror once, politely, and kept with only the fields the settings name', async () => {
  const { fetchPage, calls } = mirror(plan);
  const out = fresh();
  const answer = await keep({ links: [A, B, A, C, 'https://elsewhere.example/page'] }, { settings: settingsWith(), out, fetchPage });
  assert.equal(answer.stopped, 'finished');
  assert.equal(answer.again, null);
  assert.equal(answer.requests, 3);
  assert.deepEqual(calls.map(call => call.address), [`${MIRROR}/baker_one/status/1001`, `${MIRROR}/baker_two/status/1002`, `${MIRROR}/baker_one/status/1003`]);
  assert.equal(calls[0].headers['user-agent'], shipped.posts.user_agent);
  assert.deepEqual(answer.posts, { ready: 2, failed: [{ post_id: '1002', reason: 'the mirror held no post' }] });
  assert.deepEqual(answer.skipped, [{ link: 'https://elsewhere.example/page', reason: 'not a link to a post this tool reads' }]);
  const [first, second] = lines(out);
  assert.deepEqual(first, {
    user: 'baker_one', post_id: '1001', link: A, status: 'ready',
    post: { id: '1001', text: 'Proofing for an hour', likes: 3, author: { screen_name: 'baker_one' }, media: { photos: [{ url: 'https://pics.example/1.jpg' }] } },
  });
  assert.equal(second.status, 'failed');
});

test('a post already kept is never asked for again', async () => {
  const { fetchPage, calls } = mirror(plan);
  const answer = await keep({ links: [A, C], skip_ids: ['1001'] }, { settings: settingsWith(), out: fresh(), fetchPage });
  assert.deepEqual(calls.map(call => call.address), [`${MIRROR}/baker_one/status/1003`]);
  assert.equal(answer.settled, 1);
  assert.equal(answer.again, null);
});

test('a refusal ends the run at once, says how long to wait, and sends the rest as again', async () => {
  const { fetchPage, calls } = mirror({ ...plan, [`${MIRROR}/baker_two/status/1002`]: { status: 429 } });
  const answer = await keep({ links: [A, B, C], refusals_in_a_row: 1 }, { settings: settingsWith(), out: fresh(), fetchPage });
  assert.equal(answer.stopped, 'refusal');
  assert.equal(answer.wait_minutes, shipped.pause_after_refusal.first_minutes * 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(answer.again, { links: [A, B, C], skip_ids: ['1001'], refusals_in_a_row: 2 });
});

test('an answer that is not a refusal but not a post either is a failed line, not a stop', async () => {
  const { fetchPage } = mirror({ ...plan, [`${MIRROR}/baker_one/status/1001`]: { status: 500 } });
  const out = fresh();
  const answer = await keep({ links: [A, C] }, { settings: settingsWith(), out, fetchPage });
  assert.equal(answer.stopped, 'finished');
  assert.deepEqual(answer.posts.failed, [{ post_id: '1001', reason: 'the mirror answered HTTP 500' }]);
  assert.equal(lines(out).length, 2);
});

test('the requests of one run and the time it has are bounded like the channel harvest\'s', async () => {
  const { fetchPage } = mirror(plan);
  const answer = await keep({ links: [A, B, C] }, { settings: settingsWith({ requests_per_run_at_most: 1 }), out: fresh(), fetchPage });
  assert.equal(answer.stopped, 'requests');
  assert.deepEqual(answer.again, { links: [A, B, C], skip_ids: ['1001'] });

  let clock = 0;
  const waits = [];
  const slow = mirror(plan);
  const bounded = await keep({ links: [A, B, C], budget_seconds: 17 }, {
    settings: settingsWith({ seconds_between_requests: { least: 2, most: 6 }, least_seconds_for_a_request: 8 }), out: fresh(), fetchPage: slow.fetchPage,
    now: () => clock, random: () => 0.75, sleep: async seconds => { waits.push(seconds); clock += seconds; },
  });
  assert.deepEqual(waits, [5]);
  assert.equal(bounded.stopped, 'budget');
});

test('rows are answered, built over the rows held, and kept nowhere', async () => {
  const { fetchPage } = mirror(plan);
  const rows = { one_per: 'post', id: { text: 'post-{post_id}' }, fields: { words: { fact: 'text' }, by: { fact: 'user' }, kind: { value: 'post' } } };
  const held = [{ id: 'record:sources:post-1001', value: { note: 'kept by hand' } }];
  const answer = await keep({ links: [A, C], rows, held }, { settings: settingsWith(), out: fresh(), fetchPage });
  assert.deepEqual(answer.refused_rows, []);
  const byId = Object.fromEntries(answer.keep.map(record => [record.id, record]));
  assert.deepEqual(byId['record:sources:post-1001'], { id: 'record:sources:post-1001', type: 'record:sources', value: { note: 'kept by hand', words: 'Proofing for an hour', by: 'baker_one', kind: 'post' }, expected: { type: 'record:sources', value: held[0].value } });
  assert.deepEqual(byId['record:sources:post-1003'].value, { words: 'Scoring the loaf', by: 'baker_one', kind: 'post' });
  assert.equal(byId['record:sources:post-1003'].expected, null, 'a row not held expects none');
  assert.equal(answer.keep.length, 2);
});

test('the input is checked whole before any request', () => {
  const settings = settingsWith();
  const refused = (input, words) => assert.throws(() => readRequest(input, settings), words);
  refused({}, /links is a list of 1 to/);
  refused({ links: [] }, /links is a list of 1 to/);
  refused({ links: [A], colour: 'red' }, /Unknown input: colour/);
  refused({ links: [A], budget_seconds: 0 }, /budget_seconds is a whole number/);
  refused({ links: [A], rows: { one_per: 'seed', id: { fact: 'user' }, fields: { a: { fact: 'user' } } } }, /rows is \{ one_per: "post"/);
  refused({ links: [A], rows: { one_per: 'post', fields: { a: { fact: 'user' } } } }, /rows.id is needed/);
});

test('a post link is read by the pattern in the settings', () => {
  const settings = settingsWith();
  assert.deepEqual(readPostLink('https://twitter.com/baker_one/status/1001?s=20', settings), { user: 'baker_one', post_id: '1001', link: 'https://twitter.com/baker_one/status/1001?s=20' });
  assert.equal(readPostLink('https://x.com/baker_one', settings), null);
});

test('the row packs what the tool reads, keeps its file by the settings\' bound, and holds no records door', () => {
  const { invoke } = row;
  const at = invoke.files.package_files.find(item => item.package === 'research-a-creator-or-topic');
  assert.equal(invoke.workdir, at.at);
  for (const file of ['do-work/harvest-posts.mjs', 'do-work/harvest-parts.mjs', 'do-work/harvest-settings.json']) assert.ok(at.paths.includes(file), file);
  assert.deepEqual(invoke.outputs.map(output => [output.name, output.path, output.max_bytes]), [['posts', `${at.at}/out/posts.jsonl`, shipped.file_bytes_at_most]]);
  assert.equal(invoke.argv[1], '/opt/workflows/do-work/run-a-function.mjs');
  assert.ok(!JSON.stringify(row).includes('records-door'), 'no records door is mounted or named');
  assert.deepEqual(row.output_schema.properties.keep.items.required, ['id', 'type', 'value', 'expected']);
  assert.equal(row.input_schema.properties.links.maxItems, shipped.posts.links_at_most);
  assert.equal(row.input_schema.properties.skip_ids.maxItems, shipped.posts.skip_ids_at_most);
  assert.equal(row.input_schema.properties.budget_seconds.maximum, shipped.budget_seconds.most);
  assert.ok(shipped.posts.mirror_base.startsWith('https://'));
});
