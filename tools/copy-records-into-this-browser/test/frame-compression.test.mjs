// A settle upload compressed against a sample of settle JSON named by its BLAKE3 hash (parts/device-copy
// frame-compression.mjs): the sender and the Worker's reader agree on it, a frame is only ever expanded to the size it
// declared, and plain uploads still work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deflateSync } from 'fflate';
import settings from '../../keep-my-records-on-this-device/do-work/frame-dictionaries.json' with { type: 'json' };
import { FrameError, compressFrame, expandFrame, frameDictionaryIds, isFrame, maxFrameBytes } from '../../keep-my-records-on-this-device/do-work/frame-compression.mjs';
import { accountCopySender } from '../../keep-my-records-on-this-device/do-work/account-copy.mjs';
import { browserRecordCopyBody } from '../src/browser-record-copy.mjs';

const upload = (count) => JSON.stringify({
  copy: 'device-1', root: '0123456789abcdef', took_through: null,
  rows: [{ id: '01a15709-3f0a-7019-81df-90cabc197099', envelopes: Array.from({ length: count }, (_, n) => ({
    id: `note:${n}`, type: 'note',
    value: { title: `Note ${n}`, text: `Words of note ${n} about the plan for the week`, created_at: new Date(1_790_000_000_000 + n * 1000).toISOString(), space_id: 'space-1', status: 'open', tags: ['a', 'b'] },
    at: `01a157093f04${String(n).padStart(7, '0')}`, floor: `01a157093f04${String(n).padStart(7, '0')}`, prior: null,
  })) }],
});
const headersOf = frame => new Headers(frame.headers);

test('a dictionary is named by the BLAKE3 hash of its bytes, never SHA-256', () => {
  const bytes = new TextEncoder().encode(settings.dictionaries.at(-1).text);
  assert.deepEqual(frameDictionaryIds(), [bytesToHex(blake3(bytes))]);
  assert.notEqual(frameDictionaryIds()[0], createHash('sha256').update(bytes).digest('hex'));
});

test('a large batch shrinks against the dictionary and expands to exactly its text', () => {
  const text = upload(60);
  const frame = compressFrame(text);
  assert.ok(frame, 'a large batch is sent as a frame');
  const alone = deflateSync(new TextEncoder().encode(text), { level: 6 }).length;
  console.log(`readback: ${text.length} bytes of settle JSON -> ${frame.body.length} bytes as a frame (${alone} deflated without the dictionary)`);
  assert.ok(frame.body.length < alone, 'the shared dictionary saves bytes over compressing alone');
  assert.ok(isFrame(headersOf(frame)));
  assert.equal(expandFrame(frame.body, headersOf(frame), { max_expanded_bytes: 4_000_000 }), text);
});

test('a short text goes plain', () => {
  assert.equal(compressFrame('{"copy":"device-1","rows":[]}'), null);
});

test('a frame is refused before use when it has no size, a size over the cap, an unknown dictionary or the wrong size', () => {
  const text = upload(60);
  const frame = compressFrame(text);
  const cap = { max_expanded_bytes: 4_000_000 };
  const refused = (headers, body = frame.body, limits = cap) => assert.throws(() => expandFrame(body, new Headers(headers), limits), FrameError);
  const { 'x-trillion-frame-size': size, ...withoutSize } = frame.headers;
  refused(withoutSize);
  refused({ ...frame.headers, 'x-trillion-frame-size': 'many' });
  assert.throws(() => expandFrame(frame.body, headersOf(frame), { max_expanded_bytes: 1000 }), error => error.status === 413);
  refused({ ...frame.headers, 'x-trillion-frame-dictionary': bytesToHex(blake3(new TextEncoder().encode('another dictionary'))) });
  refused({ ...frame.headers, 'x-trillion-frame-size': String(Number(size) - 1) });
  refused({ ...frame.headers, 'x-trillion-frame-size': String(Number(size) + 1) });
  refused(frame.headers, frame.body.slice(0, 40));
  assert.throws(() => expandFrame(new Uint8Array(maxFrameBytes + 1), headersOf(frame), cap), error => error.status === 413);
});

test('a small frame cannot become a large allocation: a bomb declaring a small size is stopped as it expands', () => {
  const bomb = deflateSync(new Uint8Array(50_000_000), { level: 9 });
  assert.ok(bomb.length < 100_000);
  assert.throws(() => expandFrame(bomb, new Headers({ 'content-type': settings.content_type, 'x-trillion-frame-dictionary': frameDictionaryIds()[0], 'x-trillion-frame-size': '1000' }), { max_expanded_bytes: 4_000_000 }), FrameError);
});

test('the sender posts a frame, the Worker reads it back as the same text, and a plain post is still read', async () => {
  const text = upload(80);
  const request = JSON.parse(text);
  let posted;
  const sender = accountCopySender({ account: 'A', url: '/work/records/settle', fetch: async (_url, init) => { posted = init; return Response.json({ root: 'x' }); } });
  await sender.send(request);
  assert.ok(posted.body instanceof Uint8Array, 'a large batch went as a frame');
  const served = new Request('https://app.test/work/records/settle', { method: 'POST', headers: { ...posted.headers, 'content-length': String(posted.body.length) }, body: posted.body });
  assert.equal((await browserRecordCopyBody(served)).text, text);
  await sender.send({ copy: 'device-1', rows: [] });
  assert.equal(typeof posted.body, 'string', 'a short one went as plain JSON');
  const plain = new Request('https://app.test/work/records/settle', { method: 'POST', headers: posted.headers, body: posted.body });
  assert.equal((await browserRecordCopyBody(plain)).text, posted.body);
  const lying = new Request('https://app.test/work/records/settle', { method: 'POST', headers: { ...posted.headers, 'content-type': settings.content_type }, body: 'not a frame' });
  assert.equal((await browserRecordCopyBody(lying)).refusal.status, 413, 'a frame must declare its length');
});
