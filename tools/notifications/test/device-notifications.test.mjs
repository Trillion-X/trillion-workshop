import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { openSync } from 'node:fs';
import { createServer } from 'node:net';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import { runRow, rowOf } from 'trillion-workshop/tools/records-door/test/run-row.mjs';
import { registerMyNotificationDevice, registerMyLiveActivity, sendNotificationToMyDevices, sendLiveActivityUpdate, myBrowserPushApplicationServerKey, heldNotificationSigningKeys } from '../read-data/device-notifications.mjs';
import { base64url, makeSigningKey, publicPoint } from '../read-data/web-push.mjs';
import rows from '../tool-rows.json' with { type: 'json' };
import deliveryContract from '../read-data/delivery-contract.json' with { type: 'json' };

const row = id => rowOf(rows, id);
const rights = id => row(id).invoke.records.rights;
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

test('browser notice delivery uses the same held signing key returned for enrollment and records accepted device ids', async () => {
  const subscriptionPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const browserJwk = await crypto.subtle.exportKey('jwk', subscriptionPair.publicKey);
  const subscription = {
    endpoint: 'https://push.example.test/send/one',
    keys: { p256dh: base64url(publicPoint(browserJwk)), auth: base64url(crypto.getRandomValues(new Uint8Array(16))) },
  };
  const webPushSigningJwk = await makeSigningKey();
  const webCredentials = { jwk: webPushSigningJwk, contact: 'mailto:push@example.test' };
  const deviceRow = { id: 'notification-device:web-1', type: 'notification-device', value: {
    device_id: 'web-1', route: 'web-push', address: subscription, can_show: 'allowed',
  } };
  await withDoor('tool:send-notification-to-my-devices', [eventRecord, deviceRow], async ({ fake, door }) => {
    let captured;
    const answer = await sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner' }, {
      door, webCredentials, send: async (url, request) => { captured = { url, request }; return new Response('', { status: 201 }); },
    });
    assert.equal(answer.stage, 'sent', JSON.stringify({ answer, results: fake.kept.get('told-the-person:1')?.value?.item?.results, provider_called: Boolean(captured) }));
    assert.equal(captured.url, subscription.endpoint);
    assert.equal(captured.request.headers.authorization.includes(base64url(publicPoint(webPushSigningJwk))), true);
    assert.deepEqual(fake.kept.get('told-the-person:1').value.item.results['web-push'].device_ids, ['web-1']);
    assert.equal(JSON.stringify(answer).includes(subscription.endpoint), false);
  });
});
const eventRecord = { id: 'notification-event:n-1', type: 'notification-event', value: event };
const device = { id: 'notification-device:1234', type: 'notification-device', value: { device_id: '1234', route: 'apns', address: 'a'.repeat(64), label: 'My iPhone', app: 'com.example.app', environment: 'sandbox', can_show: 'allowed', added_at: '2026-10-31T18:00:00Z' } };

test('device registration validates addresses, keeps a stable opaque identity, and never returns the push token', async () => {
  const register = row('tool:register-my-notification-device');
  const token = 'b'.repeat(64);
  const first = await runRow(register, { route: 'apns', address: token, app: 'com.example.app', environment: 'sandbox', can_show: 'allowed' });
  assert.equal(first.status, 0, first.error);
  assert.equal(first.result.changed, true);
  assert.equal(first.result.devices[0].address, undefined);
  assert.equal(JSON.stringify(first.result).includes(token), false);
  const saved = first.kept.find(item => item.type === 'notification-device');
  assert.equal(saved.value.address, token);
  assert.match(saved.value.device_id, /^1f[a-f0-9]{64}$/);
  const again = await runRow(register, { route: 'apns', address: token, app: 'com.example.app', environment: 'sandbox', can_show: 'allowed' }, { records: first.kept });
  assert.equal(again.result.changed, false);
  assert.equal(again.result.device_id, first.result.device_id);
  const bad = await runRow(register, { route: 'apns', address: 'not-a-token', app: 'com.example.app' });
  assert.equal(bad.status, 1);
  assert.match(bad.error, /hex token/);
  const noTopic = await runRow(register, { route: 'apns', address: 'a'.repeat(64) });
  assert.match(noTopic.error, /bundle id/);
});

test('device removal deletes the address only for the named registration', async () => {
  const registered = await runRow(row('tool:register-my-notification-device'), { route: 'live', address: 'mac-stable-12345678' });
  const deviceId = registered.result.device_id;
  const removed = await runRow(row('tool:remove-my-notification-device'), { device_id: deviceId }, { records: registered.kept });
  assert.equal(removed.result.removed, true);
  assert.equal(removed.kept.some(item => item.type === 'notification-device'), false);
  assert.equal((await runRow(row('tool:remove-my-notification-device'), { device_id: deviceId })).result.removed, false);
});

