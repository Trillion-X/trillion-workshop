// test/agent-records.test.mjs
// The agents store kept as records (src/agent-records.mjs): pages of open work and the taking order hold past one page,
// a transaction writes one log row however many records it keeps, and a store's earlier agent tables move into
// records (src/tables-into-records.mjs) with what it needs at once first, nothing newer replaced, and the tables dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords, setRecordEngine } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { agentRecordStore, AGENT_RECORD_TABLES } from '../../hand-work-to-ais/agent-records.mjs';
import { agentLegacyRows } from '../../hand-work-to-ais/agent-legacy-rows.mjs';
import { makeAgents, scheduledHandoffOf } from '../../shared-code/src/agents.mjs';
import { FIRST_SCAN, tablesIntoRecords } from '../src/tables-into-records.mjs';

function opened() {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  return { host, records, store: agentRecordStore({ records, transaction: host.transaction }) };
}
const at = n => new Date(Date.UTC(2026, 9, 5) + n * 1000).toISOString();
const job = (n, extra = {}) => ({ handoff_id: `h_${String(n).padStart(4, '0')}`, job: `job ${n}`, state: 'open', handed_at: at(n), to_agent: null, taken_by: null, priority: 0, ...extra });

test('open work pages past a page, in the order it is handed, and finished work newest first', () => {
  const { store } = opened();
  store.transaction(() => { for (let n = 0; n < 250; n += 1) store.putHandoff(job(n, n % 5 === 0 ? { state: 'finished' } : {})); });
  const seen = [];
  for (let page = store.openHandoffs({ limit: 100 }); page.length; page = page.length < 100 ? [] : store.openHandoffs({ after: page.at(-1).handoff_id, limit: 100 })) seen.push(...page.map(item => item.handoff_id));
  assert.equal(seen.length, 200);
  assert.deepEqual(seen, [...seen].sort());
  const finished = store.finishedHandoffs({ limit: 20 });
  assert.equal(finished[0].handoff_id, 'h_0245');
  assert.equal(store.finishedHandoffs({ before: finished.at(-1).handoff_id, limit: 20 })[0].handoff_id, 'h_0145');
  assert.equal(store.newestOpen(1)[0].handoff_id, 'h_0249');
});

for (const engine of ['log', 'eeaf']) test(`newest open and finished pages cross tied timestamps without gaps on ${engine}`, () => {
  const host = sqliteHost(':memory:');
  if (engine === 'eeaf') setRecordEngine(host.sql, 'eeaf');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  const store = agentRecordStore({ records, transaction: host.transaction });
  store.transaction(() => { for (let n = 0; n < 80; n += 1) store.putHandoff(job(n, { handed_at: at(1), ...(n % 2 ? {} : { state: 'finished' }) })); });
  for (const finished of [false, true]) {
    const seen = [];
    let before = null;
    do {
      const page = finished ? store.finishedHandoffs({ before, limit: 7 }) : store.newestOpen(7, { before });
      if (!page.length) break;
      assert.ok(page.length <= 7);
      seen.push(...page.map(row => row.handoff_id));
      before = page.at(-1).handoff_id;
      // Ending an open cursor's job must not rewind or invalidate the next page.
      if (!finished) store.putHandoff({ ...store.handoff(before), state: 'finished' });
    } while (true);
    if (!finished) assert.deepEqual(seen, Array.from({ length: 40 }, (_, n) => job(79 - n * 2).handoff_id));
    else assert.deepEqual(seen, Array.from({ length: 80 }, (_, n) => job(79 - n).handoff_id).filter(id => store.handoff(id).state === 'finished'));
    assert.equal(new Set(seen).size, seen.length);
  }
  assert.deepEqual(store.newestOpen(7, { before: 'missing' }), []);
});

test('selected parent reads match single-parent reads on the earlier record engine', () => {
  const host = sqliteHost(':memory:');
  setRecordEngine(host.sql, 'eeaf');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  const store = agentRecordStore({ records, transaction: host.transaction });
  store.putHandoff(job(1, { parent_handoff_id: 'parent-b' }));
  store.putHandoff(job(2, { parent_handoff_id: 'parent-a' }));
  store.putHandoff(job(3, { parent_handoff_id: 'parent-b', state: 'finished' }));
  store.putHandoff(job(4, { parent_handoff_id: 'other' }));
  const groups = store.handedOnFromMany(['parent-b', 'parent-a', 'missing']);
  assert.deepEqual(groups.get('parent-b'), store.handedOnFrom('parent-b'));
  assert.deepEqual(groups.get('parent-a'), store.handedOnFrom('parent-a'));
  assert.deepEqual(groups.get('missing'), []);
  assert.deepEqual(groups.get('parent-b').map(item => item.handoff_id), ['h_0001', 'h_0003']);
});

test('the next delivery reuses its index answer until a delivery changes', () => {
  const { host, records } = opened();
  let dueScans = 0;
  const observed = { ...records, scan: (...args) => {
    if (args[1] === 'due') dueScans += 1;
    return records.scan(...args);
  } };
  const store = agentRecordStore({ records: observed, transaction: host.transaction });
  const delivery = (id, seconds, state = 'waiting') => ({ event_id: id, agent_id: 'mac',
    event: { subject_id: 'h_0001' }, state, attempts: 0, next_at: at(seconds), created_at: at(seconds) });
  store.putDelivery(delivery('first', 5));
  assert.equal(store.nextDeliveryAt(), Date.parse(at(5)));
  assert.equal(store.nextDeliveryAt(), Date.parse(at(5)));
  store.putHandoff(job(1));
  assert.equal(store.nextDeliveryAt(), Date.parse(at(5)), 'unrelated records do not reopen the due index');
  assert.equal(dueScans, 1);
  store.putDelivery(delivery('second', 1));
  assert.equal(store.nextDeliveryAt(), Date.parse(at(1)));
  store.putDelivery(delivery('second', 1, 'delivered'));
  assert.equal(store.nextDeliveryAt(), Date.parse(at(5)));
  store.putDelivery(delivery('first', 5, 'delivered'));
  assert.equal(store.nextDeliveryAt(), null);
  assert.equal(dueScans, 4, 'each delivery change refreshes the due index');
});

test('stream pull stops after 50 ready deliveries across future rows and tied timestamps', () => {
  const { host, records } = opened();
  const scans = [];
  const reads = [];
  const observed = { ...records,
    scan: (...args) => { if (args[1] === 'agent') scans.push(args[2]); return records.scan(...args); },
    read: key => { if (key.startsWith('agent-delivery:')) reads.push(key); return records.read(key); },
    readMany: keys => { reads.push(...keys.filter(key => key.startsWith('agent-delivery:'))); return records.readMany(keys); },
  };
  const store = agentRecordStore({ records: observed, transaction: host.transaction });
  const delivery = (id, created_at, next_at) => ({ event_id: id, agent_id: 'mac',
    event: { event_id: id }, state: 'waiting', attempts: 0, created_at, next_at });
  store.transaction(() => {
    for (let n = 0; n < 85; n += 1) store.putDelivery(delivery(`future-${String(n).padStart(3, '0')}`, at(0), at(999)));
    for (let n = 0; n < 1400; n += 1) store.putDelivery(delivery(`ready-${String(n).padStart(4, '0')}`, at(1), null));
    store.putDelivery({ ...delivery('other-agent', at(0), null), agent_id: 'other' });
  });
  assert.deepEqual(store.streamWaiting('mac').map(item => item.event_id),
    Array.from({ length: 50 }, (_, n) => `ready-${String(n).padStart(4, '0')}`));
  assert.equal(reads.length, 135, 'only the future prefix and first 50 ready bodies are hydrated');
  assert.ok(scans.every(options => options.limit <= 50), 'each index request stays bounded');
  assert.ok(scans.some(options => options.idFrom), 'a tied timestamp resumes after its last ID');
});

