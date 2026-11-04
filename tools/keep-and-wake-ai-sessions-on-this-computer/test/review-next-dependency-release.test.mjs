// test/review-next-dependency-release.test.mjs
//
// Work that waits on work still open holds no entry in review_next (src/agent-records.mjs), so the writer that finishes
// what it waits on must write it again (src/agents.mjs releaseDependents). Each writer that can finish a job is run here
// with a job waiting on it, and the waiting job must be due at the next ask of nextReviewAt (what the alarm is set from),
// with the reconciler never run. A job with dependents cannot be withdrawn explicitly (withdrawalProblem); reopening finished
// work puts them back to waiting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgents } from '../../shared-code/src/agents.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords, setRecordEngine } from '../src/record-engine.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';

function fixture(store = agentStoreForTests()) {
  const instant = Date.parse('2026-10-07T12:00:00Z');
  const agents = makeAgents({ store, now: () => new Date(instant) });
  agents.publish({ agent_id: 'sender', name: 'Sender', description: 'Asks for work' }, { reader: 'app:sender' });
  agents.publish({ agent_id: 'runner', name: 'Runner', description: 'Does work' }, { reader: 'app:runner' });
  let sequence = 0;
  const hand = extra => agents.handOff({ request_key: `release-test:${++sequence}`, job: 'A requested task', from_agent: 'sender', ...extra }, { reader: 'app:sender' }).handoff;
  // Past every step the review index needs, as a store that has been running a while.
  const ready = () => { for (let step = 0; step < 10; step += 1) store.scheduledWake.step(); };
  // The dependency and the work waiting on it, with the reconciler never run.
  const pair = (first = {}) => {
    const dependency = hand(first);
    const waiting = hand({ depends_on: [dependency.handoff_id], to_agent: 'runner' });
    ready();
    return { dependency, waiting };
  };
  const next = () => agents.nextReviewAt();
  return { store, agents, hand, pair, ready, next, instant };
}

test('work waiting on a job is not due while the job is open, and is due once a writer finishes the job', () => {
  const finishers = {
    'finish': (f, { dependency }) => {
      f.agents.take({ agent_id: 'runner', handoff_id: dependency.handoff_id });
      f.agents.finish({ handoff_id: dependency.handoff_id, agent_id: 'runner', result: 'Done' });
    },
    'withdraw (not idle-only)': (f, { dependency }) => f.agents.withdraw({ handoff_id: dependency.handoff_id, by: 'sender' }),
    'closeWaiting': (f, { dependency }) => f.agents.closeWaiting({ handoff_id: dependency.handoff_id, by: 'sorter', result: { state: 'handled' } }),
    'closeDuplicate': (f, { dependency }) => {
      const twin = { ...f.store.handoff(dependency.handoff_id), handoff_id: 'h_twin' };
      f.store.putHandoff(twin);
      f.agents.closeDuplicate({ handoff_id: dependency.handoff_id, kept_id: 'h_twin', item: 'item-1', by: 'folder' });
    },
    'foldIntoMoment': (f, { dependency }) => {
      const moment = f.hand({ once_per: 'moment-1' });
      f.agents.foldIntoMoment({ keys: ['item-2'], moment_id: 'moment-1', handoff_id: moment.handoff_id });
      assert.equal(f.store.handoff(dependency.handoff_id).state, 'finished');
    },
    'invalidateMessageSource': (f, { dependency }) => f.agents.invalidateMessageSource('message-1', 'The person never wrote it.'),
  };
  const firsts = {
    'closeDuplicate': { once_per: 'item-1' },
    'foldIntoMoment': { once_per: 'item-2' },
    'invalidateMessageSource': { input: { arrived: { message_id: 'message-1' } } },
  };
  for (const [name, finish] of Object.entries(finishers)) {
    const f = fixture();
    const made = f.pair(firsts[name] ?? {});
    const waitingAt = f.store.handoff(made.waiting.handoff_id);
    assert.equal(waitingAt.waits_open, 1, `${name}: the job waits`);
    const before = f.next();
    assert.ok(before === null || before > f.instant, `${name}: while the job is open its dependent is not due (${before})`);
    finish(f, made);
    assert.equal(f.store.handoff(made.dependency.handoff_id).state, 'finished', `${name}: the job is finished`);
    assert.ok(!f.store.handoff(made.waiting.handoff_id).waits_open, `${name}: the dependent no longer says it waits`);
    const after = f.next();
    assert.ok(after !== null && after <= f.instant, `${name}: the dependent is due at the next ask (${after})`);
  }
});

