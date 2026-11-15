// Original camera algorithm tests through line 276 at old-trillion-before-worker-retire.
// The retired Worker account-erasure integration is owned by its current erasure lane.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import {
  CameraWall, answerCameraApi, createCamera, describeCamera, fileRecording, filingKey, forgetCameras, inputKey, isCameraApiPath, listKey,
  receiveStreamWebhook, removeCamera, revealCamera, streamApi, webhookSignatureHolds, WEBHOOK_SECRET_KEY,
} from '../read-data/camera-live.mjs';
import { cameraAnnotations, cameraTools } from '../../set-up-my-devices-and-cameras/src/camera-tools.mjs';

const INPUT = 'a'.repeat(32);
const VIDEO = 'b'.repeat(32);
const KEY = 'streamkey-1234567890abcd';
const TOKEN = 'stream-token-not-a-real-one';
const env = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_STREAM_TOKEN: TOKEN, OPERATOR_ACCOUNT_ID: 'user1' };

function memoryKv() {
  const map = new Map();
  return {
    map,
    async get(key, type) { const raw = map.get(key); if (raw === undefined) return null; return type === 'json' ? JSON.parse(raw) : raw; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
  };
}

function memoryFiles() {
  const written = { text: new Map(), uploads: [], parts: [] };
  return {
    written,
    async readText(name) { return written.text.get(name) ?? null; },
    async writeText(name, text) { written.text.set(name, text); },
    async startUpload(input) { written.uploads.push(input); return 'https://lease.example/put/abc'; },
    async putPart(address, offset, bytes) {
      written.parts.push({ offset, length: bytes.byteLength });
      const total = written.uploads.at(-1).byte_length;
      return offset + bytes.byteLength === total ? 'stored' : 'growing';
    },
  };
}

// A download arrives in 1 MB pieces, as a real one does.
const pieces = bytes => new ReadableStream({
  start(controller) { for (let at = 0; at < bytes.byteLength; at += 1024 * 1024) controller.enqueue(bytes.slice(at, at + 1024 * 1024)); controller.close(); },
});

const ok = result => new Response(JSON.stringify({ success: true, result }), { status: 200 });

function streamFetch({ file = new Uint8Array(1000).fill(7), calls = [], ranged = true, readyAfter = 0 } = {}) {
  let asks = 0;
  const handler = async (address, init = {}) => {
    const url = new URL(address);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    assert.ok(!JSON.stringify(init.body ?? '').includes(KEY), 'the key is never sent back out');
    if (url.host === 'download.example') {
      if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(file.byteLength) } });
      const range = /bytes=(\d+)-/.exec(init.headers?.range ?? '');
      if (range && ranged) return new Response(pieces(file.slice(Number(range[1]))), { status: 206 });
      return new Response(pieces(file), { status: 200 });
    }
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    const path = url.pathname.replace('/client/v4/accounts/acct/stream', '');
    if (path === '/webhook' && method === 'GET') return ok({ notificationUrl: '' });
    if (path === '/webhook' && method === 'PUT') return ok({ notificationUrl: JSON.parse(init.body).notificationUrl, secret: 'whsec' });
    if (path === '/live_inputs' && method === 'POST') {
      return ok({ uid: INPUT, rtmps: { url: 'rtmps://live.cloudflare.com:443/live/', streamKey: KEY }, srt: { url: 'srt://live.cloudflare.com:778', streamId: 'sid', passphrase: 'pp' }, webRTCPlayback: { url: 'https://customer-abc123.cloudflarestream.com/x/webRTC/play' } });
    }
    if (path === `/live_inputs/${INPUT}` && method === 'DELETE') return ok(null);
    if (path === `/${VIDEO}` && method === 'GET') { asks += 1; return ok({ uid: VIDEO, liveInput: INPUT, readyToStream: asks > readyAfter, status: { state: 'ready' }, created: '2026-10-07T14:03:09Z' }); }
    if (path === `/${VIDEO}/downloads` && method === 'GET') return ok({ default: { status: 'ready', url: 'https://download.example/video.mp4' } });
    if (path === `/${VIDEO}` && method === 'DELETE') return ok(null);
    return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 });
  };
  return handler;
}

