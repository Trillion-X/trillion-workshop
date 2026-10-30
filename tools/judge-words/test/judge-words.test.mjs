// tools/judge-words: rule rows with kinds, value paths and tests, as tools/judge-words/do-work/judge-words.mjs judges
// them, and the answer tool:judge-against-rules gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findingsInWords, judge, makeJudge, ruleApplies, stringsIn, TEST_NAMES, valuesAt, wordsIn } from '../do-work/judge-words.mjs';

const because = ['file:1f:fixture-stance'];

test('a rule with kinds applies only to items of a listed kind, and an item of no kind is of none', () => {
  const rule = { id: 'fixture-kind', words: ['zorblax'], says: 'Use a concrete word.', kinds: ['heading', 'caption'] };
  assert.equal(ruleApplies(rule, { text: 'A zorblax.', kind: 'heading' }), true);
  assert.equal(ruleApplies(rule, { text: 'A zorblax.', kind: 'body' }), false);
  assert.equal(ruleApplies(rule, { text: 'A zorblax.' }), false);
  const judgeItems = makeJudge([rule]);
  assert.deepEqual(judgeItems([{ text: 'A zorblax.', kind: 'caption' }, { text: 'A zorblax.', kind: 'body' }]).map(finding => finding.kind), ['caption']);
  assert.throws(() => makeJudge([{ ...rule, kinds: [] }]), /kinds/);
  assert.equal(judge({ text: 'A zorblax.', rules: [rule] }).status, 'no-applicable-rule');
  assert.equal(judge({ text: 'A zorblax.', kind: 'heading', rules: [rule] }).status, 'failed');
});

test('a required rule fails only when nothing matches, and allow still keeps a text out of it', () => {
  const rule = { id: 'fixture-form', pattern: '^How to ', flags: 'i', required: true, says: 'Use one of the accepted forms.', allow: ['(draft)'] };
  const judge = makeJudge([rule]);
  assert.deepEqual(judge(['How to start']), []);
  const [finding] = judge(['Starting out']);
  assert.equal(finding.test, 'required');
  assert.equal(finding.found, 0);
  assert.deepEqual(judge(['Starting out (draft)']), []);
  assert.deepEqual(makeJudge([{ ...rule, required: false }])(['Starting out']), []);
});

test('count tests count what a word rule finds in a text', () => {
  const judge = makeJudge([{ id: 'fixture-questions', pattern: '\\?', count_at_most: 1, says: 'One question at most.' }]);
  assert.deepEqual(judge(['Why now?']), []);
  const [finding] = judge(['Why now? Why here? Why you?']);
  assert.deepEqual([finding.test, finding.found, finding.limit], ['count_at_most', 3, 1]);
  assert.deepEqual(findingsInWords([finding]), ['3 found, at most 1 allowed in "Why now? Why here? Why you?". One question at most.']);
});

test('a path rule selects values in an item value, where keeps equal pieces, and count tests count them', () => {
  const plan = { segments: [{ kind: 'question' }, { kind: 'answer' }, { kind: 'question' }, { kind: 'question' }] };
  const rule = { id: 'fixture-asks', path: 'segments.*.kind', where: 'question', count_at_most: 2, says: 'Too many questions.' };
  const [finding] = makeJudge([rule])([{ value: plan, kind: 'plan' }]);
  assert.deepEqual([finding.found, finding.test, finding.limit, finding.kind, 'text' in finding], [3, 'count_at_most', 2, 'plan', false]);
  assert.deepEqual(makeJudge([{ ...rule, where: ['question', 'answer'], count_at_most: 4 }])([{ value: plan }]), []);
  assert.deepEqual(makeJudge([{ id: 'fixture-few', path: 'segments.*', count_at_least: 5, says: 'Too few.' }])([{ value: plan }])
    .map(item => item.found), [4]);
  assert.deepEqual(valuesAt(plan, 'segments.**.kind').map(piece => piece.path.join('.')),
    ['segments.0.kind', 'segments.1.kind', 'segments.2.kind', 'segments.3.kind']);
});

