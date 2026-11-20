// tools/workflows/read-data/host-actions.mjs: a run's nested tool runs (host.run), its files operations (host.files) and the
// whole-file reads and writes they make, through a fake native side on the descriptor route.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHostActions, resultOfRun } from '../read-data/host-actions.mjs';
import { writeWholeFile, LARGE_FILE } from '../read-data/whole-file.mjs';

const noWait = async () => {};
function descriptorWith(extra = {}) {
  const descriptor = join(tempFolder(join(tmpdir(), 'host-run-')), 'descriptor.json');
  writeFileSync(descriptor, JSON.stringify({ url: 'http://127.0.0.1:1/mcp', capability: 'synthetic-private-bearer', ...extra }));
  return descriptor;
}
// The fake native side answers each call from `answer(arguments)` and records every call it was sent.
function nativeSide(answer) {
  const sent = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push({ url, headers: options.headers, arguments: body.params.arguments });
    const result = await answer(body.params.arguments);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } });
  };
  return { sent, fetchImpl };
}

test('resultOfRun hands back a finished run result, throws a failed run, and passes an answer with neither field through', () => {
  assert.deepEqual(resultOfRun('tool:x', { tool: 'tool:x', exit_code: 0, result: { n: 1 }, replayed: false }), { n: 1 });
  assert.deepEqual(resultOfRun('tool:x', { state: 'open' }), { state: 'open' });
  assert.throws(() => resultOfRun('tool:x', { tool: 'tool:x', exit_code: 1, error: 'said', cause: 'process_exit_unsuccessful' }),
    { code: 'tool_run_failed', outcome: 'committed' });
});

test('host.run sends tools:run to the descriptor tools address with the given key, answers the result, and asks once', async () => {
  const side = nativeSide(() => ({ structuredContent: { tool: 'tool:list-connections', exit_code: 0, result: { connected: [] }, replayed: false } }));
  const host = openHostActions({ descriptor: descriptorWith({ tools_resource: '@synthetic-tools' }), wait: noWait, fetchImpl: side.fetchImpl });
  assert.deepEqual(await host.run('tool:list-connections', { now: 'x' }, { key: 'list-connections' }), { connected: [] });
  assert.equal(side.sent.length, 1);
  assert.deepEqual(side.sent[0].arguments, { address: '@synthetic-tools', method: 'tools:run',
    request_key: 'list-connections', input: { tool: 'tool:list-connections', input: { now: 'x' } } });
  assert.equal(side.sent[0].headers.authorization, 'Bearer synthetic-private-bearer');
});

test('host.run defaults to the Workshop tools address and a fresh key, and a failed run throws without its engine words', async () => {
  const side = nativeSide(() => ({ structuredContent: { tool: 'tool:x', exit_code: 1, error: 'synthetic-private-bearer said', cause: 'process_exit_unsuccessful' } }));
  const host = openHostActions({ descriptor: descriptorWith(), wait: noWait, fetchImpl: side.fetchImpl });
  await assert.rejects(host.run('tool:x'), error => {
    assert.equal(error.code, 'tool_run_failed');
    assert.equal(error.outcome, 'committed');
    return true;
  });
  assert.equal(side.sent[0].arguments.address, '@tools');
  assert.match(side.sent[0].arguments.request_key, /^tools:run:/);
});

test('a key longer than the engine bound is sent as its own identity, the same for the same key', async () => {
  const long = 'k'.repeat(300);
  const side = nativeSide(() => ({ structuredContent: { result: 1 } }));
  const host = openHostActions({ descriptor: descriptorWith(), wait: noWait, fetchImpl: side.fetchImpl });
  await host.run('tool:x', {}, { key: long });
  await host.run('tool:x', {}, { key: long });
  assert.match(side.sent[0].arguments.request_key, /^key:/);
  assert.ok(Buffer.byteLength(side.sent[0].arguments.request_key) <= 255);
  assert.equal(side.sent[0].arguments.request_key, side.sent[1].arguments.request_key);
});

test('host.files needs the files right and sends each files operation as one call of the Files tool; a read reads the whole file page by page', async () => {
  const bare = openHostActions({ descriptor: descriptorWith(), wait: noWait, fetchImpl: async () => { throw new Error('no call expected'); } });
  await assert.rejects(bare.files('list_files', {}), { code: 'no_files', outcome: 'not_started' });

  const pages = { find_file: { names: ['/notes/a.txt'] }, read_file: { byte_length: 5, bytes_returned: 5, encoding: 'utf8', content: 'hello' } };
  const side = nativeSide(args => ({ structuredContent: { tool: args.input.tool, result: { structuredContent: pages[args.input.call.name], isError: false } } }));
  const host = openHostActions({ descriptor: descriptorWith({ files_resource: 'tool:synthetic-files', tools_resource: '@synthetic-tools' }), wait: noWait, fetchImpl: side.fetchImpl });
  assert.deepEqual(await host.readWholeFile('a.txt'), { title: 'a.txt', size: 5, bytes: Buffer.from('hello') });
  assert.deepEqual([...new Set(side.sent.map(call => `${call.arguments.address} ${call.arguments.method} ${call.arguments.input.tool}`))],
    ['@synthetic-tools tools:run tool:synthetic-files']);
  assert.deepEqual(side.sent.map(call => call.arguments.input.call.name), ['find_file', 'read_file']);
  assert.deepEqual(side.sent[0].arguments.input.call.arguments, { name_or_identity: 'a.txt' });
});

test('a refusal of the Files tool throws its own code, and an answer that is no call result is an error', async () => {
  const refused = nativeSide(() => ({ structuredContent: { tool: 'tool:synthetic-files', result: { isError: true, structuredContent: { code: 'file_not_found', outcome: 'not_started' } } } }));
  const host = openHostActions({ descriptor: descriptorWith({ files_resource: 'tool:synthetic-files' }), wait: noWait, fetchImpl: refused.fetchImpl });
  await assert.rejects(host.files('find_file', { name_or_identity: '/none' }), { code: 'file_not_found', outcome: 'not_started' });
  assert.equal(refused.sent[0].arguments.address, '@tools', 'the Workshop tools address when the descriptor names none');
  const broken = nativeSide(() => ({ structuredContent: { tool: 'tool:synthetic-files', error: { message: 'no' } } }));
  const other = openHostActions({ descriptor: descriptorWith({ files_resource: 'tool:synthetic-files' }), wait: noWait, fetchImpl: broken.fetchImpl });
  await assert.rejects(other.files('find_file', { name_or_identity: '/a' }), { code: 'rpc_error', outcome: 'unknown' });
});

test('a file above the piece bound with no raw-piece road is refused before anything is sent', async () => {
  const sent = [];
  const host = { files: async (...call) => { sent.push(call); return {}; }, writeLarge: undefined };
  await assert.rejects(writeWholeFile(host, 'big.bin', Buffer.alloc(LARGE_FILE.threshold_bytes + 1)), { code: 'large_file_route_unavailable' });
  assert.equal(sent.length, 0);
});
