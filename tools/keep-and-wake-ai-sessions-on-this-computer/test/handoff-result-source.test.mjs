import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { HANDOFF_RESULT_SOURCE, readHandoffResultSource, resultSourceCapability } from '../../shared-code/src/handoff-result-source.mjs';
import { makeAgents, handleAgentsRequest, agentTools } from '../../shared-code/src/agents.mjs';
import { agentStoreForTests } from '../../shared-code/test/agent-store-for-tests.mjs';
const encoded = value => new TextEncoder().encode(JSON.stringify(value));
const descriptor = bytes => ({ identity: `1f:${bytesToHex(blake3(bytes))}`, byte_length: bytes.length, format: 'application/json' });
function fileOf(bytes, { size = bytes.length, step = 10001, onCancel = () => {} } = {}) {
  return { byte_length: size, stream: () => { let cursor = 0; return new ReadableStream({ pull(controller) {
    if (cursor === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(cursor, cursor + step)); cursor = Math.min(bytes.length, cursor + step);
  }, cancel: onCancel }); } };
}
const read = (source, bytes, options = {}) => readHandoffResultSource(source, { privateReach: true, admit() {}, open: async () => fileOf(bytes), ...options });
test('bounded source preserves original transcript including multibyte characters split across chunks', async () => {
  const result = { text: 'a'.repeat(1_100_000) + '😀終', segments: [{ text: '😀', start: 0 }], language: 'ja', heard_whole: true, produced_by: 'fixture' };
  const bytes = encoded(result);
  assert.ok(bytes.length > 1_000_000);
  assert.deepEqual(await read(descriptor(bytes), bytes, { open: async () => fileOf(bytes, { step: 1_100_002 }) }), result);
});
test('authorization and admission refuse before any source is opened', async () => {
  const bytes = encoded({ text: 'original' }); let opens = 0;
  const open = async () => { opens++; return fileOf(bytes); };
  await assert.rejects(read(descriptor(bytes), bytes, { privateReach: false, open }), /private/);
  await assert.rejects(read(descriptor(bytes), bytes, { admit() { throw Error('stale holder'); }, open }), /stale holder/);
  await assert.rejects(read({ ...descriptor(bytes), byte_length: HANDOFF_RESULT_SOURCE.max_bytes + 1 }, bytes, { open }), /byte_length/);
  assert.equal(opens, 0);
});
test('length, identity, malformed UTF8 and incomplete streams refuse without returning a partial answer', async () => {
  const bytes = encoded({ text: 'original' }), source = descriptor(bytes);
  await assert.rejects(read(source, bytes, { open: async () => fileOf(bytes, { size: bytes.length + 1 }) }), /length/);
  await assert.rejects(read({ ...source, identity: '1f:' + '0'.repeat(64) }, bytes), /immutable identity/);
  await assert.rejects(read(source, bytes.slice(0, -1), { open: async () => fileOf(bytes.slice(0, -1), { size: bytes.length }) }), /ended before/);
  const invalid = new Uint8Array([0x22, 0xff, 0x22]);
  await assert.rejects(read(descriptor(invalid), invalid), /encoded data|encoding/i);
  await assert.rejects(read(descriptor(encoded(null)), encoded(null)), /nonempty/);
});
test('overlong committed stream is cancelled and its lock released', async () => {
  const bytes = encoded({ text: 'original' }); let cancelled = 0;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes.length + 1)); }, cancel() { cancelled++; } });
  await assert.rejects(read(descriptor(bytes), bytes, { open: async () => ({ byte_length: bytes.length, stream: () => stream }) }), /exceeded/);
  assert.equal(cancelled, 1); assert.equal(stream.locked, false);
});
function held() {
  const store = agentStoreForTests(), agents = makeAgents({ store });
  agents.publish({ agent_id: 'worker', name: 'Worker', description: 'Works', takes_work: true, capacity: { max_concurrent: 1 } });
  const handoff = agents.handOff({ request_key: 'synthetic-result-source', job: 'Synthetic complete result', to_agent: 'worker' }).handoff;
  const lease = agents.take({ agent_id: 'worker', handoff_id: handoff.handoff_id });
  return { store, agents, input: { handoff_id: handoff.handoff_id, agent_id: 'worker', generation: lease.generation } };
}
const post = (agents, input, resolver, path = '/handoffs/finish') => handleAgentsRequest(agents, new Request('https://fixture.test' + path, { method: 'POST', body: JSON.stringify(input) }), { resolveResultSource: resolver });
function resolverFor(bytes, beforeOpen = () => {}) { return (source, admit) => readHandoffResultSource(source, { privateReach: true, admit, open: async () => { await beforeOpen(); return fileOf(bytes); } }); }
test('actual finish owner stores original result, repeats identical delivery, and refuses conflicting answers', async () => {
  const { agents, input } = held(), result = { text: 'x'.repeat(1_050_000), segments: [{ text: 'whole' }], heard_whole: true };
  const bytes = encoded(result), wire = { ...input, result_source: descriptor(bytes) };
  const first = await post(agents, wire, resolverFor(bytes)); assert.equal(first.status, 200);
  assert.deepEqual(agents.read({ handoff_id: input.handoff_id }).handoff.result, result);
  assert.equal((await (await post(agents, wire, resolverFor(bytes))).json()).repeated, true);
  const changed = encoded({ text: 'different' });
  assert.equal((await post(agents, { ...input, result_source: descriptor(changed) }, resolverFor(changed))).status, 400);
});
test('verified source finishes preserve the original without a second complete serialization', async () => {
  const { agents, input } = held();
  const result = { text: 'complete', segments: Array.from({ length: 500 }, (_, n) => ({ text: `segment ${n}`, start: n })) };
  const bytes = encoded(result);
  const stringify = JSON.stringify;
  let decoded, serializations = 0;
  const resolver = async (source, admit, beforeDecode) => {
    decoded = await readHandoffResultSource(source, { privateReach: true, admit, beforeDecode, open: async () => fileOf(bytes) });
    return decoded;
  };
  try {
    JSON.stringify = function(value, ...args) {
      if (value === decoded) serializations += 1;
      return stringify.call(this, value, ...args);
    };
    const answer = await post(agents, { ...input, result_source: descriptor(bytes) }, resolver);
    assert.equal(answer.status, 200);
    assert.equal(serializations, 0, 'the verified JSON already represents this complete result');
    const kept = agents.read({ handoff_id: input.handoff_id }).handoff;
    assert.deepEqual(kept.result, result);
    assert.equal(Object.hasOwn(kept, 'result_json'), false);
  } finally { JSON.stringify = stringify; }
});
test('wrong actor, missing/stale generation, mixed transports and unsettled effects never open source', async () => {
  const { agents, input } = held(), bytes = encoded({ text: 'original' }); let opens = 0;
  const resolver = resolverFor(bytes, () => { opens++; });
  for (const bad of [{ ...input, agent_id: 'other' }, { ...input, generation: undefined }, { ...input, generation: input.generation + 1 }, { ...input, result: 'also inline' }])
    assert.equal((await post(agents, { ...bad, result_source: descriptor(bytes) }, resolver)).status, 400);
  agents.recordEffect({ ...input, effect_id: 'fixture-effect', state: 'starting' });
  assert.equal((await post(agents, { ...input, result_source: descriptor(bytes) }, resolver)).status, 400);
  assert.equal(opens, 0);
});
test('lease takeover during asynchronous source read prevents stale final commit', async () => {
  const { agents, input } = held(), bytes = encoded({ text: 'original' });
  const resolver = resolverFor(bytes, () => {
    agents.release({ ...input, because: 'Fixture takeover' });
    const next = agents.take({ agent_id: 'worker', handoff_id: input.handoff_id });
    assert.notEqual(next.generation, input.generation);
  });
  assert.equal((await post(agents, { ...input, result_source: descriptor(bytes) }, resolver)).status, 400);
  assert.equal(agents.read({ handoff_id: input.handoff_id }).handoff.state, 'taken');
  assert.ok(agents.read({ handoff_id: input.handoff_id }).handoff.result == null);
});
test('capability requires held generation; inline behavior and 1M envelope limit remain', async () => {
  const { agents, input } = held();
  assert.deepEqual(await (await post(agents, input, null, '/handoffs/result-source-capability')).json(), resultSourceCapability());
  assert.equal((await post(agents, { ...input, generation: undefined }, null, '/handoffs/result-source-capability')).status, 400);
  assert.equal((await post(agents, { ...input, result: 'x'.repeat(1_000_001) }, null)).status, 400);
  assert.equal((await post(agents, { ...input, result: { text: 'ordinary' } }, null)).status, 200);
  const schema = agentTools(() => {}) .find(t => t.name === 'finish_work').inputSchema;
  assert.ok(schema.oneOf[1].required.includes('generation'));
});
