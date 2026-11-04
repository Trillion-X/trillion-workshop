// Real SQLite proof for the scheduler's timing questions: active event bodies stay unopened, including when a
// route is still being confirmed or every waiting event belongs to an obsolete route. Legacy timing fills resume.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHost } from '../src/local-store.mjs';
import { makeEventRules } from '../src/events.mjs';
import { armKnownDue } from '../src/scheduler.mjs';
import { addWorkshopFact, forgetExpiredWorkshopFacts, forgetWorkshopFacts, forgetWorkshopSetup, workshopNextExpiry, workshopValues } from '../../shared-code/src/workshop-facts.mjs';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const ISO = new Date(NOW).toISOString();
const SOURCE = { id: 'events:routes', label: 'Incoming routes', connects_with: { connection_id: 'connection:routes', vendor: 'vendor' }, route_key_proof: { collection: {} } };
test('failed event admissions keep their exact retry alarm and preserve an earlier wake', async () => {
  for (const existing of [null, NOW + 500]) {
    const source = { id: 'events:plain' };
    const kept = new Map([
      [`event-listen:${source.id}`, { source_id: source.id, route_key: 'inbox' }],
      ['event-rule:r', { rule_id: 'r', source_id: source.id, event: 'message', match: { kind: 'every' }, then: { tool_id: 'tool:fail', input: {} } }],
    ]);
    let alarmAt = existing;
    const alarm = { getAlarm: async () => alarmAt, setAlarm: async at => { alarmAt = at; } };
    const due = [];
    const rules = makeEventRules({
      workshop: { run: async () => { throw new Error('Try again later.'); } }, routes: {}, sources: async () => [source], now: () => new Date(NOW),
      facts: { read: async key => kept.get(key), list: async prefix => [...kept].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value), write: async (key, value) => { kept.set(key, value); } },
      rearm: async at => {
        assert.equal(kept.get(`event-seen:${source.id}:one`).retry_at, at, 'the admission is durable before scheduling');
        due.push(at); await armKnownDue(alarm, at, () => NOW);
      },
    });
    const answer = await rules.receive({ source_id: source.id, events: [{ event_id: 'one', name: 'message', route_key: 'inbox' }] });
    assert.equal(answer.results[0].pending, true);
    assert.deepEqual(due, [NOW + 60_000]);
    assert.equal(alarmAt, existing ?? NOW + 60_000);
  }
});
function host() {
  const result = sqliteHost(':memory:');
  result.sql.exec('CREATE TABLE workshop_facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity TEXT NOT NULL, value TEXT NOT NULL)');
  result.sql.exec('CREATE INDEX workshop_facts_current ON workshop_facts (entity, seq)');
  return result;
}
function watched(base) {
  const seen = [];
  const sql = { exec(query, ...params) {
    const rows = base.exec(query, ...params).toArray();
    seen.push({ query, params, rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(rows)) });
    return { toArray: () => rows };
  } };
  return { sql, seen, take: () => seen.splice(0) };
}
const raw = (sql, entity, value, at = ISO) => sql.exec('INSERT INTO workshop_facts (at, entity, value) VALUES (?, ?, ?) RETURNING seq', at, entity, JSON.stringify(value)).toArray()[0].seq;
const seen = (route, retry, pending = true, extra = {}) => ({ source_id: SOURCE.id, pending, retry_at: retry, event_payload: { route_key: route, text: 'body'.repeat(1000) }, ...extra });
const next = (sql, options = { scopes: [SOURCE.id], routes: ['subscribed'] }) => workshopValues(sql, 'event-seen:', { next: options })[0];
function ready(sql, prefix = 'event-seen:') {
  for (let call = 0; call < 200; call += 1) {
    try { return workshopValues(sql, prefix, { next: {} }); }
    catch (error) { if (!error.workshop_summary_pending) throw error; assert.ok(Number.isFinite(error.retry_at)); }
  }
  throw new Error('timing summary did not finish');
}
function rulesOver(sql, { listener = {}, connected_at = ISO, sources = [SOURCE] } = {}) {
  addWorkshopFact(sql, `event-listen:${SOURCE.id}`, { source_id: SOURCE.id, route_keys: ['subscribed'], registered_route_keys: ['subscribed', 'confirming'], connection_revision: `${SOURCE.connects_with.connection_id}:${ISO}`, ...listener }, ISO);
  const watch = watched(sql);
  const rules = makeEventRules({
    workshop: {}, routes: {}, sources: async () => sources, now: () => new Date(NOW),
    connection: async id => ({ connection_id: id, vendor: 'vendor', status: 'connected', connected_at }),
    facts: {
      read: async entity => {
        assert.ok(entity.startsWith('event-listen:'), `timing opened ${entity}`);
        const row = watch.sql.exec('SELECT value FROM workshop_facts WHERE entity = ? ORDER BY seq DESC LIMIT 1', entity).toArray()[0];
        return row ? JSON.parse(row.value) : null;
      },
      list: async (prefix, options) => { assert.ok(options?.next, `timing listed full ${prefix}`); return workshopValues(watch.sql, prefix, options); },
    },
  });
  return { rules, watch };
}

