// tools/where-a-person-stands: the copy gate's verdict-log tests (source-repo-a tools/copy-gate/tests/check.test.mjs
// and real-log-untouched.test.mjs), ported to rulings kept as rows of a person's list: a ruling is written once, a test
// piece or a temporary folder never reaches the list, only real rulings count and become examples, a model row catches a
// line only at its own t_fail, picks follow the latest decision, and the person's setting is read by tools/settings. Every
// line, person, piece and setting here is made up for the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRecord } from '../../settings/read-data/settings.mjs';
import { examplesFromRulings, makeExamplesFromRulings, withSettings } from '../do-work/rulings.mjs';
import { RulingRefusal, keepRulings, rulingRecords } from '../do-work/ruling-records.mjs';
import { countRealRulings, rulingStatus } from '../do-work/ruling-status.mjs';
import { examplesFromPicks } from '../do-work/picks.mjs';
import { countStands } from '../do-work/where-a-person-stands.mjs';

// The person's setting for this tool, as a made-up row of list:settings would hold it.
const SETTING = {
  row_type: 'line-rulings',
  real: ['person'],
  needs: ['film'],
  needed: 3,
  bad_label: 'real-bad-film',
  default_kind: 'voiceover',
  place: { field: 'film', pattern: 'films/([^/]+)/' },
  refuse: [{ field: 'film', one_of: ['test-piece'] }, { field: 'where', contains_one_of: ['/scratch-test-', 'synthetic-54752b612923', '/tmp/', '/.local/'] }],
  hand_rulings: { verdict: ['bad', 'good'], by: ['reviewer'] },
};
const values = write => write.records.map(record => record.value);
const RULES = [{ id: 'ask-plain', ask: { calibration: { status: 'usable', t_fail: 0.6 } } }];
const answered = (lines, p_fail) => lines.map(line => ({ text: line.text, uncertain: RULES.map(rule => ({ rule: rule.id, p_fail })) }));

test('the rulings list takes each (text, verdict, by, rule) once and counts only real bad film rulings', () => {
  const bad = { text: 'A line that says too much.', verdict: 'bad', by: 'person', where: 'films/x/SCRIPT.md:3' };
  const first = rulingRecords({ ...SETTING, rows: [bad, bad] });
  assert.equal(first.fresh, 1);
  const second = rulingRecords({ ...SETTING, existing: first.write.records, rows: [bad, { ...bad, by: 'reviewer' }, { ...bad, verdict: 'escalated', by: 'small-model', rule: 'ask-plain' }] });
  assert.equal(second.fresh, 2);
  const list = [...values(first.write), ...values(second.write)];
  assert.equal(list.length, 3);
  assert.equal(list[0].film, 'x');
  const before = JSON.stringify(list);
  const counted = rulingStatus({ ...SETTING, rulings: list });
  assert.deepEqual([counted.real_bad_film, counted.promotion_allowed], [1, false]);
  const s = rulingStatus({ ...SETTING, rulings: list, rules: RULES, results: answered(counted.bad_lines, 0.999) });
  assert.equal(s.escalated_by_any, 1);
  assert.equal(JSON.stringify(list), before);
});

test('the count calls a bad line caught only at or over the row t_fail', () => {
  const rulings = [{ text: 'A line that says too much.', verdict: 'bad', by: 'person', film: 'x', where: 'films/x/SCRIPT.md:3' }];
  const { bad_lines } = rulingStatus({ ...SETTING, rulings });
  assert.equal(rulingStatus({ ...SETTING, rulings, rules: RULES, results: answered(bad_lines, 0.01) }).escalated_by_any, 0);
  assert.equal(rulingStatus({ ...SETTING, rulings, rules: RULES, results: answered(bad_lines, 0.6) }).per_rule['ask-plain'], 1);
  assert.equal(rulingStatus({ ...SETTING, rulings, rules: RULES, results: answered(bad_lines, null) }).unanswered, 1);
});

test('a ruling with no kind is counted with the setting\'s default kind, so the check asks only the rows for that kind', () => {
  const { bad_lines } = rulingStatus({ ...SETTING, rulings: [{ text: 'Kindless.', verdict: 'bad', by: 'person', film: 'x' },
    { text: 'A title.', verdict: 'bad', by: 'person', film: 'x', kind: 'title' }] });
  assert.deepEqual(bad_lines.map(line => [line.text, line.kind, line.where]), [['Kindless.', 'voiceover', 'x'], ['A title.', 'title', 'x']]);
});

