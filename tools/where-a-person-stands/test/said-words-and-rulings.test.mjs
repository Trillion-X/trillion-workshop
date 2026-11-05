// tools/where-a-person-stands: words said elsewhere are kept only when they are literally in their source, and the record
// says where; a stand may name one rule and is then its own record; a reload never writes unverified words or a version
// already kept, and checks every earlier stand against its own source; a ruling is one record per (text, verdict, by,
// rule), the list's refuse setting refuses a write holding a test row, and real rulings and picks become calibration examples and counts.
// Every source, word, ruling, pick and rule here is made up for the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { bytesRef } from '../do-work/artifact-ref.mjs';
import { StanceRefusal, planReload, stanceRecord, standFrom, verbatimInSource } from '../do-work/where-a-person-stands.mjs';
import { examplesFromRulings } from '../do-work/rulings.mjs';
import { RulingRefusal, rulingRecordId, rulingRecords } from '../do-work/ruling-records.mjs';
import { rulingStatus } from '../do-work/ruling-status.mjs';
import { examplesFromPicks } from '../do-work/picks.mjs';

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

test('a reload checks every earlier stand against its own source and names a row it cannot verify by its record id', () => {
  const rows = [
    { kind: 'title', text: 'Plum notes', stance: 'agree', why: 'the plum title is fine now', at: '2026-01-03T00:00:00Z', source: 'notes', after_line: 3,
      earlier: [{ stance: 'disagree', why: 'the plum title is too loud', at: '2026-01-02T00:00:00Z', source: 'notes', after_line: 2 }] },
    { kind: 'title', text: 'Fig notes', stance: 'agree', why: 'the plum title is fine now', at: '2026-01-03T00:00:00Z', source: 'notes',
      earlier: [{ stance: 'disagree', why: 'an earlier word I never wrote', at: '2026-01-02T00:00:00Z', source: 'notes' }] },
  ];
  const plan = planReload({ stances: rows, fold: FOLD, sources: { notes: SOURCE } });
  assert.deepEqual(plan.writes.map(write => [write.value.text, write.value.stance, write.value.said_from.line]),
    [['Plum notes', 'disagree', 2], ['Plum notes', 'agree', 4]]);
  const fig = stanceRecord({ kind: 'title', text: 'Fig notes', fold: FOLD, stance: 'agree', answered_by: 'person' });
  assert.deepEqual(plan.summary.unverified.map(row => [row.id, row.why]), [[fig.id, 'an earlier word I never wrote']]);
});

test('a ruling is one record per (text, verdict, by, rule), a ruling already in the list is not written again, and a refused row refuses the write', () => {
  const at = '2026-01-01T00:00:00Z';
  const refuse = [{ field: 'piece', one_of: ['practice-piece'] }, { field: 'where', contains_one_of: ['/scratch-'] }];
  const existing = [{ id: 'record:line-rulings:x', type: 'record:line-rulings', value: { text: 'Old line.', verdict: 'bad', by: 'person', at: '2025-12-01T00:00:00Z' } }];
  const { write, fresh } = rulingRecords({ row_type: 'line-rulings', at, refuse, existing, rows: [
    { text: 'Bad line.', verdict: 'bad', by: 'person', where: 'pieces/a/script.md:3' },
    { text: 'Bad line.', verdict: 'bad', by: 'person', where: 'pieces/b/script.md:9' },
    { text: 'Bad line.', verdict: 'bad', by: 'person', rule: 'r', at: '2026-01-02T00:00:00Z' },
    { text: 'Old line.', verdict: 'bad', by: 'person' },
  ] });
  assert.equal(fresh, 2);
  assert.deepEqual(write.records.map(record => [record.type, record.value.text, record.value.rule ?? null, record.value.at, record.value.where ?? null]), [
    ['record:line-rulings', 'Bad line.', null, at, 'pieces/a/script.md:3'], ['record:line-rulings', 'Bad line.', 'r', '2026-01-02T00:00:00Z', null]]);
  assert.equal(write.records[0].id, rulingRecordId('line-rulings', { text: 'Bad line.', verdict: 'bad', by: 'person' }));
  assert.match(write.records[0].id, /^record:line-rulings:[0-9a-f]{64}$/);
  assert.notEqual(write.records[0].id, write.records[1].id);
  for (const row of [{ text: 'Odd line.', verdict: 'escalated', by: 'small-model', rule: 'r', p_fail: 0.99, piece: 'practice-piece' },
    { text: 'Temp line.', verdict: 'escalated', by: 'small-model', where: 'scratch-7/script.md:1' }]) {
    assert.throws(() => rulingRecords({ row_type: 'line-rulings', refuse, rows: [{ text: 'Fine.', verdict: 'good', by: 'person' }, row] }), /REFUSED: 1 row/);
  }
  assert.throws(() => rulingRecords({ row_type: 'Line Rulings', rows: [] }), RulingRefusal);
  assert.throws(() => rulingRecords({ row_type: 'line-rulings', rows: [{ text: 'No verdict.', by: 'person' }] }), RulingRefusal);
});

