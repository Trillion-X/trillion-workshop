// tool:my-notices run as the container runs it, against the fake records door with exactly the row's rights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import rows from '../tool-rows.json' with { type: 'json' };

const row = rowOf(rows, 'tool:my-notices');
const deviceRow = rowOf(rows, 'tool:my-device-notices');
const markRow = rowOf(rows, 'tool:mark-my-notices-read');
const actionRow = rowOf(rows, 'tool:act-on-my-notice');
const notice = (seq, kind, extra = {}) => ({ seq, kind, title: `Notice ${seq}`, at: `2026-01-01T00:0${seq}:00Z`, open: null, results: { page: { sent: true } }, ...extra });
const told = items => [
  { id: 'told-the-person', type: 'told-the-person', value: { seqs: items.map(item => item.seq) } },
  ...items.map(item => ({ id: `told-the-person:${item.seq}`, type: 'told-the-person', value: { item } })),
];

test('the newest notices come first, the kind is applied before the newest are taken, and seen ones are counted', async () => {
  const items = [
    notice(1, 'take-me-there', { read: true, read_on: { channel: 'page', at: '2026-01-01T00:05:00Z' } }),
    notice(2, 'report'), notice(3, 'report'),
    notice(4, 'report', { body: 'The short body', actions: [{ id: 'open', label: 'Open', opens: true }], results: { page: { sent: true }, phone: { sent: false, stage: 'unavailable', said: 'No phone is connected.' } } }),
  ];
  const all = await runRow(row, { limit: 2 }, { records: told(items) });
  assert.equal(all.status, 0, all.error);
  assert.deepEqual(all.result.notices.map(item => item.id), ['told:4', 'told:3']);
  assert.deepEqual(all.result.notices[0].told, { page: 'sent', phone: 'unavailable' });
  assert.deepEqual(all.result.notices[0].why, { phone: 'No phone is connected.' });
  assert.equal(all.result.notices[0].body, 'The short body');
  assert.deepEqual(all.result.notices[0].actions, [{ id: 'open', label: 'Open', opens: true }]);
  assert.equal(all.result.said, '2 notices, newest first; 0 seen.');
  const one = await runRow(row, { kind: 'take-me-there' }, { records: told(items) });
  assert.deepEqual(one.result.notices.map(item => [item.id, item.read, item.read_on?.channel]), [['told:1', true, 'page']]);
  assert.equal(one.result.said, '1 notice, newest first; 1 seen.');
});

test('a head kept whole by an earlier version is read as it is, and an empty account has no notices', async () => {
  const whole = [{ id: 'told-the-person', type: 'told-the-person', value: { items: [notice(1, 'report'), notice(2, 'report')] } }];
  assert.deepEqual((await runRow(row, {}, { records: whole })).result.notices.map(item => item.id), ['told:2', 'told:1']);
  assert.deepEqual((await runRow(row, {})).result, { notices: [], said: '0 notices, newest first; 0 seen.' });
});

test('the row only lists told-the-person records', () => {
  assert.deepEqual(row.invoke.records.rights, [{ kind: 'told-the-person', operations: ['records:list'] }]);
});

test('device notices require that device to be registered and return only its queued notices oldest first', async () => {
  const device = { id: 'notification-device:device-a', type: 'notification-device', value: { device_id: 'device-a', route: 'live' } };
  const held = told([notice(1, 'report', { results: { 'device-pull': { sent: true, stage: 'queued' } } }), notice(2, 'report', { results: { apns: { sent: true } } }), notice(3, 'report', { results: { 'device-pull': { sent: true, stage: 'queued' } } })]);
  const answer = await runRow(deviceRow, { device_id: 'device-a', channel: 'mac-app', after: 1 }, { records: [device, ...held] });
  assert.equal(answer.status, 0, answer.error);
  assert.deepEqual(answer.result.notices.map(item => item.id), ['told:3']);
  assert.equal(answer.result.cursor, 3);
  assert.equal(answer.result.notices[0].actions.length, 0);
  const missing = await runRow(deviceRow, { device_id: 'device-a' }, { records: held });
  assert.equal(missing.status, 1);
  assert.match(missing.error, /not registered/);
});

