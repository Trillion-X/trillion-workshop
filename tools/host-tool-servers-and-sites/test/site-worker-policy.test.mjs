// Outcome tests for the pure site Worker policy (src/site-worker-policy.mjs), ported from the old host's rules:
// cron minutes are matched in UTC, a changed permission takes the Worker offline, and a linked original backend stays authoritative.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cronMatches, pinnedWorkerPermissions, siteUsesOriginalBackend, validCron } from '../src/site-worker-policy.mjs';

test('a route with linked original routes is served by the original backend, a route without them is not', () => {
  assert.equal(siteUsesOriginalBackend({ linked_routes: { '/shop': { app: 'shop' } } }), true);
  assert.equal(siteUsesOriginalBackend({ linked_routes: {} }), false);
  assert.equal(siteUsesOriginalBackend({}), false);
  assert.equal(siteUsesOriginalBackend(null), false);
});

test('a cron text is valid only with five fields inside each field bounds and a positive step', () => {
  assert.equal(validCron('0 9 * * 1'), true);
  assert.equal(validCron('*/15 * * * *'), true);
  assert.equal(validCron('1-5/2 * * * *'), true);
  assert.equal(validCron('60 * * * *'), false);
  assert.equal(validCron('0 24 * * *'), false);
  assert.equal(validCron('*/0 * * * *'), false);
  assert.equal(validCron('0 9 * *'), false);
  assert.equal(validCron('5-2 * * * *'), false);
});

test('a cron matches the UTC minute of a time, whatever the offset it was written in', () => {
  const monday0900Utc = new Date('2026-11-23T09:00:00Z');
  assert.equal(cronMatches('0 9 * * 1', monday0900Utc), true);
  assert.equal(cronMatches('0 9 * * 1', new Date('2026-11-23T04:00:00-05:00')), true);
  assert.equal(cronMatches('0 9 * * 1', new Date('2026-11-23T09:01:00Z')), false);
  assert.equal(cronMatches('*/15 * * * *', new Date('2026-11-20T10:15:00Z')), true);
  assert.equal(cronMatches('*/15 * * * *', new Date('2026-11-20T10:14:00Z')), false);
});

test('when both day fields are restricted a cron matches either day, and when one is * it needs both', () => {
  assert.equal(cronMatches('0 0 1 * 1', new Date('2026-11-02T00:00:00Z')), true, 'a Monday that is not the 1st matches the Monday');
  assert.equal(cronMatches('0 0 1 * 1', new Date('2026-11-01T00:00:00Z')), true, 'the 1st matches the day of the month');
  assert.equal(cronMatches('0 0 1 * 1', new Date('2026-11-03T00:00:00Z')), false, 'a Tuesday that is not the 1st matches neither');
  assert.equal(cronMatches('0 0 1 * *', new Date('2026-11-02T00:00:00Z')), false, 'with day-of-week *, the day of month alone decides');
});

test('a permission that is unchanged keeps the Worker enabled, and any changed grant takes it offline', () => {
  const saved = { outbound_hosts: ['a.example.com', 'b.example.com'], ai_models: [], crons: ['0 9 * * *'],
    email_senders: [{ email: 'hi@example.com', name: 'Hi' }], receive_email: false, enabled: true };
  assert.equal(pinnedWorkerPermissions(saved, {}).enabled, true, 'an empty declaration changes nothing');
  assert.equal(pinnedWorkerPermissions(saved, { outbound_hosts: ['b.example.com', 'a.example.com'] }).enabled, true, 'the same hosts in another order are unchanged');
  assert.equal(pinnedWorkerPermissions(saved, { outbound_hosts: ['a.example.com'] }).enabled, false, 'a removed host takes it offline');
  assert.equal(pinnedWorkerPermissions(saved, { crons: ['0 10 * * *'] }).enabled, false, 'a changed schedule takes it offline');
  assert.equal(pinnedWorkerPermissions(saved, { receive_email: true }).enabled, false, 'receiving mail is a changed grant');
  assert.equal(pinnedWorkerPermissions(saved, { email_senders: [{ email: 'hi@example.com', name: 'Other' }] }).enabled, false, 'a sender with another name is a changed grant');
});

test('a first declaration starts offline, and the declared fields are kept with their defaults for the rest', () => {
  const first = pinnedWorkerPermissions(null, { outbound_hosts: ['a.example.com'] });
  assert.equal(first.enabled, false);
  assert.deepEqual(first.outbound_hosts, ['a.example.com']);
  assert.deepEqual(first.crons, []);
  assert.equal(first.receive_email, false);
});
