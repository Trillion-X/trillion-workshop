import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePlanRequest, planRecords } from '../src/plan-records.mjs';

function memoryEeaf() {
  const records = new Map();
  return {
    read: id => records.get(id)?.value ?? null,
    typeOf: id => records.get(id)?.type ?? null,
    ids: type => [...records].filter(([, row]) => row.type === type).map(([id]) => id),
    write: rows => { for (const row of rows) records.set(row.id, { type: row.type, value: row.value }); },
  };
}

test('task plans persist in Trillion records, retain append-only progress, and support safe retries', async () => {
  const eeaf = memoryEeaf();
  let tick = 0;
  const options = { app: 'Codex', now: () => `2026-09-30T00:00:0${tick++}.000Z` };
  const first = planRecords(eeaf, options).save({
    source_id: 'contract-builder:plan', title: 'Build reusable sales contracts', goal: 'Reuse Trillion primitives for client contracts',
    body: 'Use the existing decision to choose the delivery path, then record the shared plan here.',
    pursuit_ids: ['pursuit:clients'], decision_case_id: 'decision:clients', workflow_run_id: 'run:contracts',
  });
  const retried = planRecords(eeaf, options).save({
    source_id: 'contract-builder:plan', title: 'Build reusable sales contracts', goal: 'Reuse Trillion primitives for client contracts',
    body: 'Use the existing decision to choose the delivery path, then record the shared plan here.',
    pursuit_ids: ['pursuit:clients'], decision_case_id: 'decision:clients', workflow_run_id: 'run:contracts',
  });
  assert.equal(retried.id, first.id);
  assert.equal(planRecords(eeaf).list().total, 1);

  const progress = planRecords(eeaf, options);
  const saved = progress.progress({ plan_id: first.id, source_id: 'contract-builder:check:1', summary: 'Located the existing pursuit, decision and workflow references.', step: 'Inspect existing work' });
  const retriedProgress = progress.progress({ plan_id: first.id, source_id: 'contract-builder:check:1', summary: 'Located the existing pursuit, decision and workflow references.', step: 'Inspect existing work' });
  progress.progress({ plan_id: first.id, source_id: 'contract-builder:change:1', summary: 'Saved the first reusable plan update.', status: 'active' });
  assert.equal(retriedProgress.already_recorded, true);
  assert.equal(saved.progress.id, retriedProgress.progress.id);

  const read = planRecords(eeaf).read(first.id);
  assert.equal(read.progress_total, 2);
  assert.deepEqual(read.pursuit_ids, ['pursuit:clients']);
  assert.equal(read.decision_case_id, 'decision:clients');
  assert.equal(read.workflow_run_id, 'run:contracts');
  assert.equal(read.latest_progress, 'Saved the first reusable plan update.');
  assert.deepEqual(planRecords(eeaf).list({ pursuit_id: 'pursuit:clients' }).plans.map(plan => plan.id), [first.id]);

  const request = new Request(`https://person/plans/${encodeURIComponent(first.id)}?limit=1&offset=0`);
  const response = await handlePlanRequest(eeaf, request);
  const page = await response.json();
  assert.equal(response.status, 200);
  assert.equal(page.progress.length, 1);
  assert.equal(page.progress_next_offset, 1);
});

test('a repeated creation returns the current completed plan without replacing edits or progress', () => {
  const eeaf = memoryEeaf();
  let tick = 0;
  const options = { app: 'Codex', now: () => `2026-10-01T00:00:0${tick++}.000Z` };
  const initial = { source_id: 'retry-source', title: 'Original plan', goal: 'Finish the work', body: 'Original details', status: 'active' };
  const first = planRecords(eeaf, options).save(initial);
  planRecords(eeaf, options).save({ plan_id: first.id, title: 'Updated plan', body: 'Current details', pursuit_ids: ['pursuit:current'] });
  planRecords(eeaf, options).progress({ plan_id: first.id, source_id: 'finished', summary: 'The work is complete.', status: 'completed' });
  const before = planRecords(eeaf).read(first.id);
  const retried = planRecords(eeaf, options).save(initial);
  assert.equal(retried.status, 'completed');
  assert.equal(retried.title, 'Updated plan');
  assert.equal(retried.body, 'Current details');
  assert.deepEqual(retried.pursuit_ids, ['pursuit:current']);
  assert.deepEqual(planRecords(eeaf).read(first.id), before, 'the creation replay writes nothing and preserves the full progress trail');
  planRecords(eeaf, options).save({ plan_id: first.id, status: 'active', body: 'Reopened deliberately' });
  assert.equal(planRecords(eeaf).read(first.id).status, 'active', 'an explicit edit still changes a completed plan');
});
