import test from 'node:test';
import assert from 'node:assert/strict';
import settings from '../read-data/decide-with-a-method.json' with { type: 'json' };
import { addDecisionEvidence, startADecision } from '../read-data/decisions.mjs';
import { readDecision, recordsOf, writeDecision } from '../read-data/decision-records.mjs';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import { memoryDoor, plainMethod, plainChecks, run, heldOf } from './fixtures.mjs';

function account() {
  const door = memoryDoor();
  door.put(`record:${settings.records.method_row}:plain`, `record:${settings.records.method_row}`, plainMethod());
  for (const check of plainChecks()) door.put(`record:${settings.records.check_row}:${check.id}`, `record:${settings.records.check_row}`, check);
  return door;
}
const input = () => ({ source_id: 'synthetic-source:'.padEnd(200, 's'), goal: 'Choose the synthetic test change', evidence: [{ ref: 'initial', claim: 'Synthetic initial evidence' }], options: [{ id: 'a', label: 'First choice' }, { id: 'b', label: 'Second choice' }] });
const row = (claim = 'Synthetic evidence') => ({ id: 'synthetic-decision', type: 'decision', value: { claim } });
const part = { id: 'synthetic-part', type: 'decision-part', value: { text: 'synthetic content' } };
const bounded = writes => {
  assert.ok(writes.length > 0);
  for (const { key } of writes) assert.ok(Buffer.byteLength(key) <= 512, 'every final staging/root key fits UTF-8 bytes');
};
async function keys(key, list = [row(), part]) {
  const door = memoryDoor();
  door.write(writeDecision(heldOf(door), list, key));
  bounded(door.writes);
  return door.writes.map(write => write.key);
}

test('real controllers accept long sources and long evidence refs, then replay without writes', async () => {
  const door = account();
  const { case_id } = await run(door, startADecision, input());
  const evidence = Array.from({ length: 4 }, (_, n) => ({ ref: `synthetic-ref-${n}:` + 'r'.repeat(160), claim: `Synthetic evidence number ${n}` }));
  assert.ok(Buffer.byteLength(`add-decision-evidence:${case_id}:${evidence.map(row => row.ref).join(',')}`) > 512);
  const reply = await run(door, addDecisionEvidence, { decision_id: case_id, evidence });
  assert.equal(reply.added.length, 4);
  assert.equal((await readDecision(heldOf(door), case_id)).input.evidence.length, 5);
  bounded(door.writes);
  const count = door.writes.length;
  assert.equal((await run(door, addDecisionEvidence, { decision_id: case_id, evidence })).replayed, true);
  assert.equal(door.writes.length, count);
});

test('legacy request family stays exact at 512 bytes, oversized family is bounded', async () => {
  const list = [row(), part];
  const key = 'k'.repeat(371);
  const request = `${key}:${makeHashCodeHexFromJson({ basis: { root: null }, records: list })}`;
  const result = await keys(key, list);
  assert.deepEqual(result, [`${request}:part:${makeHashCodeHexFromJson([{ ...part, expected: null }])}`, `${request}:root`]);
  assert.equal(Buffer.byteLength(result[0]), 512);
  const longer = await keys(key + 'k', list);
  assert.notEqual(longer[0], result[0]);
  assert.ok(longer.every(value => !value.includes(key)));
});

test('oversized start and multipart evidence publish the root last and read back whole', async () => {
  const door = account();
  const opened = { ...input(), source_id: 'synthetic-unicode-source:' + 'é'.repeat(220) };
  const { case_id } = await run(door, startADecision, opened);
  const evidence = Array.from({ length: 3 }, (_, n) => ({ ref: `synthetic-large-${n}:` + 'r'.repeat(180), claim: 'Synthetic multipart evidence. '.repeat(1800) }));
  const start = door.writes.length;
  await run(door, addDecisionEvidence, { decision_id: case_id, evidence });
  const writes = door.writes.slice(start);
  assert.ok(writes.length > 2, 'the actual controller stages several bounded messages');
  assert.deepEqual(writes.at(-1).ids, [case_id], 'only the final write publishes the root');
  assert.equal(new Set(writes.map(write => write.key)).size, writes.length);
  assert.deepEqual((await readDecision(heldOf(door), case_id)).input.evidence.slice(1).map(({ ref, claim }) => ({ ref, claim })), evidence);
  bounded(door.writes);
});