const RETRY_SOURCE = { id: 'events:retry', delivery_policy: { retry: { when_error_contains: ['temporary'], after_seconds: 900, max_attempts: 3 } } };
const RETRY_RULE = { rule_id: 'rule:retry', source_id: RETRY_SOURCE.id, enabled: true, label: 'Retry event', then: { tool_id: 'tool:retry', input: { event: 'kept' } } };
const OLD_ATTEMPT = { task_id: 'task:old', source_id: RETRY_SOURCE.id, rule_id: RETRY_RULE.rule_id, tool_id: RETRY_RULE.then.tool_id,
  input: RETRY_RULE.then.input, base_key: 'event:stable', attempt: 1, deadline: null, due_at: new Date(NOW - 120_000).toISOString(), done: false };
function retryHarness(sql, { source = RETRY_SOURCE, rule = RETRY_RULE, task = { task_id: OLD_ATTEMPT.task_id, state: 'failed', error: 'temporary limit' },
  attempt = OLD_ATTEMPT, refuseStart = false, failSuccessorLineage = false, failCompletion = false, heldRead = null, taskByKey = new Map(), seed = true,
  clock = { at: NOW } } = {}) {
  if (seed) raw(sql, `event-attempt:${attempt.task_id}`, attempt);
  if (seed) addWorkshopFact(sql, `event-rule:${rule.rule_id}`, rule, ISO);
  let failLineage = failSuccessorLineage, failOldCompletion = failCompletion;
  let runs = 0, created = 0, reads = 0;
  const facts = {
    async read(entity) {
      const row = sql.exec('SELECT value FROM workshop_facts WHERE entity = ? ORDER BY seq DESC LIMIT 1', entity).toArray()[0];
      return row ? JSON.parse(row.value) : null;
    },
    async list(prefix, options = {}) {
      return workshopValues(sql, prefix, options);
    },
    async write(entity, value) {
      if (entity.startsWith('event-attempt:task:successor-') && failLineage) { failLineage = false; throw new Error('synthetic successor lineage refusal'); }
      if (entity === `event-attempt:${OLD_ATTEMPT.task_id}` && value.done && failOldCompletion) { failOldCompletion = false; throw new Error('synthetic predecessor completion refusal'); }
      addWorkshopFact(sql, entity, value, new Date(clock.at).toISOString());
    },
  };
  const workshop = {
    async read({ task_id }) { reads += 1; if (heldRead) await heldRead; return task_id === OLD_ATTEMPT.task_id ? task : ([...taskByKey.values()].find(item => item.task_id === task_id) ?? { task_id, state: 'scheduled' }); },
    async run(args) {
      runs += 1;
      const old = await facts.read(`event-attempt:${OLD_ATTEMPT.task_id}`);
      assert.deepEqual(old.retry_plan, { request_key: args.request_key, attempt: 2, run_at: args.run_at }, 'the plan is durable before startup is attempted');
      if (refuseStart) { refuseStart = false; throw new Error('synthetic startup refusal'); }
      if (taskByKey.has(args.request_key)) return taskByKey.get(args.request_key);
      const successor = { task_id: `task:successor-${++created}`, state: 'scheduled', request_key: args.request_key, run_at: args.run_at };
      taskByKey.set(args.request_key, successor);
      return successor;
    },
  };
  const rules = makeEventRules({ workshop, facts, routes: {}, sources: async () => [source], now: () => new Date(clock.at) });
  return { rules, facts, workshop, taskByKey, counts: () => ({ runs, created, reads }), source, rule };
}