test('reopening finished work puts the work that waited on it back to waiting', () => {
  const g = fixture();
  const made = g.pair();
  g.agents.take({ agent_id: 'runner', handoff_id: made.dependency.handoff_id });
  g.agents.finish({ handoff_id: made.dependency.handoff_id, agent_id: 'runner', result: 'Done' });
  assert.ok(g.next() <= g.instant, 'due after the finish');
  g.agents.reopenIncorrectFinish({ handoff_id: made.dependency.handoff_id, agent_id: 'sender', evidence: 'It was wrong.' });
  assert.equal(g.store.handoff(made.waiting.handoff_id).waits_open, 1, 'it waits again');
  const reopened = g.next();
  assert.ok(reopened === null || reopened > g.instant, 'and is not due while the reopened job is open');
});

test('reopening a prerequisite keeps a taken dependent scheduled for its hold expiry', () => {
  const f = fixture();
  const made = f.pair();
  f.agents.take({ agent_id: 'runner', handoff_id: made.dependency.handoff_id });
  f.agents.finish({ handoff_id: made.dependency.handoff_id, agent_id: 'runner', result: 'Done' });
  const taken = f.agents.take({ agent_id: 'runner', handoff_id: made.waiting.handoff_id });
  assert.equal(taken.handoff.handoff_id, made.waiting.handoff_id);
  const holdEnd = Date.parse(taken.handoff.hold_until);
  assert.equal(f.next(), holdEnd, 'the taken dependent is due when its hold ends');

  f.agents.reopenIncorrectFinish({ handoff_id: made.dependency.handoff_id, agent_id: 'sender', evidence: 'The required result is incomplete.' });
  const dependent = f.store.handoff(made.waiting.handoff_id);
  assert.equal(dependent.state, 'taken', 'reopening the prerequisite keeps the current attempt');
  assert.equal(dependent.waits_open, 1, 'the prerequisite is unfinished again');
  f.ready();
  assert.equal(f.next(), holdEnd, 'unfinished prerequisites cannot hide an active hold expiry');
  assert.ok(f.store.dueReviews(new Date(holdEnd).toISOString()).some(item => item.handoff_id === made.waiting.handoff_id),
    'the expiring hold remains actionable without finishing the prerequisite');
});