test('UTF-8 boundary and late intent differences cannot alias, even with the same visible prefix', async () => {
  const exact = 'é'.repeat(185) + 'x';
  assert.equal(Buffer.byteLength(exact), 371);
  assert.ok((await keys(exact))[0].startsWith(exact + ':'));
  assert.ok(!(await keys(exact + 'é'))[0].startsWith(exact));
  const prefix = 'synthetic-private-intent:'.padEnd(900, '😀');
  const variants = await Promise.all(['a', 'b', 'é', 'e\u0301'].map(tail => keys(prefix + tail)));
  assert.equal(new Set(variants.map(value => value[1])).size, 4);
  for (const pair of variants) assert.ok(pair.every(value => !value.includes('synthetic-private-intent')));
  assert.deepEqual(await keys(prefix + 'a'), variants[0], 'same complete intent produces the same keys');
  assert.notDeepEqual(await keys(prefix + 'a', [row('Different synthetic body'), part]), variants[0]);
});

test('a changed CAS basis changes identity for the same oversized intent and desired state', async () => {
  const door = account();
  const { case_id } = await run(door, startADecision, input());
  const record = await readDecision(heldOf(door), case_id);
  record.marker = 'same desired state';
  const first = recordsOf(record);
  const before = door.value(case_id);
  door.put(case_id, 'decision', { ...before, concurrent: true });
  const later = await readDecision(heldOf(door), case_id);
  delete later.concurrent;
  later.marker = 'same desired state';
  const second = recordsOf(later);
  assert.deepEqual(first, second);
  const seen = [];
  const capture = { read: door.read.bind(door), async write(records, { key }) { seen.push(key); throw new Error('synthetic unknown outcome'); } };
  for (const list of [first, second]) await assert.rejects(writeDecision(capture, list, 'intent'.repeat(200)), /synthetic unknown/);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
});

test('unknown part or root outcomes propagate once, without fallback or a second identity', async () => {
  for (const intent of ['short-legacy', 'oversized'.repeat(150)]) {
    for (const phase of ['part', 'root']) {
      const door = memoryDoor();
      const attempts = [];
      const failure = new Error('synthetic lost reply');
      const wrapped = { read: door.read.bind(door), async write(records, options) {
        attempts.push(options.key);
        if (options.key.includes(`:${phase}:`) || options.key.endsWith(`:${phase}`)) {
          await door.write(records, options);
          throw failure;
        }
        return door.write(records, options);
      } };
      await assert.rejects(writeDecision(wrapped, [row(), part], intent), error => error === failure);
      assert.equal(attempts.length, phase === 'part' ? 1 : 2);
      assert.equal(new Set(attempts).size, attempts.length);
      assert.equal(await door.read('decision', row().id) !== null, phase === 'root');
      bounded(door.writes);
    }
  }
});

test('previously committed long legacy state keeps its pointers and deduplicates at the controller', async () => {
  const door = account();
  const opened = input();
  const { case_id } = await run(door, startADecision, opened);
  const evidence = [{ ref: 'legacy-ref:'.padEnd(800, 'r'), claim: 'Synthetic historical committed evidence' }];
  // Model an older host that accepted a long request: install the real historical records and pointers,
  // including the root, without assuming that native rejection proves no prior effect on every host.
  const held = await readDecision(heldOf(door), case_id);
  held.input.evidence.push({ ...evidence[0], added_at: '2026-01-01T00:00:00.000Z' });
  const records = recordsOf(held);
  const legacyRequest = `add-decision-evidence:${case_id}:${evidence[0].ref}:${makeHashCodeHexFromJson({ basis: { root: door.value(case_id) }, records })}`;
  assert.ok(Buffer.byteLength(legacyRequest + ':root') > 512);
  for (const record of records.slice(1)) door.put(record.id, record.type, record.value);
  door.put(records[0].id, records[0].type, records[0].value);
  const before = structuredClone([...door.records]);
  const count = door.writes.length;
  assert.equal((await run(door, addDecisionEvidence, { decision_id: case_id, evidence })).replayed, true);
  assert.deepEqual([...door.records], before);
  assert.equal(door.writes.length, count);
  assert.equal((await readDecision(heldOf(door), case_id)).input.evidence.at(-1).ref, evidence[0].ref);
});

test('real controller propagates a lost root reply and later recognizes the committed evidence', async () => {
  const door = account();
  const { case_id } = await run(door, startADecision, input());
  const evidence = [{ ref: 'synthetic-lost-root:'.padEnd(800, 'r'), claim: 'Synthetic evidence committed before reply loss' }];
  const attempts = [];
  const failure = new Error('synthetic root reply lost');
  const wrapped = { read: door.read.bind(door), readRecord: door.readRecord.bind(door), async write(records, options) {
    attempts.push(options.key);
    const receipt = await door.write(records, options);
    if (options.key.endsWith(':root')) throw failure;
    return receipt;
  } };
  await assert.throws(() => run(wrapped, addDecisionEvidence, { decision_id: case_id, evidence }), error => error === failure);
  assert.equal(attempts.filter(key => key.endsWith(':root')).length, 1);
  const count = door.writes.length;
  assert.equal((await run(door, addDecisionEvidence, { decision_id: case_id, evidence })).replayed, true);
  assert.equal(door.writes.length, count);
});