test('Live Activity registration keeps an opaque idempotent token and removes it on end', async () => {
  const token = 'c'.repeat(64);
  const rowTool = row('tool:register-my-live-activity');
  const first = await runRow(rowTool, { board_key: 'running', token, app: 'com.example.app', environment: 'sandbox' });
  assert.equal(first.status, 0, first.error);
  assert.equal(first.result.kept, true);
  assert.equal(first.result.ended, false);
  assert.equal(JSON.stringify(first.result).includes(token), false);
  const record = first.kept.find(item => item.type === 'notification-live-activity');
  assert.equal(record.value.token, token);
  const again = await runRow(rowTool, { board_key: 'running', token, app: 'com.example.app', environment: 'sandbox' }, { records: first.kept });
  assert.equal(again.result.changed, false);
  const ended = await runRow(rowTool, { board_key: 'running', token, app: 'com.example.app', ended: true }, { records: first.kept });
  assert.equal(ended.result.ended, true);
  assert.equal(ended.kept.some(item => item.type === 'notification-live-activity'), false);
  const invalidEnvironment = await runRow(rowTool, { board_key: 'running', token, app: 'com.example.app', environment: 'staging' });
  assert.equal(invalidEnvironment.status, 1);
  assert.match(invalidEnvironment.error, /environment must be sandbox or production/);
});

async function withDoor(rowId, records, run) {
  const fake = await startFakeDoor({ rights: rights(rowId), records, pageCut: 1 });
  const fd = openSync(fake.descriptor, 'r');
  try {
    const door = openRecordsDoor({ descriptor: fd });
    return await run({ fake, door });
  } finally { await fake.close(); }
}

test('notification dispatch records before APNs, hides addresses, distinguishes accepted from read, and does not resend', async () => {
  await withDoor('tool:send-notification-to-my-devices', [eventRecord, device], async ({ fake, door }) => {
    const sends = [];
    const answer = await sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner' }, { door, credentials: key(), now: () => Date.parse('2026-10-31T18:01:00Z'), send: async (url, request) => {
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
    assert.equal(appPayload.id, 'told:1');
    assert.equal(appPayload.notification_id, event.notification_id);
    const aps = JSON.parse(sends[0].request.body).aps;
    assert.equal(aps['mutable-content'], 1);
    assert.equal(aps.category, `${deliveryContract.apns_category_prefix}.open-report`);
    const saved = fake.kept.get('told-the-person:1').value.item;
    assert.equal(saved.results.apns.sent, true);
    assert.deepEqual(saved.results.apns.device_ids, [device.value.device_id]);
    assert.deepEqual(saved.actions, event.actions);
    assert.equal(saved.read, false);
    assert.equal(JSON.stringify(answer).includes(device.value.address), false);
    const repeated = await sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner' }, { door, credentials: key(), send: async () => { throw new Error('must not send again'); } });
    assert.equal(repeated.delivered, true);
    assert.equal(sends.length, 1);
  });
});

test('the recorded queue names eligible device ids without leaking their private addresses', async () => {
  const live = { id: 'notification-device:live-1', type: 'notification-device', value: {
    device_id: 'live-1', route: 'live', address: 'mac-stable-12345678', can_show: 'allowed',
  } };
  await withDoor('tool:send-notification-to-my-devices', [eventRecord, live], async ({ fake, door }) => {
    const answer = await sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner' }, { door, send: async () => { throw new Error('no push route should run'); } });
    assert.equal(answer.stage, 'not-sent');
    const item = fake.kept.get('told-the-person:1').value.item;
    assert.deepEqual(item.results['device-pull'].device_ids, ['live-1']);
    assert.equal(JSON.stringify(item).includes(live.value.address), false);
  });
});

test('notification event audience mismatch fails before any tell record or network request', async () => {
  await withDoor('tool:send-notification-to-my-devices', [eventRecord, device], async ({ fake, door }) => {
    let count = 0;
    await assert.rejects(sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:other' }, { door, credentials: key(), send: async () => { count += 1; return new Response('', { status: 200 }); } }), /does not name/);
    assert.equal(count, 0);
    assert.equal([...fake.kept.keys()].some(id => id.startsWith('told-the-person')), false);
  });
});

test('a lost APNs response is held as uncertain and never blindly retried', async () => {
  await withDoor('tool:send-notification-to-my-devices', [eventRecord, device], async ({ fake, door }) => {
    let count = 0;
    const options = { door, credentials: key(), send: async () => { count += 1; throw new Error('socket closed'); } };
    const first = await sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner' }, options);
    assert.equal(first.stage, 'uncertain');
    const repeated = await sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner', retry_failed: true }, options);
    assert.equal(repeated.stage, 'uncertain');
    assert.equal(count, 1);
    assert.equal(fake.kept.get('told-the-person:1').value.item.results.apns.stage, 'uncertain');
  });
});

test('a definite APNs rejection retries only when explicitly requested', async () => {
  await withDoor('tool:send-notification-to-my-devices', [eventRecord, device], async ({ fake, door }) => {
    let count = 0;
    const credentials = key();
    const input = { notification_id: 'n-1', audience: 'person:owner' };
    const first = await sendNotificationToMyDevices(input, { door, credentials, send: async () => {
      count += 1;
      return new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500, headers: { 'content-type': 'application/json' } });
    } });
    assert.equal(first.stage, 'not-sent');
    assert.equal(count, 1);
    const retry = await sendNotificationToMyDevices({ ...input, retry_failed: true }, { door, credentials, send: async () => {
      count += 1;
      return new Response('', { status: 200 });
    } });
    assert.equal(retry.stage, 'sent');
    assert.equal(count, 2);
    assert.equal(fake.kept.get('told-the-person:1').value.item.results.apns.sent, true);
  });
});

