// Whole records use the native door's protected byte-page contract, through the real HTTP client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openDoor } from '../read-data/door.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { writeAll } from '../read-data/list-view.mjs';

const credential = 'synthetic-reader-bearer';
const identity = '900719925474099312345678901234567890';
const value = { body: '\uFEFF{ "name": "bread 🍞", "literal": "\\u0061" }\n', metadata: { order: [3, 1], exact: true } };
const record = { id: 'library:whole-document', type: 'library', value, identity };

async function fixture(t, { unknownContinuation = false } = {}) {
  const calls = [];
  let originalKey;
  const whole = Buffer.from(JSON.stringify(record));
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; });
    request.on('end', () => {
      const rpc = JSON.parse(text), call = rpc.params.arguments;
      calls.push({ ...call, authorization: request.headers.authorization });
      originalKey ??= call.request_key;
      let result;
      if (call.input.id === 'absent' || call.input.type !== record.type) {
        result = { structuredContent: { id: call.input.id, type: call.input.type, value: null } };
      } else if (call.request_key !== originalKey) {
        result = { isError: true, structuredContent: { code: 'original_input_refused', outcome: 'not_started' } };
      } else if (unknownContinuation && call.input.after_byte !== undefined) {
        result = { isError: true, structuredContent: { code: 'original_workspace_source_unavailable', outcome: 'unknown' } };
      } else {
        const offset = call.input.after_byte ?? 0, part = whole.subarray(offset, offset + 37);
        result = { structuredContent: { byte_page: { total: whole.length, blake3: makeHashCodeHexFromBytes(whole).slice(3),
          offset, length: part.length, base64: part.toString('base64'), next_after_byte: offset + part.length < whole.length ? offset + part.length : null } } };
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const door = await openDoor({
    transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { keychain_item: 'synthetic-reader' } },
    records: { address: '@synthetic-records', read_method: 'records:read', list_method: 'records:list' },
    tools: { address: '@synthetic-tools', run_method: 'tools:run' },
  }, { keyOf: async () => credential });
  return { door, calls };
}

test('a whole record keeps the first key through every byte page and preserves its exact JSON value', async t => {
  const { door, calls } = await fixture(t);
  assert.deepEqual(await door.read('library', record.id), value);
  assert.ok(calls.length > 1);
  assert.equal(new Set(calls.map(call => call.request_key)).size, 1);
  assert.deepEqual(calls.map(call => call.input.after_byte ?? 0), calls.map((_, index) => index * 37));
  assert.ok(calls.every(call => call.method === 'records:read' && call.address === '@synthetic-records'
    && call.input.type === 'library' && call.input.id === record.id && call.authorization === `Bearer ${credential}`));
  assert.ok(calls.every(call => !JSON.stringify({ ...call, authorization: undefined }).includes(credential)));
});

test('readRecord preserves native type, exact value and opaque identity while read stays value-only', async t => {
  const { door } = await fixture(t);
  assert.deepEqual(await door.readRecord('library', record.id), { type: record.type, value, identity });
  assert.equal(await door.readRecord('library', 'absent'), null);
  assert.equal(await door.readRecord('other-kind', record.id), null);
});

test('an unknown continuation retries only its original tuple then preserves the unknown error', async t => {
  const { door, calls } = await fixture(t, { unknownContinuation: true });
  await assert.rejects(door.read('library', record.id), { code: 'original_workspace_source_unavailable', outcome: 'unknown' });
  assert.equal(calls.length, 7, 'one first page and the existing six attempts of the same continuation');
  assert.equal(new Set(calls.map(call => call.request_key)).size, 1);
  assert.deepEqual(calls[1].input, { type: 'library', id: record.id, after_byte: 37 });
  assert.ok(calls.slice(1).every(call => JSON.stringify(call.input) === JSON.stringify(calls[1].input)));
});

test('a list write never repeats an effect whose first result is unknown', async t => {
  const calls = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      calls.push(JSON.parse(body).params.arguments);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: calls.length === 1
        ? { isError: true, structuredContent: { code: 'selected_owner_unavailable', outcome: 'unknown' } }
        : { structuredContent: { changed: 1, write_count: 1 } } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const door = await openDoor({ transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { keychain_item: 'synthetic' } },
    records: { address: '@synthetic-records', read_method: 'records:read', list_method: 'records:list', write_method: 'records:write' },
    tools: { address: '@synthetic-tools', run_method: 'tools:run' } }, { keyOf: async () => credential });
  const rows = [{ id: 'synthetic:row', type: 'synthetic', value: { label: 'Bread' } }];
  await assert.rejects(door.write(rows, { key: 'synthetic-original-write' }), { code: 'selected_owner_unavailable', outcome: 'unknown' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { address: '@synthetic-records', method: 'records:write', request_key: 'synthetic-original-write', input: { records: rows } });
});

test('a list write retries only an explicitly not-started busy reply with unchanged serialized input', async t => {
  const bodies = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      bodies.push(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ result: bodies.length === 1
        ? { isError: true, structuredContent: { code: 'selected_owner_unavailable', outcome: 'not_started' } }
        : { structuredContent: { changed: 1, write_count: 1 } } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const door = await openDoor({ transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { keychain_item: 'synthetic' } },
    records: { address: '@synthetic-records', read_method: 'records:read', list_method: 'records:list', write_method: 'records:write' },
    tools: { address: '@synthetic-tools', run_method: 'tools:run' } }, { keyOf: async () => credential });
  assert.deepEqual(await door.write([{ id: 'synthetic:row', type: 'synthetic', value: {} }], { key: 'original' }), { changed: 1, write_count: 1 });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test('HTTP 503 never repeats a list write', async t => {
  let calls = 0;
  const server = createServer((_request, response) => { calls++; response.writeHead(503); response.end(); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const door = await openDoor({ transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { keychain_item: 'synthetic' } },
    records: { address: '@synthetic-records', read_method: 'records:read', list_method: 'records:list', write_method: 'records:write' },
    tools: { address: '@synthetic-tools', run_method: 'tools:run' } }, { keyOf: async () => credential });
  await assert.rejects(door.write([], { key: 'original' }), { code: 'http_503', outcome: 'unknown' });
  assert.equal(calls, 1);
});

test('missing or malformed refusal outcomes cannot split an ambiguous list write into fresh effects', async t => {
  for (const outcome of [undefined, null, 'invalid', false]) {
    const calls = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        calls.push(JSON.parse(body).params.arguments);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ result: { isError: true,
          structuredContent: { code: 'original_input_refused', ...(outcome === undefined ? {} : { outcome }) } } }));
      });
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    try {
      const door = await openDoor({ transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { keychain_item: 'synthetic' } },
        records: { address: '@synthetic-records', read_method: 'records:read', list_method: 'records:list', write_method: 'records:write' },
        tools: { address: '@synthetic-tools', run_method: 'tools:run' } }, { keyOf: async () => credential });
      const rows = [{ id: 'synthetic:a', type: 'synthetic', value: {} }, { id: 'synthetic:b', type: 'synthetic', value: {} }];
      await assert.rejects(writeAll(door, rows, 'original'), { code: 'original_input_refused', outcome: 'unknown' });
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].input.records, rows);
      assert.equal(calls[0].request_key, 'original:0');
    } finally { await new Promise(done => server.close(done)); }
  }
});