test('when chooses the artifacts a rule is for by a value they hold, with where semantics', () => {
  const asks = { id: 'fixture-asks', kinds: ['plan'], path: 'segments.*.kind', where: 'question', count_at_most: 1, says: 'Too many questions.',
    when: { path: 'format', where: 'format-a' } };
  const segments = [{ kind: 'question' }, { kind: 'question' }];
  const judgeItems = makeJudge([asks]);
  assert.deepEqual(judgeItems([{ value: { format: 'format-a', segments }, kind: 'plan' }]).map(finding => finding.found), [2]);
  assert.deepEqual(judgeItems([{ value: { format: 'format-b', segments }, kind: 'plan' }]), []);
  assert.deepEqual(judgeItems([{ value: { segments }, kind: 'plan' }]), []);
  assert.equal(ruleApplies(asks, { text: 'format-a', kind: 'plan' }), false);
  assert.equal(ruleApplies({ ...asks, when: [{ path: 'format', where: ['format-b', 'format-a'] }, { path: 'meta.lang', where: 'en' }] },
    { value: { format: 'format-a', meta: { lang: 'en' } }, kind: 'plan' }), true);
  assert.equal(ruleApplies({ ...asks, when: [{ path: 'format', where: 'format-a' }, { path: 'meta.lang', where: 'en' }] },
    { value: { format: 'format-a', meta: { lang: 'de' } }, kind: 'plan' }), false);
  for (const when of [[], [{ path: 'format' }], 'format', { path: '', where: 'x' }]) assert.throws(() => makeJudge([{ ...asks, when }]), /when/);
  assert.equal(judge({ artifact: { format: 'format-b', segments }, kind: 'plan', rules: [asks] }).status, 'no-applicable-rule');
});

test('a path rule without a test flags each selected piece at its own path', () => {
  const rule = { id: 'fixture-voice', path: 'voice', where: 'voice-b', says: 'This voice was turned down.' };
  const judge = makeJudge([rule]);
  assert.deepEqual(judge([{ value: { voice: 'voice-a' } }]), []);
  const [finding] = judge([{ value: { voice: 'voice-b' }, path: ['takes', 4] }]);
  assert.deepEqual([finding.found, finding.path, finding.test], ['voice-b', 'takes.4.voice', undefined]);
  assert.deepEqual(findingsInWords([finding]), ['takes.4.voice: "voice-b". This voice was turned down.']);
});

test('value tests hold only for numbers within bounds, and selecting nothing is a finding', () => {
  const judge = makeJudge([
    { id: 'fixture-high', path: 'rows.*.drift', value_at_most: 0.07, says: 'Too much drift.' },
    { id: 'fixture-low', path: 'loudness', value_at_least: -16, says: 'Too quiet.' },
  ]);
  const findings = judge([{ value: { rows: [{ drift: 0.02 }, { drift: 0.3 }, { drift: 'n/a' }] } }]);
  assert.deepEqual(findings.map(item => [item.rule, item.found, item.path ?? null]),
    [['fixture-high', 0.3, 'rows.1.drift'], ['fixture-high', 'n/a', 'rows.2.drift'], ['fixture-low', null, null]]);
  assert.deepEqual(findingsInWords(findings), [
    'rows.1.drift: 0.3 is not a number of at most 0.07. Too much drift.',
    'rows.2.drift: "n/a" is not a number of at most 0.07. Too much drift.',
    'no value found. Too quiet.',
  ]);
  assert.deepEqual(judge([{ value: { rows: [{ drift: 0.07 }], loudness: -14 } }]), []);
});

test('equals holds when every selected value is one of the listed values', () => {
  const judge = makeJudge([{ id: 'fixture-forms', path: 'shape', equals: ['list', { form: 'pair' }], says: 'Use an accepted shape.' }]);
  assert.deepEqual(judge([{ value: { shape: { form: 'pair' } } }, { value: { shape: 'list' } }]), []);
  assert.deepEqual(judge([{ value: { shape: 'essay' } }, { value: {} }]).map(item => item.found), ['essay', null]);
});