test('a partial delivery receipt retries only definitively failed devices', async () => {
  const deviceTwo = { id: 'notification-device:5678', type: 'notification-device', value: {
    ...device.value, device_id: '5678', address: 'f'.repeat(64), label: 'Second iPhone',
  } };
  await withDoor('tool:send-notification-to-my-devices', [eventRecord, device, deviceTwo], async ({ door }) => {
    const firstToken = device.value.address;
    const secondToken = deviceTwo.value.address;
    const attempts = [];
    const credentials = key();
    const input = { notification_id: 'n-1', audience: 'person:owner' };
    const first = await sendNotificationToMyDevices(input, { door, credentials, send: async url => {
      attempts.push(url);
      return url.endsWith(firstToken) ? new Response('', { status: 200 })
        : new Response(JSON.stringify({ reason: 'InternalServerError' }), { status: 500, headers: { 'content-type': 'application/json' } });
    } });
    assert.equal(first.stage, 'partial');
    assert.equal(first.delivered, true);
    assert.equal(attempts.length, 2);
    const retry = await sendNotificationToMyDevices({ ...input, retry_failed: true }, { door, credentials, send: async url => {
      attempts.push(url);
      return new Response('', { status: 200 });
    } });
    assert.equal(retry.stage, 'sent');
    assert.equal(attempts.length, 3);
    assert.ok(attempts.at(-1).endsWith(secondToken));
  });
});

test('two concurrent delivery calls claim one APNs attempt for the event key', async () => {
  await withDoor('tool:send-notification-to-my-devices', [eventRecord, device], async ({ door }) => {
    let count = 0;
    const options = { door, credentials: key(), send: async () => { count += 1; await new Promise(done => setTimeout(done, 10)); return new Response('', { status: 200 }); } };
    const answers = await Promise.all([
      sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner' }, options),
      sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner' }, options),
    ]);
    assert.equal(count, 1);
    assert.equal(answers.every(answer => answer.recorded), true);
    assert.equal(answers.some(answer => answer.delivered), true);
  });
});

test('APNs invalid-token replies remove only that private registration', async () => {
  await withDoor('tool:send-notification-to-my-devices', [eventRecord, device], async ({ fake, door }) => {
    const answer = await sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner' }, { door, credentials: key(), send: async () => new Response(JSON.stringify({ reason: 'BadDeviceToken' }), { status: 400, headers: { 'content-type': 'application/json' } }) });
    assert.equal(answer.stage, 'not-sent');
    assert.equal(fake.kept.has(device.id), false);
    assert.equal(fake.kept.get('told-the-person:1').value.item.results.apns.stage, 'not-sent');
  });
});

test('Live Activity starts through push-to-start, stores a durable update receipt and refuses a repeated send', async () => {
  const activityDevice = { ...device, id: 'notification-device:activity', value: { ...device.value, device_id: 'activity', route: 'apns-activity', address: 'd'.repeat(64), attributes_type: 'Example.WorkAttributes' } };
  await withDoor('tool:send-live-activity-update', [activityDevice], async ({ fake, door }) => {
    let count = 0;
    const credentials = key();
    const input = { board_key: 'running', update_id: 'change-1', items: [{ id: 'job-1', title: 'Reading records', body: 'Halfway done', state: 'running', source: 'A connected AI', progress: { done: 2, total: 4, unit: 'pages', label: 'Halfway' } }] };
    const pushBodies = [];
    const send = async (_url, request) => { count += 1; assert.equal(request.headers['apns-push-type'], 'liveactivity'); pushBodies.push(JSON.parse(request.body)); return new Response('', { status: 200 }); };
    const first = await sendLiveActivityUpdate(input, { door, credentials, send, now: () => Date.parse('2026-10-31T18:02:00Z') });
    assert.equal(first.state, 'starting');
    assert.equal(count, 1);
    assert.equal(pushBodies[0].aps['attributes-type'], 'Example.WorkAttributes');
    const item = pushBodies[0].aps['content-state'].items[0];
    assert.deepEqual([item.done, item.total, item.unit, item.label, item.source], [2, 4, 'pages', 'Halfway', 'A connected AI']);
    assert.equal(Object.hasOwn(item, 'progress'), false, 'the native ContentState reads flat progress fields');
    const record = [...fake.kept.values()].find(item => item.type === 'notification-live-activity-delivery');
    assert.equal(record.value.answer.state, 'starting');
    const again = await sendLiveActivityUpdate(input, { door, credentials, send: async () => { throw new Error('must not resend'); }, now: () => Date.parse('2026-10-31T18:03:00Z') });
    assert.equal(again.state, 'starting');
    assert.equal(count, 1);
  });
});