const made = async () => {
  const kv = memoryKv();
  const files = memoryFiles();
  const answer = await createCamera({ env, userId: 'user1', name: 'Front court', origin: 'https://app.example', kv, files, fetchImpl: streamFetch() });
  return { kv, files, answer };
};

test('a camera is made once, its key is kept and never answered', async () => {
  const { kv, files, answer } = await made();
  assert.equal(answer.camera_id, 'front-court');
  assert.equal(answer.ingest.rtmps_url, 'rtmps://live.cloudflare.com:443/live/');
  assert.equal(answer.key_hint, 'ends abcd');
  assert.ok(!JSON.stringify(answer).includes(KEY), 'the answer does not carry the key');
  assert.equal((await kv.get(inputKey(INPUT), 'json')).rtmps_key, KEY);
  assert.equal(kv.map.get(WEBHOOK_SECRET_KEY), 'whsec');
  const sources = JSON.parse(files.written.text.get('/Camera/live-sources.json')).sources;
  assert.deepEqual(sources.map(source => [source.id, source.kind, source.playback_url, source.clips_folder]), [['front-court', 'hls', `https://customer-abc123.cloudflarestream.com/${INPUT}/manifest/video.m3u8`, '/Recordings/Cameras']]);
  assert.ok(!JSON.stringify(sources).includes(KEY), 'the screen file does not carry the key');
  const again = await createCamera({ env, userId: 'user1', name: 'front court', origin: 'https://app.example', kv, files, fetchImpl: async () => { throw new Error('no second input'); } });
  assert.equal(again.already, true);
});

test('an unreadable camera source list cannot be replaced with a partial list', async () => {
  const unavailable = Object.assign(new Error('Files owner unavailable'), { code: 'selected_owner_unavailable' });
  const files = memoryFiles();
  files.readText = async () => { throw unavailable; };
  await assert.rejects(createCamera({ env, userId: 'user1', name: 'Front court', origin: 'https://app.example',
    kv: memoryKv(), files, fetchImpl: streamFetch() }), error => error === unavailable);
  assert.equal(files.written.text.size, 0);
});

test('without a Stream token the wall names the one-time step', () => {
  assert.throws(() => streamApi({ CLOUDFLARE_ACCOUNT_ID: 'acct' }), error => error instanceof CameraWall && error.code === 'no-stream-token' && /Account > Stream > Edit/.test(error.message) && error.status === 503);
});

test('a refused token is reported by its Cloudflare code without the token', async () => {
  const api = streamApi(env, async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 }));
  await assert.rejects(api('GET', '/live_inputs'), error => error.code === 'stream-permission' && /10000/.test(error.message) && !error.message.includes(TOKEN));
});

test('the key is revealed to its owner only', async () => {
  const { kv } = await made();
  assert.equal((await revealCamera({ kv, userId: 'user1', cameraId: 'front-court' })).stream_key, KEY);
  await assert.rejects(revealCamera({ kv, userId: 'user2', cameraId: 'front-court' }), error => error.code === 'unknown-camera');
});

test('only the browser page may fetch a key, and only the operator may make cameras', async () => {
  const { kv, files } = await made();
  const call = (path, init, extra) => answerCameraApi(new Request(`https://app.example${path}`, init), { env: { ...env, APP_KV: kv }, userId: 'user1', origin: 'https://app.example', files, fetchImpl: streamFetch(), ...extra });
  assert.equal((await call('/mcp/api/cameras/front-court/key', {})).status, 403);
  const shown = await call('/work/api/cameras/front-court/key', {}, { browser: true });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('cache-control'), 'no-store');
  assert.equal((await shown.json()).stream_key, KEY);
  const listed = await (await call('/mcp/api/cameras', {})).text();
  assert.ok(!listed.includes(KEY), 'list never carries the key');
  const stranger = await answerCameraApi(new Request('https://app.example/mcp/api/cameras', { method: 'POST', body: '{"name":"x"}' }), { env: { ...env, APP_KV: kv }, userId: 'user2', origin: 'https://app.example', files });
  assert.equal(stranger.status, 403);
});

