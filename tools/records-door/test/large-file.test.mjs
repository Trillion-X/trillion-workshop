import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { fileSource } from '../../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';
import { bufferSource, keepLocalFile, LARGE_FILE, writeWholeFile } from '../read-data/whole-file.mjs';
import { openRecordsDoor, writeLargeFile } from '../read-data/records-door.mjs';
import { keepInRawPieces, RAW_PIECES } from '../read-data/raw-pieces.mjs';

const CAPABILITY = 'run_synthetic_capability';
const FILES = 'tool:your-files';

// Distinct bytes everywhere.
const bytesOf = (length, seed = 0x9e3779b9) => {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; out[i] = state & 0xff; }
  return out;
};

// A stand-in for the engine's door with the files session behind it, with the same checks: the capability is the bearer; a
// JSON call is the tools/call body, a raw piece is the octet-stream body with the same call in X-Call (the engine's
// src/mcp/upload.rs); the call is `tools:run` { tool, call } at @tools; a piece must start where the upload stands; the
// finish names the whole file's identity. `fail` answers the n-th piece (counting from 1) with that status once, after
// keeping it when `kept` is set, so the sender does not know whether it took. `refuse` refuses every piece as not started.
async function startFakeDoor({ fail = {}, refuse = false } = {}) {
  const uploads = new Map();
  const files = new Map();
  const calls = [];
  let pieces = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    const answer = (structuredContent, isError = false) => send(200, { jsonrpc: '2.0', id: 1, result: { structuredContent: { tool: FILES, result: { structuredContent, isError } } } });
    if (request.url !== '/mcp' || request.headers.authorization !== `Bearer ${CAPABILITY}`) return send(401, { error: 'no' });
    const raw = request.headers['content-type'] === 'application/octet-stream';
    const message = JSON.parse(raw ? Buffer.from(request.headers['x-call'], 'base64url').toString() : body.toString());
    const { address, method, input } = message.params.arguments;
    if (address !== '@tools' || method !== 'tools:run' || input.tool !== FILES) return send(400, { error: 'not a files call' });
    const { name, arguments: args } = input.call;
    calls.push({ name, raw, bytes: raw ? body.length : 0, offset: args.offset });
    if (name === 'write_file_start') {
      const open = uploads.get(args.upload_id) ?? { name: args.name, length: args.byte_length, parts: [] };
      uploads.set(args.upload_id, open);
      return answer({ upload_id: args.upload_id, next_offset: open.parts.reduce((sum, part) => sum + part.length, 0) });
    }
    const open = uploads.get(args.upload_id);
    if (name === 'write_file_piece') {
      if (!raw) return answer({ code: 'not_raw', outcome: 'not_started' }, true);
      if (refuse) return answer({ code: 'upload_refused', outcome: 'not_started' }, true);
      pieces += 1;
      const at = open.parts.reduce((sum, part) => sum + part.length, 0);
      if (args.offset !== at) return answer({ code: 'offset_not_next', outcome: 'not_started' }, true);
      const failing = fail[pieces];
      if (failing?.kept) open.parts.push(body);
      if (failing) return send(failing.status, { error: 'busy' });
      open.parts.push(body);
      return answer({ next_offset: at + body.length });
    }
    if (name === 'write_file_finish') {
      const bytes = Buffer.concat(open.parts);
      if (bytes.length !== open.length) return answer({ code: 'length_mismatch', outcome: 'not_started' }, true);
      const identity = makeHashCodeHexFromBytes(bytes);
      files.set(identity, bytes);
      return answer({ state: 'finished', identity, byte_length: bytes.length, name: open.name });
    }
    return send(400, { error: 'no' });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { url, calls, files, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

const routeOf = door => ({ url: door.url, capability: CAPABILITY, filesTool: FILES, wait: async () => {} });

test('a large file goes in raw pieces under one upload, and the door keeps the same bytes under the same identity', async () => {
  const door = await startFakeDoor();
  try {
    const bytes = bytesOf(5 * 1024 + 123);
    const sent = await keepInRawPieces(routeOf(door), '/films/a.mov', bufferSource(bytes), { pieceBytes: 1024 });
    assert.equal(sent.state, 'finished');
    assert.equal(sent.identity, makeHashCodeHexFromBytes(bytes));
    assert.deepEqual([...door.files.get(sent.identity)], [...bytes]);
    assert.deepEqual(door.calls.map(call => call.name), ['write_file_start', ...Array(6).fill('write_file_piece'), 'write_file_finish']);
    assert.ok(door.calls.every(call => call.raw === (call.name === 'write_file_piece')), 'only the pieces are raw bodies');
    assert.ok(door.calls.every(call => call.bytes <= 1024));
  } finally { await door.close(); }
});

test('the piece size is the engine\'s most bytes for one raw body', () => {
  assert.equal(RAW_PIECES.piece_bytes, 32 * 1024 * 1024);
  assert.ok(LARGE_FILE.threshold_bytes <= RAW_PIECES.piece_bytes);
});

test('a piece whose outcome is unknown is never guessed at: the upload goes on from where its start says it stands', async () => {
  // The third piece is kept but answered busy, the fifth is lost and answered busy: each is followed by a start again.
  const door = await startFakeDoor({ fail: { 3: { status: 503, kept: true }, 5: { status: 503 } } });
  try {
    const bytes = bytesOf(6 * 1000);
    const sent = await keepInRawPieces(routeOf(door), '/b.bin', bufferSource(bytes), { pieceBytes: 1000 });
    assert.equal(sent.identity, makeHashCodeHexFromBytes(bytes));
    assert.deepEqual([...door.files.get(sent.identity)], [...bytes], 'no piece was written twice and none was skipped');
    assert.equal(door.calls.filter(call => call.name === 'write_file_start').length, 3);
  } finally { await door.close(); }
});

test('a refused piece ends the upload with the files tool\'s own code, and nothing is finished', async () => {
  const door = await startFakeDoor({ refuse: true });
  try {
    await assert.rejects(keepInRawPieces(routeOf(door), '/c.bin', bufferSource(bytesOf(3000)), { pieceBytes: 1000 }),
      error => error.code === 'upload_refused' && error.outcome === 'not_started');
    assert.equal(door.files.size, 0);
    assert.equal(door.calls.filter(call => call.name === 'write_file_piece').length, 1, 'a refusal is not sent again');
  } finally { await door.close(); }
});

test('a door that stays busy fails after most_tries, with its code', async () => {
  const fail = Object.fromEntries(Array.from({ length: RAW_PIECES.most_tries + 2 }, (_, at) => [at + 1, { status: 429 }]));
  const door = await startFakeDoor({ fail });
  try {
    await assert.rejects(keepInRawPieces(routeOf(door), '/d.bin', bufferSource(bytesOf(2000)), { pieceBytes: 1000 }), error => error.code === 'http_429');
    assert.equal(door.files.size, 0);
  } finally { await door.close(); }
});

test('writeWholeFile sends a file above the threshold in raw pieces and a smaller one in base64 pieces', async () => {
  const door = await startFakeDoor();
  try {
    const direct = { writeLarge: (name, source, options) => writeLargeFile({ url: door.url, capability: CAPABILITY, filesResource: FILES }, name, source, options) };
    const big = bytesOf(LARGE_FILE.threshold_bytes + 1);
    const kept = await writeWholeFile(direct, '/big.bin', big);
    assert.equal(kept.identity, makeHashCodeHexFromBytes(big));
    assert.equal(door.calls.filter(call => call.raw).length, 1, 'one raw piece holds 16 MiB and a byte');

    const pieces = [];
    const piecesDoor = { files: async (method) => { pieces.push(method); return { next_offset: 0 }; } };
    await writeWholeFile(piecesDoor, '/small.bin', bytesOf(1000));
    assert.deepEqual(pieces, ['write_file_start', 'write_file_piece', 'write_file_finish']);
  } finally { await door.close(); }
});

test('a door with no raw-piece road refuses a large file with its reason, and sends nothing', async () => {
  const sent = [];
  const door = { files: async (method) => { sent.push(method); return {}; } };
  await assert.rejects(writeWholeFile(door, '/big.bin', bytesOf(LARGE_FILE.threshold_bytes + 1)), error => error.code === 'large_file_route_unavailable');
  assert.deepEqual(sent, []);
});

test('a run with no files right is refused before anything is sent', async () => {
  await assert.rejects(writeLargeFile({ url: 'http://127.0.0.1:9/mcp', capability: CAPABILITY }, '/x.bin', bufferSource(bytesOf(10))),
    error => error.code === 'no_files' && error.outcome === 'not_started');
});

test('keepLocalFile sends a large file from disk a raw piece at a time', async () => {
  const door = await startFakeDoor();
  const dir = tempFolder(join(tmpdir(), 'lf-disk-'));
  try {
    const big = bytesOf(LARGE_FILE.threshold_bytes + 77);
    const path = join(dir, 'big.bin');
    writeFileSync(path, big);
    const direct = { writeLarge: (name, source, options) => writeLargeFile({ url: door.url, capability: CAPABILITY, filesResource: FILES }, name, source, options) };
    const kept = await keepLocalFile(direct, '/disk.bin', path);
    assert.equal(kept.identity, makeHashCodeHexFromBytes(big));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await door.close();
  }
});

test('a records door built from its descriptor keeps a large file through its own files right', async () => {
  const door = await startFakeDoor();
  const dir = tempFolder(join(tmpdir(), 'lf-door-'));
  try {
    const descriptor = join(dir, 'fd3.json');
    writeFileSync(descriptor, JSON.stringify({ url: door.url, capability: CAPABILITY, files_resource: FILES, tools_resource: '@tools' }));
    const opened = openRecordsDoor({ descriptor });
    const bytes = bytesOf(3000);
    const sent = await opened.writeLarge('/door.bin', bufferSource(bytes));
    assert.equal(sent.identity, makeHashCodeHexFromBytes(bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await door.close();
  }
});

test('a file source reads any range exactly', async () => {
  const dir = tempFolder(join(tmpdir(), 'lf-src-'));
  const path = join(dir, 'x.bin');
  const bytes = bytesOf(10_000);
  writeFileSync(path, bytes);
  const source = await fileSource(path);
  try {
    assert.equal(source.size, 10_000);
    assert.deepEqual([...await source.readAt(4096, 100)], [...bytes.subarray(4096, 4196)]);
  } finally {
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