test('selected parent reads see jobs written earlier in the same transaction', () => {
  const { store } = opened();
  store.transaction(() => {
    store.putHandoff(job(1, { parent_handoff_id: 'parent-a' }));
    assert.deepEqual(store.handedOnFromMany(['parent-a']).get('parent-a').map(item => item.handoff_id), ['h_0001']);
  });
});

test('work is taken highest priority first, then oldest, and work only preferred for an agent joins the queue once its time has passed', () => {
  const { store } = opened();
  store.putHandoff(job(1));
  store.putHandoff(job(2, { priority: 5 }));
  store.putHandoff(job(3, { to_agent: 'mac', target: { strict: false, prefer_until: at(100) } }));
  store.putHandoff(job(4, { to_agent: 'mac', priority: 9 }));
  store.putHandoff(job(5, { priority: 5 }));
  const ids = page => page.map(item => item.handoff_id);
  assert.deepEqual(ids(store.openQueue({ nowIso: at(50) })), ['h_0002', 'h_0005', 'h_0001']);
  assert.deepEqual(ids(store.openQueue({ nowIso: at(200) })), ['h_0002', 'h_0005', 'h_0001', 'h_0003']);
  assert.deepEqual(ids(store.openQueue({ nowIso: at(200), after: 'h_0005' })), ['h_0001', 'h_0003']);
  assert.deepEqual(ids(store.openQueue({ to_agent: 'mac', nowIso: at(50) })), ['h_0004', 'h_0003']);
  assert.deepEqual(ids(store.pendingAddressedTo(['mac', 'nobody'], 5)), ['h_0004', 'h_0003']);
  assert.equal(store.waitingCount('mac'), 2);
});

test('pending work batches recipient prefixes and reads only the winning job bodies', () => {
  const { host, records } = opened();
  const scans = [];
  const selections = [];
  const reads = [];
  const observed = {
    ...records,
    scan: (...args) => { if (args[1] === 'pending') scans.push(args); return records.scan(...args); },
    scanSelectedValues: (...args) => { selections.push(args); return records.scanSelectedValues(...args); },
    read: key => { if (key.startsWith('agent-handoff:')) reads.push(key); return records.read(key); },
    readMany: keys => { reads.push(...keys.filter(key => key.startsWith('agent-handoff:'))); return records.readMany(keys); },
  };
  const store = agentRecordStore({ records: observed, transaction: host.transaction });
  const jobs = [];
  store.transaction(() => {
    for (let n = 0; n < 600; n += 1) {
      const item = job(n, { to_agent: `agent-${n % 4}`, priority: (n * 7) % 10,
        handed_at: at(Math.floor(n / 3)), state: n % 13 === 0 ? 'taken' : 'open', input: { note: 'x'.repeat(2048) } });
      jobs.push(item);
      store.putHandoff(item);
    }
  });
  const ids = ['agent-1', 'agent-2', 'agent-3'];
  const expected = jobs.filter(item => item.state === 'open' && ids.includes(item.to_agent))
    .sort((a, b) => b.priority - a.priority || a.handed_at.localeCompare(b.handed_at) || a.handoff_id.localeCompare(b.handoff_id))
    .slice(0, 20).map(item => item.handoff_id);
  assert.deepEqual(store.pendingAddressedTo(ids, 20).map(item => item.handoff_id), expected);
  assert.equal(selections.length, 1);
  assert.deepEqual(selections[0][2], { equal: ['open'], values: ids, limit: 20 });
  assert.equal(scans.length, 0, 'the record store batches the selected prefixes');
  assert.equal(reads.length, 20, 'only the selected full job bodies are read');
  assert.deepEqual(store.pendingAddressedTo(ids, 0), []);
  assert.equal(selections.length, 1, 'a zero-size greeting does not open the index');
});

test('the work board reads agent loads in two shared index walks', () => {
  const { host, records } = opened();
  const scans = [];
  const observed = { ...records, scan: (...args) => { scans.push(args[1]); return records.scan(...args); } };
  const store = agentRecordStore({ records: observed, transaction: host.transaction });
  store.transaction(() => {
    store.putHandoff(job(1, { to_agent: 'a' }));
    store.putHandoff(job(2, { to_agent: 'b', taken_by: 'a', state: 'taken' }));
    store.putHandoff(job(3, { to_agent: 'b' }));
    store.putHandoff(job(4, { to_agent: 'a', state: 'finished', taken_by: 'b' }));
  });
  const loads = store.boardAgentLoads(['a', 'b', 'none']);
  assert.deepEqual(scans, ['held', 'pending']);
  for (const id of ['a', 'b', 'none']) {
    assert.deepEqual(loads.held.get(id), store.heldBy(id));
    assert.equal(loads.waiting.get(id), store.waitingCount(id));
  }
  scans.length = 0;
  const heldOnly = store.boardAgentLoads(['a', 'b'], { includeWaiting: false });
  assert.deepEqual(scans, ['held']);
  assert.deepEqual(heldOnly.held.get('a'), store.heldBy('a'));
});

test('a seeded held-work lookup stays bounded after reopening a fragmented store', () => {
  const host = sqliteHost(':memory:');
  let olderJobsMoving = true;
  const open = () => {
    const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text, runs: { max_runs: 1000 } });
    return { records, store: agentRecordStore({ records, transaction: host.transaction, heldSummaryReady: () => !olderJobsMoving }) };
  };
  let { records, store } = open();
  for (let n = 0; n < 80; n += 1) {
    store.putHandoff(job(n, { state: 'taken', taken_by: 'another-agent' }));
    records.checkpoint();
  }
  olderJobsMoving = false;
  ({ records, store } = open());
  let pageReads = 0;
  const exec = host.sql.exec.bind(host.sql);
  host.sql.exec = (query, ...params) => {
    if (/SELECT body FROM record_keys_run_\d+ WHERE page = \?/.test(query)) pageReads += 1;
    return exec(query, ...params);
  };
  assert.deepEqual(store.heldBy('empty-agent'), []);
  assert.ok(pageReads <= 3, `${pageReads} page reads with a complete held summary`);
  records.checkpoint();

  ({ records, store } = open());
  pageReads = 0;
  assert.deepEqual(store.heldBy('empty-agent'), []);
  assert.ok(pageReads <= 3, `${pageReads} page reads after a cold reopen`);
});