for (const engine of ['log', 'eeaf']) test(`a completed older parked pass cannot hide taken holds through bounded cold migration on ${engine}`, () => {
  const host = sqliteHost(':memory:');
  if (engine === 'eeaf') setRecordEngine(host.sql, 'eeaf');
  const opened = () => openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  const records = opened();
  const f = fixture(agentRecordStore({ records, transaction: host.transaction }));
  // Use the actual finish, take and correction writers before simulating an older saved fact layout.
  const dependency = f.hand();
  const waiting = f.hand({ depends_on: [dependency.handoff_id], to_agent: 'runner' });
  f.agents.take({ agent_id: 'runner', handoff_id: dependency.handoff_id });
  f.agents.finish({ handoff_id: dependency.handoff_id, agent_id: 'runner', result: 'Done' });
  const taken = f.agents.take({ agent_id: 'runner', handoff_id: waiting.handoff_id });
  const holdEnd = taken.handoff.hold_until;
  f.agents.reopenIncorrectFinish({ handoff_id: dependency.handoff_id, agent_id: 'sender', evidence: 'The required result is incomplete.' });

  const keys = [dependency.handoff_id, waiting.handoff_id].map(id => `agent-handoff:${id}`);
  for (let n = 0; n < 140; n += 1) {
    const handoff_id = `older-${String(n).padStart(3, '0')}`;
    f.store.putHandoff({ handoff_id, job: 'Other waiting work', state: 'open', handed_at: '2026-10-06T00:00:00Z',
      priority: 0, input: {}, in_the_way: 'An outside result is missing.', in_the_way_by: 'sender' });
    keys.push(`agent-handoff:${handoff_id}`);
  }
  records.write([
    ...keys.map(id => {
      const value = records.read(id);
      const { review_checked: _checked, review_depends: _depends, ...found } = value.found_by;
      return { id, type: 'agent-handoff', value: { ...value, found_by: {
        ...found, ...(value.waits_open ? {} : { review_depends: value.depends_on?.length ? 1 : 0 }),
      } } };
    }),
    { id: 'agent-review-mark:wake-origin-facts', type: 'agent-review-mark', value: { done: true } },
    { id: 'agent-review-mark:wake-parked', type: 'agent-review-mark', value: { done: true } },
    // Current writes can seed the replacement mark on an empty store; this fixture is the older parked-only layout.
    { id: 'agent-review-mark:review-hold-facts', type: 'agent-review-mark', value: null },
  ]);
  records.checkpoint();
  assert.ok(!records.scan('agent-handoff', 'review_next', { equal: [1, 0, holdEnd], limit: 1 }).length,
    'the older layout really omitted the taken hold');
  const markKey = 'agent-review-mark:review-hold-facts';
  assert.equal(records.read(markKey), null, 'the old completed pass is not the current review marker');

  let visited = 0;
  let current;
  for (let step = 0; step < 3; step += 1) {
    current = opened();
    let slice = 0;
    const observed = { ...current, scan(type, name, options) {
      const page = current.scan(type, name, options);
      if (type === 'agent-handoff' && name === 'time') {
        assert.ok(options.limit <= 64, 'every index range stays bounded');
        slice += page.length;
      }
      return page;
    } };
    const store = agentRecordStore({ records: observed, transaction: host.transaction });
    assert.equal(store.nextReviewAt(new Date(f.instant).toISOString()), holdEnd, 'complete fallback retains the hold during migration');
    store.scheduledWake.step();
    assert.ok(slice <= 64, `one migration step visits at most 64 jobs (${slice})`);
    visited += slice;
    const mark = current.read(markKey);
    assert.equal(mark.done, step === 2, 'readiness waits until every old open job has current review facts');
    if (step < 2) assert.equal(current.read(`agent-handoff:${waiting.handoff_id}`).found_by.review_checked, undefined,
      'the late-page hold has not been repaired by reading the whole backlog');
    current.checkpoint();
  }
  assert.equal(visited, keys.length, 'cold steps resume after their cursor without rereading earlier jobs');
  const repaired = current.read(`agent-handoff:${waiting.handoff_id}`).found_by;
  assert.equal(repaired.review_checked, 1);
  assert.equal(repaired.review_depends, 0, 'the hold review itself has no prerequisite');
  assert.equal(repaired.review_at, holdEnd);
  current = opened();
  const store = agentRecordStore({ records: current, transaction: host.transaction });
  assert.equal(store.nextReviewAt(new Date(f.instant).toISOString()), holdEnd, 'the complete new index survives a cold reopen');
  let writes = 0;
  const quiet = agentRecordStore({ records: { ...current, write(...args) { writes += 1; return current.write(...args); } },
    transaction: host.transaction });
  quiet.scheduledWake.step();
  assert.equal(writes, 0, 'a completed migration does not rewrite facts or its marker');
  assert.equal(current.read(markKey).done, true, 'the completed pass remains complete');
});
