// The scheduler asks a person's store for its next review time after every request (src/person-store.mjs
// nextReviewAt). It was a MIN over every open job's review time, each checked against the jobs it waits on: 16 ms at
// 1200 open jobs, twice per read_handoff, inside the store that answers that person one request at a time. It walks
// the review index of the agents' records (src/agent-records.mjs) from the start and stops at the first job not waiting
// on unfinished work. This test holds that it answers exactly what a MIN over every open job answers, over random open
// work, and that it stops early.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeAgents, reviewOf } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

// The read as it was, kept here as the answer the new one must give: the earliest review of any open job whose waits
// are all finished ('' is now), or null.
function minOverEveryOpenJob(items, nowIso) {
  const byId = new Map(items.map(item => [item.handoff_id, item]));
  let next = null;
  for (const item of items) {
    if (item.state === 'finished') continue;
    const { review_at, waits_on } = reviewOf(item);
    if (review_at === null || waits_on.some(id => byId.get(id)?.state !== 'finished')) continue;
    const due = review_at || nowIso;
    if (next === null || due < next) next = due;
  }
  return next;
}

// A seeded random source, so a failure repeats.
function random(seed) { let state = seed; return () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; }; }

const NOW = '2026-10-05T12:00:00.000Z';
const fixedNow = () => new Date(NOW);

test('the next review read answers what the MIN over every open job answered', () => {
  for (let round = 0; round < 40; round++) {
    const store = agentStoreForTests();
    const agents = makeAgents({ store, now: fixedNow });
    const next = random(round + 1);
    const count = 1 + Math.floor(next() * 60);
    const ids = Array.from({ length: count }, (_, i) => `h_${i}`);
    const items = ids.map(id => {
      const state = next() < 0.7 ? 'open' : 'finished';
      const pick = next();
      const review = pick < 0.15 ? { in_the_way: 'waiting on a person', in_the_way_by: 'an-agent' } : pick < 0.3 ? { review_at: '' } : { review_at: new Date(Date.parse(NOW) + Math.floor((next() - 0.5) * 7_200_000)).toISOString() };
      const depends_on = next() < 0.3 ? [ids[Math.floor(next() * count)], ...(next() < 0.2 ? ['h_missing'] : [])] : undefined;
      return { handoff_id: id, job: id, state, handed_at: NOW, ...review, ...(depends_on ? { depends_on } : {}) };
    });
    store.transaction(() => { for (const item of items) store.putHandoff(item); });
    const was = minOverEveryOpenJob(items, NOW);
    // The index's legacy read is a 32-entry window; keep asking until its durable cursor has
    // crossed any blocked prefix and the next arm carries the actual earliest time.
    // The scheduler wakes at once for any time not after now, so a review already due is compared as now.
    const dueAt = ms => Math.max(ms, Date.parse(NOW));
    const expected = was === null ? null : dueAt(Date.parse(was));
    let got;
    for (let page = 0; page < 4; page++) {
      got = agents.nextReviewAt();
      if (got === null || dueAt(got) === expected) break;
    }
    assert.equal(got === null ? null : dueAt(got), expected, `round ${round}`);
  }
});

test('a review due now answers now without reading the jobs that wait on other work', () => {
  const store = agentStoreForTests();
  const agents = makeAgents({ store, now: fixedNow });
  store.transaction(() => {
    store.putHandoff({ handoff_id: 'h_blocker', job: 'blocker', state: 'open', handed_at: NOW, review_at: '' });
    store.putHandoff({ handoff_id: 'h_due', job: 'due now', state: 'open', handed_at: NOW, review_at: '' });
    store.putHandoff({ handoff_id: 'h_waiting', job: 'waits on the blocker', state: 'open', handed_at: NOW, review_at: '2026-10-05T11:00:00.000Z', depends_on: ['h_blocker'] });
  });
  assert.equal(agents.nextReviewAt(), Date.parse(NOW));
});

test('the next review read walks the review index and stops at the first due job', () => {
  const store = agentStoreForTests();
  const agents = makeAgents({ store, now: fixedNow });
  const note = 'x'.repeat(4000);
  const reviewAt = i => new Date(Date.parse(NOW) + (i + 1) * 60_000).toISOString();
  store.transaction(() => { for (let i = 0; i < 1200; i++) store.putHandoff({ handoff_id: `h_${String(i).padStart(4, '0')}`, job: note, state: 'open', handed_at: NOW, review_at: reviewAt(i) }); });
  assert.equal(agents.nextReviewAt(), Date.parse(reviewAt(0)));
  const started = performance.now();
  for (let i = 0; i < 20; i++) agents.nextReviewAt();
  const each = (performance.now() - started) / 20;
  assert.ok(each < 2, `one read took ${each.toFixed(2)} ms`);
});

// The scheduler re-arms the review walk one second later while it has pages left (src/agent-records.mjs nextReviewAt).
// Every handoff write used to restart the walk, so under live agent writes the answer was never returned and the walk
// re-armed every second. This holds that writes between reads do not change the calls it takes to finish: one bounded
// page each, then the earliest independent job's time.
test('handoff writes between reads do not keep the review walk re-arming forever', () => {
  const store = agentStoreForTests();
  const agents = makeAgents({ store, now: fixedNow });
  const reviewAt = i => new Date(Date.parse(NOW) + (i + 1) * 60_000).toISOString();
  store.transaction(() => {
    store.putHandoff({ handoff_id: 'h_blocker', job: 'blocker', state: 'open', handed_at: NOW, review_at: reviewAt(100_000) });
    for (let i = 0; i < 1200; i++) store.putHandoff({ handoff_id: `h_${String(i).padStart(4, '0')}`, job: 'waits', state: 'open', handed_at: NOW, review_at: reviewAt(i), depends_on: ['h_blocker'] });
  });
  const continuation = Date.parse(NOW) + 1000;
  let got;
  let calls = 0;
  for (; calls < 200; calls++) {
    store.putHandoff({ handoff_id: 'h_busy', job: 'busy', state: 'open', handed_at: NOW, review_at: reviewAt(50_000), revision: calls });
    got = agents.nextReviewAt();
    if (got !== continuation) break;
  }
  assert.equal(got, Date.parse(reviewAt(50_000)), 'the walk ends with the earliest independent time while writes arrive');
  assert.ok(calls + 1 <= Math.ceil(1200 / 32) + 2, `one bounded page per read, got ${calls + 1} reads`);
});
