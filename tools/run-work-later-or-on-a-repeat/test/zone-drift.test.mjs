import test from 'node:test';
import assert from 'node:assert/strict';
import { zoneDrift } from '../do-work/zone-drift.ts';

test('a device zone different from the planning zone is asked about once', () => {
  assert.deepEqual(zoneDrift('America/New_York', 'America/New_York'), { planning_zone: 'America/New_York', device_zone: 'America/New_York', drifted: false, ask: false });
  assert.deepEqual(zoneDrift('America/New_York', 'Europe/London'), { planning_zone: 'America/New_York', device_zone: 'Europe/London', drifted: true, ask: true });
  assert.equal(zoneDrift('America/New_York', 'Europe/London', ['Europe/London']).ask, false, 'asked and kept: not asked again');
  assert.equal(zoneDrift('America/New_York', 'Asia/Tokyo', ['Europe/London']).ask, true, 'a different new zone is asked afresh');
  assert.equal(zoneDrift('America/New_York', 'Europe/London', ['Europe/London']).drifted, true, 'the difference is still reported');
  assert.throws(() => zoneDrift('America/New_York', 'Mars/Base'), TypeError);
});