test('retry plans survive owner recreation and keep their original run time and request key', async () => {
  const { sql, db } = host();
  const clock = { at: NOW };
  let owner = retryHarness(sql, { refuseStart: true, clock });
  assert.equal(await owner.rules.retryFailed(), 0);
  const saved = await owner.facts.read(`event-attempt:${OLD_ATTEMPT.task_id}`);
  assert.deepEqual(saved.retry_plan, { request_key: 'event:stable:attempt-2', attempt: 2, run_at: new Date(NOW + 900_000).toISOString() });
  clock.at += 120_000;
  owner = retryHarness(sql, { seed: false, clock });
  assert.equal(await owner.rules.retryFailed(), 1);
  assert.equal(owner.taskByKey.has(saved.retry_plan.request_key), true);
  assert.equal((await owner.facts.read(`event-attempt:${OLD_ATTEMPT.task_id}`)).retry_plan.run_at, saved.retry_plan.run_at);
  assert.equal((await owner.facts.read('event-attempt:task:successor-1')).due_at, saved.retry_plan.run_at);
  db.close();
});

test('a successor-lineage refusal resumes with the stable key and an expired persisted plan is not started', async () => {
  {
    const { sql, db } = host();
    const clock = { at: NOW };
    let owner = retryHarness(sql, { failSuccessorLineage: true, clock });
    assert.equal(await owner.rules.retryFailed(), 0);
    const saved = await owner.facts.read(`event-attempt:${OLD_ATTEMPT.task_id}`);
    const successor = [...owner.taskByKey.values()][0];
    owner = retryHarness(sql, { seed: false, clock, taskByKey: owner.taskByKey });
    assert.equal(await owner.rules.retryFailed(), 1);
    assert.equal(owner.counts().created, 0);
    assert.equal((await owner.facts.read(`event-attempt:${OLD_ATTEMPT.task_id}`)).successor_task_id, successor.task_id);
    assert.equal((await owner.facts.read(`event-attempt:${successor.task_id}`)).retry_plan, undefined);
    assert.equal(saved.retry_plan.request_key, successor.request_key);
    db.close();
  }
  {
    const { sql, db } = host();
    const clock = { at: NOW };
    const deadline = NOW + 30_000;
    const attempt = { ...OLD_ATTEMPT, deadline, retry_plan: { request_key: 'event:stable:attempt-2', attempt: 2, run_at: new Date(NOW + 10_000).toISOString() } };
    const owner = retryHarness(sql, { attempt, clock });
    clock.at = deadline + 1;
    assert.equal(await owner.rules.retryFailed(), 0);
    assert.equal(owner.counts().created, 0);
    assert.equal((await owner.facts.read(`event-attempt:${OLD_ATTEMPT.task_id}`)).done, true);
    db.close();
  }
});

test('retry completion recovery preserves an advanced successor and serializes overlapping retry calls', async () => {
  const { sql, db } = host();
  const clock = { at: NOW };
  let owner = retryHarness(sql, { failCompletion: true, clock });
  assert.equal(await owner.rules.retryFailed(), 0);
  const successor = [...owner.taskByKey.values()][0];
  addWorkshopFact(sql, `event-attempt:${successor.task_id}`, { task_id: successor.task_id, attempt: 2, done: true, state: 'succeeded', due_at: successor.run_at, marker: 'advanced' }, new Date(NOW + 1).toISOString());
  owner = retryHarness(sql, { seed: false, clock, taskByKey: owner.taskByKey });
  const [first, second] = await Promise.all([owner.rules.retryFailed(), owner.rules.retryFailed()]);
  assert.equal(first, second);
  assert.deepEqual(await owner.facts.read(`event-attempt:${successor.task_id}`), { task_id: successor.task_id, attempt: 2, done: true, state: 'succeeded', due_at: successor.run_at, marker: 'advanced' });
  assert.equal((await owner.facts.read(`event-attempt:${OLD_ATTEMPT.task_id}`)).done, true);
  assert.equal(owner.counts().created, 0);
  db.close();
});

