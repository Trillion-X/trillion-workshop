// tools/workflows/read-data/host-actions.mjs: the run's host actions, through a fake native side on the descriptor route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHostActions } from '../read-data/host-actions.mjs';

const noWait = async () => {};
function descriptorWith(extra = {}) {
  const descriptor = join(mkdtempSync(join(tmpdir(), 'host-actions-')), 'descriptor.json');
  writeFileSync(descriptor, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', resource: '@own-records',
    capability: 'synthetic-private-bearer', computer_actions: { resource: '@synthetic-parent', trash_source: 'synthetic:trash' }, ...extra }));
  return descriptor;
}
const sourceObservation = { path: '/synthetic/source', expected_generation: '[["","1","2"]]' };
const parentResult = value => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: value }),
  { headers: { 'content-type': 'application/json' } });

test('the Trash move uses the descriptor route and exact observation through the MCP transport, once', async () => {
  const calls = [];
  const host = openHostActions({ descriptor: descriptorWith(), wait: noWait, fetchImpl: async (url, options) => {
    calls.push({ url, ...options, body: JSON.parse(options.body) });
    return new Response('event: message\ndata: ' + JSON.stringify({ result: { structuredContent: { outcome: 'moved' } } }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  assert.deepEqual(await host.parentActions.trashSource(sourceObservation), { outcome: 'moved' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, 'Bearer synthetic-private-bearer');
  assert.equal(calls[0].headers['mcp-protocol-version'], '2025-06-18');
  assert.deepEqual(calls[0].body.params.arguments, { address: '@synthetic-parent', method: 'synthetic:trash',
    request_key: calls[0].body.params.arguments.request_key, input: sourceObservation });
  assert.match(calls[0].body.params.arguments.request_key, /^action:/);
});

test('the Trash move never repeats busy, unknown, lost, malformed or paged answers and never echoes private errors', async () => {
  const answers = [
    () => new Response(null, { status: 503 }),
    () => parentResult({ isError: true, structuredContent: { code: 'selected_owner_unavailable', outcome: 'not_started' } }),
    () => parentResult({ isError: true, structuredContent: { code: 'computer_action_unknown', outcome: 'unknown' } }),
    () => { throw new TypeError('synthetic-private-bearer transport lost'); },
    () => ({ ok: true, headers: new Headers(), text: async () => { throw new TypeError('synthetic-private-bearer body lost'); } }),
    () => new Response('synthetic-private-bearer invalid JSON'),
    () => new Response(JSON.stringify({ error: { message: 'synthetic-private-bearer RPC error' } })),
    () => parentResult({ structuredContent: { byte_page: { next_after_byte: 1 } } }),
    () => parentResult({ structuredContent: { outcome: 'refused' } }),
  ];
  for (const answer of answers) {
    let calls = 0, waits = 0;
    const host = openHostActions({ descriptor: descriptorWith(), fetchImpl: async () => { calls++; return answer(); },
      wait: async () => { waits++; } });
    await assert.rejects(host.parentActions.trashSource(sourceObservation), error => {
      assert.equal(error.outcome, 'unknown');
      assert.doesNotMatch(error.message, /synthetic-private-bearer/);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(waits, 0);
  }
});

test('Trash refusals before any effect stay distinct from uncertain effects; a missing route and forged input are refused before a call', async () => {
  for (const code of ['computer_action_refused', 'current_workspace_rights_refused', 'original_input_refused']) {
    const host = openHostActions({ descriptor: descriptorWith(), wait: noWait, fetchImpl: async () =>
      parentResult({ isError: true, structuredContent: { code, outcome: 'not_started' } }) });
    await assert.rejects(host.parentActions.trashSource(sourceObservation), { code, outcome: 'not_started' });
  }
  const gone = openHostActions({ descriptor: descriptorWith(), wait: noWait, fetchImpl: async () => new Response(null, { status: 401 }) });
  await assert.rejects(gone.parentActions.trashSource(sourceObservation), { code: 'capability_gone', outcome: 'not_started' });
  const unrouted = openHostActions({ descriptor: descriptorWith({ computer_actions: null }), wait: noWait, fetchImpl: async () => { throw new Error('no call expected'); } });
  await assert.rejects(unrouted.parentActions.trashSource(sourceObservation), { code: 'no_parent_actions', outcome: 'not_started' });
  let calls = 0;
  const host = openHostActions({ descriptor: descriptorWith(), wait: noWait, fetchImpl: async () => { calls++; } });
  for (const input of [null, {}, { ...sourceObservation, resource: '@forged' }, { ...sourceObservation, grant: 'forged' },
    { ...sourceObservation, path: 'relative/source' }, { ...sourceObservation, expected_generation: '' }]) {
    await assert.rejects(host.parentActions.trashSource(input), { code: 'original_input_refused', outcome: 'not_started' });
  }
  assert.equal(calls, 0);
});

test('nothing is read until a host action is used, and a missing descriptor is refused as not handed its host actions', async () => {
  const host = openHostActions({ descriptor: join(tmpdir(), 'host-actions-missing-descriptor.json') });
  assert.equal(typeof host.readWholeFile, 'function');
  await assert.rejects(host.readWholeFile('notes.txt'), { code: 'no_host_actions', outcome: 'not_started' });
});

test('a whole file is read by name through the files right: find_file, then read_file pages, with a busy answer asked again under the same read', async () => {
  const bytes = Buffer.from('hello, file');
  const waits = [];
  let busy = true;
  const seen = [];
  const host = openHostActions({ descriptor: descriptorWith({ files_resource: '@own-files' }), wait: async ms => { waits.push(ms); },
    fetchImpl: async (url, options) => {
      const { params } = JSON.parse(options.body);
      seen.push(params.arguments);
      if (params.arguments.method === 'find_file' && busy) { busy = false; return parentResult({ isError: true, structuredContent: { code: 'selected_owner_unavailable' } }); }
      if (params.arguments.method === 'find_file') return parentResult({ structuredContent: { names: ['papers/notes.txt'] } });
      const { offset } = params.arguments.input;
      const part = bytes.subarray(offset, offset + 4);
      return parentResult({ structuredContent: { content: part.toString('base64'), encoding: 'base64', bytes_returned: part.length, byte_length: bytes.length } });
    } });
  const read = await host.readWholeFile('notes.txt', { readBytes: 4 });
  assert.deepEqual(read, { title: 'notes.txt', size: bytes.length, bytes });
  assert.equal(seen.filter(call => call.method === 'find_file').length, 2);
  assert.equal(seen.every(call => call.address === '@own-files'), true);
  assert.equal(waits.length, 1);
});

test('a whole file above mostBytes is never read past its first page', async () => {
  const host = openHostActions({ descriptor: descriptorWith({ files_resource: '@own-files' }), wait: noWait, fetchImpl: async (url, options) => {
    const { params } = JSON.parse(options.body);
    if (params.arguments.method === 'find_file') return parentResult({ structuredContent: { names: ['big.bin'] } });
    return parentResult({ structuredContent: { content: 'AAAA', encoding: 'base64', bytes_returned: 4, byte_length: 100 } });
  } });
  assert.deepEqual(await host.readWholeFile('big.bin', { readBytes: 4, mostBytes: 10 }), { title: 'big.bin', size: 100, bytes: null });
});

test('a tool answer sent as byte pages is joined, checked and handed on whole; the later pages reuse the first key', async () => {
  const { blake3 } = await import('@noble/hashes/blake3.js');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  const whole = Buffer.from(JSON.stringify({ tool: 'tool:made-up-list', exit_code: 0, result: { programs: Array.from({ length: 300 }, (_, pid) => ({ pid, name: `p${pid}` })), complete: true } }));
  const hash = bytesToHex(blake3(whole));
  const pageAt = (from, size = 4000) => {
    const end = Math.min(from + size, whole.length);
    return { byte_page: { total: whole.length, blake3: hash, offset: from, length: end - from, base64: whole.subarray(from, end).toString('base64'), next_after_byte: end < whole.length ? end : null } };
  };
  const calls = [];
  const host = openHostActions({ descriptor: descriptorWith(), wait: noWait, fetchImpl: async (url, options) => {
    const args = JSON.parse(options.body).params.arguments;
    calls.push(args);
    return parentResult({ structuredContent: pageAt(args.input.after_byte ?? 0) });
  } });
  const result = await host.run('tool:made-up-list', { most: 300 }, { key: 'step:list' });
  assert.equal(result.programs.length, 300);
  assert.equal(result.complete, true);
  assert.ok(calls.length > 1, 'more than one page was asked');
  assert.ok(calls.every(call => call.request_key === calls[0].request_key), 'every page is asked under the first call\'s key');
  assert.deepEqual(calls.slice(1).map(call => call.input.after_byte), calls.slice(1).map((_, at) => (at + 1) * 4000));
  // A page that does not hash to the whole's BLAKE3 is refused, never handed on.
  const wrong = openHostActions({ descriptor: descriptorWith(), wait: noWait, fetchImpl: async (url, options) => {
    const page = pageAt(JSON.parse(options.body).params.arguments.input.after_byte ?? 0);
    page.byte_page.blake3 = '0'.repeat(64);
    return parentResult({ structuredContent: page });
  } });
  await assert.rejects(wrong.run('tool:made-up-list', {}), error => error.code === 'byte_page_broken');
});