test('findings carry because and at_most unchanged, and word and path rules read only what an item carries', () => {
  const judge = makeJudge([
    { id: 'fixture-word', words: ['zorblax'], says: 'Use a concrete word.', because, at_most: 'uncertain' },
    { id: 'fixture-path', path: 'title', required: true, says: 'Give it a title.', because },
  ]);
  const findings = judge([{ text: 'A zorblax.' }, { value: { name: 'x' } }]);
  assert.deepEqual(findings.map(item => [item.rule, item.because, item.at_most ?? null]),
    [['fixture-word', because, 'uncertain'], ['fixture-path', because, null]]);
  assert.equal(ruleApplies({ path: 'title' }, { text: 'A title' }), false);
  assert.equal(ruleApplies({ words: ['a'] }, { value: { title: 'a' } }), false);
  assert.equal(ruleApplies({ ask: {}, fields: ['title'] }, { field: 'title', path: [] }), true);
});

test('a rule row with a wrong test value, an empty path or no selection is refused when compiled', () => {
  assert.deepEqual(TEST_NAMES, ['required', 'count_at_least', 'count_at_most', 'value_at_least', 'value_at_most', 'equals']);
  assert.throws(() => makeJudge([{ id: 'bad-count', pattern: 'x', count_at_most: '2' }]), /count_at_most/);
  assert.throws(() => makeJudge([{ id: 'bad-equals', path: 'a', equals: 'b' }]), /equals/);
  assert.throws(() => makeJudge([{ id: 'bad-path', path: 'a..b' }]), /dot path/);
  assert.throws(() => makeJudge([{ id: 'bad-row', count_at_most: 1 }]), /words, pattern, exact, check or path/);
});

test('judge holds when every finding comes from a capped row, fails on any other, and needs rules', () => {
  const capped = { id: 'fixture-capped', words: ['zorblax'], says: 'Maybe vague.', at_most: 'uncertain' };
  const firm = { id: 'fixture-firm', words: ['blorp'], says: 'Never this.' };
  assert.equal(judge({ text: 'A zorblax.', rules: [capped, firm] }).status, 'held');
  assert.equal(judge({ text: 'A zorblax.', rules: [capped, firm] }).passed, false);
  assert.equal(judge({ text: 'A zorblax blorp.', rules: [capped, firm] }).status, 'failed');
  assert.equal(judge({ text: 'Plain words.', rules: [capped, firm] }).status, 'passed');
  assert.equal(judge({ rules: [firm] }).status, 'no-input');
  assert.throws(() => judge({ text: 'x' }), /rules/);
  const plan = judge({ artifact: { steps: [] }, kind: 'plan', rules: [{ id: 'fixture-steps', kinds: ['plan'], path: 'steps.*', count_at_least: 1, says: 'A plan has steps.' }] });
  assert.deepEqual([plan.status, plan.findings[0].found, plan.findings[0].kind], ['failed', 0, 'plan']);
});

test('owner paths select authored words without source quotations sharing the same key, and blank leaves stay raw', () => {
  const rule = { id: 'fixture-word', words: ['zorblax'], says: 'Use a concrete word.' };
  const data = { id: 'zorblax', captures: [{ label: 'Start', prompt: { headline: 'Try again' } }],
    source: { label: 'Original zorblax quotation.' }, schema: { properties: { nested: { properties: { text: { description: 'Explain the attempt.' } } } } } };
  const owner = { fields: 'strings', paths: ['captures.*.label', 'captures.*.prompt.headline', 'schema.properties.**.description'] };
  assert.deepEqual(wordsIn(data, owner).map(item => item.text), ['Start', 'Try again', 'Explain the attempt.']);
  assert.equal(judge({ value: data, ...owner, rules: [rule] }).passed, true);
  assert.equal(judge({ value: data, fields: ['label'], rules: [rule] }).passed, false);
  assert.throws(() => wordsIn(data, { paths: 'captures.*.label' }), /paths/);
  const raw = { title: '', rows: [{ id: 'row-id', label: ' ', answer: 'Try again' }] };
  assert.deepEqual(stringsIn(raw).map(item => item.text), ['', 'row-id', ' ', 'Try again']);
  assert.deepEqual(wordsIn(raw).map(item => item.text), ['row-id', 'Try again']);
});
