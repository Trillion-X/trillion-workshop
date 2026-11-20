// The program descriptor reader and the per-day sequence reader, on made-up circles. Carried from the original fold's six
// tests (object and JSON-text payloads, rejection, unknown fields kept, a book club folding the same way, latest wins),
// and the sequence reader's day order. The original's storage key and its ten ref addresses are not carried: a
// program's ref fields are plain data, kept on `extra`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldInteractionProgram, foldInteractionPrograms, readDailySequence } from '../read-data/interaction-program-fold.mjs';

const WEEKLY = {
  kind: 'interaction-program',
  id: 'weekly-circle',
  partition_key: 'runtime-partition',
  label: 'Weekly Circle',
  pairing: { group_size: 2, order: 'similarity-desc', exclusion: 'prior-cycles' },
  group_ref: 'group:circle-members',
  participant_source_ref: 'person-list:opted-in',
  daily_context_sequence_ref: 'context-feed.sequence:weekly-themes',
  surface_ref: 'documents.page:circle-home',
};

test('folds a valid program into its id, label and pairing, with its other fields kept on extra', () => {
  const p = foldInteractionProgram({ payload: WEEKLY });
  assert.equal(p.id, 'weekly-circle');
  assert.equal(p.label, 'Weekly Circle');
  assert.equal(p.pairing.group_size, 2);
  assert.equal(p.extra.surface_ref, 'documents.page:circle-home');
  assert.equal('refs' in p, false);
  assert.equal('partition_key' in p.extra, false);
});

test('rejects non-descriptor records: returns null, never throws', () => {
  assert.equal(foldInteractionProgram({ payload: { kind: 'connection', id: 'x' } }), null);
  assert.equal(foldInteractionProgram({ payload: null }), null);
  assert.equal(foldInteractionProgram({ payload: { kind: 'interaction-program' } }), null);
  assert.equal(foldInteractionProgram({}), null);
});

test('parses JSON-text payloads (as the log stores them) identically to object payloads, and refuses text that is not JSON', () => {
  const asText = foldInteractionProgram({ value_json: JSON.stringify(WEEKLY) });
  assert.deepEqual(asText, foldInteractionProgram({ payload: WEEKLY }));
  assert.equal(asText.id, 'weekly-circle');
  assert.equal(foldInteractionProgram({ value_json: '{not json' }), null);
  assert.equal(foldInteractionProgram({ value_json: '[1,2]' }), null);
});

test('unknown extra fields are preserved on extra, not dropped', () => {
  const p = foldInteractionProgram({ payload: { ...WEEKLY, custom_knob: 42, season: 'spring' } });
  assert.equal(p.extra.custom_knob, 42);
  assert.equal(p.extra.season, 'spring');
});

test('a book club folds the same way from its own data: no branch on what the program is', () => {
  const bookClub = {
    payload: {
      kind: 'interaction-program',
      id: 'book-club',
      label: 'Monthly Book Club',
      pairing: { group_size: 2 },
      group_ref: 'group:readers',
      time_window_ref: 'timed-action.window:30day',
    },
  };
  const p = foldInteractionProgram(bookClub);
  assert.equal(p.id, 'book-club');
  assert.equal(p.label, 'Monthly Book Club');
  assert.equal(p.pairing.group_size, 2);
  assert.equal(p.extra.time_window_ref, 'timed-action.window:30day');
});

test('foldInteractionPrograms maps by id, and the later record wins', () => {
  const map = foldInteractionPrograms([
    { payload: WEEKLY },
    { payload: { ...WEEKLY, label: 'Weekly Circle v2' } },
    { payload: { kind: 'connection', id: 'not-a-program' } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get('weekly-circle').label, 'Weekly Circle v2');
  assert.equal(foldInteractionPrograms(undefined).size, 0);
});

test('readDailySequence returns the days in day order, each with its title and prompt', () => {
  const seq = readDailySequence({
    id: 'circle:weekly-themes',
    for_program: 'weekly-circle',
    days: [
      { day: 3, title: 'Third', prompt_text: 'Name one thing you tried.' },
      { day: 1, title: 'First', prompt_text: 'Say hello.' },
      { day: 2, title: 'Second', prompt_text: 'Ask a question.' },
      'not a day',
    ],
  });
  assert.equal(seq.id, 'circle:weekly-themes');
  assert.equal(seq.forProgram, 'weekly-circle');
  assert.deepEqual(seq.days.map((d) => d.day), [1, 2, 3]);
  assert.deepEqual(seq.days[0], { day: 1, title: 'First', prompt: 'Say hello.' });
});

test('readDailySequence without a string id, or with no days, is null or empty and never throws', () => {
  assert.equal(readDailySequence({ days: [] }), null);
  assert.equal(readDailySequence(null), null);
  assert.deepEqual(readDailySequence({ id: 'empty' }).days, []);
});
