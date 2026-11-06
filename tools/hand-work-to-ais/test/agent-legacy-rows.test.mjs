// Ported from old trillion test/agent-legacy-rows.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. The bridge over a store's earlier agent tables is agent-legacy-rows.mjs here, beside
// agent-records.mjs, on the record engine of keep-and-wake-ai-sessions-on-this-computer and the table mover of
// move-the-rows-a-persons-store-kept-in-tables. Every test of the bridge is the old one. Four more booted a whole
// old person store (test/person-store-reads-for-tests.mjs personStoreOver over src/person-store.mjs, one with
// src/payment.mjs ownerGrantEffect) to see a person message, a handoff write's wake, the chosen-AI and own-work clocks'
// read budget and the account alarm while old rows move; that store went with the Worker and nothing composes these owners
// so now (searched personStoreOver, PersonStore, ownerGrantEffect in trillion-workshop tools/, trillion-apps web/,
// trillion-rust src/), so they are left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { openRecords } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { agentRecordStore, AGENT_RECORD_TABLES } from '../agent-records.mjs';
import { agentLegacyRows } from '../agent-legacy-rows.mjs';
import { tablesIntoRecords } from '../../move-the-rows-a-persons-store-kept-in-tables/src/tables-into-records.mjs';
import { JOB_COLUMNS, jobColumnsOf } from '../../shared-code/src/agents.mjs';

const at = n => new Date(Date.UTC(2026, 9, 5) + n * 1000).toISOString();
const job = (n, extra = {}) => ({ handoff_id: `h${String(n).padStart(3, '0')}`, state: 'open', handed_at: at(n), priority: 0, to_agent: null, review_at: at(n + 100), ...extra });
const event = (n, extra = {}) => ({ event_id: `e${n}`, agent_id: 'mac', event: { subject_id: 'h001' }, state: 'waiting', next_at: at(n), created_at: at(n), ...extra });

function opened() {
  const host = sqliteHost(':memory:');
  const sql = host.sql;
  const records = openRecords(sql, { transaction: host.transaction, hash: text => text });
  sql.exec('CREATE TABLE agent_cards (agent_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE agent_delivery_secrets (agent_id TEXT PRIMARY KEY, secret TEXT NOT NULL)');
  sql.exec('CREATE TABLE agent_handoffs (handoff_id TEXT PRIMARY KEY, open INTEGER NOT NULL, parent TEXT, handed_at TEXT NOT NULL, value TEXT NOT NULL)');
  sql.exec('CREATE TABLE agent_deliveries (event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, subject_id TEXT NOT NULL, state TEXT NOT NULL, next_at TEXT, value TEXT NOT NULL)');
  const card = value => sql.exec('INSERT INTO agent_cards (agent_id, value) VALUES (?, ?)', value.agent_id, JSON.stringify(value));
  const handoff = value => sql.exec('INSERT INTO agent_handoffs (handoff_id, open, parent, handed_at, value) VALUES (?, ?, ?, ?, ?)', value.handoff_id, value.state === 'finished' ? 0 : 1, value.parent_handoff_id ?? null, value.handed_at, JSON.stringify(value));
  const delivery = value => sql.exec('INSERT INTO agent_deliveries (event_id, agent_id, subject_id, state, next_at, value) VALUES (?, ?, ?, ?, ?, ?)', value.event_id, value.agent_id, value.event.subject_id, value.state, value.next_at, JSON.stringify(value));
  const current = agentRecordStore({ records, transaction: host.transaction });
  const bridge = agentLegacyRows({ sql, records, current });
  return { host, sql, records, current, bridge, card, handoff, delivery };
}

test('bare legacy tables remain untouched; newer records hide old open jobs, cards, deliveries and secrets', () => {
  const { sql, current, bridge, card, handoff, delivery } = opened();
  const before = sql.exec("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'agent_%' ORDER BY name").toArray();
  card({ agent_id: 'mac', reader: 'old', takes_work: true, name: 'old card', delivery: { stream: true } });
  card({ agent_id: 'other', reader: 'old', takes_work: true, name: 'other' });
  sql.exec('INSERT INTO agent_delivery_secrets VALUES (?, ?)', 'mac', 'old-secret');
  handoff(job(1, { to_agent: 'mac' }));
  handoff(job(2, { to_agent: 'mac', priority: 8 }));
  handoff(job(3, { state: 'finished' }));
  delivery(event(1));
  delivery(event(2));

  current.putCard({ agent_id: 'mac', reader: 'new', takes_work: false, name: 'new card' });
  current.putDeliverySecret('mac', 'new-secret');
  current.putHandoff(job(2, { state: 'finished', to_agent: 'mac', priority: 8 }));
  current.putHandoff(job(3, { state: 'open', priority: 9 }));
  current.putDelivery(event(1, { state: 'sent' }));

  assert.equal(bridge.card('mac').name, 'new card');
  assert.deepEqual(bridge.cardIdsOf({ reader: 'old' }), ['other']);
  assert.equal(bridge.anyTaker(), true);
  assert.equal(bridge.deliverySecret('mac'), 'new-secret');
  assert.deepEqual(bridge.openHandoffs({ limit: 10 }).map(item => item.handoff_id), ['h001', 'h003']);
  assert.deepEqual(bridge.pendingAddressedTo(['mac'], 10).map(item => item.handoff_id), ['h001']);
  assert.equal(bridge.waitingCount('mac'), 1);
  assert.deepEqual(bridge.finishedHandoffs({ limit: 10 }).map(item => item.handoff_id), ['h002']);
  assert.deepEqual(bridge.dueDeliveries(at(10)).map(item => item.event_id), ['e2']);
  assert.equal(bridge.waitingFor('mac'), 1);
  assert.deepEqual(sql.exec("SELECT type, name, sql FROM sqlite_master WHERE name LIKE 'agent_%' ORDER BY name").toArray(), before,
    'reading bare rows does not add columns, indexes or tables');
});

test('legacy reads check each table once and stop reading it when the mover marks it moved', () => {
  const { sql, records, current } = opened();
  const checks = [];
  const traced = { exec(query, ...args) {
    if (query.includes("FROM sqlite_master WHERE type = 'table'")) checks.push(args[0]);
    return sql.exec(query, ...args);
  } };
  const places = new Map();
  const bridge = agentLegacyRows({ sql: traced, records, current, placeOf: table => places.get(table) ?? {} });
  const openingChecks = [...checks];
  for (let n = 0; n < 5; n += 1) {
    assert.deepEqual(bridge.cardsForSource('none'), []);
    assert.deepEqual(bridge.handedOnFrom('none'), []);
    assert.deepEqual(bridge.deliveriesFor('none'), []);
  }
  assert.deepEqual(checks, openingChecks, 'repeated reads reuse the schema result from opening');
  assert.deepEqual([...new Set(checks)].sort(), ['agent_cards', 'agent_deliveries', 'agent_handoffs']);
  places.set('agent_handoffs', { moved: true });
  sql.exec('DROP TABLE agent_handoffs');
  assert.deepEqual(bridge.handedOnFrom('none'), []);
  assert.deepEqual(checks, openingChecks, 'a moved table is skipped without another schema scan');
});

