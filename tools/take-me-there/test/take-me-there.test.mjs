// tools/take-me-there/test/take-me-there.test.mjs
//
// The decisions of take-me-there on made-up cards, screens and origins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readSettings, takeMeThere } from '../read-data/take-me-there.mjs';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const settings = readSettings();

const screens = [
  { path_prefix: '/sample', tool_id: 'tool:sample-screen', route_input_from_query: ['item'] },
  { path_prefix: '/sample/deep', tool_id: 'tool:deeper-screen', route_input_from_query: ['item', 'tab'] },
  { path_prefix: '/plain', tool_id: 'tool:plain-screen' },
];
const own_origins = ['https://app.example.test'];
const waiting = {
  sections: [
    {
      id: 'drafts', title: 'Drafts', action: 'Approve', points_at: '[data-approve="{item}"]',
      cards: [
        { id: 'drafts:d-1', source: 'drafts', title: 'First draft', address: '/sample/open?item=d-1' },
        { id: 'drafts:d-"2', source: 'drafts', title: 'Second draft', address: 'https://app.example.test/sample/deep/x?item=d-2&tab=body&other=1' },
      ],
    },
    {
      id: 'stuck', title: 'Stuck work',
      cards: [
        { id: 'job-1', title: 'Stuck job', action: 'Unstick', address: '/plain' },
        { id: 'job-2', title: 'Elsewhere job', address: 'https://other.example.test/plain' },
        { id: 'job-3', title: 'No screen job', address: '/nowhere' },
        { id: 'job-4', title: 'Look-alike path', address: '/samples/open' },
        { id: 'job-5', title: 'Double-slash job', address: '//other.example.test/plain' },
      ],
    },
    {
      id: 'recordings', title: 'Recordings', action: 'Record',
      batch: { title: '{count} to record', action: 'Record them', requires: 'audio_needed' },
      cards: [
        { id: 'rec-1', source: 'recordings', title: 'One', address: '/sample/open?item=r-1' },
        { id: 'rec-2', source: 'recordings', title: 'Two', audio_needed: true, address: '/sample/open?item=r-2' },
      ],
    },
  ],
};
const take = extra => takeMeThere({ thing: 'drafts:d-1', waiting, screens, own_origins, ...extra });

test('a waiting card opens its screen as one pane named by what its address adds, held under its own id', () => {
  const said = take();
  assert.equal(said.taken, true);
  assert.deepEqual(said.screen, { tool_id: 'tool:sample-screen', route_input: { item: 'd-1' } });
  assert.deepEqual(said.arrangement, {
    id: 'drafts:d-1', held: 'drafts:d-1', replaces: ['First draft'], name: 'First draft', category: settings.category,
    root: { kind: 'pane', surfaces: [{ id: 'tool:sample-screen', input: { item: 'd-1' }, title: 'First draft' }] },
  });
  assert.equal(said.tour, null);
  assert.equal(said.notice, null);
  assert.deepEqual(take(), said, 'the same input answers the same');
  assert.deepEqual(take({ name: 'Look at this', category: 'Mine' }).arrangement.replaces, ['Look at this']);
  assert.equal(take({ category: 'Mine' }).arrangement.category, 'Mine');
});

test('a screen with nothing added is named by its id alone and a whole link on an own origin opens inside', () => {
  const plain = takeMeThere({ thing: 'job-1', waiting, screens, own_origins });
  assert.deepEqual(plain.arrangement.root, { kind: 'pane', surfaces: ['tool:plain-screen'] });
  assert.deepEqual(plain.screen.route_input, {});
  const whole = takeMeThere({ thing: 'drafts:d-"2', waiting, screens, own_origins });
  assert.deepEqual(whole.screen, { tool_id: 'tool:deeper-screen', route_input: { item: 'd-2', tab: 'body' } });
});

test('what is put beside the thing splits with the sizes from the data', () => {
  const beside = { kind: 'pane', surfaces: ['tool:other-screen'] };
  const root = take({ beside }).arrangement.root;
  assert.equal(root.kind, 'split');
  assert.deepEqual(root.sizes, settings.focus_sizes);
  assert.deepEqual(root.children[1], beside);
  assert.equal(root.children[0].kind, 'pane');
  assert.equal(take({ beside: 'x' }).arrangement.root.kind, 'pane');
});