test('terminal, ineligible, disabled, exhausted and out-of-window attempts close without a retry run', async () => {
  const cases = [
    { task: { task_id: OLD_ATTEMPT.task_id, state: 'succeeded' } },
    { task: { task_id: OLD_ATTEMPT.task_id, state: 'failed', error: 'permanent' } },
    { rule: { ...RETRY_RULE, enabled: false } },
    { attempt: { ...OLD_ATTEMPT, attempt: 3 } },
    { attempt: { ...OLD_ATTEMPT, deadline: NOW + 30_000 } },
  ];
  for (const options of cases) {
    const { sql, db } = host();
    const owner = retryHarness(sql, options);
    assert.equal(await owner.rules.retryFailed(), 0);
    assert.equal(owner.counts().created, 0);
    assert.equal((await owner.facts.read(`event-attempt:${OLD_ATTEMPT.task_id}`)).done, true);
    db.close();
  }
});

test('subscribed, confirming and obsolete-only active backlogs have flat scalar scheduling reads at N and 4N', async () => {
  for (const mode of ['subscribed', 'confirming', 'obsolete']) {
    const costs = [];
    for (const count of [500, 2000]) {
      const { sql, db } = host();
      for (let index = 0; index < count; index += 1) addWorkshopFact(sql, `event-seen:${index}`, seen(mode, NOW + 120_000 + index), ISO);
      const { rules, watch } = rulesOver(sql);
      const answer = await rules.nextCheck();
      assert.equal(answer, mode === 'obsolete' ? null : NOW + (mode === 'confirming' ? 60_000 : 120_000));
      watch.take();
      // Poison bodies after current metadata exists: a timing question must not parse or return even one.
      sql.exec("UPDATE workshop_facts SET value = 'not JSON' WHERE entity >= 'event-seen:' AND entity < 'event-seen;' ");
      assert.equal(await rules.nextCheck(), answer);
      const reads = watch.take();
      assert.ok(reads.every(row => !/SELECT .*value.*event-seen/.test(row.query)));
      costs.push({ statements: reads.length, rows: reads.reduce((sum, row) => sum + row.rows, 0), bytes: reads.reduce((sum, row) => sum + row.bytes, 0) });
      db.close();
    }
    assert.deepEqual(costs[1], costs[0], `${mode} grows with its active backlog`);
    console.log(`${mode} N500/2000 scalar reads ${JSON.stringify(costs)}`);
  }
});

test('route and scope questions use indexed first-row probes without sorting a matching backlog', () => {
  const { sql, db } = host();
  addWorkshopFact(sql, 'event-seen:first', seen('subscribed', -5), ISO);
  addWorkshopFact(sql, 'event-seen:zero', seen('second', 0), ISO);
  const watch = watched(sql);
  assert.equal(next(watch.sql, { scopes: [SOURCE.id], routes: ['second', 'subscribed'] }).at, -5);
  assert.equal(next(watch.sql, { scopes: [SOURCE.id], routes: ['second'], pending: true }).pending, true);
  assert.equal(next(watch.sql, { scopes: [SOURCE.id], from_due: 0 }).at, 0);
  for (const row of watch.seen.filter(row => row.query.includes('FROM json_each'))) {
    const plan = sql.exec(`EXPLAIN QUERY PLAN ${row.query}`, ...row.params).toArray().map(row => row.detail).join('\n');
    assert.match(plan, /SEARCH workshop_current_timing USING COVERING INDEX workshop_current_timing_(route|scope)_due/);
    assert.doesNotMatch(plan, /TEMP B-TREE|SCAN workshop_current_timing/);
  }
  assert.deepEqual(next(sql, { scopes: [], routes: [] }), { at: null, pending: false });
  assert.throws(() => next(sql, { routes: ['subscribed'] }), /one source/);
  db.close();
});

test('route timing retains finite zero/negative values and ignores invalid times except for pending existence', async () => {
  const { sql, db } = host();
  addWorkshopFact(sql, 'event-seen:invalid', seen('subscribed', '0'), ISO);
  addWorkshopFact(sql, 'event-seen:zero', seen('subscribed', 0), ISO);
  assert.equal(next(sql).at, 0);
  addWorkshopFact(sql, 'event-seen:negative', seen('subscribed', -5), ISO);
  assert.equal(next(sql).at, -5);
  assert.deepEqual(next(sql, { scopes: [SOURCE.id], routes: ['unknown'], pending: true }), { at: null, pending: false });
  forgetWorkshopFacts(sql, { prefix: 'event-seen:' });
  addWorkshopFact(sql, 'event-seen:confirm', seen('confirming', null), ISO);
  const { rules } = rulesOver(sql);
  assert.equal(await rules.nextCheck(), NOW + 60_000);
  db.close();
});

