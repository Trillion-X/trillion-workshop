import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { answerOf, rowOf } from '../../../test-helpers/run-a-row.mjs';
import { registerMyNotificationDevice, registerMyLiveActivity, sendNotificationToMyDevices, sendLiveActivityUpdate, myBrowserPushApplicationServerKey, heldNotificationSigningKeys } from '../read-data/device-notifications.mjs';
import { base64url, makeSigningKey, publicPoint } from '../read-data/web-push.mjs';
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import deliveryContract from '../read-data/delivery-contract.json' with { type: 'json' };

const row = id => rowOf(rows, id);
const event = {
  notification_id: 'n-1', kind: 'work-finished', audience_refs: ['person:owner'], conversation_ref: 'conversation:1',
  privacy_class: 'private', title: 'The report is ready', body: 'Your report is ready to read.', occurred_at: '2026-10-31T18:00:00Z',
  source_refs: ['work:1'], proof_refs: ['proof:1'],
  actions: [{ id: 'open-report', label: 'Open report', press: true, open: { surface_id: 'app.reports', input: { id: 'report:1' } } }],
};
const key = () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { key_id: 'kid-test', team_id: 'team-test', pem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
};

test('browser enrollment reads only the public VAPID point from the same signing key', async () => {
  const jwk = await makeSigningKey();
  const answer = await myBrowserPushApplicationServerKey({}, { webCredentials: { jwk, contact: 'mailto:push@example.test' } });
  assert.equal(answer.applicationServerKey, base64url(publicPoint(jwk)));
  assert.equal(answer.applicationServerKey.includes(jwk.d), false);
  assert.deepEqual(Object.keys(answer).sort(), ['applicationServerKey', 'said']);
  await assert.rejects(myBrowserPushApplicationServerKey({}, { webCredentials: '' }), /browser push key/);
});

test('browser notice delivery uses the same held signing key returned for enrollment and answers the accepted device ids', async () => {
  const subscriptionPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const browserJwk = await crypto.subtle.exportKey('jwk', subscriptionPair.publicKey);
  const subscription = {
    endpoint: 'https://push.example.test/send/one',
    keys: { p256dh: base64url(publicPoint(browserJwk)), auth: base64url(crypto.getRandomValues(new Uint8Array(16))) },
  };
  const webPushSigningJwk = await makeSigningKey();
  const webCredentials = { jwk: webPushSigningJwk, contact: 'mailto:push@example.test' };
  const web = { device_id: 'web-1', route: 'web-push', address: subscription, can_show: 'allowed' };
  let captured;
  const answer = await sendNotificationToMyDevices({ notification: event, audience: 'person:owner', devices: [web] }, {
    webCredentials, send: async (url, request) => { captured = { url, request }; return new Response('', { status: 201 }); },
  });
  assert.equal(answer.stage, 'sent', JSON.stringify(answer));
  assert.equal(captured.url, subscription.endpoint);
  assert.equal(captured.request.headers.authorization.includes(base64url(publicPoint(webPushSigningJwk))), true);
  assert.deepEqual(answer.routes['web-push'].device_results, [{ device_id: 'web-1', stage: 'sent', status: 201 }]);
  assert.equal(JSON.stringify(answer).includes(subscription.endpoint), false);
});

const device = { id: 'notification-device:1234', type: 'notification-device', value: { device_id: '1234', route: 'apns', address: 'a'.repeat(64), label: 'My iPhone', app: 'com.example.app', environment: 'sandbox', can_show: 'allowed', added_at: '2026-10-31T18:00:00Z' } };

test('device registration validates addresses, keeps a stable opaque identity, and says the push token only in the row it keeps', async () => {
  const register = row('tool:register-my-notification-device');
  const token = 'b'.repeat(64);
  const first = await answerOf(register, { route: 'apns', address: token, app: 'com.example.app', environment: 'sandbox', can_show: 'allowed' });
  assert.equal(first.status, 0, first.error);
  assert.equal(first.result.changed, true);
  assert.equal(first.result.devices[0].address, undefined);
  const { keep, ...said } = first.result;
  assert.equal(JSON.stringify(said).includes(token), false, 'the answer apart from the row to keep never holds the token');
  assert.deepEqual(keep.map(item => item.type), ['notification-device']);
  const saved = keep.find(item => item.type === 'notification-device');
  assert.equal(saved.value.address, token);
  assert.match(saved.value.device_id, /^1f[a-f0-9]{64}$/);
  const again = await answerOf(register, { route: 'apns', address: token, app: 'com.example.app', environment: 'sandbox', can_show: 'allowed' }, { records: keep });
  assert.equal(again.result.changed, false);
  assert.equal(again.result.device_id, first.result.device_id);
  const bad = await answerOf(register, { route: 'apns', address: 'not-a-token', app: 'com.example.app' });
  assert.equal(bad.status, 1);
  assert.match(bad.error, /hex token/);
  const noTopic = await answerOf(register, { route: 'apns', address: 'a'.repeat(64) });
  assert.match(noTopic.error, /bundle id/);
});