test('legacy source lookup merges open rows from both stores and honors newer records', () => {
  const { current, bridge, handoff } = opened();
  handoff(job(1, { input: { arrived: { source_id: 'source-a' } } }));
  handoff(job(2, { input: { arrived: { source_id: 'source-b' } } }));
  handoff(job(3, { state: 'finished', input: { arrived: { source_id: 'source-a' } } }));
  current.putHandoff(job(1, { state: 'finished', input: { arrived: { source_id: 'source-a' } } }));
  current.putHandoff(job(4, { input: { arrived: { source_id: 'source-a' } } }));

  assert.deepEqual(bridge.openForSource('source-a').map(item => item.handoff_id), ['h004']);
  assert.deepEqual(bridge.openForSource('source-b').map(item => item.handoff_id), ['h002']);
});

test('legacy row adapter forwards the durable schedule revision', () => {
  const { current, bridge } = opened();
  assert.equal(bridge.scheduleRevision(), 0);
  current.putHandoff(job(1));
  assert.equal(bridge.scheduleRevision(), 1);
});

test('legacy next-review scan pages through blocked timestamp groups and resumes across clock changes', () => {
  const { sql, records, current } = opened();
  const queries = [];
  const traced = { exec(query, ...args) { queries.push({ query, args }); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  for (let n = 0; n < 70; n += 1) {
    const item = job(n, { review_at: '', depends_on: ['still-open'] });
    sql.exec('INSERT INTO agent_handoffs VALUES (?, 1, NULL, ?, ?)', item.handoff_id, item.handed_at, JSON.stringify(item));
  }
  const ready = job(100, { review_at: at(100) });
  sql.exec('INSERT INTO agent_handoffs VALUES (?, 1, NULL, ?, ?)', ready.handoff_id, ready.handed_at, JSON.stringify(ready));
  assert.equal(bridge.nextReviewAt(at(10)), at(11));
  const first = current.reviewSearchMark('legacy-next-review-search').cursor;
  assert.ok(first);
  assert.equal(bridge.nextReviewAt(at(20)), at(21));
  const second = current.reviewSearchMark('legacy-next-review-search').cursor;
  assert.ok(second.rowid > first.rowid, 'a later clock continues after the saved SQL row');
  current.putHandoff(job(200, { state: 'finished' }));
  assert.equal(bridge.nextReviewAt(at(20)), at(21));
  assert.ok(queries.filter(({ query }) => query.includes('FROM agent_handoffs WHERE open = 1')).every(({ args }) => args.at(-1) <= 32),
    'each legacy SQL read is limited to one page');
  let next = at(21);
  for (let attempt = 0; attempt < 8 && next !== at(100); attempt += 1) next = bridge.nextReviewAt(at(20));
  assert.equal(next, at(100));
});

test('legacy equal-time continuation seeks from the indexed rowid cursor without a temp sort', () => {
  const { sql } = opened();
  sql.exec('ALTER TABLE agent_handoffs ADD COLUMN review_at TEXT');
  sql.exec("ALTER TABLE agent_handoffs ADD COLUMN waits_on TEXT NOT NULL DEFAULT '[]'");
  sql.exec('CREATE INDEX agent_handoffs_review ON agent_handoffs (open, review_at)');
  for (let n = 0; n < 10_000; n += 1) {
    const item = job(n, { review_at: at(100), depends_on: ['still-open'] });
    sql.exec('INSERT INTO agent_handoffs (handoff_id, open, parent, handed_at, value, review_at, waits_on) VALUES (?, 1, NULL, ?, ?, ?, ?)',
      item.handoff_id, item.handed_at, JSON.stringify(item), item.review_at, JSON.stringify(item.depends_on));
  }
  // The mover may already have copied the first 9,900 rows. Keeping its independent rowid watermark out
  // of this review-ordered query lets the index page past those shadowed rows with a fixed physical limit.
  const first = 'SELECT handoff_id, review_at, waits_on, rowid FROM agent_handoffs WHERE open = 1 AND review_at IS NOT NULL ORDER BY review_at, rowid LIMIT ?';
  const firstPlan = sql.exec(`EXPLAIN QUERY PLAN ${first}`, 32).toArray().map(row => row.detail).join(' ; ');
  assert.match(firstPlan, /USING INDEX agent_handoffs_review/, firstPlan);
  assert.doesNotMatch(firstPlan, /TEMP B-TREE/, firstPlan);
  const firstPage = sql.exec(first, 32).toArray();
  assert.equal(firstPage.length, 32);
  assert.equal(firstPage[0].handoff_id, 'h000');
  assert.equal(firstPage.at(-1).handoff_id, 'h031');

  const continuation = 'SELECT handoff_id, review_at, waits_on, rowid FROM agent_handoffs WHERE open = 1 AND review_at = ? AND rowid > ? ORDER BY rowid LIMIT ?';
  const continuationPlan = sql.exec(`EXPLAIN QUERY PLAN ${continuation}`, at(100), 9_900, 32).toArray().map(row => row.detail).join(' ; ');
  assert.match(continuationPlan, /USING INDEX agent_handoffs_review \(open=\? AND review_at=\? AND rowid>\?\)/, continuationPlan);
  assert.doesNotMatch(continuationPlan, /TEMP B-TREE/, continuationPlan);
  const page = sql.exec(continuation, at(100), 9_900, 32).toArray();
  assert.equal(page.length, 32);
  assert.equal(page[0].handoff_id, 'h9900');
  assert.equal(page.at(-1).handoff_id, 'h9931');
});

test('legacy due reviews return one bounded page and keep their SQL cursor across scheduler passes', () => {
  const { sql, records, current } = opened();
  const queries = [];
  const traced = { exec(query, ...args) { queries.push({ query, args }); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  for (let n = 0; n < 70; n += 1) {
    const item = job(n, { review_at: '', depends_on: ['still-open'] });
    sql.exec('INSERT INTO agent_handoffs VALUES (?, 1, NULL, ?, ?)', item.handoff_id, item.handed_at, JSON.stringify(item));
  }
  const ready = job(100, { review_at: '' });
  sql.exec('INSERT INTO agent_handoffs VALUES (?, 1, NULL, ?, ?)', ready.handoff_id, ready.handed_at, JSON.stringify(ready));
  assert.deepEqual(bridge.dueReviews(at(10), 5), []);
  const first = current.reviewSearchMark('legacy-due-review-search').cursor;
  assert.ok(first);
  assert.deepEqual(bridge.dueReviews(at(20), 5), []);
  const second = current.reviewSearchMark('legacy-due-review-search').cursor;
  assert.ok(second.rowid > first.rowid, 'raising now does not restart the SQL scan');
  current.putHandoff(job(200, { state: 'finished' }));
  let due = [];
  for (let attempt = 0; attempt < 4 && !due.length; attempt += 1) due = bridge.dueReviews(at(20), 5);
  assert.deepEqual(due, [ready]);
  assert.ok(queries.filter(({ query }) => query.includes('FROM agent_handoffs WHERE open = 1')).every(({ args }) => args.at(-1) <= 32),
    'each due scan limits legacy rows to one page');
});

test('legacy due-review continuation revisits an earlier row after its prerequisite finishes', () => {
  const { sql, records, current, bridge, handoff } = opened();
  const child = job(0, { review_at: at(100), depends_on: ['h200'] });
  handoff(child);
  for (let n = 1; n <= 100; n += 1) handoff(job(n, { review_at: at(100), depends_on: ['still-open'] }));
  handoff(job(200, { in_the_way: 'Waiting on a person', in_the_way_by: 'someone' }));
  assert.deepEqual(bridge.dueReviews(at(200), 5), []);
  assert.deepEqual(bridge.dueReviews(at(201), 5), []);
  current.putHandoff(job(200, { state: 'finished' }));
  assert.deepEqual(bridge.dueReviews(at(201), 5), []);
  assert.deepEqual(bridge.dueReviews(at(201), 5), []);
  assert.deepEqual(bridge.dueReviews(at(201), 5), [child], 'mixed-store readiness is rechecked after the SQL pass wraps');
});

for (const prepared of [false, true]) test(`pending reader gets card IDs without loading legacy card bodies (${prepared ? 'prepared' : 'bare'} table)`, () => {
  const { sql, records, current, card } = opened();
  card({ agent_id: 'old', reader: 'reader-a', takes_work: true, name: 'x'.repeat(40_000) });
  card({ agent_id: 'changed', reader: 'reader-a', takes_work: true, name: 'x'.repeat(40_000) });
  card({ agent_id: 'other', reader: 'reader-b', takes_work: true });
  if (prepared) {
    for (const name of ['reader', 'takes_work', 'source_id', 'reaches']) sql.exec(`ALTER TABLE agent_cards ADD COLUMN ${name} ${name === 'takes_work' || name === 'reaches' ? 'INTEGER' : 'TEXT'}`);
    sql.exec("UPDATE agent_cards SET reader = json_extract(value, '$.reader'), takes_work = json_extract(value, '$.takes_work')");
    sql.exec('CREATE INDEX agent_cards_reader ON agent_cards (reader, takes_work)');
  }
  current.putCard({ agent_id: 'changed', reader: 'reader-b', takes_work: false });
  current.putCard({ agent_id: 'new', reader: 'reader-a', takes_work: true });
  const queries = [];
  const traced = { exec(query, ...args) { queries.push(query); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  queries.length = 0;
  assert.deepEqual(new Set(bridge.cardIdsOf({ reader: 'reader-a', takes_work: true })), new Set(['old', 'new']));
  assert.ok(queries.some(query => query.startsWith('SELECT agent_id FROM agent_cards WHERE ')));
  assert.ok(!queries.some(query => /SELECT\s+(?:agent_id,\s*)?value\s+FROM\s+agent_cards/i.test(query)), 'greeting does not read card JSON bodies');
  if (prepared) assert.ok(!queries.some(query => query.includes("json_extract(value, '$.reader')")), 'prepared cards use their reader index');
});

test('work board loads combine the unmoved table tail with current records once', () => {
  const { bridge, current, handoff } = opened();
  handoff(job(1, { to_agent: 'a', state: 'open' }));
  handoff(job(2, { to_agent: 'b', taken_by: 'a', state: 'taken' }));
  handoff(job(3, { to_agent: 'b', state: 'open' }));
  current.putHandoff(job(3, { to_agent: 'b', state: 'finished' }));
  current.putHandoff(job(4, { to_agent: 'a', taken_by: 'b', state: 'taken' }));
  const loads = bridge.boardAgentLoads(['a', 'b', 'none']);
  for (const id of ['a', 'b', 'none']) {
    assert.deepEqual(loads.held.get(id), bridge.heldBy(id));
    assert.equal(loads.waiting.get(id), bridge.waitingCount(id));
  }
  const heldOnly = bridge.boardAgentLoads(['a', 'b'], { includeWaiting: false });
  assert.deepEqual(heldOnly.held.get('a'), bridge.heldBy('a'));
  assert.equal(heldOnly.waiting.get('a'), 0);
  assert.deepEqual(bridge.heldByMany(['a', 'b', 'none']), ['a', 'b', 'none'].flatMap(id => bridge.heldBy(id)));
});

test('selected parents include older SQL children in order and honor newer record shadows', () => {
  const { current, bridge, handoff } = opened();
  handoff(job(1, { parent_handoff_id: 'parent-a' }));
  handoff(job(2, { parent_handoff_id: 'parent-b' }));
  handoff(job(3, { parent_handoff_id: 'parent-a' }));
  current.putHandoff(job(2, { parent_handoff_id: 'parent-a', state: 'finished' }));
  current.putHandoff(job(4, { parent_handoff_id: 'parent-b' }));
  const ids = ['parent-b', 'parent-a', 'parent-b'];
  const groups = bridge.handedOnFromMany(ids);
  assert.deepEqual([...groups.keys()], ['parent-b', 'parent-a']);
  for (const id of new Set(ids)) assert.deepEqual(groups.get(id), bridge.handedOnFrom(id));
  assert.deepEqual(groups.get('parent-a').map(item => item.handoff_id), ['h001', 'h002', 'h003']);
  assert.deepEqual(groups.get('parent-b').map(item => item.handoff_id), ['h004']);
  assert.deepEqual([...bridge.handedOnFromMany([])], []);
});

test('mixed record/table pages preserve cursors, priority order, dependency review and grouped writes', () => {
  const { host, sql, current, bridge, card, handoff, delivery } = opened();
  card({ agent_id: 'mac', reader: 'key:mac', takes_work: true });
  handoff(job(1, { to_agent: 'mac', priority: 3 }));
  handoff(job(2, { to_agent: 'mac', priority: 2 }));
  handoff(job(3, { state: 'finished' }));
  handoff(job(4, { depends_on: ['h003'], review_at: '' }));
  handoff(job(5, { state: 'finished' }));
  delivery(event(3));
  current.putHandoff(job(6, { to_agent: 'mac', priority: 9 }));
  current.putHandoff(job(7, { state: 'finished' }));

  assert.deepEqual(bridge.openHandoffs({ limit: 2 }).map(item => item.handoff_id), ['h001', 'h002']);
  assert.deepEqual(bridge.openHandoffs({ after: 'h002', limit: 2 }).map(item => item.handoff_id), ['h004', 'h006']);
  assert.deepEqual(bridge.openQueue({ to_agent: 'mac', nowIso: at(20), limit: 2 }).map(item => item.handoff_id), ['h006', 'h001']);
  assert.deepEqual(bridge.openQueue({ to_agent: 'mac', nowIso: at(20), after: 'h001', limit: 2 }).map(item => item.handoff_id), ['h002']);
  assert.deepEqual(bridge.finishedHandoffs({ before: 'h007', limit: 2 }).map(item => item.handoff_id), ['h005', 'h003']);
  assert.equal(bridge.nextReviewAt(at(10)), at(10), 'finished dependency in the older table unblocks a newer view');

  const logRows = () => sql.exec('SELECT COUNT(*) AS n FROM record_log').toArray()[0].n;
  const before = logRows();
  bridge.transaction(() => {
    bridge.putHandoff(job(1, { state: 'finished' }));
    bridge.putDelivery(event(3, { state: 'sent' }));
    bridge.putCard({ agent_id: 'mac', reader: 'key:mac', takes_work: false });
  });
  assert.equal(logRows() - before, 1, 'one atomic record-log write for the grouped handoff and event change');
  assert.equal(sql.exec('SELECT open FROM agent_handoffs WHERE handoff_id = ?', 'h001').toArray()[0].open, 1, 'legacy row is left intact until the mover drops its table');
  assert.deepEqual(bridge.openHandoffs({ limit: 10 }).map(item => item.handoff_id), ['h002', 'h004', 'h006']);
  assert.deepEqual(bridge.dueDeliveries(at(10)), []);
  const move = tablesIntoRecords({ sql, records: openRecords(sql, { transaction: host.transaction, hash: text => text }), transaction: host.transaction, tables: AGENT_RECORD_TABLES, batch: 10 });
  for (let i = 0; i < 30 && move.nextAt() !== null; i += 1) move.step();
  assert.equal(bridge.handoff('h001').state, 'finished', 'a later table copy cannot revive newer finished work');
});

test('record index paging continues after a legacy cursor and across shared timestamps', () => {
  const { current, bridge, handoff } = opened();
  handoff(job(1));
  current.putHandoff({ ...job(1), handoff_id: 'h001a' });
  current.putHandoff(job(2));
  assert.deepEqual(bridge.openHandoffs({ after: 'h001', limit: 1 }).map(item => item.handoff_id), ['h001a']);
  assert.deepEqual(bridge.openHandoffs({ after: 'h001a', limit: 1 }).map(item => item.handoff_id), ['h002']);
  handoff(job(3, { state: 'finished' }));
  current.putHandoff({ ...job(3, { state: 'finished' }), handoff_id: 'h002z' });
  assert.deepEqual(bridge.finishedHandoffs({ before: 'h003', limit: 1 }).map(item => item.handoff_id), ['h002z']);
});

test('prepared legacy columns serve selective work reads without a JSON predicate or schema mutation', () => {
  const { sql, records, current, handoff } = opened();
  const item = job(1, { to_agent: 'mac', priority: 5 });
  handoff(item);
  for (const name of JOB_COLUMNS) sql.exec(`ALTER TABLE agent_handoffs ADD COLUMN ${name}`);
  sql.exec('CREATE INDEX agent_handoffs_unfilled ON agent_handoffs (open) WHERE state IS NULL');
  sql.exec('CREATE INDEX agent_handoffs_addressed ON agent_handoffs (open, to_agent, handed_at, handoff_id)');
  const facts = jobColumnsOf(item);
  sql.exec(`UPDATE agent_handoffs SET ${JOB_COLUMNS.map(name => `${name} = ?`).join(', ')} WHERE handoff_id = ?`, ...JOB_COLUMNS.map(name => facts[name]), item.handoff_id);
  const seen = [];
  const traced = { exec(query, ...args) { seen.push(query); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  seen.length = 0;
  assert.deepEqual(bridge.pendingAddressedTo(['mac'], 1).map(row => row.handoff_id), ['h001']);
  assert.ok(seen.some(query => query.includes('state =') && query.includes('to_agent = ?') && !query.includes('json_extract(value')),
    'a prepared table seeks one recipient through columns without rebuilding it');
});

test('prepared work board loads use the held and pending indexes together', () => {
  const { sql, records, current, handoff } = opened();
  const items = [job(1, { to_agent: 'mac' }), job(2, { to_agent: 'other', taken_by: 'mac', state: 'taken' })];
  items.forEach(handoff);
  for (const name of JOB_COLUMNS) sql.exec(`ALTER TABLE agent_handoffs ADD COLUMN ${name}`);
  sql.exec('CREATE INDEX agent_handoffs_unfilled ON agent_handoffs (open) WHERE state IS NULL');
  sql.exec('CREATE INDEX agent_handoffs_held ON agent_handoffs (open, taken_by, handed_at, handoff_id)');
  sql.exec("CREATE INDEX agent_handoffs_pending ON agent_handoffs (open, state, to_agent, priority DESC, handed_at, handoff_id) WHERE open = 1 AND state = 'open'");
  for (const item of items) {
    const facts = jobColumnsOf(item);
    sql.exec(`UPDATE agent_handoffs SET ${JOB_COLUMNS.map(name => `${name} = ?`).join(', ')} WHERE handoff_id = ?`,
      ...JOB_COLUMNS.map(name => facts[name]), item.handoff_id);
  }
  const seen = [];
  const traced = { exec(query, ...args) { seen.push(query); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  const loads = bridge.boardAgentLoads(['mac', 'other']);
  assert.deepEqual(loads.held.get('mac').map(item => item.handoff_id), ['h002']);
  assert.equal(loads.waiting.get('mac'), 1);
  assert.ok(seen.some(query => query.includes('INDEXED BY agent_handoffs_held')));
  assert.ok(seen.some(query => query.includes('INDEXED BY agent_handoffs_pending')));
});

for (const [indexName, createIndex] of [
  ['agent_handoffs_pending', "CREATE INDEX agent_handoffs_pending ON agent_handoffs (open, state, to_agent, priority DESC, handed_at, handoff_id) WHERE open = 1 AND state = 'open'"],
  ['agent_handoffs_queue', 'CREATE INDEX agent_handoffs_queue ON agent_handoffs (open, priority DESC, handed_at, handoff_id, to_agent, prefer_until)'],
]) test(`pending work refills past superseded rows in exact priority order with ${indexName}`, () => {
  const { sql, records, current, handoff } = opened();
  const jobs = [];
  for (let n = 0; n < 180; n += 1) {
    const item = job(n, { to_agent: `agent-${n % 5}`, priority: 9 - Math.floor(n / 20), handed_at: at(Math.floor(n / 2)) });
    jobs.push(item);
    handoff(item);
  }
  for (const name of JOB_COLUMNS) sql.exec(`ALTER TABLE agent_handoffs ADD COLUMN ${name}`);
  sql.exec('CREATE INDEX agent_handoffs_unfilled ON agent_handoffs (open) WHERE state IS NULL');
  sql.exec(createIndex);
  const update = `UPDATE agent_handoffs SET ${JOB_COLUMNS.map(name => `${name} = ?`).join(', ')} WHERE handoff_id = ?`;
  for (const item of jobs) {
    const facts = jobColumnsOf(item);
    sql.exec(update, ...JOB_COLUMNS.map(name => facts[name]), item.handoff_id);
  }
  const shadowed = new Set(jobs.slice(0, 42).map(item => item.handoff_id));
  for (const item of jobs.slice(0, 42)) current.putHandoff({ ...item, state: 'finished' });
  const queries = [];
  const traced = { exec(query, ...args) { queries.push({ query, args }); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  const ids = ['agent-0', 'agent-1', 'agent-2'];
  const expected = jobs.filter(item => !shadowed.has(item.handoff_id) && ids.includes(item.to_agent))
    .sort((a, b) => b.priority - a.priority || a.handed_at.localeCompare(b.handed_at) || a.handoff_id.localeCompare(b.handoff_id))
    .slice(0, 20).map(item => item.handoff_id);
  assert.deepEqual(bridge.pendingAddressedTo(ids, 20).map(item => item.handoff_id), expected);
  const candidateQueries = queries.filter(({ query }) => query.includes('SELECT handoff_id, handed_at'));
  assert.ok(candidateQueries.length > (indexName === 'agent_handoffs_pending' ? ids.length : 1),
    'stale top rows cause a refill instead of an underfilled result');
  assert.ok(candidateQueries.every(({ query, args }) => query.includes(`INDEXED BY ${indexName}`) && args.at(-1) <= 20),
    'each seek reads bounded metadata pages, not full handoff bodies');
  const recipient = indexName === 'agent_handoffs_pending' ? 'to_agent = ?' : 'to_agent IN (SELECT value FROM json_each(?))';
  const plan = sql.exec(`EXPLAIN QUERY PLAN SELECT handoff_id, handed_at, priority FROM agent_handoffs INDEXED BY ${indexName}
    WHERE open = 1 AND state = 'open' AND ${recipient} AND rowid > ?
    ORDER BY priority DESC, handed_at, handoff_id LIMIT ?`, indexName === 'agent_handoffs_pending' ? 'agent-0' : JSON.stringify(ids), 0, 20)
    .toArray().map(row => row.detail).join(' ');
  assert.match(plan, new RegExp(indexName));
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  if (indexName === 'agent_handoffs_queue') assert.equal(sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'agent_handoffs_pending'").toArray().length, 0,
    'the bridge does not build an index in the first request');
});

test('a rare recipient uses the existing addressed index; a dense one keeps the queue index', () => {
  const { host, sql, records, current } = opened();
  for (const name of JOB_COLUMNS) sql.exec(`ALTER TABLE agent_handoffs ADD COLUMN ${name}`);
  sql.exec('CREATE INDEX agent_handoffs_unfilled ON agent_handoffs (open) WHERE state IS NULL');
  sql.exec('CREATE INDEX agent_handoffs_addressed ON agent_handoffs (open, to_agent, handed_at, handoff_id)');
  sql.exec('CREATE INDEX agent_handoffs_queue ON agent_handoffs (open, priority DESC, handed_at, handoff_id, to_agent, prefer_until)');
  const columns = ['handoff_id', 'open', 'parent', 'handed_at', 'value', ...JOB_COLUMNS];
  const insert = item => {
    const facts = jobColumnsOf(item);
    sql.exec(`INSERT INTO agent_handoffs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      item.handoff_id, 1, null, item.handed_at, JSON.stringify(item), ...JOB_COLUMNS.map(name => facts[name]));
  };
  host.transaction(() => {
    for (let n = 0; n < 2_000; n += 1) insert(job(n, { to_agent: 'other', priority: 100 }));
    insert(job(2_000, { to_agent: 'rare', priority: 9 }));
    insert(job(2_001, { to_agent: 'rare', priority: 7 }));
    insert(job(2_002, { to_agent: 'rare', priority: 5 }));
  });
  current.putHandoff(job(2_000, { to_agent: 'rare', priority: 9, state: 'finished' }));
  const queries = [];
  const traced = { exec(query, ...args) { queries.push({ query, args }); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  queries.length = 0;
  assert.deepEqual(bridge.pendingAddressedTo(['rare'], 2).map(item => item.handoff_id), ['h2001', 'h2002']);
  assert.equal(queries.filter(({ query }) => query.includes('SELECT handoff_id, handed_at, priority, to_agent')
    && query.includes('INDEXED BY agent_handoffs_addressed')).length, 1);
  assert.ok(!queries.some(({ query }) => query.includes('INDEXED BY agent_handoffs_queue') && query.includes('SELECT handoff_id')),
    'one rare recipient does not walk two thousand unrelated higher-priority jobs');
  const plan = sql.exec(`EXPLAIN QUERY PLAN SELECT handoff_id FROM agent_handoffs INDEXED BY agent_handoffs_addressed
    WHERE open = 1 AND state = 'open' AND rowid > ? AND to_agent = ? LIMIT ?`, 0, 'rare', 4_097)
    .toArray().map(row => row.detail).join(' ');
  assert.match(plan, /agent_handoffs_addressed/);

  host.transaction(() => { for (let n = 2_003; n < 6_097; n += 1) insert(job(n, { to_agent: 'rare', priority: 0 })); });
  queries.length = 0;
  assert.deepEqual(bridge.pendingAddressedTo(['rare'], 2).map(item => item.handoff_id), ['h2001', 'h2002']);
  assert.ok(queries.some(({ query }) => query.includes('INDEXED BY agent_handoffs_queue') && query.includes('SELECT handoff_id')),
    'a recipient beyond the metadata budget keeps the complete queue-order result');
});

test('sparse pending work checks record shadows only until the visible page fills', () => {
  const { host, sql, records, current } = opened();
  for (const name of JOB_COLUMNS) sql.exec(`ALTER TABLE agent_handoffs ADD COLUMN ${name}`);
  sql.exec('CREATE INDEX agent_handoffs_unfilled ON agent_handoffs (open) WHERE state IS NULL');
  sql.exec('CREATE INDEX agent_handoffs_addressed ON agent_handoffs (open, to_agent, handed_at, handoff_id)');
  sql.exec('CREATE INDEX agent_handoffs_queue ON agent_handoffs (open, priority DESC, handed_at, handoff_id, to_agent, prefer_until)');
  const columns = ['handoff_id', 'open', 'parent', 'handed_at', 'value', ...JOB_COLUMNS];
  host.transaction(() => {
    for (let n = 0; n < 240; n += 1) {
      const item = job(n, { to_agent: 'mac', priority: 1 });
      const facts = jobColumnsOf(item);
      sql.exec(`INSERT INTO agent_handoffs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        item.handoff_id, 1, null, item.handed_at, JSON.stringify(item), ...JOB_COLUMNS.map(name => facts[name]));
    }
  });
  for (let n = 0; n < 5; n += 1) current.putHandoff(job(n, { to_agent: 'mac', priority: 1, state: 'finished' }));
  const bridge = agentLegacyRows({ sql, records, current });
  const originalHasState = records.hasState;
  let shadowChecks = 0;
  records.hasState = id => { if (id.startsWith('agent-handoff:')) shadowChecks += 1; return originalHasState(id); };
  const found = bridge.pendingAddressedTo(['mac'], 20).map(item => item.handoff_id);
  assert.deepEqual(found, Array.from({ length: 20 }, (_, n) => job(n + 5).handoff_id));
  assert.equal(shadowChecks, 25, 'five superseded jobs plus twenty visible jobs, never the full old recipient set');
});

test('first-row move cursor excludes old open rows already copied into records', () => {
  const { records, current, bridge, handoff } = opened();
  const earlier = job(1, { to_agent: 'mac', priority: 9 });
  const later = job(2, { to_agent: 'mac', priority: 1 });
  handoff(earlier);
  handoff(later);
  current.putHandoff(earlier);
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 1 } }], { actor: { by: 'trillion' } });
  assert.deepEqual(bridge.pendingAddressedTo(['mac'], 5).map(item => item.handoff_id), ['h001', 'h002']);
  current.putHandoff(later);
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 2, first_done: true } }], { actor: { by: 'trillion' } });
  assert.deepEqual(bridge.pendingAddressedTo(['mac'], 5).map(item => item.handoff_id), ['h001', 'h002']);
});

test('waiting delivery reads skip the copied legacy prefix and stop at first-pass completion', () => {
  const { sql, records, current, bridge, delivery } = opened();
  const movedStream = event(1, { next_at: null });
  const movedDue = event(2);
  const olderStream = event(3, { next_at: null });
  const olderDue = event(4);
  for (const item of [movedStream, movedDue, olderStream, olderDue]) delivery(item);
  current.putDelivery(movedStream);
  current.putDelivery(movedDue);
  records.write([{ id: 'table-move:agent_deliveries', type: 'table-move', value: { first_after: 2 } }], { actor: { by: 'trillion' } });
  sql.exec('CREATE INDEX agent_deliveries_due ON agent_deliveries (state, next_at)');

  const originalExec = sql.exec;
  const scans = [];
  sql.exec = (query, ...args) => {
    if (/FROM agent_deliveries/.test(query)) scans.push({ query, args });
    return originalExec(query, ...args);
  };
  assert.deepEqual(bridge.streamWaiting('mac').map(item => item.event_id), ['e1', 'e3']);
  assert.deepEqual(bridge.dueDeliveries(at(10)).map(item => item.event_id), ['e2', 'e4']);
  assert.equal(bridge.waitingFor('mac'), 4);
  assert.equal(bridge.nextDeliveryAt(), Date.parse(at(2)));
  const tail = scans.find(scan => scan.query.includes('ORDER BY next_at, event_id'));
  assert.match(tail.query, /FROM agent_deliveries NOT INDEXED\s+WHERE/);
  assert.ok(tail.query.includes('rowid > ?') && tail.args.includes(2));
  const tailPlan = originalExec(`EXPLAIN QUERY PLAN ${tail.query}`, ...tail.args).toArray();
  assert.ok(tailPlan.some(step => /USING INTEGER PRIMARY KEY \(rowid>\?\)/.test(step.detail)), JSON.stringify(tailPlan));
  const indexed = scans.find(scan => scan.query.includes('INDEXED BY agent_deliveries_due'));
  assert.ok(indexed, 'the earliest due time probes the existing due index first');
  const indexPlan = originalExec(`EXPLAIN QUERY PLAN ${indexed.query}`, ...indexed.args).toArray();
  assert.ok(indexPlan.some(step => /USING INDEX agent_deliveries_due/.test(step.detail)), JSON.stringify(indexPlan));

  current.putDelivery(olderStream);
  current.putDelivery(olderDue);
  records.write([{ id: 'table-move:agent_deliveries', type: 'table-move', value: { first_after: 4, first_done: true } }], { actor: { by: 'trillion' } });
  scans.length = 0;
  assert.deepEqual(bridge.streamWaiting('mac').map(item => item.event_id), ['e1', 'e3']);
  assert.deepEqual(bridge.dueDeliveries(at(10)).map(item => item.event_id), ['e2', 'e4']);
  assert.equal(bridge.waitingFor('mac'), 4);
  assert.equal(bridge.nextDeliveryAt(), Date.parse(at(2)));
  assert.deepEqual(scans, [], 'completed first pass needs no legacy waiting scan');
});

test('waiting count stops after enough visible old and new deliveries', () => {
  const { sql, bridge, current, delivery } = opened();
  sql.exec('CREATE INDEX agent_deliveries_agent ON agent_deliveries (agent_id, state)');
  for (let n = 0; n < 250; n++) delivery(event(n));
  current.putDelivery(event(0, { state: 'sent' }));
  current.putDelivery(event(500));
  const originalExec = sql.exec;
  const waitingReads = [];
  sql.exec = (query, ...args) => {
    if (/SELECT rowid, event_id FROM agent_deliveries/.test(query)) waitingReads.push({ query, args });
    return originalExec(query, ...args);
  };
  assert.equal(bridge.waitingFor('mac', 200), 200);
  assert.ok(waitingReads.length <= 3, 'the capped read stops at the threshold');
  assert.ok(waitingReads.every(read => read.query.includes('INDEXED BY agent_deliveries_agent') && !read.query.includes('OFFSET')));
  const plan = originalExec(`EXPLAIN QUERY PLAN ${waitingReads[0].query}`, ...waitingReads[0].args).toArray().map(step => step.detail).join(' ');
  assert.match(plan, /USING INDEX agent_deliveries_agent \(agent_id=\? AND state=\? AND rowid>\?\)/);
  assert.doesNotMatch(plan, /TEMP B-TREE/);
  assert.equal(bridge.waitingFor('mac'), 250);
});

test('the earliest unmoved delivery is reused until its row moves or a newer write hides it', () => {
  const { sql, records, bridge, delivery } = opened();
  for (const n of [1, 2, 3]) delivery(event(n));
  records.write([{ id: 'table-move:agent_deliveries', type: 'table-move', value: { first_after: 1 } }], { actor: { by: 'trillion' } });
  let queries = 0;
  const originalExec = sql.exec;
  sql.exec = (query, ...args) => {
    if (/SELECT rowid, event_id, next_at FROM agent_deliveries/.test(query)) queries += 1;
    return originalExec(query, ...args);
  };
  assert.equal(bridge.nextDeliveryAt(), Date.parse(at(2)));
  assert.equal(bridge.nextDeliveryAt(), Date.parse(at(2)));
  assert.equal(queries, 1, 'repeated clock reads do not rescan the old table');

  bridge.putDelivery(event(2, { state: 'sent' }));
  assert.equal(bridge.nextDeliveryAt(), Date.parse(at(3)));
  assert.equal(queries, 2, 'a newer write invalidates the cached legacy row');
  records.write([{ id: 'table-move:agent_deliveries', type: 'table-move', value: { first_after: 2 } }], { actor: { by: 'trillion' } });
  assert.equal(bridge.nextDeliveryAt(), Date.parse(at(3)));
  assert.equal(queries, 2, 'moving other rows leaves the minimum valid');
  records.write([{ id: 'table-move:agent_deliveries', type: 'table-move', value: { first_after: 3 } }], { actor: { by: 'trillion' } });
  assert.equal(bridge.nextDeliveryAt(), null);
  assert.equal(queries, 3, 'moving the minimum searches the remaining tail');
});

test('a dense copied waiting prefix falls back to the unmoved rowid tail', () => {
  const { sql, records, bridge, delivery } = opened();
  for (let n = 1; n <= 41; n += 1) delivery(event(n));
  sql.exec('CREATE INDEX agent_deliveries_due ON agent_deliveries (state, next_at)');
  records.write([{ id: 'table-move:agent_deliveries', type: 'table-move', value: { first_after: 40 } }], { actor: { by: 'trillion' } });
  const originalExec = sql.exec;
  const queries = [];
  sql.exec = (query, ...args) => {
    if (/SELECT rowid, event_id, next_at FROM agent_deliveries/.test(query)) queries.push({ query, args });
    return originalExec(query, ...args);
  };
  assert.equal(bridge.nextDeliveryAt(), Date.parse(at(41)));
  assert.equal(queries.length, 2);
  assert.match(queries[0].query, /INDEXED BY agent_deliveries_due/);
  assert.match(queries[1].query, /NOT INDEXED/);
  assert.ok(queries[1].args.includes(40));
});

test('timing and own-work readers keep order, blocked retry facts and record shadows during a partial move', () => {
  const { records, current, bridge, handoff } = opened();
  const moved = job(1, { priority: 5, said: 'First' });
  const held = job(2, { priority: 5, state: 'taken', taken_by: 'mac', hold_until: at(200) });
  const blocked = job(3, { priority: 5, in_the_way: 'try again', in_the_way_by: 'agent-retired-trillion', in_the_way_at: at(3), said: 'Third' });
  const removed = job(5, { priority: 5 });
  for (const item of [moved, held, blocked, removed]) handoff(item);
  current.putHandoff(moved);
  current.putHandoff(job(4, { priority: 5, said: 'Fourth' }));
  current.putHandoff({ ...removed, state: 'finished' });
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 1 } }], { actor: { by: 'trillion' } });
  const scheduled = bridge.openScheduledHandoffs();
  assert.deepEqual(scheduled.map(item => item.handoff_id), ['h001', 'h002', 'h003', 'h004']);
  assert.equal(scheduled[2].in_the_way_by, 'agent-retired-trillion');
  assert.equal(scheduled[2].in_the_way_at, at(3));
  const scheduledPages = [];
  for (let after = null;;) {
    const page = bridge.openScheduledHandoffsPage({ after, limit: 2 });
    scheduledPages.push(...page.map(item => item.handoff_id));
    if (page.length < 2) break;
    after = page.at(-1);
  }
  assert.deepEqual(scheduledPages, ['h001', 'h002', 'h003', 'h004'], 'cursor pages preserve tuple ordering through a partial table move');
  assert.deepEqual(bridge.ownWorkWaiting({ nowIso: at(100), minPriority: 5, limit: 2, includeSaid: true }), [
    { handoff_id: 'h001', handed_at: at(1), said: 'First' },
    { handoff_id: 'h003', handed_at: at(3), said: 'Third' },
  ]);
  assert.deepEqual(bridge.ownWorkWaiting({ nowIso: at(100), minPriority: 5, limit: 5 }).map(item => item.handoff_id),
    ['h001', 'h003', 'h004']);
});