test('stopped listeners and changed connection incarnations never use pending route timing', async () => {
  for (const change of [{ listener: { stop_requested: true } }, { listener: { stopped: true } }, { connected_at: 'new-incarnation' }]) {
    const { sql, db } = host();
    addWorkshopFact(sql, 'event-seen:due', seen('subscribed', -5), ISO);
    const { rules, watch } = rulesOver(sql, change);
    assert.equal(await rules.nextCheck(), change.connected_at ? NOW : null);
    assert.equal(watch.seen.filter(row => row.query.includes('FROM json_each')).length, 0);
    db.close();
  }
});

test('legacy summary creation avoids populated global indexes and advances only one bounded page', async () => {
  for (const count of [500, 2000]) {
    const { sql, db } = host();
    sql.exec('CREATE TABLE workshop_current (entity TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT, scope TEXT, due REAL, expires REAL)');
    sql.exec('CREATE INDEX workshop_current_due ON workshop_current (kind, due) WHERE due IS NOT NULL');
    sql.exec('CREATE INDEX workshop_current_scope_due ON workshop_current (kind, scope, due) WHERE due IS NOT NULL');
    sql.exec('CREATE INDEX workshop_current_expiring ON workshop_current (expires) WHERE expires IS NOT NULL');
    sql.exec('CREATE INDEX workshop_current_newest ON workshop_current (kind, seq) WHERE kind IS NOT NULL');
    sql.exec('CREATE TABLE workshop_current_filled (id INTEGER PRIMARY KEY CHECK (id = 1), after TEXT NOT NULL, done INTEGER NOT NULL)');
    sql.exec("INSERT INTO workshop_current_filled VALUES (1, '', 1)");
    for (let index = 0; index < count; index += 1) {
      const entity = `event-seen:${String(index).padStart(4, '0')}`;
      const seq = raw(sql, entity, seen('subscribed', index));
      sql.exec('INSERT INTO workshop_current VALUES (?, ?, ?, ?, ?, NULL)', entity, seq, 'event-seen:', SOURCE.id, index);
      raw(sql, `unrelated:${index}`, { large: 'unused'.repeat(1000) });
    }
    const creation = [];
    const watch = watched({ exec(query, ...params) {
      if (/CREATE INDEX.*workshop_current_timing/.test(query)) creation.push(sql.exec('SELECT COUNT(*) AS n FROM workshop_current_timing').toArray()[0].n);
      return sql.exec(query, ...params);
    } });
    assert.throws(() => next(watch.sql), error => error.workshop_summary_pending && Number.isFinite(error.retry_at));
    assert.deepEqual(creation, [0, 0, 0, 0], 'new indexes must be created while their projection is empty');
    assert.equal(sql.exec('SELECT COUNT(*) AS n FROM workshop_current_timing').toArray()[0].n, 64);
    assert.equal(watch.seen.filter(row => row.query.includes('AS scalar')).length, 64);
    assert.equal(watch.seen.filter(row => /SELECT (at, )?value/.test(row.query)).length, 0, 'no complete legacy value is returned');
    assert.equal(sql.exec('SELECT COUNT(*) AS n FROM workshop_current').toArray()[0].n, count, 'scalar migration does not rewrite global current rows');
    const cursor = sql.exec("SELECT after FROM workshop_current_summaries_filled WHERE kind = 'event-seen:'").toArray()[0].after;
    const resumed = watched(sql);
    assert.throws(() => next(resumed.sql), error => error.workshop_summary_pending);
    assert.equal(resumed.seen.find(row => row.query.includes('picked')).params[0], cursor);
    ready(resumed.sql);
    assert.equal(next(resumed.sql).at, 0);
    db.close();
  }
});

test('legacy summary enforces its processing-byte budget and sizes only one possible following body', () => {
  const { sql, db } = host();
  for (let index = 0; index < 10; index += 1) raw(sql, `event-seen:${index}`, seen('subscribed', index, true, { text: 'x'.repeat(600_000) }));
  const watch = watched(sql);
  assert.throws(() => next(watch.sql), error => error.workshop_summary_pending);
  assert.equal(watch.seen.filter(row => row.query.includes('AS scalar')).length, 1);
  assert.equal(watch.seen.filter(row => row.query.includes('AS bytes')).length, 2, 'only one boundary size probe');
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM workshop_current_timing').toArray()[0].n, 1);
  db.close();
});