test('a finished recording is filed whole, then Stream\'s copy is deleted', async () => {
  const { kv, files } = await made();
  const calls = [];
  const result = await fileRecording({ env, uid: VIDEO, kv, files, fetchImpl: streamFetch({ calls }) });
  assert.equal(result.state, 'filed');
  assert.equal(result.name, `/Recordings/Cameras/2026-10-07/14.03.09 Front court ${VIDEO.slice(0, 8)}.mp4`);
  assert.deepEqual(files.written.uploads, [{ name: result.name, byte_length: 1000, media_type: 'video/mp4', app: undefined }].map(({ app, ...rest }) => rest));
  assert.equal(files.written.parts.reduce((sum, part) => sum + part.length, 0), 1000);
  assert.ok(calls.indexOf(`DELETE /client/v4/accounts/acct/stream/${VIDEO}`) > calls.findIndex(line => line.startsWith('GET https://download') || line.includes('/video.mp4')), 'deleted after the copy');
  assert.equal((await fileRecording({ env, uid: VIDEO, kv, files, fetchImpl: async () => { throw new Error('already filed'); } })).state, 'filed');
});

test('Stream\'s copy survives when Files never confirms the last byte', async () => {
  const { kv, files } = await made();
  files.putPart = async () => 'growing';
  const calls = [];
  await assert.rejects(fileRecording({ env, uid: VIDEO, kv, files, fetchImpl: streamFetch({ calls }) }), error => error.code === 'not-confirmed');
  assert.ok(!calls.some(line => line.startsWith('DELETE') && line.endsWith(`/${VIDEO}`)));
  assert.equal(await kv.get(`camera-filing:${VIDEO}`), null);
});

test('a recording that is not ready waits, and one from another input is ignored', async () => {
  const { kv, files } = await made();
  assert.equal((await fileRecording({ env, uid: VIDEO, kv, files, fetchImpl: streamFetch({ readyAfter: 5 }) })).state, 'waiting');
  kv.map.delete(inputKey(INPUT));
  assert.equal((await fileRecording({ env, uid: VIDEO, kv, files, fetchImpl: streamFetch() })).state, 'ignored');
});

test('a copy that runs out of time resumes from the byte it reached', async () => {
  const { kv, files } = await made();
  const file = new Uint8Array(20 * 1024 * 1024).fill(3);
  let clock = 0;
  const first = await fileRecording({ env, uid: VIDEO, kv, files, fetchImpl: streamFetch({ file }), budgetMs: 10, now: () => (clock += 100) });
  assert.equal(first.state, 'more');
  assert.ok(first.offset > 0 && first.offset < file.byteLength);
  const second = await fileRecording({ env, uid: VIDEO, kv, files, fetchImpl: streamFetch({ file }) });
  assert.equal(second.state, 'filed');
  assert.equal(files.written.uploads.length, 1, 'one upload, resumed');
  assert.equal(files.written.parts.reduce((sum, part) => sum + part.length, 0), file.byteLength);
});

const sign = (body, key, time) => `time=${time},sig1=${createHmac('sha256', key).update(`${time}.${body}`).digest('hex')}`;

test('Stream\'s webhook signature is checked and stale ones are refused', async () => {
  const body = '{"uid":"x"}';
  const now = 1_800_000_000;
  assert.equal(await webhookSignatureHolds({ header: sign(body, 'whsec', now), body, key: 'whsec', nowSeconds: now }), true);
  assert.equal(await webhookSignatureHolds({ header: sign(body, 'other', now), body, key: 'whsec', nowSeconds: now }), false);
  assert.equal(await webhookSignatureHolds({ header: sign(body, 'whsec', now - 3600), body, key: 'whsec', nowSeconds: now }), false);
  assert.equal(await webhookSignatureHolds({ header: undefined, body, key: 'whsec', nowSeconds: now }), false);
});

