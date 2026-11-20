import test from 'node:test';
import assert from 'node:assert/strict';
import { correctWhenAMessageWasWritten } from '../do-work/correct-when-a-message-was-written.mjs';

const NOW = '2026-10-05T07:00:00.000Z';
const captured = { app: 'Muse', conversation_id: 'muse:one', speaker: 'person', text: 'Chat from the old app.', at: '2026-10-05T06:00:00.000Z', recorded_by: 'app:Muse' };
const row = (id, value, type = 'message') => ({ id, type, value });
const input = (over = {}) => ({ records: [row('message:old', captured)], message_id: 'message:old', authored_at: '2026-09-27T17:13:00Z', evidence: 'The old chat export shows this message on Sept 27', now: NOW, ...over });

test('a kept person message shows the exact time the person wrote it; its id and text stay', () => {
  const { correction, keep } = correctWhenAMessageWasWritten(input());
  assert.deepEqual(correction, { message_id: 'message:old', authored_at: '2026-09-27T17:13:00.000Z', captured_at: captured.at, evidence: 'The old chat export shows this message on Sept 27', corrected_at: NOW });
  assert.deepEqual(keep.find(k => k.id === 'message:old'), { id: 'message:old', type: 'message', value: { ...captured, authored_at: '2026-09-27T17:13:00.000Z', captured_at: captured.at }, expected: captured });
  assert.equal(keep.find(k => k.type === 'message-time-correction').value, correction);
});

test('the same correction again answers the first one and keeps nothing; a different one is refused', () => {
  const first = correctWhenAMessageWasWritten(input());
  assert.deepEqual(correctWhenAMessageWasWritten(input({ records: [row('message:old', captured), row('message-time-correction:message:old', first.correction)] })), { correction: first.correction, keep: [] });
  assert.throws(() => correctWhenAMessageWasWritten(input({ records: [row('message:old', captured), row('message-time-correction:message:old', first.correction)], authored_at: '2026-09-28T00:00:00Z' })),
    /different time correction/);
});

test('a time ahead of the clock, a non-time, and missing evidence are refused', () => {
  assert.throws(() => correctWhenAMessageWasWritten(input({ authored_at: '2027-01-01T00:00:00Z' })), /has not happened yet/);
  assert.throws(() => correctWhenAMessageWasWritten(input({ authored_at: 'next tuesday' })), /authored_at, and source evidence are required/);
  assert.throws(() => correctWhenAMessageWasWritten(input({ evidence: '' })), /authored_at, and source evidence are required/);
});

test('only a kept person message can be dated, and never after its capture time', () => {
  assert.throws(() => correctWhenAMessageWasWritten(input({ records: [row('message:old', { ...captured, speaker: 'ai' })] })), /kept person message is required/);
  assert.throws(() => correctWhenAMessageWasWritten(input({ authored_at: '2026-10-05T06:30:00Z' })), /cannot follow the stored capture time/);
});