test('examples come only from real film rulings; a text ruled both ways or in a model\'s training lines is left out', () => {
  const rulings = values(rulingRecords({ ...SETTING, rows: [
    { text: 'Bad line.', verdict: 'bad', by: 'person', film: 'f' },
    { text: 'Good line.', verdict: 'good', by: 'person', film: 'f' },
    { text: 'Torn line.', verdict: 'bad', by: 'person', film: 'f' }, { text: 'Torn line.', verdict: 'good', by: 'person', film: 'f' },
    { text: 'Trained line.', verdict: 'bad', by: 'person', film: 'f' },
    { text: 'Reviewer line.', verdict: 'bad', by: 'reviewer', film: 'f' },
    { text: 'No film.', verdict: 'bad', by: 'person' },
  ] }).write);
  const speech = ['Their words.', 'Their trained words.'].map(text => ({ text, sets: ['person'], bad_for: [] }));
  const { items, left_out } = examplesFromRulings({ ...SETTING, rulings, speech, exclude: [['Trained line.', 'Their trained words.']] });
  assert.deepEqual(items.map(item => [item.text, item.good, item.bad_for, item.source]), [
    ['Bad line.', false, ['real-bad-film'], 'ruling'], ['Good line.', true, [], 'ruling'], ['Their words.', true, [], 'speech']]);
  assert.deepEqual(left_out, { both_rulings: 1, in_exclude: 2 });
});

test('a test piece or a temporary folder never reaches the list: the whole write is refused', () => {
  const row = { text: 'A synthetic line.', verdict: 'escalated', by: 'small-model', rule: 'r', where: 'test-piece' };
  for (const where of ['/privatesynthetic-54752b612923xx/T/scratch-test-abc/films/test-piece/specs/a.json', 'elsewhere']) {
    const one = where === 'elsewhere' ? { ...row, film: 'test-piece', where } : { ...row, where };
    assert.throws(() => rulingRecords({ ...SETTING, rows: [{ ...row, where: 'films/real/a.json' }, one] }), /REFUSED: 1 row\(s\) come from a test piece or a temporary folder/);
  }
});

test('a run on a .local/ scratch folder never reaches the list, by relative or absolute path', () => {
  const row = { text: 'A synthetic line.', verdict: 'escalated', by: 'small-model', rule: 'r' };
  assert.throws(() => rulingRecords({ ...SETTING, rows: [{ ...row, where: '.local/scratch/slides.txt:4' }] }), RulingRefusal);
  assert.throws(() => rulingRecords({ ...SETTING, rows: [{ ...row, where: '/somewhere/checkout/.local/scratch/slides.txt:4' }] }), RulingRefusal);
});

test('a real film row is not a refused row', () => {
  const { write } = rulingRecords({ ...SETTING, rows: [{ text: 'A synthetic line.', verdict: 'escalated', by: 'small-model', rule: 'r', where: 'checkout/films/a-film/a.json' }] });
  assert.deepEqual(values(write).map(value => value.film), ['a-film']);
});

test('a ruling given by hand uses only the words the setting allows', () => {
  const row = { text: 'A line.', verdict: 'bad', by: 'reviewer' };
  assert.equal(rulingRecords({ ...SETTING, by_hand: true, rows: [row] }).fresh, 1);
  assert.throws(() => rulingRecords({ ...SETTING, by_hand: true, rows: [{ ...row, verdict: 'meh' }] }), /verdict to be one of bad, good/);
  assert.throws(() => rulingRecords({ ...SETTING, by_hand: true, rows: [{ ...row, by: 'someone' }] }), /by to be one of reviewer/);
  assert.equal(rulingRecords({ ...SETTING, rows: [{ ...row, verdict: 'escalated', by: 'small-model' }] }).fresh, 1);
});

