// Consumer controls for protected original-result recovery. Synthetic transport only;
// these do not claim that a native launch or an account-files effect supports recovery.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRecordsDoor, recordsDoorFromCall, RecordsDoorError } from '../read-data/records-door.mjs';

const reply = result => new Response(JSON.stringify({ result }), { headers: { 'content-type': 'application/json' } });
const unknown = () => reply({ isError: true, structuredContent: { code: 'original_command_unknown', outcome: 'unknown' } });

async function withDoor(fetchImpl, check) {
  const folder = tempFolder(join(tmpdir(), 'original-result-door-'));
  const descriptor = join(folder, 'descriptor.json');
  writeFileSync(descriptor, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', resource: '@synthetic-records',
    files_resource: '@synthetic-files', capability: 'synthetic-private-capability' }));
  try { await check(openRecordsDoor({ descriptor, fetchImpl, wait: async () => {} })); }
  finally { rmSync(folder, { recursive: true, force: true }); }
}

test('an unknown mutation outcome stops after its first effect attempt', async () => {
  for (const invoke of [
    door => door.write([{ id: 'synthetic:one', type: 'synthetic', value: { words: 'once' } }], { key: 'original-write' }),
    door => door.files('set_aside', { name: '/synthetic/one' }, { key: 'original-file-effect' }),
  ]) {
    let attempts = 0;
    await withDoor(async () => { attempts++; return unknown(); }, async door => {
      await assert.rejects(invoke(door), error => error instanceof RecordsDoorError && error.outcome === 'unknown');
      assert.equal(attempts, 1, 'unknown does not mean the effect is safe to repeat');
    });
  }
});

test('a busy owner that proves not-started may be asked again with the unchanged command', async () => {
  const sent = [];
  await withDoor(async (_url, options) => {
    sent.push(JSON.parse(options.body).params.arguments);
    return sent.length === 1
      ? reply({ isError: true, structuredContent: { code: 'selected_owner_unavailable', outcome: 'not_started' } })
      : reply({ structuredContent: { changed: 1 } });
  }, async door => {
    assert.deepEqual(await door.write([{ id: 'synthetic:two', type: 'synthetic', value: {} }], { key: 'not-started' }), { changed: 1 });
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
});

test('busy with an unknown outcome cannot use the not-started retry path', async () => {
  let attempts = 0;
  await withDoor(async () => { attempts++; return reply({ isError: true,
    structuredContent: { code: 'selected_owner_unavailable', outcome: 'unknown' } }); }, async door => {
    await assert.rejects(door.write([{ id: 'synthetic:three', type: 'synthetic', value: {} }], { key: 'busy-unknown' }),
      error => error.outcome === 'unknown');
    assert.equal(attempts, 1);
  });
});

test('explicit recovery carries the original command unchanged under a separate delivery key', async () => {
  const sent = [];
  const original = { request_key: 'the-original-key', operation: 'records:write', input: { records: [
    { id: 'synthetic:pending', type: 'synthetic', value: { at: 'immutable-time' }, expected: { type: 'synthetic', identity: 'opaque-root-token' } },
  ] } };
  const receipt = { changed: 1, write_count: 1 };
  const door = recordsDoorFromCall(async (method, input, key, address, safeRead) => {
    sent.push({ method, input, key, address, safeRead });
    return receipt;
  }, { resource: '@synthetic-records' });
  assert.equal(typeof door.result, 'function', 'the shared client exposes protected result reads');
  assert.deepEqual(await door.result(original, { key: 'new-result-delivery' }), receipt);
  assert.deepEqual(sent, [{ method: 'records:result', input: original, key: 'new-result-delivery',
    address: '@synthetic-records', safeRead: true }]);
});

test('missing or erased originals remain unknown and recovery never falls back to a write', async () => {
  const sent = [];
  const door = recordsDoorFromCall(async (method, input, key) => {
    sent.push({ method, input, key });
    throw new RecordsDoorError('original_result_unavailable', 'The protected original is unavailable.', 'unknown');
  }, { resource: '@synthetic-records' });
  assert.equal(typeof door.result, 'function');
  const original = { request_key: 'lost-original', operation: 'records:write', input: { records: [
    { id: 'synthetic:lost', type: 'synthetic', value: {} },
  ] } };
  await assert.rejects(door.result(original, { key: 'read-only-delivery' }),
    { code: 'original_result_unavailable', outcome: 'unknown' });
  assert.deepEqual(sent.map(call => call.method), ['records:result']);
});

test('HTTP 503 and broken mutation delivery stay unknown without an automatic repeat', async () => {
  for (const answer of [
    () => new Response(null, { status: 503 }),
    () => { throw new TypeError('synthetic-private-capability socket lost'); },
    () => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw new TypeError('synthetic-private-capability body lost'); } }),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{"result":{}}', { headers: { 'content-type': 'application/json' } }),
  ]) {
    let attempts = 0;
    await withDoor(async () => { attempts++; return answer(); }, async door => {
      await assert.rejects(door.write([{ id: 'synthetic:ambiguous', type: 'synthetic', value: {} }], { key: 'same-original' }), error => {
        assert.equal(error.outcome, 'unknown');
        assert.doesNotMatch(error.message, /synthetic-private-capability/);
        return true;
      });
      assert.equal(attempts, 1);
    });
  }
});

test('file effects preserve the explicit original key and body and never infer a replacement key', async () => {
  const sent = [];
  await withDoor(async (_url, options) => {
    sent.push(JSON.parse(options.body).params.arguments);
    return unknown();
  }, async door => {
    await assert.rejects(door.files('set_aside', { name: '/synthetic/exact', limit: 1 }, { key: 'file-original-key' }),
      error => error.outcome === 'unknown');
  });
  assert.deepEqual(sent, [{ address: '@synthetic-files', method: 'set_aside', request_key: 'file-original-key',
    input: { name: '/synthetic/exact', limit: 1 } }]);
});

test('explicit original-result transport retries are read-only and retain both identities', async () => {
  const sent = [];
  const original = { request_key: 'effect-original-key', operation: 'records:write', input: { records: [
    { id: 'synthetic:exact-body', type: 'synthetic', value: { original: true }, expected: null },
  ] } };
  await withDoor(async (_url, options) => {
    sent.push(JSON.parse(options.body).params.arguments);
    if (sent.length === 1) throw new TypeError('read socket lost');
    return reply({ structuredContent: { changed: 1 } });
  }, async door => {
    assert.deepEqual(await door.result(original, { key: 'separate-read-delivery' }), { changed: 1 });
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.deepEqual(sent[0], { address: '@synthetic-records', method: 'records:result',
    request_key: 'separate-read-delivery', input: original });
});
