import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { addWorkshopFact, forgetExpiredWorkshopFacts, forgetWorkshopFacts, prefixEnd, workshopNextDue, workshopNextExpiry, workshopValues, workshopValuesPage, workshopVersion } from '../../shared-code/src/workshop-facts.mjs';

const afterFill = ask => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { return ask(); } catch (error) { if (!error.workshop_current_pending) throw error; assert.ok(Number.isFinite(error.retry_at)); }
  }
  throw new Error('current metadata did not finish');
};

test('current Workshop values use the entity index and keep literal prefix semantics', () => {
  const { sql } = sqliteHost(':memory:');
  sql.exec('CREATE TABLE workshop_facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity TEXT NOT NULL, value TEXT NOT NULL)');
  sql.exec('CREATE INDEX workshop_facts_current ON workshop_facts (entity, seq)');
  const add = (entity, value) => sql.exec('INSERT INTO workshop_facts (at, entity, value) VALUES (?, ?, ?)', 'now', entity, JSON.stringify(value));
  add('charge:one', { value: 'old' });
  add('other:one', { value: 'other' });
  add('charge:two', { value: 'two' });
  add('charge:one', { value: 'new' });
  add('charge%:literal', { value: 'percent' });
  add('charge_:literal', { value: 'underscore' });
  add('é:one', { value: 'accent' });
  add('😺:one', { value: 'cat' });
  add('😸:one', { value: 'other cat' });
  assert.deepEqual(workshopValues(sql, 'charge:'), [{ value: 'two' }, { value: 'new' }]);
  assert.deepEqual(workshopValues(sql, 'charge%:'), [{ value: 'percent' }]);
  assert.deepEqual(workshopValues(sql, 'charge_:'), [{ value: 'underscore' }]);
  assert.deepEqual(workshopValues(sql, '😺:'), [{ value: 'cat' }]);
  assert.deepEqual(workshopValues(sql, ''), [
    { value: 'other' }, { value: 'two' }, { value: 'new' }, { value: 'percent' },
    { value: 'underscore' }, { value: 'accent' }, { value: 'cat' }, { value: 'other cat' },
  ]);
  assert.equal(prefixEnd('😺:'), '😺;');
  assert.equal(prefixEnd('\ud7ff'), '\ue000');
  assert.equal(prefixEnd('\udbff\udfff'), null);
  const plan = sql.exec(`EXPLAIN QUERY PLAN SELECT f.value FROM workshop_current c JOIN workshop_facts f ON f.seq = c.seq
    WHERE c.entity >= ? AND c.entity < ? ORDER BY c.seq`, 'charge:', prefixEnd('charge:')).toArray();
  assert.ok(plan.some(row => /SEARCH c USING (COVERING )?INDEX sqlite_autoindex_workshop_current_1 \(entity>\? AND entity<\?\)|SEARCH c USING PRIMARY KEY \(entity>\? AND entity<\?\)/.test(row.detail)), JSON.stringify(plan));
});

const factsHost = () => {
  const { sql } = sqliteHost(':memory:');
  sql.exec('CREATE TABLE workshop_facts (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, entity TEXT NOT NULL, value TEXT NOT NULL)');
  sql.exec('CREATE INDEX workshop_facts_current ON workshop_facts (entity, seq)');
  return sql;
};
const reading = sql => {
  const seen = [];
  const exec = sql.exec.bind(sql);
  return { seen, sql: { exec: (query, ...params) => { const cursor = exec(query, ...params); const rows = cursor.toArray(); seen.push({ query, rows: rows.length }); return { toArray: () => rows }; } } };
};