for (const prepared of [false, true]) test(`review time reads only unmoved old open rows${prepared ? ' with its existing review index' : ' without review columns'}`, () => {
  const { sql, records, current, handoff } = opened();
  const moved = job(1, { review_at: at(20) });
  const unmoved = job(2, { review_at: at(10) });
  handoff(moved);
  handoff(unmoved);
  if (prepared) {
    sql.exec('ALTER TABLE agent_handoffs ADD COLUMN review_at TEXT');
    sql.exec("ALTER TABLE agent_handoffs ADD COLUMN waits_on TEXT NOT NULL DEFAULT '[]'");
    sql.exec('CREATE INDEX agent_handoffs_review ON agent_handoffs (open, review_at)');
    for (const item of [moved, unmoved]) sql.exec('UPDATE agent_handoffs SET review_at = ? WHERE handoff_id = ?', item.review_at, item.handoff_id);
  }
  current.putHandoff(moved);
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 1 } }], { actor: { by: 'trillion' } });
  const queries = [];
  const traced = { exec(query, ...args) { queries.push({ query, args }); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  queries.length = 0;
  assert.equal(bridge.nextReviewAt(at(0)), at(10), 'the eligible unmoved handoff still wins over a moved record');
  if (prepared) assert.ok(queries.some(({ query, args }) => query.includes('FROM agent_handoffs WHERE open = 1')
    && query.includes('ORDER BY review_at, rowid LIMIT ?') && args.at(-1) <= 32),
  'the review index supplies a bounded page and record shadows remove copied rows');
  else assert.ok(queries.some(({ query, args }) => query.includes('FROM agent_handoffs WHERE open = 1')
    && query.includes('rowid > ?') && args[0] === 1), 'the bare table scan starts after the persisted first-row cursor');

  current.putHandoff({ ...unmoved, state: 'finished' });
  assert.equal(bridge.nextReviewAt(at(0)), at(20), 'the newer finished record hides its old open review');
  current.putHandoff({ ...unmoved, review_at: at(30) });
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 2, first_done: true } }], { actor: { by: 'trillion' } });
  queries.length = 0;
  assert.equal(bridge.nextReviewAt(at(0)), at(20), 'moved open work continues to supply its review time from records');
  assert.equal(queries.some(({ query }) => query.includes('FROM agent_handoffs WHERE open = 1')), false,
    'a complete first pass never scans old open review rows');
});

