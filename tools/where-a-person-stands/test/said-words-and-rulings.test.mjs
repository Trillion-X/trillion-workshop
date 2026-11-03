// tools/where-a-person-stands: words said elsewhere are kept only when they are literally in their source, and the record
// says where; a stand may name one rule and is then its own record; a reload never writes unverified words or a version
// already kept; the rulings log is append-only and its real rulings become calibration examples. Every source, word,
// ruling and rule here is made up for the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { bytesRef } from '../do-work/artifact-ref.mjs';
import { StanceRefusal, planReload, stanceRecord, standFrom, verbatimInSource } from '../do-work/where-a-person-stands.mjs';
import { examplesFromRulings, freshRulings } from '../do-work/rulings.mjs';

const FOLD = { lowercase: true, collapse_space: true, strip_trailing: '[.!?]+' };
const SOURCE = 'line one\nthe plum title is too loud\nline three\nthe plum title is fine now\n';

test('words are found literally in their source at or after the line named, and bound to its bytes', () => {
  const found = verbatimInSource('the plum title is fine now', SOURCE, { source: 'notes.md' });
  assert.equal(found.ok, true);
  const start = SOURCE.indexOf('the plum title is fine now');
  assert.deepEqual(found.binding, { source: 'notes.md', blake3: bytesRef(utf8ToBytes(SOURCE)), text: 'the plum title is fine now',
    byte_start: start, byte_end: start + 26, line: 4 });
  assert.equal(verbatimInSource('the plum title is too loud', SOURCE, { after_line: 2 }).binding.line, 2);
  assert.match(verbatimInSource('the plum title is too loud', SOURCE, { after_line: 3 }).reason, /at or after line 3/);
  assert.match(verbatimInSource('a zorblax I never said', SOURCE).reason, /do not appear literally/);
  assert.match(verbatimInSource('line one', SOURCE, { after_line: 9 }).reason, /fewer than 9 lines/);
  assert.equal(verbatimInSource('', SOURCE).ok, false);
});

test('in a JSON-lines source the escaped form of the words is found and bound as it is in the bytes', () => {
  const words = 'it\'s "quiet" now';
  const jsonl = `${JSON.stringify({ said: 'hello' })}\n${JSON.stringify({ said: words })}\n`;
  const found = verbatimInSource(words, jsonl, { source: 'chat.jsonl' });
  assert.deepEqual([found.ok, found.binding.encoding, found.binding.text, found.binding.line], [true, 'json-string', JSON.stringify(words).slice(1, -1), 2]);
  assert.equal(verbatimInSource(words, jsonl, { source: 'chat.md' }).ok, false);
});

test('a stand with a source keeps where its words were said, and words that are not there are refused', () => {
  const kept = stanceRecord({ kind: 'title', text: 'Plum notes', fold: FOLD, stance: 'agree', why: 'the plum title is fine now',
    answered_by: 'person', source: 'notes.md', source_text: SOURCE, after_line: 3, at: '2026-01-02T00:00:00Z' });
  assert.deepEqual([kept.said_from.source, kept.said_from.line, kept.why], ['notes.md', 4, 'the plum title is fine now']);
  assert.throws(() => stanceRecord({ kind: 'title', text: 'Plum notes', fold: FOLD, stance: 'agree', why: 'words I never wrote',
    answered_by: 'person', source: 'notes.md', source_text: SOURCE }), StanceRefusal);
  assert.equal(stanceRecord({ kind: 'title', text: 'Plum notes', fold: FOLD, stance: 'agree', answered_by: 'person' }).said_from, undefined);
});