test('per-device reads require a matching route and receipt; legacy channel-wide queue fallback is live-only', async () => {
  const browser = { id: 'notification-device:browser-a', type: 'notification-device', value: { device_id: 'browser-a', route: 'web-push' } };
  const phone = { id: 'notification-device:phone-a', type: 'notification-device', value: { device_id: 'phone-a', route: 'apns' } };
  const held = told([
    notice(1, 'browser', { results: { 'web-push': { sent: true, device_ids: ['browser-a'] } } }),
    notice(2, 'browser', { results: { 'web-push': { sent: true, device_ids: ['browser-b'] } } }),
    notice(3, 'phone', { results: { apns: { sent: true, device_ids: ['phone-a'] } } }),
    notice(4, 'legacy-live', { results: { 'device-pull': { sent: true, stage: 'queued' } } }),
    notice(5, 'not-queued', { results: { 'device-pull': { sent: false, stage: 'unavailable' } } }),
    notice(6, 'push-in-flight', { results: { 'web-push': { sent: false, stage: 'attempting' } } }),
  ]);
  const browserAnswer = await runRow(deviceRow, { device_id: 'browser-a', after: 0 }, { records: [browser, phone, ...held] });
  assert.equal(browserAnswer.status, 0, browserAnswer.error);
  assert.deepEqual(browserAnswer.result.notices.map(item => item.id), ['told:1']);
  assert.equal(browserAnswer.result.cursor, 5, 'the cursor stops before a notice whose browser delivery is still in flight');
  const phoneAnswer = await runRow(deviceRow, { device_id: 'phone-a', after: 0 }, { records: [browser, phone, ...held] });
  assert.equal(phoneAnswer.status, 0, phoneAnswer.error);
  assert.deepEqual(phoneAnswer.result.notices.map(item => item.id), ['told:3']);
  const mismatch = await runRow(deviceRow, { device_id: 'browser-a', channel: 'apns' }, { records: [browser, ...held] });
  assert.equal(mismatch.status, 1);
  const legacy = await runRow(deviceRow, { device_id: 'old-live-device', channel: 'mac-app' }, { records: [{ id: 'notification-device:old-live-device', type: 'notification-device', value: { device_id: 'old-live-device', route: 'live' } }, ...held] });
  assert.deepEqual(legacy.result.notices.map(item => item.id), ['told:4']);
  const newDevice = await runRow(deviceRow, { device_id: 'new-live-device', channel: 'device-pull' }, { records: [{ id: 'notification-device:new-live-device', type: 'notification-device', value: { device_id: 'new-live-device', route: 'live', added_at: '2026-02-01T00:00:00Z' } }, ...held] });
  assert.deepEqual(newDevice.result.notices, [], 'a later registration cannot claim an older channel-wide queue');
});