test('a cold work board skips the moved legacy prefix and stops reading old open jobs when the first pass is done', () => {
  const { sql, records, current, handoff } = opened();
  for (let n = 0; n < 150; n += 1) {
    const item = job(n);
    handoff(item);
    if (n < 100) current.putHandoff(item);
  }
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 100, after: 40 } }], { actor: { by: 'trillion' } });
  const queries = [];
  const traced = { exec(query, ...args) { queries.push({ query, args }); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  assert.deepEqual(bridge.newestOpen(5).map(item => item.handoff_id), ['h149', 'h148', 'h147', 'h146', 'h145']);
  assert.ok(queries.some(({ query, args }) => query.includes('FROM agent_handoffs WHERE') && query.includes('rowid > ?') && args.includes(100)),
    'the old table starts beyond the first-row cursor');
  queries.length = 0;
  for (let n = 100; n < 150; n += 1) current.putHandoff(job(n));
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 150, first_done: true, after: 40 } }], { actor: { by: 'trillion' } });
  assert.deepEqual(bridge.newestOpen(5).map(item => item.handoff_id), ['h149', 'h148', 'h147', 'h146', 'h145']);
  assert.equal(queries.some(({ query }) => query.includes('FROM agent_handoffs WHERE open = 1')), false,
    'the old open table is absent from a work board after its first pass');
});