test('the CLI caller deadline ends stalled headers or body without repeating its request', async t => {
  for (const stage of ['headers', 'body']) {
    const folder = await mkdtemp(join(tmpdir(), 'list-reader-deadline-'));
    let calls = 0;
    const server = createServer((_request, response) => {
      calls++;
      if (stage === 'body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{');
      }
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    try {
      const keyFile = join(folder, 'synthetic-key');
      await writeFile(keyFile, credential);
      const config = join(folder, 'config.json');
      await writeFile(config, JSON.stringify({ transport: { url: `http://127.0.0.1:${server.address().port}/mcp`, credential: { key_file: keyFile } },
        records: { address: '@synthetic-records', read_method: 'records:read', list_method: 'records:list' },
        tools: { address: '@synthetic-tools', run_method: 'tools:run' },
        names: { list_type: 'list', list_record: 'list:{list_id}', row_type: 'record:{row_type}' } }));
      await assert.rejects(promisify(execFile)(process.execPath, [new URL('../do-work/read-list-view.mjs', import.meta.url).pathname,
        '--config', config, '--list', 'synthetic', '--deadline-ms', String(Date.now() + 400)], { timeout: 5000 }), error => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /outcome=unknown/);
        assert.doesNotMatch(error.stderr, /synthetic-reader-bearer/);
        return true;
      });
      assert.equal(calls, 1, stage);
    } finally {
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      await rm(folder, { recursive: true, force: true });
    }
  }
});

test('expired and malformed CLI deadlines stop before reading config or sending a request', async () => {
  const cli = new URL('../do-work/read-list-view.mjs', import.meta.url).pathname;
  for (const tail of [['--deadline-ms', String(Date.now() - 100)], ['--deadline-ms', 'not-a-number'],
    ['--deadline-ms', '1.5'], ['--deadline-ms'], ['--deadline-ms=1'],
    ['--deadline-ms', '123', '--deadline-ms', '456']]) {
    await assert.rejects(promisify(execFile)(process.execPath, [cli, '--config', '/synthetic/nonexistent-config', '--list', 'synthetic', ...tail]), error => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /outcome=not_started/);
      assert.doesNotMatch(error.stderr, /ENOENT/);
      return true;
    });
  }
});
