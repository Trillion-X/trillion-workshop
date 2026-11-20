const toolsFolder = import.meta.dirname.split('/test')[0].replace(/[^/]+$/, '');
const runtime = { moduleURL: specifier => `file://${toolsFolder}${specifier.slice('tools/'.length)}` };
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const runtimeImport1 = await import(runtime.moduleURL("tools/keep-and-wake-ai-sessions-on-this-computer/harness/record-every-message.mjs"));
const { executionsOf, recordNew, sendExecutionToTrillion, settings } = runtimeImport1;
const runtimeImport2 = await import(runtime.moduleURL("tools/keep-and-wake-ai-sessions-on-this-computer/src/execution-context.mjs"));
const { EXECUTION_LIMITS, findExecutionRecords, recordExecution } = runtimeImport2;
const runtimeImport3 = await import(runtime.moduleURL("tools/record-log/do-work/record-model.mjs"));
const { recordModel, partsOf } = runtimeImport3;
const runtimeImport4 = await import(runtime.moduleURL("tools/keep-and-wake-ai-sessions-on-this-computer/src/record-model.json"), { with: { type: "json" } });
const modelData = runtimeImport4.default;

// This carrier check exercises the locked Workshop producer and the portable receipt/model/query functions it
// carries. The removed Worker adapters are preserved at 4e632497:test/execution-host-references.test.mjs:153-186
// (record-scope.mjs) and :235-251 (execution-tools.mjs); those assertions are not evidence of a native endpoint.
// The optional native replacement is recoverable at
// codex/proposal-optional-hook-reference-coverage-2026-11-07:test/execution-host-references.test.mjs.
// Native ingestion/reverse-read obligations remain with trillion-rust tests/mcp_selected_records_write/hook_ingestion.rs;
// an acknowledgement from this producer does not prove that a native consumer stored or indexed the receipt.

const sessionId = 'fixture-native-source-session';
const recorder = { reader: 'fixture-recorder', app: 'Fixture authenticated recorder', app_basis: 'authenticated' };
const file = '1f:' + 'c'.repeat(64);
const first = 'post:arbitrary-first';
const middle = 'future-resource-kind:' + 'exact-identity-'.repeat(100);
const last = 'record:another-person-declared-kind:last';
const metadata = { item: first, references: [
  { ref: first, role: 'source', label: 'Shared name' },
  { ref: middle, role: 'counterexample', label: 'Shared name' },
  { ref: last, role: 'evidence for the requested result', label: 'Shared name' },
], token: 'TOP_SECRET', command: 'cat /private/native-source.txt', body: 'TOP_SECRET' };
const nativeRows = (harness, input, output, id = 'host-call') => harness === 'claude-code' ? [
  { type: 'assistant', sessionId, uuid: 'called-row', timestamp: '2026-10-11T00:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'read_or_transform', input }] } },
  { type: 'user', sessionId, uuid: 'returned-row', timestamp: '2026-10-11T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(output) }] }] } },
] : [
  { type: 'response_item', timestamp: '2026-10-11T00:00:00Z', payload: { type: 'function_call', call_id: id, name: 'read_or_transform', arguments: JSON.stringify(input) } },
  { type: 'response_item', timestamp: '2026-10-11T00:00:01Z', payload: { type: 'function_call_output', call_id: id, output: JSON.stringify(output) } },
];
const captured = (harness, input, output) => executionsOf(nativeRows(harness, input, output), settings.harnesses.find(row => row.id === harness), { sessionId }).executions;
const memory = () => {
  const records = new Map(), types = new Map(), writes = [];
  return { records, writes, typeOf: id => types.get(id) ?? null, read: id => records.has(id) ? structuredClone(records.get(id)) : null,
    write: (rows, attribution) => { writes.push(structuredClone({ rows, attribution })); for (const row of rows) { records.set(row.id, structuredClone(row.value)); types.set(row.id, row.type); } } };
};

for (const harness of ['claude-code', 'codex']) test(`${harness} retains exact ordered typed source references and the existing complete-result identity, without payload copies`, () => {
  const rows = captured(harness, metadata, { structuredContent: { id: last, result_source: { identity: file, byte_length: 4096, raw: 'TOP_SECRET' }, body: 'TOP_SECRET', content: 'TOP_SECRET' } });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].call_id, rows[1].call_id);
  assert.deepEqual(rows[0].references, [
    { ref: first, role: 'input', basis: 'claimed', path: ['input', 'item'] },
    ...metadata.references.map(({ ref, role }, ordinal) => ({ ref, role, basis: 'claimed', path: ['input', 'references', ordinal, 'ref'], ordinal })),
  ]);
  assert.deepEqual(rows[1].references, [
    { ref: last, role: 'output', basis: 'claimed', path: ['result', 'id'] },
    { ref: file, role: 'output', basis: 'claimed', path: ['result', 'result_source', 'identity'] },
  ]);
  assert.equal(JSON.stringify(rows).includes('TOP_SECRET'), false);
  assert.equal(JSON.stringify(rows).includes('/private/native-source.txt'), false);
  assert.ok(rows.every(row => row.capture_kind === 'host_transcript' && row.origin === 'unknown'));
});

