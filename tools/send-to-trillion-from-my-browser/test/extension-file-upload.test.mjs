import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelFileUpload, FILE_UPLOAD_MCP_MAX_BYTES, FILE_UPLOAD_PIECE_BYTES, uploadFile } from '../src/file-upload.mjs';
import { recorderUploadOperation } from '../src/recorder-upload.mjs';

const stored = new Map();
const lockTails = new Map();
globalThis.chrome = { runtime: { getURL: name => `chrome-extension://upload-test/${name}`, getManifest: () => ({ version: '1' }) }, storage: { local: {
  get: async key => stored.has(key) ? { [key]: stored.get(key) } : {},
  set: async rows => { for (const [key, value] of Object.entries(rows)) stored.set(key, value); },
  remove: async key => { stored.delete(key); },
} } };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (name, action) => {
  const before = lockTails.get(name) ?? Promise.resolve();
  let release;
  const after = new Promise(resolve => { release = resolve; });
  lockTails.set(name, before.then(() => after));
  await before;
  try { return await action(); } finally { release(); }
} } } });

const transportCalls = [];
let namespaceState;
let keyedReceipts;
let replayFirstPiece = false;
let switchedAfterResponse = false;
globalThis.fetch = async (_url, init = {}) => {
  const rawBody = init.body ?? '';
  const body = JSON.parse(rawBody);
  const args = body.params?.arguments;
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params?.name, 'do_one_thing_in_my_account');
  assert.equal(args?.address, '@namespace');
  assert.ok(new TextEncoder().encode(rawBody).byteLength <= FILE_UPLOAD_MCP_MAX_BYTES, 'one resource operation fits the native MCP request bound');
  transportCalls.push({ rawBody, args, authorization: init.headers?.authorization });
  let answer;
  const prior = keyedReceipts.get(args.request_key);
  if (prior) answer = prior;
  else if (args.method === 'write_file_start') {
    const input = args.input;
    if (namespaceState && JSON.stringify(namespaceState.tuple) !== JSON.stringify(input)) return Response.json({ jsonrpc: '2.0', id: 1, error: { message: 'upload token tuple changed' } });
    namespaceState ??= { tuple: input, next: 0 };
    answer = { upload_id: input.upload_id, state: 'open', next_offset: namespaceState.next, byte_length: input.byte_length };
  } else if (args.method === 'write_file_piece') {
    const input = args.input;
    const bytes = Buffer.from(input.content_base64, 'base64');
    assert.ok(bytes.length > 0 && bytes.length <= FILE_UPLOAD_PIECE_BYTES);
    assert.equal(input.offset, namespaceState.next);
    namespaceState.next += bytes.length;
    answer = { upload_id: input.upload_id, next_offset: namespaceState.next, accepted_bytes: bytes.length, already_received: false };
    if (replayFirstPiece) {
      replayFirstPiece = false;
      keyedReceipts.set(args.request_key, answer);
      throw new TypeError('RemoteDisconnected after commit');
    }
  } else if (args.method === 'write_file_finish') {
    answer = { upload_id: args.input.upload_id, state: 'finished', identity: `1f:${'d'.repeat(64)}`, name: args.input.name, byte_length: namespaceState.tuple.byte_length };
  } else {
    throw new Error(`Unexpected resource method ${args.method}`);
  }
  keyedReceipts.set(args.request_key, answer);
  if (switchedAfterResponse) {
    switchedAfterResponse = false;
    stored.set('tokens', { access_token: 'token-b', refresh_token: 'refresh-b', account: 'account-b', account_source: 'mcp-initialize', session_id: 'session-b', expires_at: Date.now() + 3_600_000 });
  }
  return Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: answer } });
};

const { fileKeeper, runResourceOperation } = await import('../src/trillion.mjs');
const resetTransport = () => {
  stored.clear();
  stored.set('tokens', { access_token: 'token-a', refresh_token: 'refresh-a', account: 'account-a', account_source: 'mcp-initialize', session_id: 'session-a', expires_at: Date.now() + 3_600_000 });
  transportCalls.length = 0;
  namespaceState = null;
  keyedReceipts = new Map();
  replayFirstPiece = false;
  switchedAfterResponse = false;
};