test('the first held-work read for several agents seeds their summaries in one pass', () => {
  const { host, records } = opened();
  let olderJobsMoving = true;
  const scans = [];
  const observed = { ...records, scan: (...args) => { scans.push({ name: args[1], equal: args[2].equal }); return records.scan(...args); } };
  const store = agentRecordStore({ records: observed, transaction: host.transaction, heldSummaryReady: () => !olderJobsMoving });
  store.transaction(() => {
    store.putHandoff(job(1, { state: 'taken', taken_by: 'a' }));
    store.putHandoff(job(2, { state: 'taken', taken_by: 'b' }));
    store.putHandoff(job(3, { state: 'taken', taken_by: 'a' }));
    store.putHandoff(job(4, { state: 'open' }));
  });
  olderJobsMoving = false;
  const before = host.db.prepare('SELECT COUNT(*) AS n FROM record_log').get().n;
  assert.deepEqual(store.heldByMany(['a', 'b', 'empty']).map(item => item.handoff_id), ['h_0001', 'h_0003', 'h_0002']);
  assert.deepEqual(scans, [{ name: 'held', equal: [1] }]);
  assert.equal(host.db.prepare('SELECT COUNT(*) AS n FROM record_log').get().n - before, 1);
  scans.length = 0;
  assert.deepEqual(store.heldByMany(['a', 'b', 'empty']).map(item => item.handoff_id), ['h_0001', 'h_0003', 'h_0002']);
  assert.deepEqual(scans, [], 'seeded agents use their exact-key summaries');
  assert.deepEqual(store.heldByMany(['a', 'b', 'new']).map(item => item.handoff_id), ['h_0001', 'h_0003', 'h_0002']);
  assert.deepEqual(scans, [{ name: 'held', equal: [1, 'new'] }], 'one missing agent uses its selected index range');
});

for (const engine of ['log', 'eeaf']) test(`new handoffs maintain every hold and certify dependency facts through a cold reopen on ${engine}`, () => {
  const host = sqliteHost(':memory:');
  if (engine === 'eeaf') setRecordEngine(host.sql, 'eeaf');
  let records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  let store = agentRecordStore({ records, transaction: host.transaction });
  store.transaction(() => {
    store.putHandoff(job(0, { state: 'taken', taken_by: 'first', hold_until: at(500) }));
    for (let n = 1; n < 300; n += 1) store.putHandoff(job(n, { depends_on: ['unrelated'] }));
    store.putHandoff(job(300, { depends_on: [job(0).handoff_id, 'another-parent'] }));
  });
  assert.equal(records.read('agent-review-mark:dependency-facts').done, true);
  assert.deepEqual(records.read('agent-held-work:first').ids, [job(0).handoff_id]);
  records.checkpoint();
  records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  const bodies = [], scans = [];
  const observed = { ...records,
    read: key => { if (key.startsWith('agent-handoff:')) bodies.push(key); return records.read(key); },
    readMany: keys => { bodies.push(...keys.filter(key => key.startsWith('agent-handoff:'))); return records.readMany(keys); },
    scan: (...args) => { scans.push(args[1]); return records.scan(...args); },
  };
  store = agentRecordStore({ records: observed, transaction: host.transaction });
  assert.deepEqual(store.heldLoad('newcomer'), []);
  assert.deepEqual(store.heldBy('newcomer'), []);
  assert.deepEqual(store.heldByMany(['first', 'newcomer']).map(item => item.handoff_id), [job(0).handoff_id]);
  assert.deepEqual(scans, [], 'an absent held summary is empty only under the durable complete mark');
  bodies.length = 0;
  assert.deepEqual(store.dependentsOf(job(0).handoff_id).map(item => item.handoff_id), [job(300).handoff_id]);
  assert.deepEqual(bodies, [`agent-handoff:${job(300).handoff_id}`], 'only the matching dependency body is read');
});

test('dependency completion never releases a new job while another prerequisite is unfinished', () => {
  const { store } = opened();
  const agents = makeAgents({ store, now: () => new Date(at(10)) });
  agents.publish({ agent_id: 'worker', name: 'Worker', description: 'Finishes jobs', capacity: { max_concurrent: 3 } });
  const first = agents.handOff({ request_key: 'first', job: 'First', to_agent: 'worker' }).handoff;
  const second = agents.handOff({ request_key: 'second', job: 'Second', to_agent: 'worker' }).handoff;
  const child = agents.handOff({ request_key: 'child', job: 'Child', to_agent: 'worker', depends_on: [first.handoff_id, second.handoff_id] }).handoff;
  for (const parent of [first, second]) {
    assert.equal(agents.take({ agent_id: 'worker', handoff_id: child.handoff_id }).handoff, null);
    const taken = agents.take({ agent_id: 'worker', handoff_id: parent.handoff_id });
    agents.finish({ agent_id: 'worker', handoff_id: parent.handoff_id, generation: taken.generation, result: 'Finished' });
  }
  assert.equal(agents.take({ agent_id: 'worker', handoff_id: child.handoff_id }).handoff.handoff_id, child.handoff_id);
});

test('existing dependency facts beyond a migration page cannot be certified as a new store or silently missed', () => {
  const { host, records } = opened();
  const parent = 'earlier-parent';
  records.write(Array.from({ length: 150 }, (_, n) => ({
    id: `agent-handoff:${job(n).handoff_id}`, type: 'agent-handoff',
    value: { ...job(n, { depends_on: [parent] }), found_by: { open: 1, depends: 1, handed_at: at(n) } },
  })), { actor: { by: 'earlier-agent' } });
  const store = agentRecordStore({ records, transaction: host.transaction });
  store.putHandoff(job(200));
  assert.equal(records.read('agent-held-work-state:complete'), null);
  assert.equal(records.read('agent-review-mark:dependency-facts'), null);
  assert.deepEqual(store.dependentsOf(parent).map(item => item.handoff_id), Array.from({ length: 150 }, (_, n) => job(n).handoff_id));
  assert.equal(records.read('agent-review-mark:dependency-facts').done, false, 'only one old-fact migration page was checked');
});

test('held summaries follow taking, reassignment and finishing in one handoff write', () => {
  const { host, records, store } = opened();
  const a = job(1, { state: 'taken', taken_by: 'a', revision: 1 });
  store.putHandoff(a);
  assert.deepEqual(store.heldBy('a').map(item => item.handoff_id), [a.handoff_id]);
  assert.deepEqual(store.heldBy('b'), []);
  const before = host.db.prepare('SELECT COUNT(*) AS n FROM record_log').get().n;
  store.putHandoff({ ...a, taken_by: 'b', revision: 2 });
  assert.equal(host.db.prepare('SELECT COUNT(*) AS n FROM record_log').get().n - before, 1,
    'handoff and both summaries share one log row');
  assert.deepEqual(store.heldBy('a'), []);
  assert.deepEqual(store.heldBy('b').map(item => item.handoff_id), [a.handoff_id]);
  const mark = records.changeSeq();
  store.putHandoff({ ...a, taken_by: 'b', hold_until: at(100), revision: 3 });
  // The summary keeps each job's hold beside its id (so counting an agent's slots reads no job), so a renewed hold is
  // that one small line of the summary, written in the same log row as the handoff.
  assert.deepEqual(records.changedSince(mark), ['agent-schedule-state:handoffs', 'agent-held-work:b', `agent-handoff:${a.handoff_id}`],
    'renewing the same hold advances the durable schedule revision and updates only that job\'s hold in its agent summary');
  assert.deepEqual(Object.keys(records.read('agent-held-work:b').holds), [a.handoff_id]);
  assert.equal(records.read('agent-held-work:b').holds[a.handoff_id].hold_until, at(100));
  store.putHandoff({ ...a, taken_by: 'b', state: 'finished', revision: 4 });
  assert.deepEqual(store.heldBy('b'), []);
  assert.deepEqual(records.read('agent-held-work:b').ids, []);
});