test('the webhook answers at once and files the owner\'s recording after the answer', async () => {
  const { kv, files } = await made();
  const body = JSON.stringify({ uid: VIDEO, readyToStream: true });
  const pending = [];
  const reply = await receiveStreamWebhook(new Request('https://app.example/camera/stream-webhook', { method: 'POST', body, headers: { 'webhook-signature': sign(body, 'whsec', Math.floor(Date.now() / 1000)) } }),
    { env, ctx: { waitUntil: work => pending.push(work) }, kv, filesFor: userId => { assert.equal(userId, 'user1'); return files; }, fetchImpl: streamFetch() });
  assert.equal(reply.status, 202);
  await Promise.all(pending);
  assert.equal((await kv.get(`camera-filing:${VIDEO}`, 'json')).state, 'filed');
  const forged = await receiveStreamWebhook(new Request('https://app.example/camera/stream-webhook', { method: 'POST', body, headers: { 'webhook-signature': sign(body, 'wrong', Math.floor(Date.now() / 1000)) } }),
    { env, ctx: { waitUntil: () => assert.fail('nothing runs for a forged notice') }, kv, filesFor: () => files });
  assert.equal(forged.status, 401);
  assert.equal((await receiveStreamWebhook(new Request('https://app.example/camera/stream-webhook'), { env, ctx: {}, kv, filesFor: () => files })).status, 405);
});

test('removing a camera deletes its input and keeps its recordings', async () => {
  const { kv, files } = await made();
  const out = await removeCamera({ env, userId: 'user1', cameraId: 'front-court', kv, files, fetchImpl: streamFetch() });
  assert.equal(out.removed, 'front-court');
  assert.equal(await kv.get(inputKey(INPUT)), null);
  assert.deepEqual(await kv.get(listKey('user1'), 'json'), []);
  assert.deepEqual(JSON.parse(files.written.text.get('/Camera/live-sources.json')).sources, []);
  await assert.rejects(describeCamera({ kv, uid: INPUT }), error => error.code === 'unknown-camera');
});