test('device removal deletes the address only for the named registration', async () => {
  const registered = await answerOf(row('tool:register-my-notification-device'), { route: 'live', address: 'mac-stable-12345678' });
  const deviceId = registered.result.device_id;
  const removed = await answerOf(row('tool:remove-my-notification-device'), { device_id: deviceId }, { records: registered.result.keep });
  assert.equal(removed.result.removed, true);
  assert.deepEqual(removed.result.keep.map(item => [item.type, item.value]), [['notification-device', null]], 'the removal keeps the registration out');
  assert.equal((await answerOf(row('tool:remove-my-notification-device'), { device_id: deviceId })).result.removed, false);
});

test('Live Activity registration keeps an opaque idempotent token and removes it on end', async () => {
  const token = 'c'.repeat(64);
  const rowTool = row('tool:register-my-live-activity');
  const first = await answerOf(rowTool, { board_key: 'running', token, app: 'com.example.app', environment: 'sandbox' });
  assert.equal(first.status, 0, first.error);
  assert.equal(first.result.kept, true);
  assert.equal(first.result.ended, false);
  const { keep: _rows, ...shown } = first.result;
  assert.equal(JSON.stringify(shown).includes(token), false, 'the answer apart from the row to keep never holds the token');
  const record = first.result.keep.find(item => item.type === 'notification-live-activity');
  assert.equal(record.value.token, token);
  const again = await answerOf(rowTool, { board_key: 'running', token, app: 'com.example.app', environment: 'sandbox' }, { records: first.result.keep });
  assert.equal(again.result.changed, false);
  const ended = await answerOf(rowTool, { board_key: 'running', token, app: 'com.example.app', ended: true }, { records: first.result.keep });
  assert.equal(ended.result.ended, true);
  assert.deepEqual(ended.result.keep.map(item => [item.type, item.value]), [['notification-live-activity', null]]);
  const invalidEnvironment = await answerOf(rowTool, { board_key: 'running', token, app: 'com.example.app', environment: 'staging' });
  assert.equal(invalidEnvironment.status, 1);
  assert.match(invalidEnvironment.error, /environment must be sandbox or production/);
});

test('notification dispatch answers each device, hides addresses, distinguishes accepted from read and keeps nothing', async () => {
  const sends = [];
  const answer = await sendNotificationToMyDevices({ notification: event, audience: 'person:owner', devices: [device.value] }, { credentials: key(), now: () => Date.parse('2026-10-31T18:01:00Z'), send: async (url, request) => {
    sends.push({ url, request });
    return new Response('', { status: 200 });
  } });
  assert.equal(answer.delivered, true);
  assert.equal(answer.stage, 'sent');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].url, `https://api.sandbox.push.apple.com/3/device/${device.value.address}`);
  assert.equal(sends[0].request.headers['apns-topic'], device.value.app);
  const appPayload = JSON.parse(sends[0].request.body)[deliveryContract.apns_payload_key];
  assert.deepEqual(appPayload.actions, [{ id: 'open-report', label: 'Open report', opens: true }]);
  assert.equal(appPayload.id, event.notification_id);
  assert.equal(appPayload.notification_id, event.notification_id);
  const aps = JSON.parse(sends[0].request.body).aps;
  assert.equal(aps['mutable-content'], 1);
  assert.equal(aps.category, `${deliveryContract.apns_category_prefix}.open-report`);
  assert.deepEqual(answer.routes.apns.device_results, [{ device_id: device.value.device_id, stage: 'sent', status: 200 }]);
  assert.equal(JSON.stringify(answer).includes(device.value.address), false);
});