test('picks follow the pick ledger: the latest picked row gives good, a standing rejection gives its named lines bad', () => {
  const spec = option => `specs/${option}.json`;
  const units = Object.fromEntries(Object.entries({
    o1: ['Kept card', 'Criticised card', 'Ruled line'], o2: ['Named bad', 'Other string'], o3: ['Withdrawn pick'], o4: ['Leaning only'],
    o5: ['Row-named bad', 'Unnamed string', 'Picked but criticised'], o6: ['Picked fine', 'Picked but criticised'],
  }).map(([option, texts]) => [spec(option), texts.map(text => ({ text, kind: 'onscreen', context: null }))]));
  const film = { name: 'film', files: Object.keys(units), units,
    gate: { picked_verdicts: ['picked', 'picked-with-changes'], pick_labels: { text_keys: '^text$', spec_globs: ['specs/{option}.json'],
      exclude: { o1: [{ text: 'Criticised card', why: 'their note' }] }, rejected_lines: { o2: { lines: ['Named bad'] } } } },
    decisions: [
      { option_id: 'o1', verdict: 'picked-with-changes', reason_verbatim: 'keep it' },
      { option_id: 'o2', verdict: 'rejected', reason_verbatim: 'that card makes no sense' },
      { option_id: 'o3', verdict: 'picked' }, { option_id: 'o3', verdict: 'rejected' },
      { option_id: 'o4', verdict: 'leaning' }, { option_id: 'gone', verdict: 'picked' },
      { option_id: 'o5', verdict: 'rejected-as-built', lines: ['Row-named bad'] }, { option_id: 'o6', verdict: 'picked', lines: ['Picked but criticised'] }] };
  const unlabelled = { name: 'no-labels', files: [], gate: { picked_verdicts: ['picked'] }, decisions: [{ option_id: 'o1', verdict: 'picked' }] };
  const rulings = [{ text: 'Ruled line', verdict: 'bad', by: 'person', film: 'f' }];
  const { items, left_out, units_needed } = examplesFromPicks({ ...SETTING, films: [film, unlabelled], rulings });
  assert.deepEqual(items.map(item => [item.text, item.good, item.source, item.option, item.their_words]),
    [['Kept card', true, 'pick-implied', 'o1', 'keep it'], ['Named bad', false, 'pick-implied', 'o2', 'that card makes no sense'],
      ['Row-named bad', false, 'pick-implied', 'o5', null], ['Picked fine', true, 'pick-implied', 'o6', null]]);
  assert.deepEqual(items.map(item => item.bad_for), [[], ['real-bad-film'], ['real-bad-film'], []]);
  assert.deepEqual(left_out, { excluded: 2, ruled_directly: 1, both_labels: 0, no_spec: ['gone'], several_specs: [] });
  assert.deepEqual(units_needed, []);
  assert.equal(rulings.length, 1);
});

test('the stands read back are counted by kind and stand, with history and taken back', () => {
  const stands = [{ kind: 'title', stance: 'agree', earlier: [{ stance: 'disagree' }] }, { kind: 'title', stance: 'disagree', earlier: [] },
    { kind: 'voice', stance: 'partly' }, { kind: 'voice', stance: null, taken_back: true }];
  assert.deepEqual(countStands({ stands }), { read: 4, by_kind: { title: { agree: 1, disagree: 1 }, voice: { partly: 1 } }, with_history: 1, taken_back: 1 });
});

test('without settings_record the tools answer from their input alone and write nothing', async () => {
  const row = { text: 'A line.', verdict: 'bad', by: 'person', film: 'x' };
  const kept = await keepRulings({ ...SETTING, rows: [row] });
  assert.equal(kept.write.records.length, 1);
  assert.equal((await countRealRulings({ ...SETTING, rulings: [row] })).real_bad_film, 1);
  assert.deepEqual(await withSettings({ a: 1 }), { a: 1 });
});

test('settings_record is the person\'s setting row read by tools/settings, and the input\'s own fields win', async () => {
  const record = makeRecord('where-a-person-stands', 'person', 'sample', SETTING, { name: 'Rulings for a sample person', tool: 'tool:keep-rulings-on-lines', source: 'made up' });
  for (const given of [record, record.value, [record]]) {
    const kept = await keepRulings({ settings_record: given, rows: [{ text: 'A line.', verdict: 'bad', by: 'person', where: 'films/x/a.md:1' }] });
    assert.deepEqual([kept.write.records[0].type, kept.write.records[0].value.film], ['record:line-rulings', 'x']);
  }
  const examples = await makeExamplesFromRulings({ settings_record: record, bad_label: 'given', rulings: [{ text: 'A line.', verdict: 'bad', by: 'person', film: 'x' }] });
  assert.deepEqual(examples.items[0].bad_for, ['given']);
  const retired = makeRecord('where-a-person-stands', 'person', 'sample', SETTING, { name: 'old', tool: 'tool:keep-rulings-on-lines', source: 'made up', status: 'retired' });
  await assert.rejects(keepRulings({ settings_record: retired, rows: [] }), /retired/);
  const other = makeRecord('another-tool', 'person', 'sample', { row_type: 'x' }, { name: 'other', tool: 'tool:other', source: 'made up' });
  await assert.rejects(keepRulings({ settings_record: other, rows: [] }), /row_type/);
});
