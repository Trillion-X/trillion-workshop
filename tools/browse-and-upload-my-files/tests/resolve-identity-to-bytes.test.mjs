// Hostile proof of the second locator reader: windows are rendered as each row spells them, rows are tried in
// priority order, a wrong byte count or a missing reader falls through to the next row, reads stay bounded, and a
// total failure names every target tried.
import assert from 'node:assert/strict';
import test from 'node:test';
import { identityByteLength, readIdentityWindow, renderLocatorRequest, streamIdentity } from '../read-data/resolve-identity-to-bytes.mjs';

const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 251);
const slice = (offset, length) => bytes.slice(offset, offset + length);

const numbers = { kind: 'live-namespace.locator', target: 'numbers', request: { path: 'x' }, range_keys: { offset: 'offset', length: 'length' }, response_encoding: 'payload-is-the-bytes', byte_length: 1000 };
const rendered = { kind: 'live-namespace.locator', target: 'rendered', request: { url: 'u', headers: {} }, range_render: { target_path: ['headers', 'Range'], template: 'bytes={offset}-{end_inclusive}' }, response_encoding: 'payload-is-the-bytes', byte_length: 1000 };

test('a window is written where each row says, and the row itself is never changed', () => {
  const before = JSON.stringify(rendered);
  assert.deepEqual(renderLocatorRequest(numbers, { offset: 10, length: 5 }), { path: 'x', offset: 10, length: 5 });
  assert.deepEqual(renderLocatorRequest(rendered, { offset: 10, length: 5 }), { url: 'u', headers: { Range: 'bytes=10-14' } });
  assert.equal(JSON.stringify(rendered), before);
  assert.throws(() => renderLocatorRequest({ ...numbers, range_render: rendered.range_render }, { offset: 0, length: 1 }), /exactly one/);
  assert.throws(() => renderLocatorRequest({ ...numbers, range_keys: undefined }, { offset: 0, length: 1 }), /exactly one/);
});

test('rows are tried by priority; an unreachable first row falls through to the next', async () => {
  const seen = [];
  const readers = {
    numbers: async request => { seen.push('numbers'); throw new Error(`drive not mounted for ${request.path}`); },
    rendered: async request => { seen.push('rendered'); const [, from, to] = /bytes=(\d+)-(\d+)/.exec(request.headers.Range); return slice(Number(from), Number(to) - Number(from) + 1); },
  };
  const result = await readIdentityWindow({ locators: [{ ...rendered, priority: 2 }, { ...numbers, priority: 1 }], readers, offset: 100, length: 50 });
  assert.deepEqual(seen, ['numbers', 'rendered']);
  assert.deepEqual(result.bytes, slice(100, 50));
  assert.equal(result.locator.target, 'rendered');
  assert.match(result.attempts[0].error, /not mounted/);
});

test('a source that returns the wrong number of bytes is not trusted', async () => {
  const readers = { numbers: async () => slice(0, 3), rendered: async () => slice(0, 4) };
  await assert.rejects(readIdentityWindow({ locators: [numbers, rendered], readers, offset: 0, length: 5 }), error => {
    assert.equal(error.code, 'NAMESPACE_UNREACHABLE');
    assert.match(error.message, /numbers \(returned 3 bytes/);
    assert.match(error.message, /rendered \(returned 4 bytes/);
    return true;
  });
});

test('an unavailable row and a row with no reader here are skipped, and no rows at all is a distinct answer', async () => {
  await assert.rejects(readIdentityWindow({ locators: [{ ...numbers, available: false }], readers: { numbers: async () => slice(0, 1) }, offset: 0, length: 1 }), error => error.code === 'NAMESPACE_NOT_FOUND');
  await assert.rejects(readIdentityWindow({ locators: [numbers], readers: {}, offset: 0, length: 1 }), /no reader here/);
});

test('a base64 reply is decoded at its pointer', async () => {
  const base64 = { ...numbers, response_encoding: 'base64', response_bytes_pointer: '/data/bytes_base64' };
  const readers = { numbers: async request => ({ data: { bytes_base64: Buffer.from(slice(request.offset, request.length)).toString('base64') } }) };
  assert.deepEqual((await readIdentityWindow({ locators: [base64], readers, offset: 7, length: 9 })).bytes, slice(7, 9));
});

test('a long span is read as bounded windows that together equal the bytes, and the end clamps to the length', async () => {
  const asked = [];
  const readers = { numbers: async request => { asked.push(request.length); return slice(request.offset, request.length); } };
  const parts = [];
  for await (const part of streamIdentity({ locators: [numbers], readers, start: 5, maxWindowBytes: 128 })) parts.push(part);
  assert.deepEqual(Buffer.concat(parts), Buffer.from(bytes.slice(5)));
  assert.ok(asked.every(length => length <= 128));
  assert.equal(identityByteLength([numbers]), 1000);
});