test('camera paths and tools', () => {
  for (const path of ['/mcp/api/cameras', '/work/api/cameras', '/mcp/api/cameras/file', '/work/api/cameras/front-court/key', '/mcp/api/cameras/front-court']) assert.equal(isCameraApiPath(path), true, path);
  for (const path of ['/mcp/api/camerasx', '/mcp/api/cameras/Front', '/mcp/api/cameras/a/b/c']) assert.equal(isCameraApiPath(path), false, path);
  const tools = cameraTools(async () => ({}));
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(cameraAnnotations).sort());
  assert.ok(tools.every(tool => !/key['"]?\s*:/.test(JSON.stringify(tool.inputSchema))), 'no tool takes or returns a key');
});

// Account erasure (src/worker.mjs deleteAccount -> forgetCameras): a deleted account's cameras stop taking video at
// Stream, their recordings still at Stream go, and no key carrying the account, its inputs or their videos is left in
// KV. Another account's camera and the account-wide webhook secret stay.
test('deleting an account ends its cameras at Stream and leaves none of its camera keys', async () => {
  const kv = memoryKv();
  const [mine1, mine2, theirs] = ['c'.repeat(32), 'd'.repeat(32), 'e'.repeat(32)];
  const [video1, video2, theirVideo] = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
  await kv.put(listKey('gone'), JSON.stringify([{ camera_id: 'front', uid: mine1 }, { camera_id: 'back', uid: mine2 }]));
  for (const uid of [mine1, mine2]) await kv.put(inputKey(uid), JSON.stringify({ user_id: 'gone', rtmps_key: KEY, srt_passphrase: 'pass-1' }));
  await kv.put(filingKey(`last:${mine1}`), JSON.stringify({ name: '/Recordings/Cameras/x.mp4', bytes: 1 }));
  await kv.put(filingKey(video1), JSON.stringify({ state: 'filing', send_bytes_to: 'https://lease.example/put/abc', offset: 5 }));
  await kv.put(listKey('stays'), JSON.stringify([{ camera_id: 'court', uid: theirs }]));
  await kv.put(inputKey(theirs), JSON.stringify({ user_id: 'stays', rtmps_key: 'their-key' }));
  await kv.put(filingKey(theirVideo), JSON.stringify({ state: 'filed' }));
  await kv.put(WEBHOOK_SECRET_KEY, 'shared-secret');
  const live = new Set([mine1, mine2, theirs]);
  const videos = new Map([[mine1, [video1]], [mine2, [video2]], [theirs, [theirVideo]]]);
  const kept = new Set([video1, theirVideo]); // video2 was already filed and deleted at Stream
  const calls = [];
  let failNext = false;
  const fetchImpl = async (address, init = {}) => {
    const path = new URL(address).pathname.replace('/client/v4/accounts/acct/stream', '');
    const method = init.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (failNext) { failNext = false; return new Response(JSON.stringify({ success: false, errors: [{ code: 10001, message: 'busy' }] }), { status: 500 }); }
    let match = /^\/live_inputs\/([a-f0-9]{32})\/videos$/.exec(path);
    if (match) return live.has(match[1]) ? ok((videos.get(match[1]) ?? []).map(uid => ({ uid }))) : new Response('{"success":false,"errors":[{"code":10003,"message":"not found"}]}', { status: 404 });
    match = /^\/live_inputs\/([a-f0-9]{32})$/.exec(path);
    if (match && method === 'DELETE') return live.delete(match[1]) ? ok(null) : new Response('{"success":false,"errors":[{"code":10003,"message":"not found"}]}', { status: 404 });
    match = /^\/([a-f0-9]{32})$/.exec(path);
    if (match && method === 'DELETE') return kept.delete(match[1]) ? ok(null) : new Response('{"success":false,"errors":[{"code":10003,"message":"not found"}]}', { status: 404 });
    return assert.fail(`Unexpected Stream call ${method} ${path}`);
  };

  // A Stream refusal part way leaves the deletion unfinished: the account's list is still there to finish from.
  const firstVideosCall = calls.length;
  let call = 0;
  const flaky = async (address, init) => { call += 1; if (call === 3) failNext = true; return fetchImpl(address, init); };
  await assert.rejects(forgetCameras({ env, userId: 'gone', kv, fetchImpl: flaky }), error => error instanceof CameraWall);
  assert.ok(kv.map.has(listKey('gone')), 'an unfinished erasure keeps the list it finishes from');
  assert.ok(calls.length > firstVideosCall);

  const done = await forgetCameras({ env, userId: 'gone', kv, fetchImpl });
  assert.deepEqual(done, { cameras: 2, recordings: 2 });
  assert.equal(live.has(mine1) || live.has(mine2), false, 'neither input takes video any more');
  assert.equal(kept.has(video1), false, 'its recording still at Stream is deleted');
  const left = [...kv.map.keys()];
  for (const name of left) for (const id of ['gone', mine1, mine2, video1, video2]) assert.ok(!name.includes(id), `${name} still names the deleted account`);
  assert.ok(!left.some(name => JSON.stringify(kv.map.get(name)).includes(KEY)), 'no ingest key is left');
  assert.deepEqual(left.sort(), [WEBHOOK_SECRET_KEY, filingKey(theirVideo), inputKey(theirs), listKey('stays')].sort(), 'another account and the shared webhook secret stay');
  assert.ok(live.has(theirs) && kept.has(theirVideo), 'another account\'s camera and recording are untouched at Stream');
  assert.ok(!calls.some(line => line.includes(theirs) || line.includes(theirVideo)));

  // Again, and for an account that never had a camera: nothing is asked of Stream, so no token is needed.
  calls.length = 0;
  assert.deepEqual(await forgetCameras({ env, userId: 'gone', kv, fetchImpl }), { cameras: 0, recordings: 0 });
  assert.deepEqual(await forgetCameras({ env: {}, userId: 'never', kv, fetchImpl }), { cameras: 0, recordings: 0 });
  assert.deepEqual(calls, []);
});

// The Worker's own deleteAccount (its actual source) forgets the account's cameras before the account's store is
// emptied, and a Stream refusal leaves the deletion unfinished, with the store untouched, for the next call to finish.
