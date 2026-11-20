// tools/run-rules-and-schedules-by-themselves/test/commands-run-as-the-rows-run-them.test.mjs
// The rows run these commands with one request on standard input and read one JSON line back. These tests run them the
// same way (a child process, stdin, stdout), so a row's argv and its answer are both checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const run = (script, args, request) => spawnSync(process.execPath, [join(root, script), ...args], { input: JSON.stringify(request), encoding: 'utf8' });

test('the schedule row command sets a schedule and keeps it in the list it answers', () => {
  const set = run('do-work/automation-operations.mjs', ['--kind', 'schedule'], {
    operation: 'set', input: { schedule_id: 's1', label: 'Morning', every: { unit: 'day', at: '09:00', time_zone: 'UTC' }, then: { tool_id: 'tool:x' } }, items: [], now: '2026-11-20T09:00:00.000Z',
  });
  assert.equal(set.status, 0, set.stderr);
  const kept = JSON.parse(set.stdout).items;
  assert.equal(kept.length, 1);
  const list = run('do-work/automation-operations.mjs', ['--kind', 'schedule'], { operation: 'list', items: kept });
  assert.equal(JSON.parse(list.stdout).answer.schedules[0].label, 'Morning');
});

test('the rule row command refuses a bad request with a reason and a non-zero exit', () => {
  const bad = run('do-work/automation-operations.mjs', ['--kind', 'rule'], { operation: 'set', input: { rule_id: 'r', then: {} }, items: [] });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).error.reason, 'when');
});

test('the health command answers an empty source list with the report shape', () => {
  const out = run('do-work/read-source-health.mjs', [], { now: '2026-11-20T09:00:00.000Z', sources: [] });
  assert.equal(out.status, 0, out.stderr);
  const answer = JSON.parse(out.stdout);
  assert.deepEqual(answer.sources, []);
  assert.ok(Array.isArray(answer.periods));
});