test('related Workshop values select only current matching bodies with literal prefix semantics', () => {
  const sql = factsHost();
  const origin = 'workflow:origin';
  const variation = { id: 'workflow:variation', made_from: [origin] };
  addWorkshopFact(sql, 'workflow-recipe:workflow:old-edge', { id: 'workflow:old-edge', made_from: [origin] });
  addWorkshopFact(sql, 'workflow-recipe:workflow:old-edge', { id: 'workflow:old-edge', made_from: [] });
  addWorkshopFact(sql, 'workflow-recipe:workflow:unrelated', { id: 'workflow:unrelated', made_from: [], text: 'x'.repeat(200_000) });
  addWorkshopFact(sql, 'workflow-recipe:workflow:scalar', { id: 'workflow:scalar', made_from: origin });
  addWorkshopFact(sql, 'workflow-recipe:workflow:object', { id: 'workflow:object', made_from: { parent: origin } });
  addWorkshopFact(sql, 'workflow-recipe:workflow:variation', variation);
  addWorkshopFact(sql, 'other:workflow:variation', { ...variation, id: 'workflow:other-kind' });
  addWorkshopFact(sql, 'workflow-recipe%:workflow:literal', { ...variation, id: 'workflow:literal' });
  const watched = reading(sql);
  const containing = { field: 'made_from', value: origin };
  afterFill(() => workshopValues(watched.sql, 'workflow-recipe:', { containing }));
  watched.seen.length = 0;
  assert.deepEqual(workshopValues(watched.sql, 'workflow-recipe:', { containing }), [variation]);
  assert.deepEqual(watched.seen.map(read => read.rows), [1], 'only the related current body crosses the cursor');
  assert.deepEqual(workshopValues(sql, 'workflow-recipe%:', { containing }).map(row => row.id), ['workflow:literal']);
  assert.deepEqual(workshopValues(sql, 'workflow-recipe:', { containing: { ...containing, value: "workflow:origin' OR 1=1 --" } }), [], 'the member value is bound, not SQL');
  assert.throws(() => workshopValues(sql, 'workflow-recipe:', { containing: { field: 'made_from) OR 1=1', value: origin } }), /list field/);
  assert.throws(() => workshopValues(sql, 'workflow-recipe:', { containing: { field: 'made_from', value: null } }), /text member/);
});

test('related Workshop pages preserve every current match in write order', () => {
  const sql = factsHost();
  const origin = 'workflow:many-origins';
  const related = Array.from({ length: 131 }, (_, index) => ({ id: `workflow:related-${index}`, made_from: [origin] }));
  for (const row of related) addWorkshopFact(sql, `workflow-recipe:${row.id}`, row);
  const watched = reading(sql);
  const containing = { field: 'made_from', value: origin };
  afterFill(() => workshopValues(watched.sql, 'workflow-recipe:', { containing }));
  watched.seen.length = 0;
  assert.deepEqual(workshopValues(watched.sql, 'workflow-recipe:', { containing }), related);
  assert.deepEqual(watched.seen.map(read => read.rows), [64, 64, 3]);
  assert.ok(watched.seen.every(read => /LIMIT \?/.test(read.query)));
});

test('current Workshop values cost the entities under a prefix, never the versions written, and a forgotten fact is gone', () => {
  const sql = factsHost();
  for (let index = 0; index < 500; index += 1) addWorkshopFact(sql, `tool:${index % 5}`, { version: index });
  addWorkshopFact(sql, 'other:x', { version: 0 });
  const watched = reading(sql);
  assert.deepEqual(workshopValues(watched.sql, 'tool:').map(value => value.version), [495, 496, 497, 498, 499]);
  watched.seen.length = 0;
  assert.deepEqual(workshopValues(watched.sql, 'tool:').map(value => value.version), [495, 496, 497, 498, 499]);
  assert.deepEqual(watched.seen.map(read => read.rows), [5], 'one statement, one row per entity');
  addWorkshopFact(sql, 'tool:2', { version: 500 });
  assert.deepEqual(workshopValues(watched.sql, 'tool:').map(value => value.version), [495, 496, 498, 499, 500]);
  const copy = workshopValues(watched.sql, 'tool:');
  copy[0].version = 'changed';
  assert.equal(workshopValues(watched.sql, 'tool:')[0].version, 495, 'each read answers its own copy');
  forgetWorkshopFacts(sql, { entity: 'tool:0' });
  assert.deepEqual(workshopValues(watched.sql, 'tool:').map(value => value.version), [496, 498, 499, 500]);
  forgetWorkshopFacts(sql, { prefix: 'tool:' });
  assert.deepEqual(workshopValues(watched.sql, 'tool:'), []);
  assert.deepEqual(workshopValues(watched.sql, 'other:'), [{ version: 0 }]);
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM workshop_facts WHERE entity LIKE 'tool:%'").toArray()[0].n, 0);
});

