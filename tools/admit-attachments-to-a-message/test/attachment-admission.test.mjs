import test from 'node:test';
import assert from 'node:assert/strict';
import { admitAttachments } from '../src/attachment-admission.mjs';

const files = n => Array.from({ length: n }, (_, i) => ({ name: `f${i}.png`, size: 1000 }));

test('nothing binds when everything fits', () => {
  const r = admitAttachments({ files: files(3) });
  assert.deepEqual([r.accepted, r.binding, r.banner, r.blocked], [[0, 1, 2], null, null, false]);
});
test('per-turn cap admits a prefix and names itself', () => {
  const r = admitAttachments({ files: files(5), limits: { per_turn_cap: 2 } });
  assert.deepEqual(r.accepted, [0, 1]);
  assert.equal(r.binding, 'per_turn');
  assert.match(r.banner, /first 2 of 5/);
  console.log('READBACK', JSON.stringify(r));
});
test('daily quota binds with its reset time; exhausted blocks', () => {
  const resets_at = '2030-01-01T00:00:00.000Z';
  const r = admitAttachments({ files: files(4), daily: { remaining: 1, resets_at }, now: 0 });
  assert.equal(r.binding, 'daily'); assert.deepEqual(r.accepted, [0]); assert.match(r.banner, /2030-01-01/);
  const none = admitAttachments({ files: files(2), daily: { remaining: 0, resets_at }, now: 0 });
  assert.equal(none.blocked, true); assert.deepEqual(none.accepted, []);
});
test('oversize files are left out; a null limit does not bind', () => {
  const r = admitAttachments({ files: [{ name: 'big.mov', size: 600e6 }, ...files(1)], limits: { per_turn_cap: null } });
  assert.deepEqual(r.accepted, [1]); assert.equal(r.binding, 'size'); assert.match(r.banner, /big\.mov/);
  assert.equal(admitAttachments({ files: files(50), limits: { per_turn_cap: null } }).accepted.length, 50);
});