test('work board loads count only unmoved old jobs and honor newer edits', () => {
  const { sql, records, current, handoff } = opened();
  const held = n => job(n, { state: 'taken', taken_by: 'mac', to_agent: 'mac', hold_until: at(1000) });
  const waiting = n => job(n, { to_agent: 'mac' });
  for (const item of [held(1), waiting(2), waiting(3), waiting(4), held(5), held(6)]) handoff(item);
  current.putHandoff(held(1));
  current.putHandoff(waiting(2));
  current.putHandoff({ ...waiting(4), state: 'finished' });
  current.putHandoff({ ...held(6), state: 'finished' });
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 2, after: 0 } }], { actor: { by: 'trillion' } });
  const queries = [];
  const traced = { exec(query, ...args) { queries.push({ query, args }); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  assert.equal(bridge.waitingCount('mac'), 2);
  assert.deepEqual(bridge.heldBy('mac').map(item => item.handoff_id), ['h001', 'h005']);
  const oldReads = queries.filter(({ query }) => query.includes('FROM agent_handoffs') && query.includes('open = 1'));
  assert.ok(oldReads.length > 0 && oldReads.every(({ query, args }) => query.includes('rowid > ?') && args.includes(2)),
    'the work board reads past the first-row cursor');

  current.putHandoff(waiting(3));
  current.putHandoff(held(5));
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 6, first_done: true, after: 0 } }], { actor: { by: 'trillion' } });
  queries.length = 0;
  assert.equal(bridge.waitingCount('mac'), 2);
  assert.deepEqual(bridge.heldBy('mac').map(item => item.handoff_id), ['h001', 'h005']);
  assert.equal(queries.some(({ query }) => query.includes('FROM agent_handoffs') && query.includes('open = 1')), false,
    'a complete first pass serves the board from records alone');
});

