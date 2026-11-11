import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { fileSource } from '../../browse-and-upload-my-files/do-work/send-a-file-to-a-namespace.mjs';
import { bufferSource, keepLocalFile, LARGE_FILE, writeWholeFile } from '../read-data/whole-file.mjs';
import { openRecordsDoor, writeLargeFile } from '../read-data/records-door.mjs';

const CAPABILITY = 'run_synthetic_capability';

// Distinct bytes everywhere (a periodic pattern would repeat chunks, which the engine keeps once).
const bytesOf = (length, seed = 0x9e3779b9) => {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; out[i] = state & 0xff; }
  return out;
};

// A stand-in for the engine's lease and growing routes (src/mcp/carried/bytes.rs), with the same checks: the capability
// mints a lease; the growing routes take only a lease; a chunk is named by its BLAKE3 and must be described first; the
// finish names the whole file's BLAKE3 and is refused when it differs. `refuseFinish` makes every finish refused.
async function startFakeEngine({ refuseFinish = false } = {}) {
  const leases = new Set();
  const uploads = new Map();
  const files = new Map();
  const calls = [];
  let count = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
    const path = request.url;
    calls.push({ method: request.method, path, token });
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(value === undefined ? '' : JSON.stringify(value)); };
    if (request.method === 'POST' && path === '/mcp/api/namespace/leases') {
      if (token !== CAPABILITY) return send(401, { error: 'no' });
      const lease = `run_lease_${(count += 1)}`;
      leases.add(lease);
      return send(200, { lease, scope: 'write', identity: null, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (!leases.has(token)) return send(401, { error: 'lease gone' });
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    if (request.method === 'POST' && parts.length === 2 && parts[0] === 'namespace' && parts[1] === 'growing') {
      const input = JSON.parse(body);
      const growing = `up:${(count += 1).toString(16).padStart(32, '0')}`;
      uploads.set(growing, { name: input.name, spans: new Map(), stored: new Map() });
      return send(200, { growing, state: 'open', name: input.name, byte_length: input.byte_length });
    }
    const upload = uploads.get(parts[2]);
    if (!upload) return send(404, { error: 'not growing' });
    if (request.method === 'POST' && parts[3] === 'spans') {
      const { spans } = JSON.parse(body);
      const needed = [];
      for (const span of spans) {
        upload.spans.set(span.ordinal, span);
        if (!upload.stored.has(span.chunk)) needed.push(span.ordinal);
      }
      return send(200, { needed });
    }
    if (request.method === 'GET' && parts[3] === 'demands') return send(200, { ordinals: [] });
    if (request.method === 'PUT' && parts[3] === 'chunks') {
      const chunk = parts[4];
      if (chunk !== makeHashCodeHexFromBytes(body)) return send(400, { error: 'chunk bytes do not match their name' });
      if (![...upload.spans.values()].some(span => span.chunk === chunk)) return send(409, { error: 'chunk not described' });
      upload.stored.set(chunk, body);
      return send(200, { stored: true });
    }
    if (request.method === 'POST' && parts[3] === 'finish') {
      const input = JSON.parse(body);
      const ordered = [...upload.spans.values()].sort((a, b) => a.ordinal - b.ordinal);
      const bytes = Buffer.concat(ordered.map(span => upload.stored.get(span.chunk)));
      const actual = makeHashCodeHexFromBytes(bytes);
      if (refuseFinish || input.identity !== actual) return send(409, { error: 'identity mismatch' });
      files.set(actual, bytes);
      return send(200, { state: 'present', file: { identity: actual, byte_length: bytes.length, names: [upload.name] } });
    }
    return send(405, { error: 'no' });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, calls, files, close: () => new Promise(done => { server.closeAllConnections(); server.close(done); }) };
}

test('a large file goes over the lease road, and the engine keeps the same bytes under the same identity', async () => {
  const engine = await startFakeEngine();
  try {
    const bytes = bytesOf(20 * 1024 * 1024 + 123);
    const sent = await writeLargeFile({ origin: engine.origin, capability: CAPABILITY }, '/films/a.mov', bufferSource(bytes));
    assert.equal(sent.state, 'uploaded');
    assert.equal(sent.identity, makeHashCodeHexFromBytes(bytes));
    assert.equal(sent.byte_length, bytes.length);
    assert.deepEqual([...engine.files.get(sent.identity)], [...bytes]);
    assert.ok(sent.chunks >= 2, `split into ${sent.chunks} chunks`);
    assert.ok(engine.calls.filter(call => call.path.startsWith('/mcp/')).every(call => call.token === CAPABILITY), 'only the lease mint takes the capability');
    assert.ok(engine.calls.filter(call => call.path.startsWith('/namespace/')).every(call => call.token.startsWith('run_lease_')), 'the growing route takes only a lease');
  } finally { await engine.close(); }
});

test('a refused finish is an error, not a written file', async () => {
  const engine = await startFakeEngine({ refuseFinish: true });
  try {
    await assert.rejects(writeLargeFile({ origin: engine.origin, capability: CAPABILITY }, '/a.bin', bufferSource(bytesOf(5000))));
    assert.equal(engine.files.size, 0);
  } finally { await engine.close(); }
});

test('writeWholeFile sends a file above the threshold over the lease road and a smaller one in pieces', async () => {
  const engine = await startFakeEngine();
  try {
    const direct = { writeLarge: (name, source, options) => writeLargeFile({ origin: engine.origin, capability: CAPABILITY }, name, source, options) };
    const big = bytesOf(LARGE_FILE.threshold_bytes + 1);
    const kept = await writeWholeFile(direct, '/big.bin', big);
    assert.equal(kept.identity, makeHashCodeHexFromBytes(big));

    const pieces = [];
    const piecesDoor = { files: async (method, input) => { pieces.push(method); return { next_offset: 0 }; } };
    await writeWholeFile(piecesDoor, '/small.bin', bytesOf(1000));
    assert.deepEqual(pieces, ['write_file_start', 'write_file_piece', 'write_file_finish']);
  } finally { await engine.close(); }
});

test('a door with no lease road refuses a large file with its reason, and sends nothing', async () => {
  const sent = [];
  const door = { files: async (method) => { sent.push(method); return {}; } };
  await assert.rejects(writeWholeFile(door, '/big.bin', bytesOf(LARGE_FILE.threshold_bytes + 1)), error => error.code === 'large_file_route_unavailable');
  assert.deepEqual(sent, []);
});

test('keepLocalFile sends a large file from disk over the lease road', async () => {
  const engine = await startFakeEngine();
  const dir = mkdtempSync(join(tmpdir(), 'lf-disk-'));
  try {
    const big = bytesOf(LARGE_FILE.threshold_bytes + 77);
    const path = join(dir, 'big.bin');
    writeFileSync(path, big);
    const direct = { writeLarge: (name, source, options) => writeLargeFile({ origin: engine.origin, capability: CAPABILITY }, name, source, options) };
    const kept = await keepLocalFile(direct, '/disk.bin', path);
    assert.equal(kept.identity, makeHashCodeHexFromBytes(big));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await engine.close();
  }
});

test('a records door built from its descriptor carries the lease road at its own origin', async () => {
  const engine = await startFakeEngine();
  const dir = mkdtempSync(join(tmpdir(), 'lf-door-'));
  try {
    const descriptor = join(dir, 'fd3.json');
    writeFileSync(descriptor, JSON.stringify({ url: `${engine.origin}/mcp`, resource: '@own-records', capability: CAPABILITY, files_resource: '@own-files' }));
    const door = openRecordsDoor({ descriptor });
    const bytes = bytesOf(3000);
    const sent = await door.writeLarge('/door.bin', bufferSource(bytes));
    assert.equal(sent.identity, makeHashCodeHexFromBytes(bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await engine.close();
  }
});

test('a file source reads any range exactly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lf-src-'));
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
