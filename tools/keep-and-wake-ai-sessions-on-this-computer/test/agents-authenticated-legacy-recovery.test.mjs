import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteHost } from '../src/local-store.mjs';
import { openRecords, setRecordEngine } from '../src/record-engine.mjs';
import { identityOf } from '../src/decision-store.mjs';
import { agentRecordStore } from '../../hand-work-to-ais/agent-records.mjs';
import { makeAgents, handleAgentsRequest } from '../../shared-code/src/agents.mjs';
import { readHandoffResultSource } from '../../shared-code/src/handoff-result-source.mjs';

function fixture(t, { reader = null } = {}) {
  const host = sqliteHost(':memory:');
  t.after(() => host.db.close());
  setRecordEngine(host.sql, 'record-log');
  const records = openRecords(host.sql, { transaction: host.transaction, hash: identityOf });
  const store = agentRecordStore({ records, transaction: host.transaction });
  let effects = 0;
  const agents = makeAgents({ store, onFinished: () => { effects++; } });
  agents.publish({ agent_id: 'worker', name: 'Worker', description: 'Synthetic recovery worker' });
  const { handoff } = agents.handOff({ job: 'Keep the complete result', to_agent: 'worker', request_key: 'legacy-reader-recovery' });
  const lease = agents.take({ handoff_id: handoff.handoff_id, agent_id: 'worker' }, { reader });
  const input = { handoff_id: handoff.handoff_id, agent_id: 'worker', generation: lease.generation };
  const original = { text: 'Synthetic complete accepted answer', sections: Array.from({ length: 80 }, (_, n) => ({ n, text: `section ${n}` })) };
  agents.finish({ ...input, result: original }, { reader });
  records.checkpoint?.();
  records.forgetCached();
  effects = 0;
  return { records, store, agents, input, original, get effects() { return effects; } };
}

function sourceOf(result) {
  const json = JSON.stringify(result), bytes = new TextEncoder().encode(json);
  const wire = { identity: identityOf(json), byte_length: bytes.length, format: 'application/json' };
  let opens = 0, checks = 0;
  return {
    wire, get opens() { return opens; }, get checks() { return checks; },
    checkResultSourceAccess: async (_source, admit) => { admit(); checks++; },
    resolveResultSource: (source, admit) => readHandoffResultSource(source, {
      privateReach: true, admit,
      open: async () => { opens++; return { byte_length: bytes.length, stream: () => new Blob([bytes]).stream() }; },
    }),
  };
}

const post = (f, source, reader = 'key:recovery-client', extra = {}) => handleAgentsRequest(f.agents,
  new Request('https://fixture.test/handoffs/finish', {
    method: 'POST', headers: { 'x-trillion-reader': reader },
    body: JSON.stringify({ ...f.input, result_source: source.wire, ...extra }),
  }), source);

test('authenticated legacy source recovery preserves the original and unknown actor through durable receipt retries', async t => {
  const f = fixture(t), source = sourceOf(f.original);
  const before = f.store.handoff(f.input.handoff_id);
  assert.ok(f.store.legacyResultRecovery(f.input.handoff_id));
  const response = await post(f, source);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).completion_receipt, true);
  f.records.checkpoint?.();
  f.records.forgetCached();
  const after = f.store.handoff(f.input.handoff_id);
  assert.deepEqual(after.result, f.original);
  assert.deepEqual(after.attempts, before.attempts, 'representation recovery never assigns historical claim identity');
  assert.equal(Object.hasOwn(after.attempts.at(-1), 'claim_reader'), false);
  assert.equal(after.generation, before.generation);
  assert.equal(after.finished_at, before.finished_at);
  assert.equal(f.effects, 0, 'recovering storage never repeats finish effects');
  const retry = await post(f, source);
  assert.equal(retry.status, 200, await retry.clone().text());
  assert.equal((await retry.json()).repeated, true);
  assert.equal(source.opens, 1, 'the persisted exact receipt avoids reopening result bytes');
  assert.equal(source.checks, 1, 'receipt retries still check current source access');
});

test('legacy source backend failure preserves the finished handoff and has no finish effects', async t => {
  const f = fixture(t), source = sourceOf(f.original), before = f.store.handoff(f.input.handoff_id);
  const failure = Error('Synthetic legacy source backend failure');
  source.resolveResultSource = () => { throw failure; };
  await assert.rejects(post(f, source), cause => cause === failure);
  assert.deepEqual(f.store.handoff(f.input.handoff_id), before);
  assert.equal(f.store.handoff(f.input.handoff_id).result_source_receipt, null);
  assert.equal(f.effects, 0);
});

test('legacy recovery refuses different content and caller-supplied claim or recovery authority', async t => {
  const f = fixture(t), before = f.store.handoff(f.input.handoff_id);
  const source = sourceOf({ ...f.original, text: 'Different content' });
  const response = await post(f, source, 'key:recovery-client', {
    claim_reader: 'key:recovery-client', acceptedResultSource: source.wire,
    legacy_result_recovery: true, result_source_receipt: { ...source.wire, ...f.input },
  });
  assert.equal(response.status, 400);
  const refused = await response.json();
  assert.match(refused.error, /differs/);
  assert.equal(refused.failure_code, 'request-refused');
  assert.deepEqual(f.store.handoff(f.input.handoff_id), before);
  assert.equal(f.effects, 0);
});

test('legacy source recovery authority never admits an ordinary authenticated result write', async t => {
  const f = fixture(t);
  assert.throws(() => f.agents.finish({ ...f.input, result: f.original }, { reader: 'key:recovery-client' }), /no authenticated reader recorded/);
  assert.equal(f.store.handoff(f.input.handoff_id).result_source_receipt, null);
});

test('new authenticated claims cannot use legacy source recovery to bypass their original reader', async t => {
  const f = fixture(t, { reader: 'key:original' }), source = sourceOf(f.original);
  assert.ok(f.store.legacyResultRecovery(f.input.handoff_id), 'inline representation alone is not legacy actor evidence');
  const response = await post(f, source, 'key:other');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /different authenticated reader/);
  assert.equal(source.opens, 0);
  assert.equal(f.store.handoff(f.input.handoff_id).result_source_receipt, null);
  const accepted = await post(f, source, 'key:original');
  assert.equal(accepted.status, 200, await accepted.clone().text());
  f.records.checkpoint?.();
  f.records.forgetCached();
  assert.equal(f.store.handoff(f.input.handoff_id).attempts.at(-1).claim_reader, 'key:original');
  const wrongRetry = await post(f, source, 'key:other');
  assert.equal(wrongRetry.status, 400);
  assert.equal(source.opens, 1, 'wrong-reader receipt retries cannot reopen content');
});