test('waiting event reads stop at the caller\'s delivery limit', () => {
  const { store } = opened();
  store.transaction(() => {
    for (let n = 0; n < 250; n++) store.putDelivery({ event_id: `event-${n}`, agent_id: 'mac', event: { subject_id: 'proof' }, state: 'waiting', created_at: at(n), next_at: at(n) });
  });
  assert.equal(store.waitingFor('mac', 200), 200);
  assert.equal(store.waitingFor('mac'), 250);
});

test('due-work timing is read from the wake index once every open job has its wake facts, and a changed handoff shows at once', () => {
  const { host, records } = opened();
  let handoffReads = 0;
  const observed = {
    ...records,
    read: id => {
      if (id.startsWith('agent-handoff:')) handoffReads += 1;
      return records.read(id);
    },
  };
  const store = agentRecordStore({ records: observed, transaction: host.transaction });
  store.transaction(() => {
    for (let n = 0; n < 120; n += 1) store.putHandoff(job(n, { input: { note: 'x'.repeat(4096) } }));
  });
  // Every handoff is written with its wake facts (wakeFactsOf), so a store that never held an older handoff is ready from construction.
  assert.equal(store.scheduledWake.ready(), true, 'a store whose handoffs are written with their wake facts is ready from the start');
  assert.equal(store.openScheduledHandoffs().length, 120);
  handoffReads = 0;
  const first = store.openScheduledHandoffs();
  assert.equal(first.length, 120);
  assert.equal(first[0].state, 'open');
  assert.equal(first[0].priority, 0);
  assert.equal(handoffReads, 0, 'a clock read does not hydrate the jobs');
  assert.deepEqual(first, store.openHandoffs().map(item => scheduledHandoffOf(item)), 'the index says what the jobs say');
  first[0].priority = 99;
  assert.equal(store.openScheduledHandoffs()[0].priority, 0, 'a caller cannot change what the next read sees');
  store.putCard({ agent_id: 'mac', name: 'Mac', takes_work: true });
  assert.equal(store.openScheduledHandoffs().length, 120);
  store.putHandoff(job(0, { priority: 9, state: 'taken', taken_by: 'mac', hold_until: at(300) }));
  handoffReads = 0;
  const changed = store.openScheduledHandoffs()[0];
  assert.equal(changed.priority, 9);
  assert.equal(changed.state, 'taken');
  assert.equal(changed.hold_until, at(300));
  assert.equal(handoffReads, 0, 'a changed handoff is in the index when it is written');
  store.putHandoff(job(0, { state: 'finished' }));
  assert.equal(store.openScheduledHandoffs().length, 119);
  store.putHandoff(job(120, { priority: 2 }));
  assert.equal(store.openScheduledHandoffs().length, 120);
  assert.equal(handoffReads, 0);
});

test('wake indexes and bounded summaries retain capability needs including an older model-road carrier', () => {
  const { host, records } = opened();
  const store = agentRecordStore({ records, transaction: host.transaction });
  store.putHandoff(job(1, { input: { needs: ['code', 'files'], note: 'Large input '.repeat(1000) } }));
  store.putHandoff(job(2, { from_agent: 'trillion-model-road', input: {} }));
  const summaries = store.openScheduledHandoffs();
  assert.deepEqual(summaries.map(item => item.input.needs), [['code', 'files'], ['subscription-ai']]);
  assert.ok(summaries.every(item => !('note' in item.input)), 'large instructions stay out of timing summaries');
  const indexed = store.scheduledWake.rows({ to_agent: '', priority: 0, limit: 10 }).map(entry => entry.item);
  assert.deepEqual(indexed.map(item => item.input.needs), summaries.map(item => item.input.needs));
});

test('take facts are kept on jobs written before them a page at a time, and the index is trusted only when every open job has them', () => {
  const { host, records } = opened();
  const store = agentRecordStore({ records, transaction: host.transaction });
  const nowIso = at(10_000);
  // Jobs as an earlier version wrote them: no facts for a take to find them by.
  records.write(Array.from({ length: 150 }, (_, n) => ({ id: `agent-handoff:${job(n).handoff_id}`, type: 'agent-handoff', value: { ...job(n), found_by: { open: 1, handed_at: job(n).handed_at } } })), { actor: { by: 'trillion' } });
  const kept = () => Array.from({ length: 150 }, (_, n) => records.read(`agent-handoff:${job(n).handoff_id}`).found_by.takes).filter(Boolean).length;
  const taking = () => store.openQueue({ nowIso, limit: 5, takeable: { source_id: '' } }).map(item => item.handoff_id);
  assert.equal(store.takeable.ready(), false);
  assert.equal(kept(), 0);
  assert.deepEqual(taking(), [], 'no job is found by facts it does not have');
  const kinds = [];
  for (let step = 0; !store.takeable.ready(); step += 1) {
    assert.ok(step < 10);
    store.takeable.step();
    kinds.push(kept());
  }
  assert.deepEqual(kinds, [64, 128, 150], 'a step keeps one page of jobs');
  assert.deepEqual(taking(), ['h_0000', 'h_0001', 'h_0002', 'h_0003', 'h_0004'], 'oldest first');
  assert.deepEqual(store.openQueue({ nowIso, after: 'h_0004', limit: 3, takeable: { source_id: '' } }).map(item => item.handoff_id), ['h_0005', 'h_0006', 'h_0007']);
  store.putHandoff(job(0, { priority: 3 }));
  store.putHandoff(job(1, { to_agent: 'mac' }));
  store.putHandoff(job(2, { in_the_way: 'Waiting for a source connection', in_the_way_by: 'ai-3', in_the_way_at: at(2) }));
  store.putHandoff(job(3, { state: 'taken', taken_by: 'mac', hold_until: at(20_000) }));
  assert.deepEqual(taking(), ['h_0000', 'h_0004', 'h_0005', 'h_0006', 'h_0007'], 'priority first; addressed, stuck and held jobs are not in the way of the rest');
  store.putHandoff(job(5, { take_by: at(5) }));
  assert.deepEqual(store.takeable.lapsed({ to_agent: '', nowIso, limit: 10 }).map(item => item.handoff_id), ['h_0005'], 'work past its take_by is found by it');
  assert.deepEqual(store.takeable.lapsed({ to_agent: 'mac', nowIso, limit: 10 }), []);
});

