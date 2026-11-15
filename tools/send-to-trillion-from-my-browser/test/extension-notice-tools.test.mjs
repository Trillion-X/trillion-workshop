import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOTIFICATION_TOOLS, browserDeviceRegistration, browserNoticeAction, browserNoticeList, browserNoticeRead,
} from '../src/notice-tools.mjs';

test('browser device and notice operations bind to the Workshop device-scoped contracts', () => {
  assert.deepEqual(NOTIFICATION_TOOLS, {
    publicKey: 'tool:my-browser-push-application-key',
    register: 'tool:register-my-notification-device',
    list: 'tool:my-device-notices',
    markRead: 'tool:mark-my-notices-read',
    act: 'tool:act-on-my-notice',
  });
  assert.deepEqual(browserDeviceRegistration({ label: 'Arc', address: { endpoint: 'https://push.example/', keys: { p256dh: 'p', auth: 'a' } } }), {
    route: 'web-push', label: 'Arc', address: { endpoint: 'https://push.example/', keys: { p256dh: 'p', auth: 'a' } },
  });
  assert.deepEqual(browserNoticeList({ deviceId: 'device-a', after: 18 }), { device_id: 'device-a', channel: 'web-push', after: 18, limit: 100 });
  assert.deepEqual(browserNoticeRead({ id: 'told:19', deviceId: 'device-a' }), {
    ids: ['told:19'], read: true, on: { channel: 'browser', device_id: 'device-a' },
  });
});

test('notice actions carry the exact offered action and a stable submission identity', () => {
  assert.deepEqual(browserNoticeAction({ id: 'told:19', action: 'tool:reply', text: 'Keep this', submissionId: '9ca91c98-8c2e-4a74-8d19-6127163a19e0' }), {
    id: 'told:19', action: 'tool:reply', text: 'Keep this', submission_id: '9ca91c98-8c2e-4a74-8d19-6127163a19e0',
  });
  assert.deepEqual(browserNoticeAction({ id: 'told:19', action: 'ack', text: '', submissionId: 'same-key' }), {
    id: 'told:19', action: 'ack', submission_id: 'same-key',
  });
});
