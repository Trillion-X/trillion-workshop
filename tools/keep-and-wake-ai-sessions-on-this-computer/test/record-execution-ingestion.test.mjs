import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { executionsOf, recordNew, sendExecutionToTrillion, settings } from '../harness/record-every-message.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The Trillion address these tests talk to is the one the caller gives; no address is built in.
process.env.TRILLION_ORIGIN ??= 'https://app.example.com';
const harness = settings.harnesses.find(row => row.id === 'claude-code');
const row = { type: 'assistant', sessionId: 'fixture-source-session', timestamp: '2026-11-07T12:00:00Z', uuid: 'fixture-row', message: { content: [
  { type: 'tool_use', id: 'fixture-call', name: 'read_source', input: { references: [{ ref: 'record:fixture:source', role: 'source' }], token: 'DO_NOT_KEEP', body: 'DO_NOT_KEEP' } },
] } };
const bytes = JSON.stringify(row) + '\n';
const [receipt] = executionsOf([row], harness, { sessionId: row.sessionId }).executions;
const source = { transcript_path: '/synthetic/transcript.jsonl', offset: 0, end: Buffer.byteLength(bytes) };
const kept = { ...receipt, execution_ref: `execution:${receipt.call_id}`, actor: { basis: 'unknown' }, recorder: { basis: 'authenticated' }, coverage: { before_dispatch: false, native_host: 'verified_transcript_occurrence' } };
const response = value => new Response(JSON.stringify({ jsonrpc: '2.0', result: { structuredContent: value } }), { status: 200 });

test('automatic observations use the current hook door, then exact readback; credentials stay in headers and payloads stay out', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = JSON.parse(options.body); calls.push({ url, options, request });
    return calls.length === 1 ? response({ executions_accepted: [{ call_id: receipt.call_id, execution_ref: kept.execution_ref, event_phase: receipt.event_phase }] })
      : response({ id: kept.execution_ref, type: 'execution', value: kept });
  });
  assert.equal(await sendExecutionToTrillion(receipt, { source, key: 'FIXTURE_KEY', deadline: Date.now() + 1000 }), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url === process.env.TRILLION_ORIGIN + '/mcp'));
  assert.equal(calls[0].request.params.arguments.address, '@harness-hooks');
  assert.equal(calls[0].request.params.arguments.method, 'hooks:receive');
  assert.deepEqual(calls[0].request.params.arguments.input.executions, [{ receipt, source }]);
  assert.equal(calls[1].request.params.arguments.method, 'records:read');
  assert.ok(calls.every(call => call.options.headers.authorization === 'Bearer FIXTURE_KEY'));
  assert.equal(JSON.stringify(calls.map(call => call.request)).includes('FIXTURE_KEY'), false);
  assert.equal(JSON.stringify(calls.map(call => call.request)).includes('DO_NOT_KEEP'), false);
  assert.ok(receipt.references.every(ref => ref.basis === 'claimed'));
});

for (const failure of ['refused', 'wrong_call', 'unverified_readback', 'missing_readback', 'lost_reference']) test(`ingestion ${failure} retains the exact occurrence for retry`, async t => {
  const folder = tempFolder(join(tmpdir(), 'execution-ingestion-'));
  const path = join(folder, 'fixture.jsonl'), rules = { ...settings, cursor_folder: join(folder, 'cursors') };
  writeFileSync(path, bytes);
  let fail = true, attempts = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body), args = request.params.arguments;
    if (args.method === 'hooks:receive') {
      attempts.push(request);
      if (fail && failure === 'refused') return new Response(JSON.stringify({ result: { isError: true } }), { status: 200 });
      return response({ executions_accepted: [{ call_id: fail && failure === 'wrong_call' ? 'different' : receipt.call_id, execution_ref: kept.execution_ref, event_phase: receipt.event_phase }] });
    }
    return response(fail && failure === 'missing_readback' ? {} : { id: kept.execution_ref, type: 'execution', value: fail && failure === 'unverified_readback' ? { ...kept, actor: { basis: 'claimed-native' } } : fail && failure === 'lost_reference' ? { ...kept, references: [] } : kept });
  });
  const first = await recordNew({ transcript_path: path }, { rules, key: () => 'FIXTURE_KEY', send: async () => true });
  assert.equal(first.executions_sent, 0);
  assert.equal(first.executions_pending, 1);
  assert.equal(JSON.parse(readFileSync(join(rules.cursor_folder, `${row.sessionId}.json`))).execution_offset, 0);
  fail = false;
  const retry = await recordNew({ transcript_path: path }, { rules, key: () => 'FIXTURE_KEY', send: async () => true });
  assert.equal(retry.executions_sent, 1);
  assert.equal(retry.executions_pending, 0);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(JSON.parse(readFileSync(join(rules.cursor_folder, `${row.sessionId}.json`))).execution_offset, Buffer.byteLength(bytes));
});

test('manual or unsupported recording never enters the automatic source road', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Must not send a fabricated automatic source'); });
  assert.equal(await sendExecutionToTrillion(receipt, { deadline: Date.now() + 1000 }), false);
  assert.equal(await sendExecutionToTrillion({ ...receipt, capture_kind: 'explicit_recording' }, { source, deadline: Date.now() + 1000 }), false);
  assert.equal(await sendExecutionToTrillion(receipt, { source: { ...source, end: 0 }, deadline: Date.now() + 1000 }), false);
});