test('only real rulings become examples, and a text ruled both ways or trained on is left out and counted', () => {
  const log = [
    { text: 'Bad line.', verdict: 'bad', by: 'person', where: 'a' }, { text: 'Good line.', verdict: 'good', by: 'person', where: 'a' },
    { text: 'Torn line.', verdict: 'bad', by: 'person', where: 'a' }, { text: 'Torn line.', verdict: 'good', by: 'person', where: 'a' },
    { text: 'Trained line.', verdict: 'bad', by: 'person', where: 'a' }, { text: 'Helper line.', verdict: 'bad', by: 'helper', where: 'a' },
    { text: 'Nowhere line.', verdict: 'bad', by: 'person' }, { text: 'Bad line.', verdict: 'bad', by: 'person', where: 'b' },
  ];
  const { items, left_out } = examplesFromRulings({ rulings: log, needs: ['where'], exclude: [['Trained line.', { text: 'My trained words.' }]],
    speech: [{ text: 'My own words.', sets: ['person'] }, { text: 'My trained words.', sets: ['person'] }, { text: 'Not mine.', sets: ['other'] }],
    contexts: { 'Bad line.': { before: 'Earlier.' } } });
  assert.deepEqual(items.map(item => [item.text, item.good, item.bad_for, item.source, item.context]), [
    ['Bad line.', false, ['real-bad'], 'ruling', { before: 'Earlier.' }], ['Good line.', true, [], 'ruling', null], ['My own words.', true, [], 'speech', null]]);
  assert.deepEqual(left_out, { both_rulings: 1, in_exclude: 2 });
});

test('the count names the real bad lines to check, then how many each rule catches at its own threshold', () => {
  const rulings = [
    { text: 'Bad one.', verdict: 'bad', by: 'person', piece: 'p', where: 'p/s.md:1' }, { text: 'Bad one.', verdict: 'bad', by: 'person', piece: 'p' },
    { text: 'Bad two.', verdict: 'bad', by: 'person', piece: 'p', kind: 'title' }, { text: 'Bad three.', verdict: 'bad', by: 'helper', piece: 'p' },
    { text: 'Loose.', verdict: 'bad', by: 'person' }, { text: 'Flagged.', verdict: 'escalated', by: 'small-model', rule: 'r1' },
  ];
  const first = rulingStatus({ rulings, real: ['person'], needs: ['piece'], needed: 3 });
  assert.deepEqual([first.real_bad_film, first.promotion_allowed, first.counts], [2, false, { 'person bad': 4, 'helper bad': 1, 'small-model escalated': 1 }]);
  assert.deepEqual(first.bad_lines, [{ text: 'Bad one.', kind: 'line', where: 'p', also_at: [] }, { text: 'Bad two.', kind: 'title', where: 'p', also_at: [] }]);
  const results = [{ text: 'Bad one.', uncertain: [{ rule: 'r1', p_fail: 0.9 }, { rule: 'r2', p_fail: 0.5 }] }, { text: 'Bad two.', uncertain: [{ rule: 'r2', p_fail: null }] }];
  const second = rulingStatus({ rulings, real: ['person'], needs: ['piece'], needed: 2, rules: [{ id: 'r1', ask: { calibration: { t_fail: 0.8 } } }, { id: 'r2', ask: { calibration: { t_fail: 0.6 } } }, { id: 'r3', ask: {} }], results });
  assert.deepEqual([second.promotion_allowed, second.escalated_by_any, second.per_rule, second.unanswered], [true, 1, { r1: 1, r2: 0, r3: 0 }, 1]);
});