test('a stand naming one rule is its own record, read back with its rule, and a bad rule id is refused', () => {
  const whole = stanceRecord({ kind: 'line', text: 'Not quite.', fold: FOLD, stance: 'agree', answered_by: 'person' });
  const waiver = stanceRecord({ kind: 'line', text: 'Not quite.', fold: FOLD, stance: 'agree', answered_by: 'person', rule: 'no-not-quite' });
  assert.equal(waiver.id, `${whole.id}:rule:no-not-quite`);
  assert.equal(waiver.rule, 'no-not-quite');
  assert.equal(standFrom({ versions: [{ version: 1, value: waiver, deleted: false, at: waiver.at }], next: null }).rule, 'no-not-quite');
  assert.equal('rule' in standFrom({ versions: [{ version: 1, value: whole, deleted: false, at: whole.at }], next: null }), false);
  for (const rule of ['', 'has space', 'a:b', 7]) {
    assert.throws(() => stanceRecord({ kind: 'line', text: 'Not quite.', fold: FOLD, stance: 'agree', answered_by: 'person', rule }), StanceRefusal);
  }
});

test('a reload lists words it cannot find as unverified, writes nothing of them, and writes no version already kept', () => {
  const rows = [
    { kind: 'title', text: 'Plum notes', stance: 'agree', why: 'the plum title is fine now', at: '2026-01-03T00:00:00Z', source: 'notes', after_line: 3,
      earlier: [{ stance: 'disagree', why: 'the plum title is too loud', at: '2026-01-02T00:00:00Z' }] },
    { kind: 'title', text: 'Grape notes', stance: 'disagree', why: 'never said this', at: '2026-01-04T00:00:00Z', source: 'notes' },
    { kind: 'title', text: 'Pear notes', stance: 'agree', why: 'no source named', at: '2026-01-05T00:00:00Z', source: 'missing' },
  ];
  const first = planReload({ stances: rows, fold: FOLD, sources: { notes: SOURCE } });
  assert.deepEqual(first.writes.map(write => [write.value.text, write.value.stance]), [['Plum notes', 'disagree'], ['Plum notes', 'agree']]);
  assert.equal(first.writes[1].value.said_from.line, 4);
  assert.deepEqual(first.summary.unverified.map(row => row.why), ['never said this', 'no source named']);
  assert.equal(first.summary.already, 0);
  const again = planReload({ stances: rows, fold: FOLD, sources: { notes: SOURCE }, kept: first.writes.map(write => write.value) });
  assert.deepEqual([again.writes.length, again.summary.already], [0, 2]);
});

test('the rulings log takes each (text, verdict, by, rule) once, and only real rulings become examples', () => {
  const at = '2026-01-01T00:00:00Z';
  const log = freshRulings([], [
    { text: 'Bad line.', verdict: 'bad', by: 'person', where: 'a' }, { text: 'Good line.', verdict: 'good', by: 'person', where: 'a' },
    { text: 'Torn line.', verdict: 'bad', by: 'person', where: 'a' }, { text: 'Torn line.', verdict: 'good', by: 'person', where: 'a' },
    { text: 'Trained line.', verdict: 'bad', by: 'person', where: 'a' }, { text: 'Helper line.', verdict: 'bad', by: 'helper', where: 'a' },
    { text: 'Nowhere line.', verdict: 'bad', by: 'person' }, { text: 'Bad line.', verdict: 'bad', by: 'person', where: 'b' },
  ], { at });
  assert.equal(log.length, 7);
  assert.equal(log[0].at, at);
  assert.deepEqual(freshRulings(log, [{ text: 'Bad line.', verdict: 'bad', by: 'person' }, { text: 'Bad line.', verdict: 'bad', by: 'person', rule: 'r' }]).map(row => row.rule), ['r']);
  const { items, left_out } = examplesFromRulings({ rulings: log, needs: ['where'], exclude: [['Trained line.', { text: 'My trained words.' }]],
    speech: [{ text: 'My own words.', sets: ['person'] }, { text: 'My trained words.', sets: ['person'] }, { text: 'Not mine.', sets: ['other'] }],
    contexts: { 'Bad line.': { before: 'Earlier.' } } });
  assert.deepEqual(items.map(item => [item.text, item.good, item.bad_for, item.source, item.context]), [
    ['Bad line.', false, ['real-bad'], 'ruling', { before: 'Earlier.' }], ['Good line.', true, [], 'ruling', null], ['My own words.', true, [], 'speech', null]]);
  assert.deepEqual(left_out, { both_rulings: 1, in_exclude: 2 });
});
