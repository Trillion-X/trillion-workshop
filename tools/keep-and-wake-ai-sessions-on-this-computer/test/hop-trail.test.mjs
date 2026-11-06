// Ported from old trillion test/hop-trail.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted by
// Trillion-X/trillion #243. withHopTrail, hopTrailOf and nextDependencyDepth are this tool's src/failure.mjs. Left out:
// the first test and the first assertion of the second, which called through the retired Durable Object stub wrapper
// (src/resource-host.mjs hostOf) that added each hop: no running code makes stub calls between objects (searched the
// three repos for resource-host.mjs and a hostOf over env bindings: none; the hostOf names left are URL helpers).
// Every other assertion is the old one.
// The platform names no stack when its nested-request limit stops a chain ("Subrequest depth limit exceeded"). Each stub call
// that sees the failure come back adds its own address and operation, so the failure reaches the top naming the whole chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withHopTrail } from '../src/failure.mjs';

test('another failure is passed on as it is, without a trail', async () => {
  assert.equal(withHopTrail('x', new Error('plain')).hop_trail, undefined);
});

test('a long hop keeps its method: the middle of the address is cut, not the end', async () => {
  const {withHopTrail, hopTrailOf} = await import('../src/failure.mjs');
  const error = withHopTrail('gate:["f281a627ef39a0fa2cb5bb28b47fbabd40c5e25ecef73b1e29d3f8904a750aa7","key:abc","shared-policy-address-that-is-long"].checkResourcePermit', new Error('Subrequest depth limit exceeded'));
  const [hop] = hopTrailOf(error);
  assert.ok(hop.length <= 90 && hop.startsWith('gate:') && hop.endsWith('.checkResourcePermit'), hop);
});

test('a dependency command carries its depth, increments it on every level, and is refused retryably past the most', async () => {
  const {nextDependencyDepth, MOST_DEPENDENCY_DEPTH, DEPENDENCY_TOO_DEEP, platformTransient} = await import('../src/failure.mjs');
  let commitment = {};
  const seen = [];
  for (let level = 1; level <= MOST_DEPENDENCY_DEPTH; level++) {
    const depth = nextDependencyDepth(commitment);
    seen.push(depth);
    commitment = {dependency: {depth}};
  }
  assert.deepEqual(seen, Array.from({length: MOST_DEPENDENCY_DEPTH}, (_, i) => i + 1), 'one more on every level, from the lifecycle command at none');
  const refused = (() => { try { nextDependencyDepth(commitment); } catch (error) { return error; } })();
  assert.equal(refused?.message, DEPENDENCY_TOO_DEEP);
  assert.equal(refused.status, 503);
  assert.equal(refused.not_begun, true);
  assert.ok(refused.retry_after_ms > 0);
  assert.equal(platformTransient(new Error(refused.message)), true, 'and the alarm asks again later, as the words arrive after a call between objects');
});

test('twenty sibling dependencies of one command all run at depth 1: siblings do not nest', async () => {
  const {nextDependencyDepth} = await import('../src/failure.mjs');
  const parent = {};
  const depths = Array.from({length: 20}, () => nextDependencyDepth(parent));
  assert.deepEqual([...new Set(depths)], [1]);
});
