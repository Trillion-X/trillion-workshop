import test from 'node:test';
import assert from 'node:assert/strict';
import { openRecordsDoor } from 'trillion-workshop/tools/records-door/read-data/records-door.mjs';
import { startFakeDoor } from 'trillion-workshop/tools/records-door/test/fake-door.mjs';
import fixtures from './policy-fixtures.json' with { type: 'json' };
import { createHandToAccount } from '../read-data/hand-to-an-account.mjs';
import { createFormerNamesCounter } from '../read-data/former-names-count.mjs';

const ops = ['records:read', 'records:list', 'records:write'];
async function world(t, types) {
  const fake = await startFakeDoor({ rights: types.map(kind => ({ kind, operations: ops })), pageCut: 1 });
  t.after(fake.close);
  return { fake, door: openRecordsDoor({ descriptor: fake.descriptor }) };
}
const invoke = fixtures.tray.records[0].payload.invoke;
const report = (note = 'Original report') => ({ invoke, from: { ref: 'authenticated-account', user: 'member', name: 'Member' }, things: [], note, where: 'Files', screen: '', browser: '', more: { kind: 'friction' }, capture: { submission_id: 'task:1', execution_ref: 'execution:1', origin: 'synthetic' }, at: '2026-10-08T03:00:00.000Z', sent_by: 'ai', harness: 'Codex', their_words: 'their words' });
const handoffs = createHandToAccount(fixtures.reports, { recordJourney: async () => {}, reportKindOf: value => value });

test('a report retry repairs work joins without replacing report, review or outcome; conflicting replay is refused', async t => {
  const kind = `record:${invoke.list.row_type ?? invoke.list.id}`;
  const { door } = await world(t, ['list', kind]);
  let fails = true, notices = 0;
  const owners = { door, tools: [{ invoke }], keep: async file => ({ name: file.name }), tell: async () => { notices++; }, handOff: async () => { if (fails) throw new Error('work unavailable'); return { handoff: { handoff_id: 'work:1' } }; } };
  await assert.rejects(handoffs.keepHandOffOverDoor(owners, report()), /work unavailable/);
  const stored = [];
  for await (const row of door.list({ type: kind })) stored.push(row);
  assert.equal(stored.length, 1);
  const record = stored[0];
  assert.equal(record.value.note, 'Original report');
  await door.write([{ ...record, value: { ...record.value, review: 'approved', outcome: 'kept outcome' }, expected: { type: kind, value: record.value } }]);
  fails = false;
  const kept = await handoffs.keepHandOffOverDoor(owners, report());
  const after = await door.read(kind, kept.source_ref);
  assert.equal(after.review, 'approved');
  assert.equal(after.outcome, 'kept outcome');
  assert.equal(after.note, 'Original report');
  assert.equal(after.harness, 'Codex');
  assert.equal(after.sent_by, 'ai');
  assert.equal(after.their_words, 'their words');
  assert.equal(kept.work_ref, 'work:1');
  assert.equal(notices, 2);
  await assert.rejects(handoffs.keepHandOffOverDoor(owners, report('different report')), /different report/);
  await assert.rejects(handoffs.keepHandOffOverDoor(owners, { ...report(), invoke: { ...invoke, said: 'forged' } }), /not one Trillion sends/);
  assert.equal((await door.read(kind, kept.source_ref)).note, 'Original report');
});

test('the former-name counter keeps only closed-table ids and suppresses repeated names within its interval', async () => {
  const sent = [];
  const counter = createFormerNamesCounter({ formerNames: () => ({ ids: ['old-tool'], note_every_minutes: 1 }), serverEvent: (kind, facts) => ({ kind, facts }), noteInteractions: async (_, events) => sent.push(...events) });
  await counter.countFormerIds({}, ['unregistered-private-input', 'old-tool', 'old-tool'], 100);
  assert.deepEqual(sent, [{ kind: 'former_id_used', facts: { former_id: 'old-tool' } }]);
  assert.equal(counter.countFormerIds({}, ['old-tool'], 200), null);
  await counter.countFormerIds({}, ['old-tool'], 60101);
  assert.equal(sent.length, 2);
});
