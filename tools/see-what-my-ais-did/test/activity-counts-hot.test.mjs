// Ported from old trillion test/activity-counts-hot.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The counts live in this tool's activity.mjs now (old src/activity.mjs); the old
// test/person-store-reads-for-tests.mjs countingHost is rebuilt below over local-store's sqliteHost. Every assertion is the old one.
// The progress line of a job counts the distinct kept calls done for it, its decision, the parts handed on from it and
// its parts (activityCounts). A decision that many calls name is counted from the count kept for it as calls are
// written (activity_counts_g<n>), not by reading every link; this holds the answer equal to counting the links outright,
// across generations kept before the counts existed, a second such decision, calls kept between two reads, and a reset.
import assert from 'node:assert/strict';
import test from 'node:test';
import { activityCount, activityCounts, activityTable, forgetActivityTable, keepActivity } from '../activity.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';

// What a statement hands back, counted (old test/person-store-reads-for-tests.mjs countingHost).
function countingHost() {
  const host = sqliteHost(':memory:');
  const reads = [];
  const sql = { exec(query, ...params) {
    const cursor = host.sql.exec(query, ...params);
    const rows = cursor.toArray();
    let bytes = 0;
    for (const row of rows) for (const value of Object.values(row)) bytes += typeof value === 'string' ? value.length : (value?.byteLength ?? 8);
    reads.push({ query, params, rows: rows.length, bytes });
    return cursor;
  } };
  return { host, sql, reads, take: () => reads.splice(0) };
}

const at = new Date().toISOString();
const call = (sql, ids, keep = 5000) => keepActivity(sql, { at, app: 'Trillion', item: null, uses: [], for: ids, ok: true }, keep);
// What counting the links outright says for each group.
const outright = (sql, groups) => new Map(groups.map(({ id, related }) => [id, activityCount(sql, related)]).filter(([, count]) => count > 0));
const same = (sql, groups, message) => assert.deepEqual([...activityCounts(sql, groups)].sort(), [...outright(sql, groups)].sort(), message);
const groupsOf = (jobs, extra) => jobs.map(id => ({ id, related: [id, ...extra(id)] }));

test('separately cached hot decisions combine exactly without flattening later single-decision reads', () => {
  const { sql, take } = countingHost();
  activityTable(sql);
  for (let i = 0; i < 160; i++) call(sql, ['a', ...(i < 80 ? ['b'] : [])]);
  for (let i = 0; i < 80; i++) call(sql, ['b']);
  const separate = [{ id: 'a-only', related: ['a'] }, { id: 'b-only', related: ['b'] }];
  same(sql, separate, 'both decisions are cached separately');
  const combined = [{ id: 'both', related: ['a', 'b'] }];
  same(sql, combined, 'a later group combines only already-cached IDs');
  call(sql, ['extra']);
  call(sql, ['a', 'extra']);
  call(sql, ['b', 'extra']);
  same(sql, [{ id: 'both', related: ['b', 'a', 'extra'] }], 'overlap counts once, extras count once');
  same(sql, separate, 'a combined group does not flatten subsequent single-hot groups');
  take();
  call(sql, ['unrelated']);
  take();
  activityCounts(sql, separate);
  const reads = take();
  assert.ok(reads.reduce((n, read) => n + read.rows, 0) < 20, 'one unrelated arrival never returns retained hot history');
});

test('a decision named by many calls is counted from its kept count, equal to counting the links', () => {
  const { sql, take } = countingHost();
  activityTable(sql);
  const jobs = Array.from({ length: 30 }, (_, i) => `h_${i}`);
  for (let i = 0; i < 400; i += 1) call(sql, [jobs[i % jobs.length], 'case-hot']);
  for (let i = 0; i < 40; i += 1) call(sql, [jobs[i % jobs.length]]);
  call(sql, ['case-hot']);
  const groups = groupsOf(jobs, id => ['case-hot', `${id}-child`]);
  same(sql, groups, 'first read');
  // The read again, with calls kept since for a job only, for the decision only, and for both.
  call(sql, ['h_3']);
  same(sql, groups, 'a call for one job');
  call(sql, ['case-hot']);
  same(sql, groups, 'a call for the decision');
  call(sql, ['h_4', 'case-hot', 'h_5']);
  same(sql, groups, 'a call for two jobs and the decision');
  // A call that names a part of the job and the decision both.
  call(sql, ['h_6-child', 'case-hot']);
  same(sql, groups, 'a call for a part and the decision');
  // Read again with nothing kept since: nothing is read.
  take();
  activityCounts(sql, groups);
  assert.equal(take().length, 0, 'nothing kept since, so nothing is read');
});

test('counts stay equal across a generation kept before the counts existed, and when generations roll', () => {
  const { sql } = countingHost();
  activityTable(sql);
  const jobs = Array.from({ length: 12 }, (_, i) => `h_${i}`);
  for (let i = 0; i < 200; i += 1) call(sql, [jobs[i % jobs.length], 'case-hot'], 300);
  // Make that generation look as one kept before the counts: no counts table.
  sql.exec('DROP TABLE activity_counts_g1');
  forgetActivityTable(sql);
  const groups = groupsOf(jobs, () => ['case-hot']);
  same(sql, groups, 'a generation without counts is counted from its links');
  for (let i = 0; i < 90; i += 1) call(sql, [jobs[(i * 5) % jobs.length], 'case-hot'], 300);
  same(sql, groups, 'calls kept after, in the same uncounted generation');
  // The generation is full: the next calls start one with counts, beside the one without.
  for (let i = 0; i < 150; i += 1) call(sql, [jobs[(i * 7) % jobs.length], ...(i % 3 ? ['case-hot'] : [])], 300);
  same(sql, groups, 'a counted generation beside an uncounted one');
  for (let i = 0; i < 300; i += 1) call(sql, [jobs[i % jobs.length], 'case-hot'], 300);
  same(sql, groups, 'after the uncounted generation is dropped');
  const tables = sql.exec("SELECT name FROM sqlite_master WHERE name GLOB 'activity_counts_g*'").toArray().map(row => row.name);
  const generations = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'activity_g[0-9]*'").toArray().length;
  assert.equal(tables.length <= generations, true, 'a dropped generation takes its counts with it');
});

