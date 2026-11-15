// The `latest` aggregate row says the largest key wins and the later row wins a tie; measure() over tied keys must say the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateOf, measure } from 'trillion-workshop/tools/query-and-change-list-rows/src/list-aggregates.mjs';

const latest = pairs => measure(pairs, aggregateOf('latest'));

test('latest: the largest key wins whatever the order', () => {
  assert.equal(latest([{ value: 'a', by: 1 }, { value: 'b', by: 3 }, { value: 'c', by: 2 }]), 'b');
});

test('latest: the later row wins a tie', () => {
  assert.equal(latest([{ value: 'a', by: 2 }, { value: 'b', by: 2 }]), 'b');
  assert.equal(latest([{ value: 'a', by: 2 }, { value: 'b', by: 2 }, { value: 'c', by: 2 }, { value: 'd', by: 2 }]), 'd');
  assert.equal(latest([{ value: 'a', by: 2 }, { value: 'b', by: 2 }, { value: 'c', by: 1 }]), 'b');
  assert.equal(latest([{ value: 'a', by: 1 }, { value: 'b', by: 2 }, { value: 'c', by: 2 }, { value: 'd', by: 0 }]), 'c');
});
