// tool:hear-a-recording's own run limit (invoke.max_run_ms). The default limit is 120 s, too short to read a recording of
// hundreds of megabytes through the files right and hear it: the run was cut off as OutcomeUnknown (Nov 20 2026, 11:49 CST).
// The limit is sized from the largest recording the tool was run on (341,851,041 bytes), read at the measured rate of about
// 1.3 MB/s (L08's read), plus room for the hearing itself. It must stay within the engine's ceiling (run_ceiling_ms).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RUN_CEILING_MS = 50_400_000;
// The chosen-workflow wake's line budget (a-workflow-was-chosen, wall_ms): a row's own limit must fit inside it, or the step is
// refused before the tool starts (run-refused, Nov 20 2026 12:05 CST). A longer recording needs the wake owner's bigger budget.
const WAKE_LINE_WALL_MS = 2_400_000;
const LARGEST_BYTES = 341_851_041;
const READ_BYTES_PER_SECOND = 1_300_000;
const READ_MS = Math.ceil((LARGEST_BYTES / READ_BYTES_PER_SECOND) * 1000);

const row = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8'))
  .records.map(record => record.payload).find(payload => payload.id === 'tool:hear-a-recording');

test('hear-a-recording declares its own run limit as a whole number of milliseconds within the engine ceiling', () => {
  assert.ok(Number.isInteger(row.invoke.max_run_ms), 'max_run_ms is a whole number');
  assert.ok(row.invoke.max_run_ms >= 1 && row.invoke.max_run_ms <= RUN_CEILING_MS, 'within run_ceiling_ms');
  assert.ok(row.invoke.max_run_ms <= WAKE_LINE_WALL_MS, 'within the chosen-workflow wake budget, so the step is not refused');
});

test('the run limit covers reading the largest recording it has been given, with room to hear it', () => {
  assert.ok(row.invoke.max_run_ms > READ_MS, `longer than the ${READ_MS} ms read, not the 120 s default`);
  assert.ok(row.invoke.max_run_ms - READ_MS >= 600_000, 'at least ten minutes for the hearing itself');
});
