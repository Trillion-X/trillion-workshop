import test from 'node:test';
import assert from 'node:assert/strict';
import { correctAMessageRecordedAsThePerson, messageIdOf, threadIdOf } from '../do-work/correct-a-message-recorded-as-the-person.mjs';

const row = (id, value, type = 'message') => ({ id, type, value });
const person = { app: 'Codex', conversation_id: 'codex:one', speaker: 'person', text: 'Please check the build.', at: '2026-10-03T05:04:29Z', recorded_at: '2026-10-03T05:04:30Z' };

test('a person message recorded as the wrong speaker moves to a new id; its arrivals and thread row retire', () => {
  const id = messageIdOf(person);
  const arrivalIds = ['arrival:one', 'arrival:two'];
  const other = { ...person, at: '2026-10-03T05:09:00Z', text: 'Another message.' };
  const otherId = messageIdOf(other);
  const threadId = threadIdOf(person, id);
  const records = [
    row(id, person), row(threadId, { app: 'Codex', conversation_id: 'codex:one', message_id: id }, 'message-thread-index'),
    row(arrivalIds[0], { message_id: id }, 'arrival'), row(arrivalIds[1], { message_id: id }, 'arrival'),
    row('arrival:elsewhere', { message_id: otherId }, 'arrival'),
  ];
  const { correction, keep } = correctAMessageRecordedAsThePerson({ records, message_id: id, speaker: 'peer', evidence: 'The transcript names the reviewer as the author', now: '2026-10-03T06:00:00Z' });
  const revised = { ...person, speaker: 'peer' };
  delete revised.recorded_at;
  assert.equal(correction.corrected_message_id, messageIdOf(revised));
  assert.deepEqual(correction.retired_arrival_ids, arrivalIds);
  assert.deepEqual(keep.find(k => k.id === messageIdOf(revised)).value, { ...revised, recorded_at: person.recorded_at, corrected_from: id });
  assert.deepEqual(keep.find(k => k.id === id), { id, type: 'message', value: null, expected: person });
  assert.equal(keep.find(k => k.id === threadId).type, 'message-thread-index');
  assert.deepEqual(keep.filter(k => k.type === 'arrival').map(k => k.id).sort(), arrivalIds.slice().sort());
  assert.equal(keep.some(k => k.id === 'arrival:elsewhere'), false);
  // The same correction again answers the first one and keeps nothing.
  const again = correctAMessageRecordedAsThePerson({ records: [...records, row(`message-provenance-correction:${id}`, correction)], message_id: id, speaker: 'peer', evidence: 'The transcript names the reviewer as the author' });
  assert.deepEqual(again, { correction, keep: [] });
});

test('a correction for a message already corrected to another speaker is refused', () => {
  const id = messageIdOf(person);
  const records = [row(id, person), row(`message-provenance-correction:${id}`, { speaker: 'peer', evidence: 'first' })];
  assert.throws(() => correctAMessageRecordedAsThePerson({ records, message_id: id, speaker: 'generated context', evidence: 'second' }),
    /already has a different provenance correction/);
});

test('only a kept person message can be corrected, and the speaker and evidence are required', () => {
  const id = messageIdOf(person);
  const ai = { ...person, speaker: 'ai' };
  assert.throws(() => correctAMessageRecordedAsThePerson({ records: [row(id, ai)], message_id: id, speaker: 'peer', evidence: 'x' }), /currently kept person message/);
  assert.throws(() => correctAMessageRecordedAsThePerson({ records: [row(id, person)], message_id: id, speaker: 'person', evidence: 'x' }), /speaker \(sdk diagnostic/);
  assert.throws(() => correctAMessageRecordedAsThePerson({ records: [row(id, person)], message_id: id, speaker: 'peer', evidence: '' }), /speaker \(sdk diagnostic/);
});