test('only a specific offered open action completes; unknown and source-owned actions are refused', async () => {
  const items = [notice(1, 'report', { open: '/work/reports/1', actions: [{ id: 'open', label: 'Open report', open: '/work/reports/1' }, { id: 'approve', label: 'Approve', post: { path: '/work/api/approve', body: { id: '1' } } }, { id: 'road-then-open', label: 'Answer then open', opens: true }] })];
  const opened = await runRow(actionRow, { id: 'told:1', action: 'open' }, { records: told(items) });
  assert.equal(opened.status, 0, opened.error);
  assert.deepEqual(opened.result, { done: true, said: 'Opening Open report.', open: '/work/reports/1' });
  assert.equal(opened.kept.find(record => record.id === 'told-the-person:1').value.item.read, true);
  assert.equal(opened.calls.filter(call => call.method === 'records:write').length, 1);
  const retried = await runRow(actionRow, { id: 'told:1', action: 'open' }, { records: opened.kept });
  assert.deepEqual(retried.result, opened.result);
  assert.equal(retried.calls.filter(call => call.method === 'records:write').length, 0, 'a repeated open uses the read receipt and writes nothing');
  const legacyHead = [{ id: 'told-the-person', type: 'told-the-person', value: { items } }];
  const legacyOpened = await runRow(actionRow, { id: 'told:1', action: 'open' }, { records: legacyHead });
  assert.deepEqual(legacyOpened.result, opened.result);
  assert.equal(legacyOpened.kept[0].value.items[0].read, true);
  const unknown = await runRow(actionRow, { id: 'told:1', action: 'delete' }, { records: told(items) });
  assert.equal(unknown.status, 1);
  assert.match(unknown.error, /not offered/);
  const unsupported = await runRow(actionRow, { id: 'told:1', action: 'approve' }, { records: told(items) });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.error, /source app/);
  const road = await runRow(actionRow, { id: 'told:1', action: 'road-then-open' }, { records: told(items) });
  assert.equal(road.status, 1);
  assert.match(road.error, /source road/);
  const foreignOpen = await runRow(actionRow, { id: 'told:2', action: 'foreign' }, { records: told([notice(2, 'report', { actions: [{ id: 'foreign', label: 'Open elsewhere', open: 'https://example.invalid/' }] })]) });
  assert.equal(foreignOpen.status, 1);
  assert.match(foreignOpen.error, /not performed/);
  const mixed = await runRow(actionRow, { id: 'told:3', action: 'both' }, { records: told([notice(3, 'report', { open: '/work/reports/3', actions: [{ id: 'both', label: 'Submit and open', opens: true, post: { path: '/work/api/approve', body: { id: '3' } } }] })]) });
  assert.equal(mixed.status, 1);
  assert.match(mixed.error, /source app/);
});

test('mark read keeps the first surface, repeated reads write nothing, and unread clears the surface', async () => {
  const initial = told([notice(1, 'report'), notice(2, 'report')]);
  const first = await runRow(markRow, { ids: ['told:1'], on: { channel: 'device-pull', device_id: 'phone-a' } }, { records: initial });
  assert.equal(first.status, 0, first.error);
  const keptItem = first.kept.find(record => record.id === 'told-the-person:1').value.item;
  assert.equal(keptItem.read, true);
  assert.deepEqual(keptItem.read_on, { channel: 'device-pull', device_id: 'phone-a', at: keptItem.read_on.at });
  const again = await runRow(markRow, { ids: ['told:1'], on: { channel: 'apns', device_id: 'phone-b' } }, { records: first.kept });
  assert.equal(again.result.changed, false);
  assert.equal(again.calls.filter(call => call.method === 'records:write').length, 0);
  assert.equal(again.kept.find(record => record.id === 'told-the-person:1').value.item.read_on.channel, 'device-pull');
  const unread = await runRow(markRow, { ids: ['told:1'], read: false }, { records: first.kept });
  assert.equal(unread.kept.find(record => record.id === 'told-the-person:1').value.item.read, false);
  assert.equal('read_on' in unread.kept.find(record => record.id === 'told-the-person:1').value.item, false);
  const browser = await runRow(markRow, { ids: ['told:2'], on: { channel: 'browser', device_id: 'browser-a' } }, { records: initial });
  assert.equal(browser.kept.find(record => record.id === 'told-the-person:2').value.item.read_on.channel, 'browser');
  assert.equal(browser.kept.find(record => record.id === 'told-the-person:2').value.item.read_on.device_id, 'browser-a');
  const watch = await runRow(markRow, { ids: ['told:2'], on: { channel: 'watch', device_id: 'watch-a' } }, { records: initial });
  assert.equal(watch.kept.find(record => record.id === 'told-the-person:2').value.item.read_on.channel, 'watch');
});