test('open work pages read only unmoved metadata through shadows and hydrate only selected jobs', () => {
  const { sql, records, current, handoff } = opened();
  sql.exec('CREATE INDEX agent_handoffs_open ON agent_handoffs (open, handed_at)');
  for (let n = 0; n < 200; n += 1) {
    handoff(job(n, { job: 'x'.repeat(8_000) }));
    if (n < 80) current.putHandoff(job(n));
    else if (n < 160) current.putHandoff(job(n, { state: 'finished' }));
  }
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 80 } }], { actor: { by: 'trillion' } });
  const queries = [];
  const traced = { exec(query, ...args) { queries.push({ query, args }); return sql.exec(query, ...args); } };
  const bridge = agentLegacyRows({ sql: traced, records, current });
  queries.length = 0;
  assert.deepEqual(bridge.openHandoffs({ after: 'h079', limit: 5 }).map(item => item.handoff_id),
    ['h160', 'h161', 'h162', 'h163', 'h164']);
  const metadata = queries.filter(({ query }) => query.includes('SELECT handoff_id, handed_at FROM agent_handoffs'));
  assert.equal(metadata.length, 2, 'a fixed metadata page passes 80 shadows in two reads');
  assert.ok(metadata.every(({ query, args }) => query.includes('rowid > ?') && args.includes(80) && args.at(-1) === 64));
  const values = queries.filter(({ query }) => query.includes('SELECT handoff_id, value FROM agent_handoffs'));
  assert.equal(values.length, 1, 'only the selected legacy jobs are hydrated');
  assert.equal(JSON.parse(values[0].args[0]).length, 5);

  for (let n = 160; n < 200; n += 1) current.putHandoff(job(n));
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_after: 200, first_done: true } }], { actor: { by: 'trillion' } });
  queries.length = 0;
  assert.deepEqual(bridge.openHandoffs({ after: 'h079', limit: 5 }).map(item => item.handoff_id),
    ['h160', 'h161', 'h162', 'h163', 'h164']);
  assert.equal(queries.some(({ query }) => query.includes('FROM agent_handoffs') && query.includes('open = 1')), false,
    'completed first move never reads the old open table');
});