test('legacy metadata page seeks past old versions instead of grouping their whole history', () => {
  const costs = [];
  for (const versions of [500, 2000]) {
    const { sql, db } = host();
    for (let version = 0; version < versions; version += 1) raw(sql, 'event-seen:one', seen('subscribed', version));
    const watch = watched(sql);
    assert.equal(next(watch.sql).at, versions - 1);
    const picked = watch.seen.find(row => row.query.includes('WITH RECURSIVE picked'));
    const plan = sql.exec(`EXPLAIN QUERY PLAN ${picked.query}`, ...picked.params).toArray().map(row => row.detail).join('\n');
    assert.match(plan, /SEARCH workshop_facts USING COVERING INDEX workshop_facts_current \(entity>\? AND entity<\?\)/);
    assert.match(plan, /SEARCH workshop_facts USING COVERING INDEX workshop_facts_current \(entity=\?\)/);
    assert.doesNotMatch(picked.query, /GROUP BY|MAX\(seq\)/);
    costs.push({ statements: watch.seen.length, rows: watch.seen.reduce((sum, row) => sum + row.rows, 0) });
    db.close();
  }
  assert.deepEqual(costs[1], costs[0]);
});

test('interrupted legacy pages resume safely and a concurrent newer timing value wins', () => {
  const { sql, db } = host();
  for (let index = 0; index < 70; index += 1) raw(sql, `event-seen:${String(index).padStart(4, '0')}`, seen('subscribed', 100 + index));
  let inserts = 0;
  const cut = { exec(query, ...params) {
    if (query.startsWith('INSERT INTO workshop_current_timing') && ++inserts === 3) throw new Error('interrupted');
    return sql.exec(query, ...params);
  } };
  assert.throws(() => next(cut), /interrupted/);
  assert.equal(sql.exec("SELECT after FROM workshop_current_summaries_filled WHERE kind = 'event-seen:'").toArray()[0].after, 'event-seen:');
  let updated = false;
  const resumed = { exec(query, ...params) {
    if (!updated && query.startsWith('INSERT INTO workshop_current_timing') && params[0] === 'event-seen:0000') {
      updated = true; addWorkshopFact(sql, params[0], seen('subscribed', -10), ISO);
    }
    return sql.exec(query, ...params);
  } };
  ready(resumed);
  assert.equal(next(resumed).at, -10);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM workshop_current_timing').toArray()[0].n, 70);
  db.close();
});

test('legacy and current writes preserve JS truthiness, time types and source identity', () => {
  const values = [false, 0, '', null, true, 1, 'yes', [], {}];
  for (const pending of values) {
    const { sql, db } = host();
    raw(sql, 'event-seen:legacy', seen('subscribed', 9, pending));
    ready(sql);
    const old = next(sql);
    forgetWorkshopFacts(sql, { entity: 'event-seen:legacy' });
    addWorkshopFact(sql, 'event-seen:current', seen('subscribed', 9, pending), ISO);
    assert.deepEqual(next(sql), old);
    assert.equal(old.at, pending ? 9 : null);
    db.close();
  }
  for (const done of values) {
    const { sql, db } = host();
    raw(sql, 'event-attempt:legacy', { due_at: ISO, done });
    const old = ready(sql, 'event-attempt:');
    forgetWorkshopFacts(sql, { entity: 'event-attempt:legacy' });
    addWorkshopFact(sql, 'event-attempt:current', { due_at: ISO, done }, ISO);
    assert.deepEqual(workshopValues(sql, 'event-attempt:', { next: {} }), old);
    assert.equal(old[0].at, done ? null : NOW + 60_000);
    db.close();
  }
  for (const value of [true, false, '9', null, 0, -5, 9, [ISO], {}]) {
    const { sql, db } = host();
    raw(sql, 'event-seen:legacy', seen('subscribed', value));
    raw(sql, 'event-attempt:legacy', { due_at: value, done: false });
    ready(sql); ready(sql, 'event-attempt:');
    const old = next(sql), attempt = workshopValues(sql, 'event-attempt:', { next: {} });
    forgetWorkshopFacts(sql, { prefix: 'event-' });
    addWorkshopFact(sql, 'event-seen:current', seen('subscribed', value), ISO);
    addWorkshopFact(sql, 'event-attempt:current', { due_at: value, done: false }, ISO);
    assert.deepEqual(next(sql), old, `retry_at ${JSON.stringify(value)}`);
    assert.deepEqual(workshopValues(sql, 'event-attempt:', { next: {} }), attempt, `due_at ${JSON.stringify(value)}`);
    db.close();
  }
  const { sql, db } = host();
  raw(sql, 'event-seen:bad-source', seen('subscribed', 1, true, { source_id: [SOURCE.id] }));
  ready(sql);
  assert.equal(next(sql).at, null);
  db.close();
});