test('native file paths, URIs, unqualified provider ids and prose are unavailable as record references', () => {
  const rejected = ['/private/tmp/one.txt', './one.txt', '~/one.txt', 'C:\\private\\one.txt', 'file:///private/tmp/one.txt', 'file:/private/tmp/one.txt',
    'https://example.test/private', 'vscode://file/private/fixture.txt', 'customscheme://user:FAKE_PASSWORD@example.test/private', 'customscheme:/private/fixture.txt',
    'data:text/plain,secret', 'mailto:person@example.test', 'urn:uuid:not-a-record', '1f:short', 'bare-provider-id'];
  const rows = captured('codex', { file_id: '/private/tmp/one.txt', references: rejected.map(ref => ({ ref, role: 'source' })),
    body: JSON.stringify({ references: [{ ref: 'record:secret:body', role: 'source' }] }) }, { files: rejected.map(id => ({ id })) });
  assert.deepEqual(rows.map(row => row.references), [[], []]);
  const harness = settings.harnesses.find(row => row.id === 'codex');
  const [row] = nativeRows('codex', {}, {});
  row.payload.type = 'custom_tool_call'; delete row.payload.arguments;
  row.payload.input = 'read_file({"item":"record:unobserved:inside-code"}); cat /tmp/notes';
  assert.deepEqual(executionsOf([row], harness, { sessionId }).executions[0].references, []);
  assert.deepEqual(executionsOf([row], { id: 'unsupported-host' }, { sessionId }).executions, []);
});

for (const harness of ['claude-code', 'codex']) test(`${harness} retains actual argument metadata without treating content bodies as transport envelopes`, () => {
  const input = { item: 'record:fixture:outer', content: [{ type: 'text', text: '{"item":"record:fixture:inner-body"}' }], structuredContent: { item: 'record:fixture:inner-structure' } };
  const rows = captured(harness, input, { id: 'record:fixture:result', content: input.content });
  assert.deepEqual(rows[0].references, [{ ref: 'record:fixture:outer', role: 'input', basis: 'claimed', path: ['input', 'item'] }]);
  assert.deepEqual(rows[1].references, [{ ref: 'record:fixture:result', role: 'output', basis: 'claimed', path: ['result', 'id'] }]);
  assert.equal(JSON.stringify(rows).includes('record:fixture:inner'), false);
});

test('reference selectors and supported-host input shapes remain data, including future kinds and roles', () => {
  const harness = { ...settings.harnesses.find(row => row.id === 'claude-code'), id: 'a-different-supported-host', app: 'Fixture future host' };
  const rules = { ...settings, execution_references: { ...settings.execution_references,
    fields: [...settings.execution_references.fields, { path: ['consulted'], each: true, ref_path: ['identity'], role_path: ['relationship'] }] } };
  const rows = nativeRows('claude-code', { consulted: [{ identity: 'new-resource-shape:precise-target', relationship: 'explicitly named alternative' }] }, {});
  const result = executionsOf(rows, harness, { sessionId }, rules).executions;
  assert.deepEqual(result[0].references, [{ ref: 'new-resource-shape:precise-target', role: 'explicitly named alternative', basis: 'claimed', path: ['input', 'consulted', 0, 'identity'], ordinal: 0 }]);
  assert.equal(result[0].claimed.conversation_id, `a-different-supported-host:${sessionId}`);
});

