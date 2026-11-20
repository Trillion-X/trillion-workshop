import test from 'node:test';
import assert from 'node:assert/strict';
import { retireCopiedAiReply, threadIdOf } from '../do-work/retire-a-copied-ai-reply.mjs';

const common = { app: 'Codex', conversation_id: 'codex:one', speaker: 'ai', text: 'The change is live.' };
const row = (id, value) => ({ id, type: 'message', value });

test('an exact manual AI copy retires; the transcript reply keeps its links and gets the copy\'s links', () => {
  const manual = { ...common, at: '2026-10-03T05:04:29Z', about: [{ kind: 'pursuit', id: 'pursuit:one' }] };
  const source = { ...common, at: '2026-10-03T05:04:51Z', source_ref: 'msg_final' };
  const commentary = { ...common, text: 'Checking the live service.', at: '2026-10-03T05:04:40Z', source_ref: 'msg_commentary' };
  const records = [row('m:manual', manual), row('m:source', source), row('m:commentary', commentary)];
  const input = { records, duplicate_id: 'm:manual', kept_id: 'm:source', evidence: 'Transcript msg_final at 05:04:51Z matches manual copy at 05:04:29Z', now: '2026-10-03T06:00:00Z' };
  const { correction, keep } = retireCopiedAiReply(input);
  assert.equal(correction.duplicate_id, 'm:manual');
  assert.equal(correction.corrected_at, '2026-10-03T06:00:00.000Z');
  assert.deepEqual(keep.find(k => k.id === 'm:manual'), { id: 'm:manual', type: 'message', value: null, expected: manual });
  const kept = keep.find(k => k.id === 'm:source');
  assert.equal(kept.value.source_ref, 'msg_final');
  assert.deepEqual(kept.value.about, [{ kind: 'pursuit', id: 'pursuit:one' }]);
  assert.equal(keep.some(k => k.id === 'm:commentary'), false);
  assert.equal(keep.find(k => k.type === 'message-duplicate-correction').value, correction);
  assert.equal(keep.find(k => k.type === 'message-duplicate-correction').expected, null);
  // The same correction again answers the first one and keeps nothing.
  const again = retireCopiedAiReply({ ...input, records: [...records, row(`message-duplicate-correction:m:manual`, correction)] });
  assert.deepEqual(again, { correction, keep: [] });
});

test('duplicate correction refuses different text, conversation, or distant time', () => {
  const manual = { ...common, at: '2026-10-03T05:04:29Z' };
  const bad = [
    { ...manual, text: 'Commentary.', source_ref: 'commentary', at: '2026-10-03T05:04:51Z' },
    { ...manual, conversation_id: 'codex:other', source_ref: 'other', at: '2026-10-03T05:04:51Z' },
    { ...manual, source_ref: 'distant', at: '2026-10-03T05:08:00Z' },
  ];
  for (const source of bad) {
    const records = [row('m:manual', manual), row('m:source', source)];
    assert.throws(() => retireCopiedAiReply({ records, duplicate_id: 'm:manual', kept_id: 'm:source', evidence: 'test evidence' }),
      /exact nearby manual AI copy/);
  }
});

test('the request must name two different messages and evidence', () => {
  const records = [];
  assert.throws(() => retireCopiedAiReply({ records, duplicate_id: 'a', kept_id: 'a', evidence: 'x' }), /Two different message IDs/);
  assert.throws(() => retireCopiedAiReply({ records, duplicate_id: 'a', kept_id: 'b', evidence: '' }), /Two different message IDs/);
  assert.throws(() => retireCopiedAiReply({ duplicate_id: 'a', kept_id: 'b', evidence: 'x' }), /records must be the list/);
});

test('a thread index row for the copy is retired with it', () => {
  const manual = { ...common, at: '2026-10-03T05:04:29Z' };
  const source = { ...common, at: '2026-10-03T05:04:51Z', source_ref: 'msg_final' };
  const threadId = threadIdOf(manual, 'm:manual');
  const thread = { app: 'Codex', conversation_id: 'codex:one', message: 'm:manual' };
  const records = [row('m:manual', manual), row('m:source', source), row(threadId, thread)];
  const { keep } = retireCopiedAiReply({ records, duplicate_id: 'm:manual', kept_id: 'm:source', evidence: 'test evidence' });
  assert.deepEqual(keep.find(k => k.id === threadId), { id: threadId, type: 'message-thread-index', value: null, expected: thread });
});