test('a full-value migration resumed after an old cursor cannot mark missing early timing rows ready', () => {
  const { sql, db } = host();
  for (let index = 0; index < 70; index += 1) raw(sql, `event-seen:${String(index).padStart(4, '0')}`, seen('subscribed', 10 + index));
  raw(sql, 'tool:tail', { id: 'tail' });
  sql.exec('CREATE TABLE workshop_current_filled (id INTEGER PRIMARY KEY CHECK (id = 1), after TEXT NOT NULL, done INTEGER NOT NULL)');
  sql.exec("INSERT INTO workshop_current_filled VALUES (1, 'event-seen:0069', 0)");
  assert.deepEqual(workshopValues(sql, 'tool:'), [{ id: 'tail' }]);
  assert.throws(() => next(sql), error => error.workshop_summary_pending);
  ready(sql);
  assert.equal(next(sql).at, 10);
  db.close();
});

test('exact, prefix and expired deletion remove timing, and rolled-back setup can be rebuilt', () => {
  const { sql, db, transaction } = host();
  const old = new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString();
  addWorkshopFact(sql, 'event-seen:first', seen('subscribed', 1), ISO);
  addWorkshopFact(sql, 'event-seen:second', seen('subscribed', 2), ISO);
  forgetWorkshopFacts(sql, { entity: 'event-seen:first' });
  assert.equal(next(sql).at, 2);
  forgetWorkshopFacts(sql, { prefix: 'event-seen:' });
  assert.equal(next(sql).at, null);
  addWorkshopFact(sql, 'event-seen:closed', seen('subscribed', 3, false), old);
  addWorkshopFact(sql, 'event-attempt:closed', { done: [] }, old);
  addWorkshopFact(sql, 'event-count:closed', { ignored: 'body' }, old);
  assert.equal(workshopNextExpiry(sql), Date.parse(old) + 30 * 24 * 60 * 60 * 1000);
  assert.equal(forgetExpiredWorkshopFacts(sql, NOW, 2), 2);
  assert.equal(forgetExpiredWorkshopFacts(sql, NOW, 2), 1);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM workshop_current_timing').toArray()[0].n, 0);
  assert.equal(workshopNextExpiry(sql), null);
  db.close();

  const clean = host();
  assert.throws(() => clean.transaction(() => { next(clean.sql); throw new Error('rollback'); }), /rollback/);
  forgetWorkshopSetup(clean.sql);
  raw(clean.sql, 'event-seen:legacy', seen('subscribed', 7));
  assert.equal(next(clean.sql).at, 7);
  clean.db.close();
});

test('nextCheck and the scheduler expiry sibling never invoke the legacy full-value fill', async () => {
  const { sql, db } = host();
  for (let index = 0; index < 130; index += 1) {
    raw(sql, `event-seen:${String(index).padStart(4, '0')}`, seen('subscribed', index));
    raw(sql, `event-count:${String(index).padStart(4, '0')}`, { unused: 'x'.repeat(20_000) });
    raw(sql, `tool:${index}`, { unused: 'x'.repeat(20_000) });
  }
  const { rules, watch } = rulesOver(sql);
  await assert.rejects(rules.nextCheck(), error => error.workshop_summary_pending);
  ready(watch.sql);
  assert.equal(await rules.nextCheck(), 0);
  assert.throws(() => workshopNextExpiry(watch.sql), error => error.workshop_summary_pending);
  assert.equal(sql.exec('SELECT COUNT(*) AS n FROM workshop_current_filled').toArray()[0].n, 0);
  assert.equal(watch.seen.filter(row => /SELECT at, value|SELECT entity, MAX\(seq\) AS seq FROM workshop_facts WHERE entity > \? GROUP BY/.test(row.query)).length, 0);
  db.close();
});