test('called and returned observations share one bounded receipt and preserve input, source, identity, and explicit claim basis', () => {
  const eeaf = memory();
  const [called, returned] = captured('codex', metadata, { id: last, result_source: { identity: file } });
  const start = recordExecution(eeaf, { ...called, origin: 'synthetic', links: { record_refs: [first] } }, recorder, { now: '2026-10-11T01:00:00Z' });
  const finish = recordExecution(eeaf, { ...returned, actor: { basis: 'registered_agent_snapshot' }, links: { record_refs: [last] },
    references: returned.references.map(row => ({ ...row, basis: 'tool_result' })), observation: { provider: 'fixture', object_id: 'same-result', basis: 'provider_response' } }, { reader: 'second-recorder' }, { now: '2026-10-11T02:00:00Z' });
  assert.equal(finish.execution_ref, start.execution_ref);
  assert.equal(finish.event_phase, 'returned');
  assert.deepEqual(finish.references, [...called.references, ...returned.references]);
  assert.deepEqual(finish.links.record_refs, [first, middle, last, file]);
  assert.deepEqual(finish.recorder, start.recorder);
  assert.deepEqual(finish.actor, start.actor);
  assert.deepEqual(finish.claimed, start.claimed);
  assert.equal(finish.observation.basis, 'claimed');
  assert.equal(finish.observation.observed_at, '2026-10-11T00:00:01.000Z');
  assert.equal(finish.origin, 'synthetic');
  assert.deepEqual(finish.coverage, { before_dispatch: false, input_output: 'not_captured', native_host: 'caller_supplied_evidence', references: 'declared_metadata_only' });
  assert.equal(eeaf.writes.length, 2);
  const replay = { ...returned, links: { record_refs: [last] }, observation: { provider: 'fixture', object_id: 'same-result' } };
  recordExecution(eeaf, replay, recorder, { now: '2026-10-11T03:00:00Z' });
  recordExecution(eeaf, called, recorder, { now: '2026-10-11T04:00:00Z' });
  assert.equal(eeaf.writes.length, 2, 'phase replay creates no extra EEAF version and does not regress the returned phase');
  assert.throws(() => recordExecution(eeaf, { ...called, operation: 'a different action' }, recorder), /different captured action/);
  assert.equal(eeaf.writes.length, 2);
});

test('a late called observation can add explicit references without regressing a returned receipt', () => {
  const eeaf = memory();
  const [called, returned] = captured('claude-code', metadata, { id: last });
  assert.equal(returned.operation, undefined, 'the native result row does not repeat the called operation');
  recordExecution(eeaf, returned, recorder);
  const kept = recordExecution(eeaf, called, recorder);
  assert.equal(kept.event_phase, 'returned');
  assert.equal(kept.operation, called.operation);
  assert.deepEqual(kept.references, [...returned.references, ...called.references]);
  assert.equal(eeaf.writes.length, 2);
});

test('a returned-only native observation retries idempotently at its captured time', () => {
  const eeaf = memory();
  const [, returned] = captured('codex', {}, { id: last, provider: 'fixture' });
  const value = { ...returned, operation: 'observed after dispatch' };
  const original = recordExecution(eeaf, value, recorder, { now: '2026-10-11T01:00:00Z' });
  assert.equal(original.observation.observed_at, returned.captured_at);
  recordExecution(eeaf, value, recorder, { now: '2026-10-11T02:00:00Z' });
  assert.equal(eeaf.writes.length, 1);
});

