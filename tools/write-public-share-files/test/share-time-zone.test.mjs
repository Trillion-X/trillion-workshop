import assert from 'node:assert/strict';
import test from 'node:test';
import { zoneProblem } from '../read-data/share-zone-rules.mjs';
const rule = field => ({ kind: 'rule', field, operator: 'is', value: 9 });

test('a nested hour or weekday rule requires a time zone', () => {
  for (const condition of [
    rule('hour'),
    { rules: [{ kind: 'group', rules: [rule('weekday')] }] },
  ]) {
    assert.match(zoneProblem(condition, undefined), /needs time_zone/);
    assert.match(zoneProblem(condition, null), /needs time_zone/);
  }
});

test('an invalid offset is refused even when the condition does not use a zoned fact', () => {
  assert.match(zoneProblem(rule('opened'), '+05:00'), /IANA zone/);
});

test('a known alias is accepted and unzoned conditions may omit the zone', () => {
  assert.equal(zoneProblem(rule('hour'), 'america/new_york'), null);
  assert.equal(zoneProblem(rule('opened'), undefined), null);
  assert.equal(zoneProblem(null, null), null);
});