test('file uploads use the exact absolute start tuple and sequential pieces of at most 32 KiB', async () => {
  const source = new Uint8Array(FILE_UPLOAD_PIECE_BYTES * 2 + 19).map((_, index) => index % 251);
  const calls = [];
  const operation = async (method, input, { requestKey, context }) => {
    calls.push({ method, input, requestKey, context });
    if (method === 'write_file_start') return { upload_id: input.upload_id, state: 'open', next_offset: 0, byte_length: source.length };
    if (method === 'write_file_piece') {
      const bytes = Buffer.from(input.content_base64, 'base64');
      assert.ok(bytes.length > 0 && bytes.length <= FILE_UPLOAD_PIECE_BYTES);
      assert.equal(Buffer.compare(bytes, Buffer.from(source.subarray(input.offset, input.offset + bytes.length))), 0);
      return { upload_id: input.upload_id, next_offset: input.offset + bytes.length, accepted_bytes: bytes.length, already_received: false };
    }
    return { upload_id: input.upload_id, state: 'finished', identity: `1f:${'a'.repeat(64)}`, name: input.name, byte_length: source.length };
  };
  const context = { account: 'account-a', session_id: 'session-a' };
  const saved = await uploadFile({ bytes: source, name: 'Sent/page.bin', mediaType: 'application/octet-stream', upload_id: '1'.repeat(32), context, operation });
  assert.equal(saved, `1f:${'a'.repeat(64)}`);
  assert.deepEqual(calls[0].input, {
    upload_id: '1'.repeat(32), name: '/Sent/page.bin', byte_length: source.length, media_type: 'application/octet-stream',
  });
  assert.ok(calls.every(call => call.context === context));
  assert.deepEqual(calls.filter(call => call.method === 'write_file_piece').map(call => call.input.offset), [0, 32768, 65536]);
  assert.deepEqual(calls.filter(call => call.method === 'write_file_piece').map(call => Buffer.from(call.input.content_base64, 'base64').length), [32768, 32768, 19]);
});

test('fileKeeper sends the exact addressed MCP envelope and retries a lost piece with its original key', async () => {
  resetTransport();
  replayFirstPiece = true;
  const bytes = new Uint8Array(FILE_UPLOAD_PIECE_BYTES + 7).map((_, index) => index % 239);
  const identity = await fileKeeper()({ bytes, name: 'synthetic.bin', mediaType: 'application/octet-stream', upload_id: 'a'.repeat(32) });
  assert.equal(identity, `1f:${'d'.repeat(64)}`);
  const pieces = transportCalls.filter(call => call.args.method === 'write_file_piece');
  assert.equal(pieces.length, 3, 'one piece is retried after the transport loses its response');
  assert.equal(pieces[0].rawBody, pieces[1].rawBody, 'the serialized MCP request is byte-for-byte identical on retry');
  assert.equal(pieces[0].args.request_key, pieces[1].args.request_key, 'the same native request key is reused');
  assert.deepEqual(JSON.parse(pieces[0].rawBody), {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'do_one_thing_in_my_account', arguments: pieces[0].args },
  });
  assert.equal(pieces[0].args.address, '@namespace');
  assert.equal(pieces[0].args.method, 'write_file_piece');
  assert.equal(Buffer.from(pieces[0].args.input.content_base64, 'base64').length, FILE_UPLOAD_PIECE_BYTES);
  assert.equal(new TextEncoder().encode(pieces[0].rawBody).byteLength <= 65_536, true);
  assert.equal(pieces.at(-1).args.input.offset, FILE_UPLOAD_PIECE_BYTES);
  assert.ok(transportCalls.every(call => call.authorization === 'Bearer token-a'));
  assert.ok(transportCalls.every(call => !call.rawBody.includes('token-a') && !call.rawBody.includes('session-a')));
});

test('addressed resource calls opt out of replay by default while fencing the initiating session', async () => {
  resetTransport();
  switchedAfterResponse = true;
  await assert.rejects(runResourceOperation('@namespace', 'write_file_start', {}, {
    requestKey: 'key-a', expectedAccount: 'account-a', expectedSessionId: 'session-a',
  }), /sign in|changed/i);
  assert.equal(transportCalls.length, 1, 'an arbitrary addressed operation is not replayed by default');
});

test('a response after account or session replacement is discarded without retrying into the new sign-in', async () => {
  resetTransport();
  switchedAfterResponse = true;
  await assert.rejects(fileKeeper()({ bytes: new Uint8Array([1]), name: '/switch.bin', upload_id: 'b'.repeat(32) }), /sign in|account changed/i);
  assert.equal(transportCalls.length, 1);
  assert.equal(transportCalls[0].authorization, 'Bearer token-a');
  assert.equal(stored.get('tokens').account, 'account-b');
});

test('a retry resumes the identical token and tuple at the owner-reported offset', async () => {
  const source = new Blob([new Uint8Array(FILE_UPLOAD_PIECE_BYTES * 2 + 5)]);
  const calls = [];
  let next = FILE_UPLOAD_PIECE_BYTES;
  const operation = async (method, input) => {
    calls.push({ method, input });
    if (method === 'write_file_start') return { upload_id: input.upload_id, state: 'open', next_offset: next, byte_length: source.size };
    if (method === 'write_file_piece') {
      const count = Buffer.from(input.content_base64, 'base64').length;
      next = input.offset + count;
      return { upload_id: input.upload_id, next_offset: next, accepted_bytes: count, already_received: false };
    }
    return { upload_id: input.upload_id, state: 'finished', identity: `1f:${'b'.repeat(64)}`, name: input.name, byte_length: source.size };
  };
  const tuple = { blob: source, name: '/Recordings/one.m4a', mediaType: 'audio/mp4', upload_id: '2'.repeat(32), operation };
  assert.equal(await uploadFile(tuple), `1f:${'b'.repeat(64)}`);
  assert.equal(calls[0].input.upload_id, tuple.upload_id);
  assert.equal(calls[0].input.byte_length, source.size);
  assert.deepEqual(calls.filter(call => call.method === 'write_file_piece').map(call => call.input.offset), [32768, 65536]);
});