test('review index pages beyond blocked jobs sharing one review time', () => {
  const { current, bridge } = opened();
  for (let n = 0; n < 70; n += 1) current.putHandoff(job(n, { review_at: '', depends_on: ['missing'] }));
  current.putHandoff(job(100, { review_at: at(200) }));
  let next;
  for (let attempt = 0; attempt < 8 && next !== at(200); attempt += 1) next = bridge.nextReviewAt(at(10));
  assert.equal(next, at(200));
});

test('copied open work keeps its review answer until a handoff changes', () => {
  const { sql, records, current } = opened();
  let reviewScans = 0;
  const scan = records.scan.bind(records);
  records.scan = (...args) => {
    if (args[1] === 'review') reviewScans += 1;
    return scan(...args);
  };
  const bridge = agentLegacyRows({ sql, records, current });
  for (let n = 0; n < 70; n += 1) current.putHandoff(job(n, { review_at: '', depends_on: ['missing'] }));
  current.putHandoff(job(100, { review_at: '' }));
  current.putHandoff(job(101, { review_at: at(200) }));
  records.write([{ id: 'table-move:agent_handoffs', type: 'table-move', value: { first_done: true } }], { actor: { by: 'trillion' } });
  const settled = (nowIso, expected) => {
    let result;
    for (let attempt = 0; attempt < 8 && result !== expected; attempt += 1) result = bridge.nextReviewAt(nowIso);
    return result;
  };
  assert.equal(settled(at(10), at(10)), at(10));
  assert.equal(settled(at(300), at(200)), at(200));
  current.putCard({ agent_id: 'mac', name: 'Mac' });
  assert.equal(settled(at(20), at(20)), at(20));
  current.putHandoff(job(101, { review_at: at(5) }));
  assert.equal(settled(at(20), at(5)), at(5));
});