test('empty Live Activity board does not send an APNs request or lose a receipt', async () => {
  await withDoor('tool:send-live-activity-update', [], async ({ fake, door }) => {
    let count = 0;
    const answer = await sendLiveActivityUpdate({ board_key: 'running', update_id: 'empty-1', items: [] }, { door, credentials: key(), send: async () => { count += 1; return new Response('', { status: 200 }); } });
    assert.equal(answer.state, 'not-running');
    assert.equal(count, 0);
    assert.equal([...fake.kept.values()].some(item => item.type === 'notification-live-activity-delivery'), true);
  });
});



test('all signing rows use one private bundle and a registered activity type', () => {
  for (const id of ['tool:send-notification-to-my-devices', 'tool:send-live-activity-update', 'tool:my-browser-push-application-key']) {
    assert.deepEqual(row(id).invoke.credential_mounts, [{ secret_name: 'notification-signing-keys', fd: 4 }]);
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
  await withDoor('tool:send-notification-to-my-devices', [eventRecord, device], async ({ fake, door }) => {
    const answer = await sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner' }, {
      door, credentials: key(), send: async () => new Response(JSON.stringify({ reason: sentinel }), { status: 500 }),
    });
    assert.equal(answer.stage, 'not-sent');
    assert.equal(JSON.stringify([answer, [...fake.kept.values()]]).includes(sentinel), false);
  });
  const activityDevice = { ...device, id: 'notification-device:activity-private', value: { ...device.value, device_id: 'activity-private', route: 'apns-activity', attributes_type: 'Example.OtherAttributes' } };
  await withDoor('tool:send-live-activity-update', [activityDevice], async ({ fake, door }) => {
    const answer = await sendLiveActivityUpdate({ board_key: 'private', update_id: 'private-1', items: [{ id: 'job', title: 'Work', state: 'running' }] }, {
      door, credentials: key(), send: async () => { throw new Error(sentinel); },
    });
    assert.equal(answer.state, 'uncertain');
    assert.equal(JSON.stringify([answer, [...fake.kept.values()]]).includes(sentinel), false);
  });
});

test('Live Activity start refuses missing types and uses each registered native type', async () => {
  const input = { board_key: 'native-types', update_id: 'types-1', items: [{ id: 'job', title: 'Work', state: 'running' }] };
  const missing = { ...device, value: { ...device.value, route: 'apns-activity' } };
  await withDoor('tool:send-live-activity-update', [missing], async ({ door }) => {
    const answer = await sendLiveActivityUpdate(input, { door, credentials: key(), send: async () => { assert.fail('must not send without a registered type'); } });
    assert.equal(answer.state, 'unavailable');
  });
  const devices = ['One.Attributes', 'Two.Attributes'].map((attributes_type, index) => ({
    ...device, id: `notification-device:types-${index}`, value: { ...device.value, route: 'apns-activity', device_id: `types-${index}`, address: String(index + 1).repeat(64), attributes_type },
  }));
  await withDoor('tool:send-live-activity-update', devices, async ({ door }) => {
    const types = [];
    const answer = await sendLiveActivityUpdate(input, { door, credentials: key(), send: async (_url, request) => {
      types.push(JSON.parse(request.body).aps['attributes-type']); return new Response('', { status: 200 });
    } });
    assert.equal(answer.state, 'starting');
    assert.deepEqual(types.sort(), ['One.Attributes', 'Two.Attributes']);
  });
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
    await withDoor('tool:send-notification-to-my-devices', [eventRecord, device], async ({ door }) => {
      const answer = await sendNotificationToMyDevices({ notification_id: 'n-1', audience: 'person:owner' }, { door, credentials: key() });
      assert.equal(answer.stage, 'uncertain');
    });
    assert.deepEqual(connects, ['CONNECT api.sandbox.push.apple.com:443 HTTP/1.1']);
  } finally {
    globalThis.fetch = beforeFetch;
    if (beforeProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = beforeProxy;
    await new Promise(resolve => proxy.close(resolve));
  }
});