test('review time is earliest while each bounded continuation walks only one page', () => {
  const { host, records } = opened();
  let handoffReads = 0;
  const observed = { ...records, read: id => {
    if (id.startsWith('agent-handoff:')) handoffReads += 1;
    return records.read(id);
  } };
  const store = agentRecordStore({ records: observed, transaction: host.transaction });
  store.transaction(() => {
    for (let n = 0; n < 70; n += 1) store.putHandoff(job(n, { review_at: '', depends_on: ['missing'] }));
    store.putHandoff(job(100, { review_at: '' }));
    store.putHandoff(job(101, { review_at: at(200) }));
  });
  const settledReviewAt = (nowIso, expected) => {
    let result;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      result = store.nextReviewAt(nowIso);
      if (result === expected) break;
    }
    return result;
  };
  assert.equal(settledReviewAt(at(10), at(10)), at(10));
  assert.equal(settledReviewAt(at(300), at(200)), at(200), 'a timed review becomes earlier as time advances');
  store.putCard({ agent_id: 'mac', name: 'Mac' });
  assert.equal(settledReviewAt(at(20), at(20)), at(20));
  store.putHandoff(job(101, { review_at: at(5) }));
  assert.equal(settledReviewAt(at(20), at(5)), at(5));
  store.putHandoff(job(101, { state: 'finished' }));
  handoffReads = 0;
  assert.equal(settledReviewAt(at(20), at(20)), at(20), 'work ready as it stands is due now');
  assert.ok(handoffReads <= 8 * 32, 'each continuation reads at most one bounded page of review bodies');
  store.putHandoff(job(100, { review_at: at(400) }));
  assert.equal(settledReviewAt(at(20), at(400)), at(400), 'work waiting on a handoff that is not there is not ready');
});

test('due review search resumes inside a tied timestamp when now advances and handoffs change', () => {
  const { host, records } = opened();
  const scans = [];
  const observe = backing => ({ ...backing, scan: (type, name, options) => {
    if (type === 'agent-handoff' && name === 'review') scans.push(options);
    return backing.scan(type, name, options);
  } });
  let store = agentRecordStore({ records: observe(records), transaction: host.transaction });
  store.transaction(() => {
    for (let n = 0; n < 100; n += 1) store.putHandoff(job(n, { review_at: at(100), depends_on: ['still-open'] }));
    store.putHandoff(job(200, { review_at: at(100), state: 'open' }));
  });
  const blocked = id => id !== 'still-open';
  assert.deepEqual(store.dueReviews(at(200), 10, blocked), []);
  const firstCursor = records.read('agent-review-mark:due-review-search').cursor;
  assert.ok(firstCursor);
  records.checkpoint();
  const reopened = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  store = agentRecordStore({ records: observe(reopened), transaction: host.transaction });
  assert.deepEqual(store.dueReviews(at(201), 10, blocked), []);
  const secondCursor = reopened.read('agent-review-mark:due-review-search').cursor;
  assert.ok(secondCursor && secondCursor.id > firstCursor.id, 'advancing now continues past the saved tuple');
  // An unrelated handoff write advances the revision, but does not restart the scan at its first tied row.
  store.putHandoff(job(300, { review_at: at(100), state: 'finished' }));
  assert.deepEqual(store.dueReviews(at(200), 10, blocked), []);
  const thirdCursor = reopened.read('agent-review-mark:due-review-search').cursor;
  assert.ok(thirdCursor && thirdCursor.id > secondCursor.id, 'a changed revision still makes bounded forward progress');
  assert.deepEqual(store.dueReviews(at(200), 10, blocked), [store.handoff('h_0200')]);
  assert.ok(scans.slice(-2).some(options => options.idFrom), 'the tied timestamp is resumed with an id boundary');
  assert.ok(scans.every(options => options.limit <= 33), 'no review index read exceeds one bounded page');
});

test('next review resumes inside a blocked timestamp across clocks and unrelated handoff writes', () => {
  const { host, records } = opened();
  const scans = [];
  const observed = { ...records, scan: (type, name, options) => {
    if (type === 'agent-handoff' && name.startsWith('review')) scans.push(options);
    return records.scan(type, name, options);
  } };
  const store = agentRecordStore({ records: observed, transaction: host.transaction });
  store.transaction(() => {
    for (let n = 0; n < 70; n += 1) store.putHandoff(job(n, { review_at: '', depends_on: ['still-open'] }));
    store.putHandoff(job(200, { review_at: at(100) }));
  });
  const first = store.nextReviewAt(at(10));
  assert.equal(first, at(11), 'unfinished search schedules a later pass instead of spinning immediately');
  const cursor1 = records.read('agent-review-mark:next-review-search').cursor;
  assert.ok(cursor1);
  const second = store.nextReviewAt(at(20));
  assert.equal(second, at(21));
  const cursor2 = records.read('agent-review-mark:next-review-search').cursor;
  assert.ok(cursor2 && cursor2.id > cursor1.id, 'a later clock continues after the saved tuple');
  // An unrelated write does not restart the walk: the saved position stays and the pass finishes.
  store.putHandoff(job(300, { state: 'finished', review_at: at(50) }));
  let result = store.nextReviewAt(at(20));
  for (let attempt = 0; attempt < 8 && result !== at(100); attempt += 1) result = store.nextReviewAt(at(20));
  assert.equal(result, at(100), 'the first ready timed review is found after the blocked prefix');
  // A job made ready behind the saved position is found by the next full pass, not missed.
  store.putHandoff(job(301, { review_at: at(5), depends_on: ['gate'] }));
  store.putHandoff({ ...job(999), handoff_id: 'gate', state: 'finished', review_at: '' });
  let found = null;
  for (let attempt = 0; attempt < 80 && found !== at(5); attempt += 1) found = store.nextReviewAt(at(20));
  assert.equal(found, at(5), 'a job that became ready behind the saved position is found by the next pass');
  assert.ok(scans.every(options => options.limit <= 33), 'every review lookup asks for one bounded page');
});

test('due-review continuation revisits earlier rows after their dependency finishes', () => {
  const { host, records } = opened();
  const store = agentRecordStore({ records, transaction: host.transaction });
  store.transaction(() => {
    store.putHandoff(job(0, { review_at: at(100), depends_on: ['h_0200'] }));
    for (let n = 1; n <= 100; n += 1) store.putHandoff(job(n, { review_at: at(100), depends_on: ['still-open'] }));
    store.putHandoff(job(200, { review_at: at(100) }));
  });
  assert.deepEqual(store.dueReviews(at(200), 10), []);
  assert.deepEqual(store.dueReviews(at(201), 10), []);
  store.putHandoff(job(200, { state: 'finished' }));
  assert.deepEqual(store.dueReviews(at(201), 10), []);
  assert.deepEqual(store.dueReviews(at(201), 10), []);
  assert.deepEqual(store.dueReviews(at(201), 10), [store.handoff('h_0000')], 'the next pass sees a row whose prerequisite changed before its cursor');
});

