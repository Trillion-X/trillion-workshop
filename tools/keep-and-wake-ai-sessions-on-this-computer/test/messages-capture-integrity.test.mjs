import test from 'node:test';
import assert from 'node:assert/strict';
import { localStore } from '../src/local-store.mjs';
import { messages, mustUseTranscriptForPerson } from '../src/messages.mjs';

test('coding app replies require a transcript row identity', () => {
  const batch = message => ({ messages: [message] });
  assert.equal(mustUseTranscriptForPerson('app:Codex', 'Codex', batch({ speaker: 'person', text: 'Go' })), true);
  assert.equal(mustUseTranscriptForPerson('app:Codex', 'Codex', batch({ speaker: 'ai', text: 'Done' })), true);
  assert.equal(mustUseTranscriptForPerson('app:Claude Code', 'Claude Code', batch({ speaker: 'ai', text: 'Done' })), true);
  assert.equal(mustUseTranscriptForPerson('app:Codex', 'Codex', batch({ speaker: 'ai', text: 'Done', source_ref: 'msg_final' })), false);
  assert.equal(mustUseTranscriptForPerson(null, null, batch({ app: 'Codex', speaker: 'ai', text: 'Done' })), true);
  assert.equal(mustUseTranscriptForPerson(null, null, batch({ app: 'Codex', speaker: 'ai', text: 'Done', source_ref: 'msg_final' })), false);
  assert.equal(mustUseTranscriptForPerson('app:Muse', 'Muse', batch({ speaker: 'ai', text: 'Done' })), false);
});

test('exact manual AI duplicate retires, keeps transcript reply and merges its links', () => {
  const eeaf = localStore(':memory:').eeaf;
  const kept = messages(eeaf, { now: () => new Date('2026-10-03T06:00:00Z') });
  const common = { app: 'Codex', conversation_id: 'codex:one', speaker: 'ai', text: 'The change is live.' };
  const manualId = kept.record({ messages: [{ ...common, at: '2026-10-03T05:04:29Z', about: [{ kind: 'pursuit', id: 'pursuit:one' }] }] }).ids[0];
  const sourceId = kept.record({ messages: [{ ...common, at: '2026-10-03T05:04:51Z', source_ref: 'msg_final' }] }).ids[0];
  const commentaryId = kept.record({ messages: [{ ...common, text: 'Checking the live service.', at: '2026-10-03T05:04:40Z', source_ref: 'msg_commentary' }] }).ids[0];
  assert.equal(kept.read({ conversation_id: common.conversation_id }).messages.length, 3);
  const input = { duplicate_id: manualId, kept_id: sourceId, evidence: 'Transcript msg_final at 05:04:51Z matches manual copy at 05:04:29Z' };
  const correction = kept.correctDuplicate(input);
  assert.equal(correction.duplicate_id, manualId);
  assert.equal(eeaf.read(manualId), null);
  assert.equal(eeaf.read(sourceId).source_ref, 'msg_final');
  assert.deepEqual(eeaf.read(sourceId).about, [{ kind: 'pursuit', id: 'pursuit:one' }]);
  assert.equal(eeaf.read(commentaryId).text, 'Checking the live service.');
  assert.deepEqual(kept.read({ conversation_id: common.conversation_id }).messages.map(row => row.id).sort(), [commentaryId, sourceId].sort());
  assert.deepEqual(kept.correctDuplicate(input), correction);
  assert.equal(eeaf.read(`message-duplicate-correction:${manualId}`).duplicate.text, common.text);
});

test('duplicate correction refuses different text, conversation, or distant time', () => {
  const kept = messages(localStore(':memory:').eeaf);
  const base = { app: 'Codex', conversation_id: 'codex:one', speaker: 'ai', text: 'Final.', at: '2026-10-03T05:04:29Z' };
  const manual = kept.record({ messages: [base] }).ids[0];
  const rows = [
    { ...base, text: 'Commentary.', source_ref: 'commentary', at: '2026-10-03T05:04:51Z' },
    { ...base, conversation_id: 'codex:other', source_ref: 'other', at: '2026-10-03T05:04:51Z' },
    { ...base, source_ref: 'distant', at: '2026-10-03T05:08:00Z' },
  ];
  for (const row of rows) {
    const source = kept.record({ messages: [row] }).ids[0];
    assert.throws(() => kept.correctDuplicate({ duplicate_id: manual, kept_id: source, evidence: 'test evidence' }), /exact nearby manual AI copy/);
  }
  assert.equal(kept.read({ conversation_id: base.conversation_id }).messages.length, 3);
});
