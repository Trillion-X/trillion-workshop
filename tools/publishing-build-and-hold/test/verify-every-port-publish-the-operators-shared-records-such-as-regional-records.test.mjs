// test/verify-every-port-publish-the-operators-shared-records-such-as-regional-records.test.mjs
//
// The publish decisions of the operator's shared records, with no storage and no network: which names are published,
// which records a batch sends, what the operator's store still publishes, when a kept read stands, and which refresh
// want wins its window.
import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../read-data/verify-every-port-publish-the-operators-shared-records-such-as-regional-records.json' with { type: 'json' };
import {
  assertServiceRecordLabel,
  isKeptServiceRead,
  isServiceRecordLabel,
  operatorStorePublished,
  planServiceRecordPublication,
  planServiceRefreshWant,
} from '../read-data/verify-every-port-publish-the-operators-shared-records-such-as-regional-records.mjs';

test('only a named label or one under a named prefix is a service record', () => {
  assert.equal(isServiceRecordLabel('show-rules'), true);
  assert.equal(isServiceRecordLabel('brand-presentation'), true);
  assert.equal(isServiceRecordLabel('device-distribution:mac'), true);
  assert.equal(isServiceRecordLabel('a-private-note'), false);
  assert.equal(isServiceRecordLabel(''), false);
  assert.equal(isServiceRecordLabel(42), false);
  assert.equal(isServiceRecordLabel(undefined), false);
  assert.throws(() => assertServiceRecordLabel('someones-private-notes'), /The service keeps no record by that name\./);
  assert.equal(assertServiceRecordLabel('setup-context'), 'setup-context');
});

test('the operator store publishes only the records no owner writes itself', () => {
  const published = operatorStorePublished();
  assert.deepEqual(published.labels, ['service-value-states', 'service-plain-values', 'service-relay', 'client-programs']);
  assert.deepEqual(published.prefixes, [], 'device releases are written by their own owner and never published from here');
  assert.equal(published.labels.includes('show-rules'), false);
  assert.equal(published.labels.includes('setup-context'), false);
  assert.equal(published.labels.includes('brand-presentation'), false);
});

test('a batch publishes a new record and leaves a newer or identical kept record alone', () => {
  const kept = { 'show-rules': { at: 20, identity: 'id-new' }, 'setup-context': { at: 5, identity: 'id-same' } };
  const plan = planServiceRecordPublication([
    { label: 'show-rules', value: { rules: ['older'] }, identity: 'id-old', at: 10 },
    { label: 'setup-context', value: { accounts: {} }, identity: 'id-same', at: 9 },
    { label: 'client-programs', value: [{ id: 'p1' }], identity: 'id-p1', at: 9 },
  ], kept, settings);
  assert.deepEqual(plan.publish, [{ label: 'client-programs', value: [{ id: 'p1' }], identity: 'id-p1', at: 9 }]);
  assert.deepEqual(plan.skipped, [
    { label: 'show-rules', reason: 'a newer value is kept' },
    { label: 'setup-context', reason: 'the same value is kept' },
  ]);
  assert.deepEqual(kept['show-rules'], { at: 20, identity: 'id-new' }, 'the kept map is not changed');
});

test('a batch judges each record against what the batch kept before it', () => {
  const plan = planServiceRecordPublication([
    { label: 'show-rules', value: { r: 1 }, identity: 'a', at: 10 },
    { label: 'show-rules', value: { r: 2 }, identity: 'a', at: 11 },
    { label: 'show-rules', value: { r: 0 }, identity: 'b', at: 9 },
  ], {}, settings);
  assert.deepEqual(plan.publish.map(record => record.at), [10]);
  assert.deepEqual(plan.skipped.map(record => record.reason), ['the same value is kept', 'a newer value is kept']);
});

test('a publication names a time and sends between one and the most records', () => {
  assert.throws(() => planServiceRecordPublication([{ label: 'show-rules', identity: 'a', at: Number.NaN }], {}, settings), /Each published record needs the time it was read\./);
  assert.throws(() => planServiceRecordPublication([{ label: 'show-rules', identity: 'a' }], {}, settings), /Each published record needs the time it was read\./);
  assert.throws(() => planServiceRecordPublication([], {}, settings), /Publish between 1 and 50 records at a time\./);
  assert.throws(() => planServiceRecordPublication(Array.from({ length: 51 }, () => ({ label: 'show-rules', identity: 'a', at: 1 })), {}, settings), /Publish between 1 and 50 records at a time\./);
  assert.throws(() => planServiceRecordPublication([{ label: 'someones-private-notes', identity: 'a', at: 1 }], {}, settings), /keeps no record by that name/);
});

test('a kept read stands for its time and no longer after', () => {
  const found = { at: 1_000 };
  assert.equal(isKeptServiceRead(found, 1_000 + 29_999, 30), true);
  assert.equal(isKeptServiceRead(found, 1_000 + 30_000, 30), false);
  assert.equal(isKeptServiceRead(undefined, 1_000, 30), false);
  assert.equal(isKeptServiceRead(found, 1_000, 0), false, 'a zero time keeps nothing');
  assert.equal(isKeptServiceRead(found, 1_000 + 1), true, 'the default time is the data\'s read_seconds');
});

test('the first want of a refresh window wins and an earlier window never does', () => {
  const first = planServiceRefreshWant({ operation: 'want', label: 'device-distribution:mac', window: 7 }, undefined, settings);
  assert.deepEqual(first, { first: true, next: { label: 'device-distribution:mac', window: 7 } });
  const second = planServiceRefreshWant({ operation: 'want', label: 'device-distribution:mac', window: 7 }, first.next, settings);
  assert.equal(second.first, false, 'the same window is already wanted');
  const older = planServiceRefreshWant({ operation: 'want', label: 'device-distribution:mac', window: 6 }, first.next, settings);
  assert.equal(older.first, false);
  const later = planServiceRefreshWant({ operation: 'want', label: 'device-distribution:mac', window: 8 }, first.next, settings);
  assert.deepEqual(later, { first: true, next: { label: 'device-distribution:mac', window: 8 } });
});

test('a refresh want names a service record and its window, and only wants', () => {
  assert.throws(() => planServiceRefreshWant({ operation: 'read', label: 'show-rules', window: 1 }, undefined, settings), /A service record refresh can only be wanted\./);
  assert.throws(() => planServiceRefreshWant({ operation: 'want', label: 'show-rules' }, undefined, settings), /A wanted refresh names its window\./);
  assert.throws(() => planServiceRefreshWant({ operation: 'want', label: 'show-rules', window: 1.5 }, undefined, settings), /A wanted refresh names its window\./);
  assert.throws(() => planServiceRefreshWant({ operation: 'want', label: 'someones-private-notes', window: 1 }, undefined, settings), /keeps no record by that name/);
});