test('records kept in one transaction are one log row, read back inside it, and seen by every question', () => {
  const { host, store } = opened();
  const logRows = () => host.db.prepare('SELECT COUNT(*) AS n FROM record_log').get().n;
  const before = logRows();
  store.transaction(() => {
    store.putHandoff(job(1, { to_agent: 'mac' }));
    store.putDelivery({ event_id: 'ev_1', agent_id: 'mac', event: { subject_id: 'h_0001' }, state: 'waiting', attempts: 0, next_at: at(1), created_at: at(1) });
    store.putCard({ agent_id: 'mac', name: 'Mac', takes_work: true, reader: 'key:1', delivery: { url: 'https://mac.example/events' } });
    assert.equal(store.handoff('h_0001').to_agent, 'mac');
    assert.deepEqual(store.dueDeliveries(at(5)).map(item => item.event_id), ['ev_1']);
  });
  assert.equal(logRows() - before, 1, 'three records, one log row');
  assert.deepEqual(store.reachableCards().map(card => card.agent_id), ['mac']);
  assert.equal(store.nextDeliveryAt(), Date.parse(at(1)));
  assert.throws(() => store.transaction(() => { store.putCard({ agent_id: 'gone', name: 'Gone' }); throw new Error('stop'); }));
  assert.equal(store.card('gone'), null, 'a transaction that fails keeps nothing');
});