test('a store kept before the index is filled once, a page at a time, and a page is read through the index', () => {
  const sql = factsHost();
  const add = (entity, value) => sql.exec('INSERT INTO workshop_facts (at, entity, value) VALUES (?, ?, ?)', new Date().toISOString(), entity, JSON.stringify(value));
  for (let index = 0; index < 1300; index += 1) add(`tool:${String(index % 650).padStart(4, '0')}`, { version: index });
  add('task:t1', { task_id: 't1' });
  assert.throws(() => workshopValues(sql, 'tool:'), error => error.workshop_current_pending);
  assert.equal(afterFill(() => workshopValues(sql, 'tool:')).length, 650);
  assert.equal(sql.exec('SELECT done FROM workshop_current_filled').toArray()[0].done, 1);
  assert.deepEqual(workshopValues(sql, 'tool:0649').map(value => value.version), [1299]);
  assert.throws(() => workshopValues(sql, 'task:'), /Workshop runs/);
  const page = workshopValuesPage(sql, 'tool:', { limit: 3 });
  assert.deepEqual(page.rows.map(row => row.entity), ['tool:0000', 'tool:0001', 'tool:0002']);
  assert.equal(workshopValuesPage(sql, 'tool:', { after: page.next, limit: 2 }).rows[0].entity, 'tool:0003');
});

test('a fill that is cut short resumes after the page it last finished, and what was written meanwhile is kept', () => {
  const sql = factsHost();
  const add = (entity, value) => sql.exec('INSERT INTO workshop_facts (at, entity, value) VALUES (?, ?, ?)', new Date().toISOString(), entity, JSON.stringify(value));
  for (let index = 0; index < 1300; index += 1) add(`tool:${String(index).padStart(4, '0')}`, { version: index });
  add('event-seen:src:a', { event_id: 'a', source_id: 'src', pending: true, retry_at: 5 });
  const pageSelect = query => query.includes('WITH RECURSIVE workshop_fill');
  // A store reset in the middle of the second page: the first page is marked, the rest is not.
  let pages = 0;
  const cut = { exec(query, ...params) { if (pageSelect(query) && (pages += 1) === 2) throw new Error('the store was reset'); return sql.exec(query, ...params); } };
  assert.throws(() => workshopValues(cut, 'tool:'), error => error.workshop_current_pending);
  assert.throws(() => workshopValues(cut, 'tool:'), /reset/);
  const mark = sql.exec('SELECT after, done FROM workshop_current_filled').toArray()[0];
  assert.equal(mark.done, 0);
  assert.ok(mark.after > 'event-seen:src:a' && mark.after < 'tool:1299', 'the first page was marked');
  // A fact written before the rest is filled: its version must win over the older one the fill meets later.
  addWorkshopFact(sql, 'tool:1299', { version: 'newer' });
  // The next wake is a new process: it starts after the marked page, not from the beginning.
  const starts = [];
  const resumed = { exec(query, ...params) { if (pageSelect(query)) starts.push(params[0]); return sql.exec(query, ...params); } };
  const values = afterFill(() => workshopValues(resumed, 'tool:'));
  assert.equal(starts[0], mark.after, 'it resumed after the page it last finished');
  assert.equal(starts.length, 20, 'only the twenty remaining64-entity pages were read');
  assert.equal(values.length, 1300);
  assert.deepEqual(values.at(-1), { version: 'newer' });
  assert.equal(sql.exec('SELECT done FROM workshop_current_filled').toArray()[0].done, 1);
  assert.equal(workshopNextDue(resumed, 'event-seen:'), 5);
});