test('an overdue timed review precedes work reviewed immediately', () => {
  const { current, bridge, handoff } = opened();
  current.putHandoff(job(1, { review_at: '' }));
  current.putHandoff(job(2, { review_at: at(20) }));
  handoff(job(3, { review_at: '' }));
  handoff(job(4, { review_at: at(10) }));
  assert.equal(bridge.nextReviewAt(at(100)), at(10));
});

test('a table whose rows all moved into records is no longer read while it is let go', () => {
  const { sql, records, current, handoff } = opened();
  handoff(job(1));
  const statements = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...params) => { statements.push(query); return exec(query, ...params); };
  const reading = agentLegacyRows({ sql, records, current, placeOf: () => ({}) });
  assert.equal(reading.handoff('h001')?.handoff_id, 'h001', 'an unmoved table is still read');
  statements.length = 0;
  const moved = agentLegacyRows({ sql, records, current, placeOf: table => (table === 'agent_handoffs' ? { moved: true } : {}) });
  assert.equal(moved.handoff('h001'), null);
  assert.deepEqual(moved.openHandoffs({ limit: 10 }), []);
  assert.ok(!statements.some(query => /agent_handoffs/.test(query)), statements.join('\n'));
});

// The mover keeps its place in memory and writes its record only with write-outs, so the record lags. Reads follow the
// mover: on 2026-10-06 they read the lagging record and Sam's events pull re-walked 41,000 copied rows a call.
test('old rows are read only past where the mover has reached, ahead of its kept record', () => {
  const { sql, records, current, delivery } = opened();
  delivery(event(1, { next_at: null }));
  const statements = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...params) => { statements.push(query); return exec(query, ...params); };
  const lagging = agentLegacyRows({ sql, records, current });
  assert.equal(lagging.streamWaiting('mac').length, 1, 'with no place anywhere, the old row is still read');
  statements.length = 0;
  const ahead = agentLegacyRows({ sql, records, current, placeOf: table => (table === 'agent_deliveries' ? { first_done: true, first_after: 1 } : {}) });
  statements.length = 0;
  assert.deepEqual(ahead.streamWaiting('mac'), []);
  assert.equal(ahead.nextDeliveryAt(), null);
  assert.ok(!statements.some(query => /FROM agent_deliveries/.test(query)), statements.join('\n'));
});

test('old cards copied by the first pass are not read again; a card past its place still is', () => {
  const { sql, records, current, card } = opened();
  for (let n = 1; n <= 30; n += 1) card({ agent_id: `a${String(n).padStart(2, '0')}`, reader: 'reader', takes_work: true, name: `old ${n}` });
  const statements = [];
  const exec = sql.exec.bind(sql);
  sql.exec = (query, ...params) => { statements.push({ query, params }); return exec(query, ...params); };
  const passed = agentLegacyRows({ sql, records, current, placeOf: table => (table === 'agent_cards' ? { first_done: true, first_after: 30 } : {}) });
  current.putCard({ agent_id: 'a01', reader: 'reader', takes_work: true, name: 'moved 1' });
  assert.deepEqual(passed.cards().map(item => item.name), ['moved 1']);
  assert.deepEqual(passed.cardIdsOf({ reader: 'reader', takes_work: true }), ['a01'], 'the greeting skips the copied card prefix too');
  const read = statements.filter(({ query }) => /FROM agent_cards/.test(query));
  assert.ok(read.length && read.every(({ query, params }) => /rowid > \?/.test(query) && params.includes(30)), JSON.stringify(read));
  card({ agent_id: 'a31', reader: 'reader', takes_work: true, name: 'old 31, written after the pass' });
  assert.deepEqual(passed.cards().map(item => item.name), ['moved 1', 'old 31, written after the pass']);
  assert.deepEqual(passed.cardIdsOf({ reader: 'reader', takes_work: true }), ['a01', 'a31']);
});