test('two decisions named by many calls in one piece of work are still counted exactly', () => {
  const { sql } = countingHost();
  activityTable(sql);
  const jobs = Array.from({ length: 10 }, (_, i) => `h_${i}`);
  for (let i = 0; i < 300; i += 1) call(sql, [jobs[i % jobs.length], 'case-a', ...(i % 2 ? ['case-b'] : [])]);
  for (let i = 0; i < 100; i += 1) call(sql, ['case-b']);
  const groups = groupsOf(jobs, () => ['case-a', 'case-b']);
  same(sql, groups, 'two hot ids');
  call(sql, ['h_1', 'case-a']);
  same(sql, groups, 'again after a call');
  // A later page names only the one decision, after both were read.
  same(sql, groupsOf(jobs, () => ['case-a']), 'one of them alone');
});

test('a reset of the store starts the counts again', () => {
  const { sql } = countingHost();
  activityTable(sql);
  const jobs = ['h_a', 'h_b'];
  for (let i = 0; i < 200; i += 1) call(sql, [jobs[i % 2], 'case-hot']);
  const groups = groupsOf(jobs, () => ['case-hot']);
  same(sql, groups, 'before');
  sql.exec('DROP VIEW IF EXISTS activity');
  sql.exec('DROP VIEW IF EXISTS activity_links');
  for (const { name } of sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND (name GLOB 'activity_*')").toArray()) sql.exec(`DROP TABLE ${name}`);
  forgetActivityTable(sql);
  for (let i = 0; i < 5; i += 1) call(sql, [jobs[i % 2], 'case-hot']);
  same(sql, groups, 'after a reset');
});


test('combined hot counts survive legacy generations, expiry and reset', () => {
  const { sql } = countingHost();
  activityTable(sql);
  const groups = [{ id: 'both', related: ['a', 'b', 'extra'] }];
  for (let i = 0; i < 200; i++) call(sql, ['a', ...(i % 2 ? ['b'] : ['extra'])], 240);
  sql.exec('DROP TABLE activity_counts_g1');
  forgetActivityTable(sql);
  same(sql, groups, 'legacy links');
  for (let i = 0; i < 220; i++) call(sql, ['b', ...(i % 2 ? ['a'] : ['extra'])], 240);
  same(sql, groups, 'two hot counted IDs alongside legacy links');
  for (let i = 0; i < 250; i++) call(sql, ['a', 'b', ...(i % 2 ? ['extra'] : [])], 240);
  same(sql, groups, 'legacy generation expired');
  sql.exec('DROP VIEW activity');
  sql.exec('DROP VIEW activity_links');
  for (const { name } of sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'activity_*'").toArray()) sql.exec(`DROP TABLE ${name}`);
  forgetActivityTable(sql);
  for (let i = 0; i < 150; i++) call(sql, ['a', ...(i % 2 ? ['b'] : [])]);
  for (let i = 0; i < 90; i++) call(sql, ['b']);
  same(sql, groups, 'new store after sequence reset');
});

test('a failed membership probe does not publish a union delta twice on retry', () => {
  const counted = countingHost();
  let failMembership = false;
  const sql = { exec(query, ...params) {
    if (failMembership && query.includes('WHERE a.seq IN') && query.includes('AND a.id IN')) {
      failMembership = false;
      throw new Error('membership probe interrupted');
    }
    return counted.sql.exec(query, ...params);
  } };
  activityTable(sql);
  for (let i = 0; i < 160; i++) call(sql, ['a', ...(i < 80 ? ['b'] : [])]);
  for (let i = 0; i < 80; i++) call(sql, ['b']);
  const groups = [{ id: 'both', related: ['a', 'b', 'extra'] }];
  same(sql, groups, 'initial union');
  call(sql, ['a', 'extra']);
  call(sql, ['extra']);
  failMembership = true;
  assert.throws(() => activityCounts(sql, groups), /membership probe interrupted/);
  same(sql, groups, 'retry after delta succeeded but membership failed');
  same(sql, groups, 'subsequent read stays exact');
});

test('a cached small ID promotes to a count when it becomes hot', () => {
  const { sql, take } = countingHost();
  activityTable(sql);
  const groups = [{ id: 'a', related: ['a'] }];
  for (let i = 0; i < 60; i++) call(sql, ['a']);
  same(sql, groups, 'small history');
  for (let i = 0; i < 120; i++) call(sql, ['a']);
  same(sql, groups, 'promotion keeps exact count');
  call(sql, ['unrelated']);
  take();
  activityCounts(sql, groups);
  const reads = take();
  assert.equal(reads.some(read => read.query.includes('activity_links_g')), false, 'later poll reads the count only');
});