test('the version of a prefix moves when a fact under it is written or forgotten, and only then', () => {
  const sql = factsHost();
  addWorkshopFact(sql, 'event-listen:a', { source_id: 'a' });
  addWorkshopFact(sql, 'event-listen-task:a:proof', { state: 'working' });
  const before = workshopVersion(sql, 'event-listen');
  assert.equal(workshopVersion(sql, 'event-listen'), before);
  addWorkshopFact(sql, 'event-seen:x', { pending: false });
  assert.equal(workshopVersion(sql, 'event-listen'), before, 'a fact outside the prefix does not move it');
  addWorkshopFact(sql, 'event-listen-task:a:proof', { state: 'completed' });
  const written = workshopVersion(sql, 'event-listen');
  assert.notEqual(written, before);
  forgetWorkshopFacts(sql, { entity: 'event-listen:a' });
  assert.notEqual(workshopVersion(sql, 'event-listen'), written);
});

test('open facts say when they are next due, and facts that are over age out in bounded pages', () => {
  const sql = factsHost();
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const old = new Date(now - 40 * day).toISOString();
  for (let index = 0; index < 5; index += 1) {
    addWorkshopFact(sql, `event-seen:src:${index}`, { event_id: String(index), source_id: 'src', pending: true, retry_at: now + (5 - index) * 1000 }, old);
    addWorkshopFact(sql, `event-seen:src:${index}`, { event_id: String(index), source_id: 'src', pending: false }, old);
  }
  addWorkshopFact(sql, 'event-seen:src:open', { event_id: 'open', source_id: 'src', pending: true, retry_at: now + 5000 });
  addWorkshopFact(sql, 'event-seen:other:open', { event_id: 'open2', source_id: 'other', pending: true, retry_at: now + 1000 });
  addWorkshopFact(sql, 'event-seen:fresh', { event_id: 'fresh', source_id: 'src', pending: false });
  assert.equal(sql.exec("SELECT COUNT(*) AS n FROM workshop_facts WHERE entity LIKE 'event-seen:src:_'").toArray()[0].n, 5, 'a newer version replaces the one before');
  assert.deepEqual(workshopValues(sql, 'event-seen:', { open: {} }).map(value => value.event_id), ['open2', 'open']);
  assert.deepEqual(workshopValues(sql, 'event-seen:', { open: { scopes: ['src'] } }).map(value => value.event_id), ['open']);
  assert.deepEqual(workshopValues(sql, 'event-seen:', { open: { due_by: now + 2000 } }).map(value => value.event_id), ['open2']);
  assert.equal(workshopNextDue(sql, 'event-seen:'), now + 1000);
  assert.equal(workshopNextDue(sql, 'event-seen:', { scopes: ['src'] }), now + 5000);
  assert.equal(workshopNextDue(sql, 'event-batch:'), null);
  assert.deepEqual(workshopValues(sql, 'event-seen:', { newest: 2 }).map(value => value.event_id), ['open2', 'fresh']);
  assert.equal(workshopNextExpiry(sql), Date.parse(old) + 30 * day);
  assert.equal(forgetExpiredWorkshopFacts(sql, now, 3), 3);
  assert.equal(forgetExpiredWorkshopFacts(sql, now, 3), 2);
  assert.equal(forgetExpiredWorkshopFacts(sql, now, 3), 0);
  assert.ok(Math.abs(workshopNextExpiry(sql) - (now + 30 * day)) < 5000, 'what is left ages out from when it was written');
  assert.equal(workshopValues(sql, 'event-seen:').length, 3);
});
