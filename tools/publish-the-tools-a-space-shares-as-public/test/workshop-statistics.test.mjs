import test from 'node:test';
import assert from 'node:assert/strict';
import { workshopStatistics } from '../src/workshop-statistics.mjs';

// The local store zero-fills every id it is asked about, as the older Workshop copy's toolStats did (b6ae0ebf81 tool-telemetry.mjs:44).
const zero = () => ({ runs: 0, contract_passed: 0, reported_met: 0, reported_failed: 0 });
const localWith = counts => ids => Object.fromEntries(ids.map(id => [id, counts[id] ?? zero()]));

test('missing or failed shared statistics remain unknown while the resource keeps its measured local summary', async () => {
  const id = 'tool:local-evidence';
  const local = localWith({ [id]: { ...zero(), runs: 1, contract_passed: 1 } });
  const missing = (await workshopStatistics({ ids: [id], local, shared: async () => ({ [id]: null }) }))[id];
  assert.equal(missing.runs, 1);
  assert.equal(missing.basis, 'resource_local');
  assert.equal(missing.resource_local.coverage, 'captured_resource_projections');
  assert.deepEqual(missing.shared_evidence, { state: 'unknown', reason: 'not_published', counts: null });

  const failed = (await workshopStatistics({ ids: [id], local, shared: async () => { throw new Error('private credential details must stay out of the response'); } }))[id];
  assert.equal(failed.contract_passed, 1);
  assert.equal(failed.resource_local.runs, 1);
  assert.deepEqual(failed.shared_evidence, { state: 'unknown', reason: 'projection_unavailable', counts: null });
  assert.equal(JSON.stringify(failed).includes('private credential'), false);

  const empty = (await workshopStatistics({ ids: ['tool:no-local-runs'], local, shared: async () => { throw new Error('unavailable'); } }))['tool:no-local-runs'];
  assert.equal(empty.resource_local.runs, 0);
  assert.equal(empty.shared_evidence.counts, null, 'local zero must not manufacture a measured global zero');
});

test('partial shared history stays explicitly partial and a complete summary keeps its own basis and local evidence', async () => {
  const id = 'tool:published-evidence';
  const local = localWith({ [id]: { ...zero(), runs: 1, contract_passed: 1 } });
  const counts = { ...zero(), runs: 1, contract_passed: 1, legacy_complete: true };
  const complete = (await workshopStatistics({ ids: [id], local, shared: async () => ({ [id]: counts }) }))[id];
  assert.equal(complete.shared_evidence.state, 'available');
  assert.equal(complete.shared_evidence.counts.runs, 1);
  assert.equal(complete.basis, 'shared_projection');
  assert.equal(complete.resource_local.runs, 1);

  const partial = (await workshopStatistics({ ids: [id], local, shared: async () => ({ [id]: { ...counts, legacy_complete: false } }) }))[id];
  assert.equal(partial.shared_evidence.state, 'partial');
  assert.equal(partial.legacy_complete, false);
});

test('a shared count that is not a non-negative number is unknown as an invalid projection, never read as zero', async () => {
  const id = 'tool:broken-projection';
  const local = localWith({});
  for (const bad of [{ ...zero(), runs: -1 }, { ...zero(), reported_met: Number.NaN }, { ...zero(), runs: '3' }, { contract_passed: 0 }]) {
    const row = (await workshopStatistics({ ids: [id], local, shared: async () => ({ [id]: bad }) }))[id];
    assert.deepEqual(row.shared_evidence, { state: 'unknown', reason: 'invalid_projection', counts: null });
  }
});

test('a requested id bound to a public tool reads that tool\'s shared counts under the requested id', async () => {
  const privateId = 'tool:bound-connection:private-7';
  const publicId = 'tool:public-tool';
  const seen = [];
  const local = ids => { seen.push(...ids); return localWith({ [publicId]: { ...zero(), runs: 2 } })(ids); };
  const shared = async ids => ({ [publicId]: { ...zero(), runs: 5, reported_met: 1, legacy_complete: true } });
  const row = (await workshopStatistics({ ids: [privateId], local, shared, publicIdOf: id => (id === privateId ? publicId : id) }))[privateId];
  assert.deepEqual(seen, [publicId]);
  assert.equal(row.shared_evidence.counts.runs, 5);
  assert.equal(row.resource_local.runs, 2);
});