test('finished start receipts and cancellation preserve the source owner result', async () => {
  const complete = await uploadFile({ bytes: new Uint8Array([1]), name: '/already.bin', upload_id: '3'.repeat(32), operation: async (method, input) => {
    assert.equal(method, 'write_file_start');
    return { upload_id: input.upload_id, state: 'finished', identity: `1f:${'c'.repeat(64)}`, name: input.name, byte_length: 1 };
  } });
  assert.equal(complete, `1f:${'c'.repeat(64)}`);
  const cancelled = await cancelFileUpload({ upload_id: '4'.repeat(32), name: '/cancel.bin', byte_length: 10, operation: async (method, input) => {
    assert.equal(method, 'write_file_cancel');
    assert.deepEqual(input, { upload_id: '4'.repeat(32), name: '/cancel.bin' });
    return { upload_id: input.upload_id, state: 'cancelled', bytes_retained: true, byte_length: 10 };
  } });
  assert.equal(cancelled.bytes_retained, true);
});

test('malformed owner receipts and unsafe inputs never become a saved-file identity', async () => {
  await assert.rejects(uploadFile({ bytes: new Uint8Array(FILE_UPLOAD_PIECE_BYTES + 1), name: '/x', upload_id: '5'.repeat(32), operation: async (_method, input) => ({
    upload_id: input.upload_id, state: 'open', next_offset: 1, byte_length: FILE_UPLOAD_PIECE_BYTES + 1,
  }) }), /invalid upload position/);
  await assert.rejects(uploadFile({ bytes: new Uint8Array([1]), name: '/x', upload_id: '6'.repeat(32), operation: async (method, input) => method === 'write_file_start'
    ? { upload_id: input.upload_id, state: 'open', next_offset: 0, byte_length: 1 }
    : { upload_id: input.upload_id, next_offset: 1, accepted_bytes: 0, already_received: false } }), /invalid piece receipt/);
  await assert.rejects(uploadFile({ bytes: new Uint8Array([1]), name: '/x', upload_id: '7'.repeat(32), operation: async (method, input) => method === 'write_file_start'
    ? { upload_id: input.upload_id, state: 'open', next_offset: 0, byte_length: 1 }
    : method === 'write_file_piece' ? { upload_id: input.upload_id, next_offset: 1, accepted_bytes: 1, already_received: false }
      : { upload_id: input.upload_id, state: 'finished', identity: 'client-supplied', name: input.name, byte_length: 1 } }), /did not confirm/);
  await assert.rejects(uploadFile({ bytes: new Uint8Array([1]), name: '/safe/../unsafe', upload_id: '8'.repeat(32), operation: async () => ({}) }), /absolute path/);
  await assert.rejects(uploadFile({ bytes: new Uint8Array([1]), name: '/x', upload_id: 'UPPER'.repeat(6) + '1234', operation: async () => ({}) }), /upload token/);
});

test('an offscreen recording can only relay a file operation for its initiating account and session', async () => {
  let state = { state: 'keeping', account: 'account-a', session_id: 'session-a' };
  const calls = [];
  const run = async (...args) => {
    calls.push(args);
    return { upload_id: '9'.repeat(32), state: 'open', next_offset: 0, byte_length: 1 };
  };
  const extensionId = 'upload-test';
  const recorderUrl = 'chrome-extension://upload-test/recorder.html';
  const operation = recorderUploadOperation({ readRecording: async () => state, run, extensionId, recorderUrl });
  const request = { method: 'write_file_start', input: {}, request_key: 'request-a', auth_context: { account: 'account-a', session_id: 'session-a' } };
  const sender = { id: extensionId, url: recorderUrl };
  await assert.rejects(operation(request, { id: extensionId, url: 'chrome-extension://upload-test/popup.html' }), /recording page/);
  await assert.rejects(operation(request, { id: 'other-extension', url: recorderUrl }), /recording page/);
  assert.deepEqual(await operation(request, sender), { upload_id: '9'.repeat(32), state: 'open', next_offset: 0, byte_length: 1 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['@namespace', 'write_file_start', {}]);
  assert.deepEqual(calls[0][3], { requestKey: 'request-a', expectedAccount: 'account-a', expectedSessionId: 'session-a', replayTransportOnce: true });
  state = { ...state, session_id: 'session-b' };
  await assert.rejects(operation(request, sender), /recording sign-in changed/);
  assert.equal(calls.length, 1, 'a stale offscreen request is refused before it reaches the resource');
  await assert.rejects(operation({ ...request, method: 'records:write' }, sender), /recording sign-in changed/);
});