test('portable receipts expose canonical model parts to the bounded relationship query without extra writes', () => {
  const eeaf = memory(), model = recordModel(modelData), queries = [];
  eeaf.write([{ id: 'list:fixture-sources', type: 'list', value: { row_type: 'arbitrary-source-kind' } }], { actor: recorder });
  const [called] = captured('codex', { references: [
    { ref: `file:${file}`, role: 'consulted source' }, { ref: file, role: 'another declared role' },
    { ref: 'list:fixture-sources:rows:first', role: 'named example' },
    { ref: 'future-resource:audience-preference', role: 'contextual preference' },
  ] }, {});
  const before = eeaf.writes.length;
  const kept = recordExecution(eeaf, called, recorder);
  assert.equal(eeaf.writes.length, before + 1, 'reference participation is in the existing receipt write');
  assert.deepEqual(kept.references, called.references, 'source identity, declaration role and path are not rewritten');
  assert.deepEqual(kept.links.record_refs, [file, 'record:arbitrary-source-kind:first', 'future-resource:audience-preference']);
  const parts = partsOf(model.kindOf('execution'), kept);
  assert.deepEqual(parts.filter(part => part.role === 'record_refs').map(part => part.id), kept.links.record_refs);
  assert.deepEqual(parts.filter(part => part.role !== 'record_refs'), called.references.map((reference, ordinal) => ({
    role: reference.role, id: reference.ref, ordinal,
  })), 'the current model retains each declared role and original reference independently of its lookup alias');
  eeaf.find = () => { throw new Error('A canonical source lookup must not scan execution text'); };
  // This is the portable query's supplied relationship-page boundary, not a stand-in for the retired scope server
  // or proof that the native account has ingested anything. Its candidates come from the actual model above.
  const references = (target, options) => {
    queries.push({ target, ...options });
    const records = parts.filter(part => part.id === target && part.role === 'record_refs')
      .map(() => ({ id: kept.execution_ref, type: 'execution' }));
    assert.ok(records.length <= options.limit, 'fixture exercises one bounded relationship page');
    return { records, coverage: { complete: true, next_cursor: null } };
  };
  for (const target of [file, 'record:arbitrary-source-kind:first']) {
    const found = findExecutionRecords(eeaf, { item: target, limit: 3 }, { references });
    assert.equal(found.records[0].id, kept.execution_ref);
    assert.equal(found.coverage.candidate_work_bounded, true);
    assert.equal(found.coverage.lookup, 'indexed_exact_match');
  }
  assert.equal(queries.length, 2);
  assert.ok(queries.every(query => query.limit === 3 && query.kinds.includes('execution') && query.cursor === null));
  assert.equal(eeaf.writes.length, before + 1, 'reverse inspection adds no managed read receipt or index write');
});

test('host reference collection and merged receipts reject excessive work before retaining a partial phase', () => {
  assert.equal(settings.execution_references.max_references, EXECUTION_LIMITS.links);
  assert.equal(settings.execution_references.max_bytes, EXECUTION_LIMITS.link_bytes);
  const references = Array.from({ length: 202 }, (_, i) => ({ ref: `future-kind:${i}`, role: 'source' }));
  assert.throws(() => captured('codex', { references }, {}), /not truncated/);
  assert.throws(() => captured('codex', { item: 'future-kind:' + 'x'.repeat(8192) }, {}), /8192 character/);
  assert.throws(() => captured('codex', { references: [{ ref: first, role: 'x'.repeat(81) }] }, {}), /bounded text/);
  assert.throws(() => captured('codex', { references: Array.from({ length: 100 }, (_, i) => ({ ref: `future-kind:${i}${'x'.repeat(8000)}`, role: 'source' })) }, {}), /byte capture limit/);
  const eeaf = memory();
  const [called, returned] = captured('codex', { references: references.slice(0, 201) }, { id: last });
  const original = recordExecution(eeaf, called, recorder);
  assert.throws(() => recordExecution(eeaf, returned, recorder), /at most 201|not truncated/);
  assert.deepEqual(eeaf.read(original.execution_ref), original);
  assert.equal(eeaf.writes.length, 1);
});

test('metadata refusal retains the existing native cursor and does not read a key or send a receipt', async () => {
  const folder = tempFolder(join(tmpdir(), 'host-reference-fixture-'));
  try {
    const path = join(folder, 'session.jsonl'), rules = { ...settings, cursor_folder: join(folder, 'cursors') };
    writeFileSync(path, JSON.stringify(nativeRows('claude-code', {}, {}, 'first')[0]) + '\n');
    const firstResult = await recordNew({ transcript_path: path }, { rules, key: () => 'fixture-only', send: async () => true, sendExecution: async () => true });
    assert.equal(firstResult.executions_sent, 1);
    const cursor = join(rules.cursor_folder, `${sessionId}.json`), before = readFileSync(cursor, 'utf8');
    appendFileSync(path, JSON.stringify(nativeRows('claude-code', { references: Array.from({ length: 202 }, (_, i) => ({ ref: `future-kind:${i}`, role: 'input' })) }, {}, 'second')[0]) + '\n');
    const result = await recordNew({ transcript_path: path }, { rules, key: () => { throw new Error('Must not read a key'); },
      send: async () => { throw new Error('Must not send'); }, sendExecution: async () => { throw new Error('Must not send a partial receipt'); } });
    assert.equal(result.execution_capture, 'metadata_limit');
    assert.equal(result.executions_sent, 0);
    assert.equal(result.executions_pending, 1);
    assert.equal(readFileSync(cursor, 'utf8'), before);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