test('a thing that is not waiting, or opens outside, or opens no screen, takes nobody anywhere', () => {
  for (const [thing, said] of [['gone', /gone is not waiting/], ['job-2', /outside their own places \(https:\/\/other\.example\.test\/plain\)/], ['job-3', /job-3 opens outside/], ['job-4', /job-4 opens outside/], ['job-5', /job-5 opens outside/]]) {
    const refused = takeMeThere({ thing, waiting, screens, own_origins, steps: [{ words: 'x' }], say: { title: 'x' } });
    assert.deepEqual(Object.keys(refused), ['taken', 'said'], thing);
    assert.equal(refused.taken, false);
    assert.match(refused.said, said);
  }
  assert.equal(takeMeThere({ thing: 'drafts:d-1', waiting, screens }).taken, true, 'a relative link needs no own origin');
  assert.equal(takeMeThere({ thing: 'drafts:d-"2', waiting, screens }).taken, false, 'a whole link is outside when no origin is the person\'s own');
});

test('the longest path_prefix wins, by whole segments', () => {
  assert.equal(takeMeThere({ thing: 'drafts:d-"2', waiting, screens, own_origins }).screen.tool_id, 'tool:deeper-screen');
  assert.equal(takeMeThere({ thing: 'drafts:d-1', waiting, screens: [...screens].reverse(), own_origins }).screen.tool_id, 'tool:sample-screen');
});

test('the walkthrough points at the card\'s own control with the item id filled, else the fallback, and is made only from steps given', () => {
  const steps = [{ title: 'Press it' }, { id: 'later', title: 'Then this', target_ref: { from: 'selector', query: '#mine' } }];
  const { tour } = take({ steps });
  assert.equal(tour.id, 'drafts:d-1');
  assert.equal(tour.title, 'Approve: First draft');
  assert.deepEqual(tour.steps[0], {
    title: 'Press it', id: `${settings.step_id}-1`,
    target_ref: { from: 'selector', query: '[data-approve="d-1"]' },
    target_preparation: { surface: { id: 'tool:sample-screen', surface_input: { item: 'd-1' } } },
    centered_when_target_missing: true, placement: settings.step_placement,
  });
  assert.deepEqual(tour.steps[1], steps[1], 'a step that names its own target is kept as given');
  const quotedItem = takeMeThere({ thing: 'drafts:d-"2', waiting, screens, own_origins, steps }).tour.steps[0].target_ref.query;
  assert.equal(quotedItem, '[data-approve="d-\\"2"]');
  const fallback = takeMeThere({ thing: 'job-1', waiting, screens, own_origins, steps }).tour;
  assert.equal(fallback.steps[0].target_ref.query, settings.fallback_points_at);
  assert.equal(fallback.title, 'Unstick: Stuck job');
  assert.equal(takeMeThere({ thing: 'job-1', waiting, screens, own_origins, steps, fallback_points_at: '[data-pane]' }).tour.steps[0].target_ref.query, '[data-pane]');
  assert.equal(take({ steps: ['x', null] }).tour, null);
});

test('the walkthrough is asked for by name and finishes when the card is completed', () => {
  const [trigger] = take({ steps: [{}] }).tour.triggers;
  assert.deepEqual(trigger, {
    reason: settings.trigger.reason,
    on_event: { event_kind: settings.trigger.start_event },
    once_key: `${settings.trigger.once_key}drafts:d-1`,
    consume_on: [{ event_kind: settings.trigger.done_event, match_all: { completed_ids: ['drafts:d-1'] } }],
  });
});

