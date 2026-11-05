// Ported from old trillion test/agent-work-reviews-flat.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. agentRecordStore is this tool's agent-records.mjs (old src/agent-records.mjs);
// the log store and its indexes come from tools/keep-and-wake-ai-sessions-on-this-computer, and the old
// test/person-store-reads-for-tests.mjs countingHost is rebuilt below. Every assertion is the old one.
// test/agent-work-reviews-flat.test.mjs
//
// The `agent-work-reviews` alarm source asks "when is the next review of open work due?" (src/agents.mjs nextReviewAt ->
// src/agent-records.mjs nextReviewAt) on every arm. On Sam Example's store (read_use, 2026-10-09 00:00-06:00Z) it read about 440
// statements and 1,300 rows on each of 1,046 asks inside tool runs. The cost was the work that waits on other work still
// open: its reviews fall due before the earliest one that can be acted on, so each was read, with the work it waits on,
// to find that it could not be. Such work now holds no entry in review_next (the write that finishes what it waits on writes
// it again). This seeds N and 4N of it, due earlier than the one ready job, and fails when asking costs more as N grows or
// answers differently from the index that walks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordLogStore } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/record-log/do-work/record-log-store.mjs';
import { RECORD_INDEXES } from '../../keep-and-wake-ai-sessions-on-this-computer/src/record-engine.mjs';
import { sqliteHost } from '../../keep-and-wake-ai-sessions-on-this-computer/src/local-store.mjs';
import { agentRecordStore, FOUND_BY } from '../agent-records.mjs';

// What each statement hands back, counted (old test/person-store-reads-for-tests.mjs countingHost).
function countingHost() {
  const host = sqliteHost(':memory:');
  const reads = [];
  const sql = { exec(query, ...params) {
    const cursor = host.sql.exec(query, ...params);
    const rows = cursor.toArray();
    reads.push({ query, params, rows: rows.length });
    return cursor;
  } };
  return { host, sql, take: () => reads.splice(0) };
}

const SMALL = 500;
const HOUR = 3_600_000;
const at = hours => new Date(Date.UTC(2026, 9, 5) + hours * HOUR).toISOString();
const NOW = at(8000);
const job = (n, extra = {}) => ({ handoff_id: `h_${String(n).padStart(5, '0')}`, job: `job ${n}`, state: 'open', handed_at: at(n), to_agent: null,
  taken_by: null, priority: 0, generation: 0, input: { note: 'x' }, ...extra });
// One open job everything waits on, `count` jobs waiting on it (as agents.mjs writes them: waits_open), due before
// the one ready job whose review is at(9000).
const work = count => [job(0, { review_at: at(9000) }),
  ...Array.from({ length: count }, (_, i) => job(i + 1, { depends_on: ['h_00000'], waits_open: 1, review_at: at(1 + i) }))];

function seeded(count, { migrated = true } = {}) {
  const host = countingHost();
  const records = recordLogStore(host.sql, { transaction: host.host.transaction, indexes: RECORD_INDEXES });
  const store = agentRecordStore({ records, transaction: host.host.transaction });
  store.transaction(() => { for (const item of work(count)) store.putHandoff(item); });
  if (migrated) for (let step = 0; step < Math.ceil(count / 64) * 2 + 4; step += 1) store.scheduledWake.step();
  records.checkpoint();
  return { host, records, store };
}
const ask = f => {
  f.host.take();
  const answer = f.store.nextReviewAt(NOW);
  const reads = f.host.take();
  return { answer, statements: reads.length, rows: reads.reduce((sum, item) => sum + item.rows, 0) };
};

test('asking for the next review costs the same at N and 4N jobs waiting on open work', () => {
  const a = ask(seeded(SMALL)), b = ask(seeded(SMALL * 4));
  console.log(`agent-work-reviews nextReviewAt: N=${SMALL} -> ${a.statements} statements ${a.rows} rows, 4N -> ${b.statements} ${b.rows}`);
  assert.equal(a.answer, at(9000), 'the ready job is the next review');
  assert.equal(b.answer, a.answer);
  assert.ok(b.statements <= a.statements + 6, `statements ${a.statements} -> ${b.statements}`);
  assert.ok(b.rows <= a.rows + 6, `rows ${a.rows} -> ${b.rows}`);
  assert.ok(b.statements <= 12, `${b.statements} statements`);
});

test('work whose dependency has finished, and work not yet through the step, are still found', () => {
  // Written before the step: the earlier index answers the same, however many wait.
  const before = seeded(SMALL, { migrated: false });
  let pendingReview = before.store.nextReviewAt(NOW);
  for (let page = 0; page < Math.ceil(SMALL / 32) + 2 && pendingReview !== at(9000); page += 1) pendingReview = before.store.nextReviewAt(NOW);
  assert.equal(pendingReview, at(9000), 'bounded continuation eventually finds work before its facts pass completes');
  // The work it waited on finishes and writes its dependents again, as agents.mjs releaseDependents does.
  const after = seeded(SMALL);
  after.store.transaction(() => {
    after.store.putHandoff(job(0, { state: 'finished', review_at: null }));
    after.store.putHandoff(job(1, { depends_on: ['h_00000'], review_at: NOW }));
  });
  assert.equal(after.store.nextReviewAt(NOW), NOW, 'a dependent written again with its dependency finished is due');
  assert.equal(after.records.read('agent-handoff:h_00001')[FOUND_BY].review_depends, 1);
});
