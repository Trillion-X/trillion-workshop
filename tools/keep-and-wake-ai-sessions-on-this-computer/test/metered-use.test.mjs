// Ported from old trillion test/metered-use.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. Of its sixty-one tests one has a running owner: the scheduler (src/scheduler.mjs here) waits out a
// use-budget refusal until its time and never counts it as a failure; it is the old test, its built-in
// tool:when-to-run-next answered by tools/run-work-later-or-on-a-repeat/do-work/when-to-wake.ts. The other sixty
// tested old src/metered-use.mjs, the Durable Object's per-purpose SQL meter (its budgets and stops, admission, hourly limits, flushes to the pool, the pool's
// ranking, traces and the kept judgement). That file went with the Worker and nothing meters that way now: trillion-rust only
// carries the old metered_use_days rows as records (src/storage/record_store_resources.json "metered-use-days"), its
// resource_authority/budget is a credit/hold book for account file bytes, and docs/worker-retirement-rust-engine-slice.md
// classes the old resource budget owner as hosted billing (searched meteredUse, UseBudgetReached, metered-use.mjs,
// heavy_invocation, purposeOfRequest, everyonesUse in trillion-workshop tools/, trillion-apps web/, trillion-rust src/), so
// they are left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScheduler } from '../src/scheduler.mjs';
import { whenToWake } from '../../run-work-later-or-on-a-repeat/do-work/when-to-wake.ts';

const NOON = Date.parse('2026-10-04T12:00:00Z');
// The built-in tool the scheduler asks (tool:when-to-run-next), as the old test/engine-tools-for-tests.mjs ran it.
const builtInToolsForTests = { run: async (tool_id, input) => { assert.equal(tool_id, 'tool:when-to-run-next'); return whenToWake(input); } };

test('the scheduler waits out a use-budget refusal until its time and never counts it as a failure', async () => {
  const kept = { value: null, read: async () => kept.value, write: async next => { kept.value = structuredClone(next); } };
  const alarms = [];
  const at = NOON;
  const until = Date.parse('2026-10-05T00:00:00Z');
  const scheduler = makeScheduler({
    alarm: { setAlarm: ms => alarms.push(ms), deleteAlarm: () => {} }, kept, now: () => at,
    builtIn: builtInToolsForTests,
    step: (label, work) => (label === 'busy:when' ? Promise.reject(Object.assign(new Error('used up'), { retry_at: until })) : work()),
    sources: [{ name: 'busy', data: async () => ({}), run: async () => ({}) }],
  });
  await scheduler.wake();
  await scheduler.wake();
  const entry = kept.value.entries.busy;
  assert.deepEqual([entry.failures, entry.held, entry.retry_at], [0, false, until]);
});