test('a sender row takes everything as input and mounts no door', () => {
  for (const id of ['tool:send-notification-to-my-devices', 'tool:send-live-activity-update']) {
    assert.equal(row(id).invoke.records, undefined);
    assert.equal(JSON.stringify(row(id)).includes('records-door'), false);
    assert.equal(JSON.stringify(row(id)).includes('records:write'), false);
  }
});

test('the sender rows answer their result through the real row with no records door and keep nothing', async () => {
  const sent = await answerOf(row('tool:send-notification-to-my-devices'), { notification: event, audience: 'person:owner', devices: [] }, { held: { 'notification-signing-keys': '{}' } });
  assert.equal(sent.status, 0, sent.error);
  assert.equal(sent.result.stage, 'not-sent');
  assert.deepEqual(sent.result.routes, {});
  assert.equal(sent.result.keep, undefined, 'a sender keeps nothing');
  const live = await answerOf(row('tool:send-live-activity-update'), { board_key: 'running', update_id: 'empty-row', items: [] }, { held: { 'notification-signing-keys': '{}' } });
  assert.equal(live.status, 0, live.error);
  assert.equal(live.result.state, 'not-running');
  assert.deepEqual(live.result.retired_activity_ids, []);
  assert.equal(live.result.keep, undefined, 'a sender keeps nothing');
});

test('the answer names the devices that read notices themselves without leaking their private addresses', async () => {
  const live = { device_id: 'live-1', route: 'live', address: 'mac-stable-12345678', can_show: 'allowed' };
  const answer = await sendNotificationToMyDevices({ notification: event, audience: 'person:owner', devices: [live] }, { send: async () => { throw new Error('no push route should run'); } });
  assert.equal(answer.stage, 'not-sent');
  assert.deepEqual(answer.live_device_ids, ['live-1']);
  assert.equal(JSON.stringify(answer).includes(live.address), false);
});

test('notification event audience mismatch fails before any network request', async () => {
  let count = 0;
  await assert.rejects(sendNotificationToMyDevices({ notification: event, audience: 'person:other', devices: [device.value] }, { credentials: key(), send: async () => { count += 1; return new Response('', { status: 200 }); } }), /does not name/);
  assert.equal(count, 0);
});

test('a lost APNs response is answered as uncertain', async () => {
  const answer = await sendNotificationToMyDevices({ notification: event, audience: 'person:owner', devices: [device.value] }, { credentials: key(), send: async () => { throw new Error('socket closed'); } });
  assert.equal(answer.stage, 'uncertain');
  assert.equal(answer.routes.apns.device_results[0].stage, 'uncertain');
});

test('a definite APNs rejection is answered as not-sent so the caller can send it again', async () => {
  const answer = await sendNotificationToMyDevices({ notification: event, audience: 'person:owner', devices: [device.value] }, { credentials: key(), send: async () => (
    new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500, headers: { 'content-type': 'application/json' } })) });
  assert.equal(answer.stage, 'not-sent');
  assert.equal(answer.delivered, false);
});