test('a store moves its agent tables into records: what it needs at once first, nothing newer replaced, then each table dropped', () => {
  const { host, records, store } = opened();
  const sql = host.sql;
  sql.exec('CREATE TABLE agent_cards (agent_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE agent_delivery_secrets (agent_id TEXT PRIMARY KEY, secret TEXT NOT NULL)');
  sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE agent_deliveries (event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, subject_id TEXT NOT NULL, state TEXT NOT NULL, next_at TEXT, value TEXT NOT NULL)');
  sql.exec('INSERT INTO agent_cards VALUES (?, ?)', 'mac', JSON.stringify({ agent_id: 'mac', name: 'Mac', takes_work: true, reader: 'key:1' }));
  sql.exec('INSERT INTO agent_delivery_secrets VALUES (?, ?)', 'mac', 'secret-1');
  for (let n = 0; n < 30; n += 1) {
    const item = job(n, n < 25 ? { state: 'finished' } : {});
    sql.exec('INSERT INTO agent_handoffs VALUES (?, ?, NULL, ?, ?)', item.handoff_id, item.state === 'finished' ? 0 : 1, item.handed_at, JSON.stringify(item));
  }
  sql.exec('INSERT INTO agent_deliveries VALUES (?, ?, ?, ?, ?, ?)', 'ev_9', 'mac', 'h_0029', 'waiting', at(9), JSON.stringify({ event_id: 'ev_9', agent_id: 'mac', event: { subject_id: 'h_0029' }, state: 'waiting', attempts: 0, next_at: at(9), created_at: at(9) }));
  // A record already written since the store moved is newer than its table row.
  store.putHandoff(job(26, { state: 'finished', summary: 'finished after the move' }));
  assert.throws(() => tablesIntoRecords({ sql, records, transaction: host.transaction, tables: AGENT_RECORD_TABLES, batch: 0 }), /positive row limit/, 'a zero-row limit must not skip first rows or drop a table');
  const move = tablesIntoRecords({ sql, records, transaction: host.transaction, tables: AGENT_RECORD_TABLES, batch: 10 });
  assert.equal(move.start(), false, 'the first call copies only one bounded page');
  assert.equal(store.card('mac').name, 'Mac');
  assert.equal(store.deliverySecret('mac'), null, 'the record store is incomplete until firstReady');
  for (let steps = 0; !move.firstReady(); steps += 1) { assert.ok(steps < 20); move.step(); }
  assert.equal(store.card('mac').name, 'Mac');
  assert.equal(store.deliverySecret('mac'), 'secret-1');
  assert.deepEqual(store.openHandoffs().map(item => item.handoff_id), ['h_0025', 'h_0027', 'h_0028', 'h_0029']);
  assert.deepEqual(store.dueDeliveries(at(20)).map(item => item.event_id), ['ev_9']);
  assert.equal(store.handoff('h_0003'), null, 'finished work follows a batch at a time');
  let steps = 0;
  while (move.nextAt() !== null) { move.step(); steps += 1; assert.ok(steps < 20); }
  assert.equal(store.handoff('h_0003').state, 'finished');
  assert.equal(store.handoff('h_0026').summary, 'finished after the move');
  assert.deepEqual(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_%'").toArray(), []);
  assert.equal(store.finishedHandoffs({ limit: 100 }).length, 26);
});

test('held summaries start only after the older open handoffs have all moved', () => {
  const { host, records } = opened();
  const sql = host.sql;
  sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  for (let n = 0; n < 90; n += 1) {
    const item = job(n, { state: 'taken', taken_by: 'mac' });
    sql.exec('INSERT INTO agent_handoffs VALUES (?, 1, NULL, ?, ?)', item.handoff_id, item.handed_at, JSON.stringify(item));
  }
  const move = tablesIntoRecords({ sql, records, transaction: host.transaction, tables: AGENT_RECORD_TABLES, batch: 10 });
  const store = agentRecordStore({ records, transaction: host.transaction,
    heldSummaryReady: () => move.firstDone('agent_handoffs') });
  move.start();
  assert.equal(move.firstDone('agent_handoffs'), false);
  assert.ok(store.heldBy('mac').length < 90);
  assert.equal(records.read('agent-held-work:mac'), null, 'an incomplete move cannot seed a permanent partial answer');
  for (let steps = 0; !move.firstDone('agent_handoffs'); steps += 1) {
    assert.ok(steps < 20);
    move.step();
  }
  assert.equal(store.heldBy('mac').length, 90);
  assert.equal(records.read('agent-held-work:mac').ids.length, 90);
});

test('a moved table is let go a bounded piece per step: its indexes one a step, then the table', () => {
  const { host, records } = opened();
  const sql = host.sql;
  sql.exec('CREATE TABLE agent_deliveries (event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, subject_id TEXT NOT NULL, state TEXT NOT NULL, next_at TEXT, value TEXT NOT NULL)');
  sql.exec('CREATE INDEX agent_deliveries_due ON agent_deliveries (state, next_at)');
  sql.exec('CREATE INDEX agent_deliveries_agent ON agent_deliveries (agent_id, state)');
  for (let n = 0; n < 4500; n += 1) sql.exec('INSERT INTO agent_deliveries VALUES (?, ?, ?, ?, ?, ?)', `ev_${n}`, 'mac', `h_${n}`, 'delivered', null, JSON.stringify({ event_id: `ev_${n}`, agent_id: 'mac', event: { subject_id: `h_${n}` }, state: 'delivered', created_at: at(n) }));
  const move = tablesIntoRecords({ sql, records, transaction: host.transaction, tables: AGENT_RECORD_TABLES, batch: 2000 });
  const results = [];
  for (let steps = 0; move.nextAt() !== null; steps += 1) { assert.ok(steps < 30); results.push(move.step()); }
  const letGo = results.filter(result => result.let_go || result.dropped).map(result => result.let_go ?? 'table');
  assert.deepEqual(letGo, ['index', 'index', 'table']);
  assert.equal(records.read('agent-delivery:ev_4499').found_by.subject_id, 'h_4499', 'every row was moved before any was let go');
  assert.deepEqual(sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'agent_%'").toArray(), []);
});

test('moving a table batch by batch writes runs only as the memtable fills, never one per batch', () => {
  const { host, records, store } = opened();
  const sql = host.sql;
  sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  for (let n = 0; n < 3000; n += 1) {
    const item = job(n, n % 10 ? { state: 'finished' } : {});
    sql.exec('INSERT INTO agent_handoffs VALUES (?, ?, NULL, ?, ?)', item.handoff_id, item.state === 'finished' ? 0 : 1, item.handed_at, JSON.stringify(item));
  }
  const runs = () => sql.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name GLOB 'record_keys_run_*'").toArray()[0].n;
  const before = runs();
  const move = tablesIntoRecords({ sql, records, transaction: host.transaction, tables: AGENT_RECORD_TABLES, batch: 50 });
  let steps = 0;
  while (move.nextAt() !== null) { move.step(); steps += 1; assert.ok(steps < 200); }
  assert.ok(steps > 60, `the move took ${steps} steps`);
  assert.ok(runs() - before <= 2 * AGENT_RECORD_TABLES.length, `${runs() - before} runs written for ${steps} steps`);
  assert.equal(store.finishedHandoffs({ limit: 3000 }).length, 2700);
  assert.equal(store.openHandoffs().length, 300);
  assert.equal(records.read('table-move:agent_handoffs').moved, true, 'the place is kept once what it names is written out');
});

test('first open work scans bounded windows and resumes after each committed page', () => {
  const { host, records, store } = opened();
  const sql = host.sql;
  sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  for (let n = 0; n < 180; n += 1) {
    const item = job(n, { input: { note: 'x'.repeat(8192) } });
    sql.exec('INSERT INTO agent_handoffs VALUES (?, 1, NULL, ?, ?)', item.handoff_id, item.handed_at, JSON.stringify(item));
  }
  let pages = 0;
  let interrupted = false;
  const streamed = { exec(query, ...params) {
    if (query.includes('CASE WHEN open = 1')) {
      pages += 1;
      assert.ok(params.at(-1) <= FIRST_SCAN, `one first scan inspects at most ${FIRST_SCAN} rows`);
      if (pages === 2 && !interrupted) { interrupted = true; throw new Error('store reset after one page'); }
    }
    const cursor = sql.exec(query, ...params);
    if (!query.includes('rowid IN (')) return cursor;
    assert.ok(params.at(-1) <= 64, 'one page loads at most 64 full rows');
    return { [Symbol.iterator]: () => cursor[Symbol.iterator](), toArray: () => { throw new Error('first full rows were materialized'); } };
  } };
  const move = tablesIntoRecords({ sql: streamed, records, transaction: host.transaction, tables: AGENT_RECORD_TABLES, batch: 2000 });
  assert.equal(move.start(), false);
  assert.equal(move.firstDone('agent_handoffs'), false, 'duplicate folding waits until every old open row is represented');
  assert.ok(move.placeOf('agent_handoffs').first_after > 0);
  assert.throws(() => move.step(), /store reset after one page/);
  for (let steps = 0; !move.firstReady(); steps += 1) { assert.ok(steps < 20); move.step(); }
  assert.equal(move.firstDone('agent_handoffs'), true);
  assert.ok(pages >= 4, `expected several bounded pages; got ${pages}`);
  assert.equal(store.openHandoffs({ limit: 200 }).length, 180);
  assert.equal(records.read('table-move:agent_handoffs').first_done, true);
});

test('first open scan does not walk an unbounded finished prefix', () => {
  const { host, records, store } = opened();
  const sql = host.sql;
  sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  const rows = 2 * FIRST_SCAN + 200;
  for (let n = 0; n < rows; n += 1) {
    const item = job(n, { state: n === rows - 1 ? 'open' : 'finished' });
    sql.exec('INSERT INTO agent_handoffs VALUES (?, ?, NULL, ?, ?)', item.handoff_id, item.state === 'open' ? 1 : 0, item.handed_at, JSON.stringify(item));
  }
  let visited = 0;
  const counted = { exec(query, ...params) {
    if (query.includes('CASE WHEN open = 1')) visited += params.at(-1);
    return sql.exec(query, ...params);
  } };
  const move = tablesIntoRecords({ sql: counted, records, transaction: host.transaction, tables: AGENT_RECORD_TABLES });
  assert.equal(move.start(), false);
  assert.equal(visited, FIRST_SCAN, 'the request asks for only one bounded rowid window');
  assert.equal(store.handoff(`h_${rows - 1}`), null, 'the incomplete record index must not be used as the answer');
  for (let steps = 0; !move.firstReady(); steps += 1) { assert.ok(steps < 5); move.step(); }
  assert.equal(store.handoff(`h_${rows - 1}`).state, 'open');
});

test('a first scan stops reading its window once it holds a page of first rows', () => {
  const { host, records, store } = opened();
  const sql = host.sql;
  sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  const rows = 1000;
  for (let n = 0; n < rows; n += 1) {
    const item = job(n);
    sql.exec('INSERT INTO agent_handoffs VALUES (?, 1, NULL, ?, ?)', item.handoff_id, item.handed_at, JSON.stringify(item));
  }
  let read = 0;
  // The window's rows as a Durable Object hands them, one at a time: rows never taken are never read.
  const counted = { exec(query, ...params) {
    const cursor = sql.exec(query, ...params);
    if (!query.includes('CASE WHEN open = 1')) return cursor;
    return { [Symbol.iterator]: function* () { for (const row of cursor) { read += 1; yield row; } }, toArray: () => { throw new Error('the whole window was read'); } };
  } };
  const move = tablesIntoRecords({ sql: counted, records, transaction: host.transaction, tables: AGENT_RECORD_TABLES });
  move.start();
  assert.equal(read, 64, 'a window dense with open work is read only as far as one page of it');
  for (let steps = 0; !move.firstReady(); steps += 1) { assert.ok(steps < 40); move.step(); }
  assert.equal(store.openHandoffs({ limit: rows + 1 }).length, rows);
  assert.ok(read < 2 * rows, `${read} rows read to move ${rows}`);
});

test('old work and deliveries stay readable across bounded first-row alarms', () => {
  const { host, records, store: current } = opened();
  const sql = host.sql;
  sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE agent_deliveries (event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, subject_id TEXT NOT NULL, state TEXT NOT NULL, next_at TEXT, value TEXT NOT NULL)');
  for (let n = 0; n < 150; n += 1) {
    const item = job(n);
    sql.exec('INSERT INTO agent_handoffs VALUES (?, 1, NULL, ?, ?)', item.handoff_id, item.handed_at, JSON.stringify(item));
    const event = { event_id: `ev_${String(n).padStart(4, '0')}`, agent_id: 'mac', event: { subject_id: item.handoff_id }, state: 'waiting', next_at: at(n), created_at: at(n) };
    sql.exec('INSERT INTO agent_deliveries VALUES (?, ?, ?, ?, ?, ?)', event.event_id, event.agent_id, item.handoff_id, event.state, event.next_at, JSON.stringify(event));
  }
  const move = tablesIntoRecords({ sql, records, transaction: host.transaction, tables: AGENT_RECORD_TABLES });
  const bridge = agentLegacyRows({ sql, records, current });
  assert.equal(move.start(), false);
  const handoffs = [];
  for (let after = null; ;) {
    const page = bridge.openHandoffs({ after, limit: 40 });
    if (!page.length) break;
    handoffs.push(...page.map(item => item.handoff_id));
    after = page.at(-1).handoff_id;
    move.step();
  }
  assert.equal(handoffs.length, 150);
  assert.deepEqual(handoffs, [...handoffs].sort());
  const queued = [];
  for (let after = null; ;) {
    const page = bridge.openQueue({ nowIso: at(200), after, limit: 40 });
    if (!page.length) break;
    queued.push(...page.map(item => item.handoff_id));
    after = page.at(-1).handoff_id;
    move.step();
  }
  assert.equal(queued.length, 150);
  assert.deepEqual(queued, [...queued].sort());
  const sent = [];
  for (let alarm = 0; alarm < 5; alarm += 1) {
    const due = bridge.dueDeliveries(at(200));
    if (!due.length) break;
    sent.push(...due.map(item => item.event_id));
    bridge.transaction(() => due.forEach(item => bridge.putDelivery({ ...item, state: 'sent' })));
    move.step();
  }
  assert.equal(sent.length, 150);
  assert.deepEqual(sent, [...new Set(sent)]);
});

test('every card is read from the records once, then only the cards written since', () => {
  const { host, records, store } = opened();
  const card = n => ({ agent_id: `a${String(n).padStart(3, '0')}`, name: `agent ${n}`, takes_work: true });
  store.transaction(() => { for (let n = 0; n < 40; n += 1) store.putCard(card(n)); });
  let reads = 0;
  const read = records.read.bind(records);
  records.read = key => { reads += 1; return read(key); };
  assert.equal(store.cards().length, 40);
  reads = 0;
  for (let call = 0; call < 5; call += 1) assert.equal(store.cards().length, 40);
  assert.equal(reads, 0, 'unchanged cards are not read again');
  store.putCard({ ...card(7), name: 'renamed' });
  store.putCard(card(40));
  reads = 0; // a write looks at the card it replaces (to move its waiting work to a new reader); the reading of cards() is what is judged
  const after = store.cards();
  assert.equal(reads, 2, 'only the two cards written since are read');
  assert.deepEqual(after.map(item => item.agent_id), [...after.map(item => item.agent_id)].sort());
  assert.equal(after.find(item => item.agent_id === 'a007').name, 'renamed');
  assert.equal(after.length, 41);
  after[0].name = 'changed by caller';
  assert.equal(store.cards()[0].name, 'agent 0', 'callers still receive separate values');
  // A rolled-back write is forgotten the way the person's store does it (src/person-store.mjs transaction).
  assert.throws(() => { try { host.transaction(() => { store.putCard(card(41)); throw new Error('roll back proof'); }); } catch (error) { records.forgetCached(); throw error; } }, /roll back proof/);
  assert.equal(store.cards().length, 41, 'a rolled-back card is not kept');
});

test('kept cards stay kept while the table move brings in other rows, once the cards have moved', () => {
  const host = sqliteHost(':memory:');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  let moving = true;
  const store = agentRecordStore({ records, transaction: host.transaction, cardsMoving: () => moving });
  store.transaction(() => { for (let n = 0; n < 10; n += 1) store.putCard({ agent_id: `a${n}`, name: `agent ${n}` }); });
  let reads = 0;
  const read = records.read.bind(records);
  records.read = key => { reads += 1; return read(key); };
  const move = mark => records.logStore().loadDone({ table_move: mark });
  store.cards();
  reads = 0;
  move('m1');
  store.cards();
  assert.equal(reads, 10, 'while cards may still be moving, a load reads them all again');
  moving = false;
  store.cards();
  reads = 0;
  move('m2');
  move('m3');
  assert.equal(store.cards().length, 10);
  assert.equal(reads, 0, 'once the cards have moved, other rows moving in leave the kept cards alone');
});

test('blocked work reads only its bounded newest open rows, across both record engines', () => {
  for (const engine of ['record-log', 'eeaf']) {
    const host = sqliteHost(':memory:');
    setRecordEngine(host.sql, engine);
    const records = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
    const scans = [];
    const store = agentRecordStore({ records: { ...records, scan(...args) { scans.push(args); return records.scan(...args); } }, transaction: host.transaction });
    for (let n = 0; n < 90; n++) store.putHandoff(job(n, { in_the_way: n % 10 === 0 ? `reason ${90 - n}` : null }));
    store.putHandoff(job(100, { state: 'finished', in_the_way: 'Finished work' }));
    assert.deepEqual(store.blockedOpen(2).map(item => item.handoff_id), ['h_0080', 'h_0070']);
    assert.equal(scans.at(-1)[2].limit, 2);
    store.putHandoff(job(80, { in_the_way: null }));
    assert.deepEqual(store.blockedOpen(2).map(item => item.handoff_id), ['h_0070', 'h_0060']);
  }
});

test('the scheduler revision persists across a cold record-store reopen', () => {
  const { host, records, store } = opened();
  assert.equal(store.scheduleRevision(), 0);
  store.putHandoff(job(1));
  assert.equal(store.scheduleRevision(), 1);
  records.checkpoint();

  const reopenedRecords = openRecords(host.sql, { transaction: host.transaction, hash: text => text });
  const reopened = agentRecordStore({ records: reopenedRecords, transaction: host.transaction });
  assert.equal(reopened.scheduleRevision(), 1, 'a replacement store reads the durable revision');
  reopened.transaction(() => {
    reopened.putHandoff(job(2));
    reopened.putHandoff(job(3));
  });
  assert.equal(reopened.scheduleRevision(), 3, 'each handoff change advances the revision');
});

test('scheduled handoff pages stay bounded across a tied timestamp backlog', () => {
  const { host, records } = opened();
  let maxRead = 0, fullReads = 0;
  const observed = {
    ...records,
    scan: (type, name, options) => {
      if (type === 'agent-handoff' && name === 'time') maxRead = Math.max(maxRead, options.limit ?? Infinity);
      return records.scan(type, name, options);
    },
    read: id => { if (id.startsWith('agent-handoff:')) fullReads += 1; return records.read(id); },
  };
  const store = agentRecordStore({ records: observed, transaction: host.transaction });
  store.transaction(() => {
    for (let n = 0; n < 275; n += 1) store.putHandoff(job(n, { handed_at: at(0), input: { note: 'x'.repeat(8192) } }));
  });
  const seen = [];
  for (let after = null;;) {
    const page = store.openScheduledHandoffsPage({ after, limit: 37 });
    seen.push(...page.map(item => item.handoff_id));
    if (page.length < 37) break;
    after = page.at(-1);
  }
  assert.equal(seen.length, 275);
  assert.deepEqual(seen, [...seen].sort());
  assert.ok(maxRead <= 38, `index reads are bounded by the requested page (max observed ${maxRead})`);
  assert.equal(fullReads, 0, 'all new rows use their narrow schedule field');
});
