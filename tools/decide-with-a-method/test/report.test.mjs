// The report words (read-data/report.mjs), ported from the old app's src/report.mjs: resultWords, statusWords, statusLabel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resultWords, statusLabel, statusWords } from '../read-data/report.mjs';

const decided = { id: 'd1', decision: { option_id: 'a', move: 'Ship it' }, decided_at: '2026-11-10T09:00:00Z', decision_generation: 1 };

test('resultWords says what a settled result means in a person\'s words', () => {
  assert.equal(resultWords('met'), 'it worked');
  assert.equal(resultWords('failed'), 'it did not work');
  assert.equal(resultWords('unknown'), 'not sure yet');
});

test('resultWords shows an unlisted result as its own text, whitespace collapsed', () => {
  assert.equal(resultWords('  partly   done \n'), 'partly done');
});

test('statusWords shows the open sentence for a decision not decided yet', () => {
  assert.equal(statusWords({ id: 'd0', status: 'needs_decision' }), 'Open: not decided yet');
});

test('statusWords says what the AI did and that the person is still to hear, for a decision carried out', () => {
  const record = { ...decided, status: 'needs_outcome', carried_out: [{ decision_generation: 1, state: 'done', what_happened: 'sent the   invoice\nto Sam' }] };
  assert.equal(statusWords(record), 'Decided and carried out: sent the invoice to Sam. Waiting to hear how it went for you.');
});

test('statusWords names the wall the AI stopped at, not the done sentence, when the receipt says a wall', () => {
  const record = { ...decided, status: 'needs_outcome', carried_out: [{ decision_generation: 1, state: 'wall', what_happened: 'the file is locked' }] };
  assert.equal(statusWords(record), 'Decided; the AI stopped at a wall: the file is locked');
});

test('statusWords ignores the receipt of an earlier decision generation', () => {
  const record = { ...decided, status: 'needs_outcome', decision_generation: 2, carried_out: [{ decision_generation: 1, state: 'done', what_happened: 'old step' }] };
  assert.equal(statusWords(record), 'Decided: waiting to hear how it went');
});

test('statusWords shows the outcome the person reported as theirs, when a verified person report is the outcome', () => {
  const record = {
    ...decided, status: 'needs_outcome',
    reports: [{ result: 'met', answered_by: 'person', reported_at: '2026-11-12T10:00:00Z', person_source: { basis: 'signed_in_person_screen', source_ref: 'screen-7' } }],
  };
  assert.equal(statusWords(record), 'Decided: you said it worked');
});

test('statusWords marks a report that is not verified as reported for the person, never as theirs', () => {
  const record = {
    ...decided, status: 'needs_outcome',
    reports: [{ result: 'met', answered_by: 'person', reported_at: '2026-11-12T10:00:00Z', person_source: { basis: 'pasted_text', source_ref: 'chat-3' } }],
  };
  assert.equal(statusWords(record), 'Decided: reported for the person that it worked');
});

test('statusLabel gives the short label and tone of a status, and a quiet unknown status its own name', () => {
  assert.deepEqual(statusLabel('needs_outcome'), { label: 'Waiting for the result', tone: 'quiet' });
  assert.deepEqual(statusLabel('outcome_verified'), { label: 'It worked', tone: 'good' });
  assert.deepEqual(statusLabel('correction_needed'), { label: 'Needs a new decision', tone: 'attention' });
  assert.deepEqual(statusLabel('some_new_status'), { label: 'some_new_status', tone: 'quiet' });
});