test('a partial delivery answer names the definitely failed device', async () => {
  const deviceTwo = { ...device.value, device_id: '5678', address: 'f'.repeat(64), label: 'Second iPhone' };
  const attempts = [];
  const answer = await sendNotificationToMyDevices({ notification: event, audience: 'person:owner', devices: [device.value, deviceTwo] }, { credentials: key(), send: async url => {
    attempts.push(url);
    return url.endsWith(device.value.address) ? new Response('', { status: 200 })
      : new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500, headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(answer.stage, 'partial');
  assert.equal(answer.delivered, true);
  assert.equal(attempts.length, 2);
  assert.deepEqual(answer.routes.apns.device_results.filter(result => result.stage === 'not-sent').map(result => result.device_id), ['5678']);
});

test('APNs invalid-token replies name that device as gone', async () => {
  const answer = await sendNotificationToMyDevices({ notification: event, audience: 'person:owner', devices: [device.value] }, { credentials: key(), send: async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400, headers: { 'content-type': 'application/json' } }) });
  assert.equal(answer.stage, 'not-sent');
  assert.deepEqual(answer.gone_device_ids, [device.value.device_id]);
});

test('Live Activity starts through push-to-start and answers started_at without keeping a receipt', async () => {
  const activityDevice = { ...device.value, device_id: 'activity', route: 'apns-activity', address: 'd'.repeat(64), attributes_type: 'Example.WorkAttributes' };
  let count = 0;
  const credentials = key();
  const input = { board_key: 'running', update_id: 'change-1', devices: [activityDevice], items: [{ id: 'job-1', title: 'Reading records', body: 'Halfway done', state: 'running', source: 'A connected AI', progress: { done: 2, total: 4, unit: 'pages', label: 'Halfway' } }] };
  const pushBodies = [];
  const send = async (_url, request) => { count += 1; assert.equal(request.headers['apns-push-type'], 'liveactivity'); pushBodies.push(JSON.parse(request.body)); return new Response('', { status: 200 }); };
  const first = await sendLiveActivityUpdate(input, { credentials, send, now: () => Date.parse('2026-10-31T18:02:00Z') });
  assert.equal(first.state, 'starting');
  assert.equal(first.started_at, '2026-10-31T18:02:00.000Z');
  assert.equal(count, 1);
  assert.equal(pushBodies[0].aps['attributes-type'], 'Example.WorkAttributes');
  const item = pushBodies[0].aps['content-state'].items[0];
  assert.deepEqual([item.done, item.total, item.unit, item.label, item.source], [2, 4, 'pages', 'Halfway', 'A connected AI']);
  assert.equal(Object.hasOwn(item, 'progress'), false, 'the native ContentState reads flat progress fields');
  const waiting = await sendLiveActivityUpdate({ ...input, last_start_at: first.started_at }, { credentials, send: async () => { throw new Error('must not start twice'); }, now: () => Date.parse('2026-10-31T18:03:00Z') });
  assert.equal(waiting.state, 'waiting-for-token');
  assert.equal(count, 1);
});

test('Live Activity updates the passed tokens and names the ones to forget', async () => {
  const activity = { id: 'notification-live-activity:one', board_key: 'running', token: 'a'.repeat(64), app: 'com.example.app', environment: 'sandbox', kept_at: '2026-10-31T18:00:00Z' };
  const stale = { ...activity, id: 'notification-live-activity:stale', token: 'b'.repeat(64), kept_at: '2026-10-31T01:00:00Z' };
  const events = [];
  const answer = await sendLiveActivityUpdate({ board_key: 'running', update_id: 'u-1', activities: [activity, stale], items: [{ id: 'job', title: 'Work', state: 'running' }] }, {
    credentials: key(), now: () => Date.parse('2026-10-31T18:05:00Z'), send: async (_url, request) => { events.push(JSON.parse(request.body).aps.event); return new Response('', { status: 200 }); },
  });
  assert.equal(answer.state, 'updated');
  assert.deepEqual(events.sort(), ['end', 'update']);
  assert.deepEqual(answer.retired_activity_ids, ['notification-live-activity:stale']);
  assert.equal(JSON.stringify(answer).includes(activity.token), false);
});

test('empty Live Activity board does not send an APNs request', async () => {
  let count = 0;
  const answer = await sendLiveActivityUpdate({ board_key: 'running', update_id: 'empty-1', items: [] }, { credentials: key(), send: async () => { count += 1; return new Response('', { status: 200 }); } });
  assert.equal(answer.state, 'not-running');
  assert.equal(count, 0);
});

test('all signing rows use one private bundle and a registered activity type', () => {
  for (const id of ['tool:send-notification-to-my-devices', 'tool:send-live-activity-update', 'tool:my-browser-push-application-key']) {
    assert.deepEqual(row(id).invoke.key, [{ secret_name: 'notification-signing-keys', fd: 4 }]);
  }
  assert.equal(row('tool:register-my-notification-device').input_schema.properties.attributes_type.type, 'string');
  assert.equal(Object.hasOwn(row('tool:send-live-activity-update').input_schema.properties, 'attributes_type'), false);
});

test('malformed signing inputs and provider failures never disclose private sentinel text', async () => {
  const sentinel = 'PRIVATE-KEY-JWT-PROVIDER-SENTINEL';
  assert.throws(() => heldNotificationSigningKeys(4, () => '{"apns":"' + sentinel), error => !error.message.includes(sentinel) && /not valid JSON/.test(error.message));
  await assert.rejects(myBrowserPushApplicationServerKey({}, { webCredentials: '{"jwk":"' + sentinel }), error => !error.message.includes(sentinel) && /not valid JSON/.test(error.message));
  const jwk = await makeSigningKey();
  await assert.rejects(myBrowserPushApplicationServerKey({}, { webCredentials: { jwk: { ...jwk, d: sentinel }, contact: 'mailto:push@example.test' } }), error => !error.message.includes(sentinel) && /not a valid/.test(error.message));
  const answer = await sendNotificationToMyDevices({ notification: event, audience: 'person:owner', devices: [device.value] }, {
    credentials: key(), send: async () => new Response(JSON.stringify({ reason: sentinel }), { status: 500 }),
  });
  assert.equal(answer.stage, 'not-sent');
  assert.equal(JSON.stringify(answer).includes(sentinel), false);
  const activityDevice = { ...device.value, device_id: 'activity-private', route: 'apns-activity', attributes_type: 'Example.OtherAttributes' };
  const live = await sendLiveActivityUpdate({ board_key: 'private', update_id: 'private-1', devices: [activityDevice], items: [{ id: 'job', title: 'Work', state: 'running' }] }, {
    credentials: key(), send: async () => { throw new Error(sentinel); },
  });
  assert.equal(live.state, 'uncertain');
  assert.equal(JSON.stringify(live).includes(sentinel), false);
});

test('Live Activity start refuses missing types and uses each registered native type', async () => {
  const input = { board_key: 'native-types', update_id: 'types-1', items: [{ id: 'job', title: 'Work', state: 'running' }] };
  const missing = { ...device.value, route: 'apns-activity' };
  const refused = await sendLiveActivityUpdate({ ...input, devices: [missing] }, { credentials: key(), send: async () => { assert.fail('must not send without a registered type'); } });
  assert.equal(refused.state, 'unavailable');
  const devices = ['One.Attributes', 'Two.Attributes'].map((attributes_type, index) => ({
    ...device.value, route: 'apns-activity', device_id: `types-${index}`, address: String(index + 1).repeat(64), attributes_type,
  }));
  const types = [];
  const answer = await sendLiveActivityUpdate({ ...input, devices }, { credentials: key(), send: async (_url, request) => {
    types.push(JSON.parse(request.body).aps['attributes-type']); return new Response('', { status: 200 });
  } });
  assert.equal(answer.state, 'starting');
  assert.deepEqual(types.sort(), ['One.Attributes', 'Two.Attributes']);
});

test('the sender default reaches APNs through HTTP/2 CONNECT rather than fetch', async () => {
  const connects = [];
  const proxy = createServer(socket => socket.once('data', data => {
    connects.push(data.toString().split('\r\n')[0]);
    socket.end('HTTP/1.1 502 Local test refusal\r\nContent-Length: 0\r\n\r\n');
  }));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const beforeProxy = process.env.HTTPS_PROXY;
  const beforeFetch = globalThis.fetch;
  try {
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('push.apple.com')) assert.fail('APNs default must not use fetch');
      return beforeFetch(input, init);
    };
    const answer = await sendNotificationToMyDevices({ notification: event, audience: 'person:owner', devices: [device.value] }, { credentials: key() });
    assert.equal(answer.stage, 'uncertain');
    assert.deepEqual(connects, ['CONNECT api.sandbox.push.apple.com:443 HTTP/1.1']);
  } finally {
    globalThis.fetch = beforeFetch;
    if (beforeProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = beforeProxy;
    await new Promise(resolve => proxy.close(resolve));
  }
});

test('the browser push key row answers from its held key alone, run by the function runner with no door', async () => {
  const command = row('tool:my-browser-push-application-key').invoke.run.slice(1).map(part => part
    .replace('/opt/workflows/', fileURLToPath(new URL('../../workflows/', import.meta.url)))
    .replace('/opt/notifications/', fileURLToPath(new URL('../', import.meta.url))));
  const jwk = await makeSigningKey();
  // As the engine runs it: the input on standard input, the held bundle on descriptor 4, nothing on descriptor 3.
  const child = spawn(process.execPath, command, { stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe'] });
  child.stdio[4].end(JSON.stringify({ web_push: { jwk, contact: 'mailto:push@example.test' } }));
  child.stdin.end('{}');
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  await new Promise(done => child.on('close', done));
  const answer = JSON.parse(out.trim().split('\n').at(-1));
  assert.equal(answer.error, undefined, answer.error);
  assert.equal(answer.result.applicationServerKey, base64url(publicPoint(jwk)));
});
