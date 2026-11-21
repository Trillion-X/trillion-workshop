// The Media screen's raw span reader (web/src/workspace/media-raw-span.ts) against a stand-in for the page's door: a raw body
// with X-Total-Bytes and X-Offset, a JSON answer (not raw, so the caller falls back), a moved offset, and a short body.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readRawSpan } from '../web/src/workspace/media-raw-span.ts';

const IDENTITY = `1f:${'b'.repeat(64)}`;
const TOTAL = 1_180_194;
const standIn = (answer) => {
  const sent = [];
  const fetcher = async (path, init) => {
    sent.push({ path, init, body: JSON.parse(init.body) });
    return answer(sent.length);
  };
  return { fetcher, sent };
};
const rawAnswer = (bytes, offset = 0, total = TOTAL) => () => new Response(bytes, {
  status: 200, headers: { 'content-type': 'application/octet-stream', 'x-total-bytes': String(total), 'x-offset': String(offset) },
});

test('a raw answer comes back as its bytes, with the total and the offset it was asked at', async () => {
  const bytes = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);
  const { fetcher, sent } = standIn(rawAnswer(bytes));
  const span = await readRawSpan(fetcher, 'pass-1', IDENTITY, 0, 4 * 1024 * 1024);
  assert.deepEqual([...span.bytes], [...bytes]);
  assert.equal(span.total, TOTAL);
  assert.equal(span.offset, 0);
  assert.equal(sent[0].path, '/mcp');
  assert.equal(sent[0].init.headers.accept, 'application/octet-stream');
  assert.equal(sent[0].init.headers.authorization, 'Bearer pass-1');
  const call = sent[0].body.params.arguments.input.call.arguments;
  assert.deepEqual(call.bytes, { offset: 0, length: 4 * 1024 * 1024 });
  assert.equal(call.raw, true);
});

test('a window larger than the raw limit is asked for at the limit', async () => {
  const { fetcher, sent } = standIn(rawAnswer(new Uint8Array(1)));
  await readRawSpan(fetcher, 'p', IDENTITY, 0, 64 * 1024 * 1024);
  assert.equal(sent[0].body.params.arguments.input.call.arguments.bytes.length, 8 * 1024 * 1024);
});

test('a JSON answer is not raw: null, so the caller reads the JSON window', async () => {
  const { fetcher } = standIn(() => new Response('{"byte_slice":{}}', { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal(await readRawSpan(fetcher, 'p', IDENTITY, 0, 1024), null);
});

test('an answer at another offset than asked is refused', async () => {
  const { fetcher } = standIn(rawAnswer(new Uint8Array(4), 99));
  await assert.rejects(readRawSpan(fetcher, 'p', IDENTITY, 0, 1024), /changed while it was read/);
});

test('a short body before the end of the file is refused', async () => {
  const { fetcher } = standIn(rawAnswer(new Uint8Array(0), 0));
  await assert.rejects(readRawSpan(fetcher, 'p', IDENTITY, 0, 1024), /could not be read completely/);
});

test('a refused request is an error, never an empty span', async () => {
  const { fetcher } = standIn(() => new Response('no', { status: 401 }));
  await assert.rejects(readRawSpan(fetcher, 'p', IDENTITY, 0, 1024), /could not be read/);
});