test('picks imply examples: a picked option is good but for the lines it names, a rejection is bad only where it names lines', () => {
  const gate = { picked_verdicts: ['picked'], pick_labels: { spec_globs: ['cuts/**/specs/{option}.json'], words: { cuts: 'cuts/words.json' },
    exclude: { o1: [{ text: 'Criticised later.' }] } } };
  const decisions = [
    { option_id: 'o1', verdict: 'rejected', lines: ['Old.'] }, { option_id: 'o1', verdict: 'picked', lines: ['Named in pick.'], reason_verbatim: 'this one' },
    { option_id: 'o2', verdict: 'rejected-tone', lines: ['Too loud.'] }, { option_id: 'o3', verdict: 'rejected' }, { option_id: 'o4', verdict: 'picked' },
    { option_id: 'o5', verdict: 'picked' },
  ];
  const files = ['cuts/a/specs/o1.json', 'cuts/b/specs/o2.json', 'cuts/a/specs/o5.json', 'cuts/b/specs/o5.json', 'cuts/a/specs/o3.json', 'notes.md'];
  const film = { name: 'piece-1', gate, decisions, files };
  const asked = examplesFromPicks({ films: [film] });
  assert.deepEqual(asked.units_needed, [{ film: 'piece-1', spec: 'cuts/a/specs/o1.json', words: 'cuts/words.json' }, { film: 'piece-1', spec: 'cuts/b/specs/o2.json', words: 'cuts/words.json' }]);
  assert.deepEqual([asked.left_out.no_spec, asked.left_out.several_specs], [['o4'], ['o5']]);
  const units = {
    'cuts/a/specs/o1.json': [{ text: 'Kept.', kind: 'onscreen' }, { text: 'Named in pick.', kind: 'narrator' }, { text: 'Criticised later.', kind: 'onscreen' },
      { text: 'Ruled.', kind: 'onscreen' }, { text: 'Both ways.', kind: 'narrator' }],
    'cuts/b/specs/o2.json': [{ text: 'Too loud.', kind: 'narrator' }, { text: 'Quiet.', kind: 'narrator' }, { text: 'Both ways.', kind: 'narrator' }],
  };
  const done = examplesFromPicks({ films: [{ ...film, units: { ...units, 'cuts/b/specs/o2.json': [...units['cuts/b/specs/o2.json']] } }],
    rulings: [{ text: 'Ruled.', verdict: 'bad', by: 'person', piece: 'piece-1' }], needs: ['piece'] });
  assert.deepEqual(done.items.map(item => [item.text, item.good, item.option, item.their_words]), [['Kept.', true, 'o1', 'this one'], ['Both ways.', true, 'o1', 'this one'], ['Too loud.', false, 'o2', null]]);
  assert.deepEqual([done.left_out.excluded, done.left_out.ruled_directly, done.left_out.both_labels, done.units_needed], [2, 1, 0, []]);
  const torn = examplesFromPicks({ films: [{ ...film, decisions: [...decisions, { option_id: 'o2', verdict: 'rejected-tone', lines: ['Too loud.', 'Both ways.'] }], units }] });
  assert.equal(torn.left_out.both_labels, 1);
  assert.equal(torn.items.some(item => item.text === 'Both ways.'), false);
});