test('a batch is held under its section key, opens where its first card opens and finishes with every row, required ones first', () => {
  const batch = takeMeThere({ thing: 'batch:recordings', waiting, screens, own_origins, steps: [{}], say: { title: 'Time to record' } });
  assert.equal(batch.taken, true);
  assert.equal(batch.arrangement.id, 'batch:recordings');
  assert.equal(batch.arrangement.name, '1 to record');
  assert.deepEqual(batch.screen, { tool_id: 'tool:sample-screen', route_input: { item: 'r-1' } });
  assert.equal(batch.tour.title, 'Record them: 1 to record');
  assert.deepEqual(batch.tour.triggers[0].consume_on[0].match_all.completed_ids, ['rec-2', 'rec-1']);
  assert.equal(batch.tour.triggers[0].once_key, `${settings.trigger.once_key}batch:recordings`);
  assert.equal(batch.notice.refs.card, 'batch:recordings');
  const row = takeMeThere({ thing: 'rec-2', waiting, screens, own_origins });
  assert.deepEqual([row.arrangement.id, row.screen.route_input], ['batch:recordings', { item: 'r-2' }], 'a card of a batch is its own thing but is held under the batch key, as the hold keeps it');
});

test('a notice is made only when words are given, and its link carries the arrangement and the walkthrough', () => {
  const said = take({ steps: [{}], say: { title: ' Look here ', body: 'It is ready' }, key: ' k1 ' });
  assert.deepEqual(said.notice, { title: 'Look here', body: 'It is ready', kind: settings.notice_kind, refs: { open: said.open, card: 'drafts:d-1' }, key: 'k1' });
  assert.equal(said.open, '/?layout=drafts%3Ad-1&tour=drafts%3Ad-1');
  assert.equal(take().open, '/?layout=drafts%3Ad-1', 'no walkthrough, no tour in the link');
  assert.equal(take({ say: { body: 'no title' } }).notice, null);
  assert.equal(take({ say: { title: 'Hi' } }).notice.body, null);
  assert.match(said.said, /ready to open.*nothing was saved here\. A walkthrough points at Approve there\. A notice is ready to send.*nothing was sent here\./);
  assert.doesNotMatch(take().said, /walkthrough|notice/);
});

test('a request that is not plainly shaped is refused in words', () => {
  assert.throws(() => takeMeThere([]), /Send an object/);
  assert.throws(() => takeMeThere({ waiting, screens }), /Say which thing/);
  assert.throws(() => takeMeThere({ thing: 'x', screens }), /Give waiting/);
  assert.throws(() => takeMeThere({ thing: 'x', waiting }), /Give screens/);
  assert.throws(() => takeMeThere({ thing: 'x', waiting, screens: [{ path_prefix: 'sample', tool_id: 'tool:a' }] }), /screens\[0\] is/);
  assert.throws(() => takeMeThere({ thing: 'x', waiting, screens: [{ path_prefix: '/a', tool_id: 'tool:a', route_input_from_query: 'item' }] }), /screens\[0\] is/);
  assert.throws(() => takeMeThere({ thing: 'x', waiting, screens, own_origins: ['not an origin'] }), /not an origin is not one/);
  assert.throws(() => takeMeThere({ thing: 'x', waiting, screens, own_origins: 'https://a.test' }), /own_origins is a list/);
});

test('the command answers one JSON line, and refuses what it cannot read', () => {
  const run = request => spawnSync('node', [new URL('../do-work/take-me-there.mjs', import.meta.url).pathname], { input: request, encoding: 'utf8' });
  const ok = run(JSON.stringify({ thing: 'drafts:d-1', waiting, screens, own_origins }));
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).result.screen.tool_id, 'tool:sample-screen');
  const bad = run('{');
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).error, /not JSON/);
  assert.match(JSON.parse(run('{}').stdout).error, /Say which thing/);
});

test('the row packs what the tool reads and runs its own sample', () => {
  assert.deepEqual(rows.map(row => row.id), ['tool:take-me-there']);
  assert.deepEqual(rows[0].invoke.files.package_files.paths, ['do-work', 'read-data']);
  const sample = takeMeThere(rows[0].verify[0].input);
  assert.equal(sample.screen.tool_id, rows[0].verify[0].contains);
  assert.deepEqual(sample.screen.route_input, { item: 'one' });
});
