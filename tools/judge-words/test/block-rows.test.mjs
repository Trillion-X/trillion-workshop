// tools/judge-words: a piece of content given as blocks (each an item with its text, its kind, its place and the block
// itself as its value) judged by word, path and across rows. Carried from bitfield-packages
// packages/content-gate/__tests__/standard-evaluators.test.ts: its pattern (forbid and require, by text and by block
// kind, scoped, normalized), required-kinds, kind-order and length-bound evaluators, each said as rule rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findingsInWords, judge, makeJudge } from '../do-work/judge-words.mjs';

// Blocks as items: a block with no words is a value only.
const blocks = (...list) => list.map((block, index) => ({ ...(block.text ? { text: block.text } : {}), kind: block.kind,
  path: ['blocks', index], value: block }));
const text = words => blocks({ kind: 'text', text: words });
const run = (rules, items) => judge({ rules, items });

const noDash = { id: 'no-long-dash', pattern: '—', says: 'Long dashes are not used here.' };

test('a forbidden mark fails with its block, its offset in that block and what was found; clean words pass at 100', () => {
  const copy = 'The best fixture—and the dearest.';
  const answer = run([noDash], text(copy));
  assert.deepEqual([answer.passed, answer.score], [false, 0]);
  const [finding] = answer.findings;
  assert.deepEqual([finding.rule, finding.found, finding.path, finding.offset], ['no-long-dash', '—', 'blocks.0', copy.indexOf('—')]);
  const passed = run([noDash], text('The best fixture and the dearest.'));
  assert.deepEqual([passed.passed, passed.score, passed.findings.length], [true, 100, 0]);
});

test('every match is found, each at its offset in its own block, not in the joined text', () => {
  assert.deepEqual(run([noDash], text('First—second—third')).findings.map(item => item.offset), [5, 12]);
  const many = run([noDash], blocks({ kind: 'paragraph', text: 'First block—has one.' }, { kind: 'paragraph', text: 'Second block is clean.' },
    { kind: 'paragraph', text: 'Third block—also has one.' }));
  assert.deepEqual(many.findings.map(item => [item.path, item.kind, item.offset, item.found]),
    [['blocks.0', 'paragraph', 11, '—'], ['blocks.2', 'paragraph', 11, '—']]);
  const second = run([noDash], blocks({ kind: 'text', text: 'A very long first block with no dash.' }, { kind: 'text', text: 'Hi—there.' }));
  assert.deepEqual(second.findings.map(item => [item.path, item.offset]), [['blocks.1', 2]]);
});

test('a row that says what to write instead carries it on each finding; one that does not, does not', () => {
  const [withSuggest] = run([{ ...noDash, suggest: '" - "' }], text('One—two.')).findings;
  assert.equal(withSuggest.suggest, '" - "');
  assert.match(findingsInWords([withSuggest])[0], /Say " - "\.$/);
  assert.equal('suggest' in run([noDash], text('One—two.')).findings[0], false);
});

test('a forbidden phrase is found; a required phrase across the whole piece passes when any block has it and fails when none does', () => {
  assert.equal(run([{ id: 'r', pattern: 'foo', says: 'x' }], text('bar baz')).passed, true);
  assert.equal(run([{ id: 'r', pattern: 'bad word', says: 'x' }], text('this is a bad word in text')).findings[0].found, 'bad word');
  const required = { id: 'needs-ask', pattern: 'call to action', across: true, required: true, says: 'Ask for the next step.' };
  assert.equal(run([required], blocks({ kind: 'text', text: 'Body.' }, { kind: 'text', text: 'this is a call to action here' })).passed, true);
  const missing = run([{ ...required, pattern: 'cta' }], blocks({ kind: 'text', text: 'no matching' }, { kind: 'text', text: 'content here' }));
  assert.deepEqual([missing.passed, missing.score, missing.findings.length, missing.findings[0].test], [false, 0, 1, 'required']);
});

test('kinds scope a row to some blocks, and normalize matches NFKC and whitespace variants without an offset', () => {
  const headingOnly = { id: 'r', pattern: '§', kinds: ['heading'], says: 'x' };
  // a block the scoped row is not for is still judged by a row for every block, so no pass rests on silence
  const everyBlock = { id: 'any', pattern: '¶', says: 'y' };
  assert.equal(run([headingOnly, everyBlock], blocks({ kind: 'paragraph', text: '§' }, { kind: 'heading', text: 'Clean' })).passed, true);
  const rejected = run([headingOnly, everyBlock], blocks({ kind: 'paragraph', text: '§' }, { kind: 'heading', text: '§' }));
  assert.deepEqual([rejected.passed, rejected.findings[0].path], [false, 'blocks.1']);
  const normalized = run([{ id: 'n', pattern: 'café house', normalize: ['nfkc', 'whitespace'], says: 'x' }], text('café   house'));
  assert.equal(normalized.passed, false);
  assert.equal(normalized.findings[0].found, 'café house');
  assert.equal('offset' in normalized.findings[0], false);
  assert.equal(run([{ id: 'r', pattern: '§', says: 'x' }], text('x § y')).findings[0].offset, 2);
  assert.throws(() => makeJudge([{ id: 'r', pattern: '§', kinds: 'heading' }]), /kinds/);
  assert.throws(() => makeJudge([{ id: 'r', pattern: '§', normalize: ['upper'] }]), /normalize/);
});

test('a block kind may be forbidden or required by a pattern over the kinds', () => {
  const draft = { id: 'no-drafts', path: 'kind', where_pattern: '^draft-', says: 'Drafts are not published.' };
  const [finding] = run([draft], blocks({ kind: 'draft-intro', text: 'draft content' })).findings;
  assert.equal(finding.found, 'draft-intro');
  const ask = { id: 'has-ask', path: 'kind', where_pattern: '^cta', across: true, required: true, says: 'Ask for the next step.' };
  assert.equal(run([ask], blocks({ kind: 'cta-button', text: 'click me' }, { kind: 'text', text: 'body' })).passed, true);
  assert.equal(run([ask], blocks({ kind: 'text', text: 'body only' })).passed, false);
});

test('a pattern that is not a regular expression is refused when compiled, not judged', () => {
  assert.throws(() => makeJudge([{ id: 'r', pattern: '([' }]), /Invalid regular expression/);
});

test('includes_all names each listed kind that is absent, and scores the share present', () => {
  const parts = { id: 'parts', path: 'kind', across: true, includes_all: ['hook', 'body', 'ask'], says: 'Every part is there.' };
  const all = run([parts], blocks({ kind: 'hook', text: 'attention' }, { kind: 'body', text: 'content' }, { kind: 'ask', text: 'buy now' }));
  assert.deepEqual([all.passed, all.score, all.findings.length], [true, 100, 0]);
  const two = run([parts], blocks({ kind: 'hook', text: 'attention' }, { kind: 'body', text: 'content' }));
  assert.ok(Math.abs(two.score - 200 / 3) < 0.1);
  assert.deepEqual([two.passed, two.findings.map(item => item.found)], [false, ['ask']]);
  const one = run([{ ...parts, includes_all: ['hook', 'body', 'ask', 'quote'] }], blocks({ kind: 'hook', text: 'x' }));
  assert.deepEqual([one.score, one.findings.length], [25, 3]);
  const none = run([{ ...parts, includes_all: ['hook', 'ask'] }], blocks({ kind: 'text', text: 'hello' }));
  assert.deepEqual([none.score, none.findings.length], [0, 2]);
  assert.throws(() => makeJudge([{ ...parts, includes_all: [] }]), /includes_all/);
  const capped = run([{ ...parts, includes_all: ['hook', 'ask'], at_most: 'warn' }], blocks({ kind: 'hook', text: 'x' }));
  assert.deepEqual([capped.score, capped.status, capped.findings.length, capped.findings[0].at_most], [50, 'held', 1, 'warn']);
});

test('in_order holds when the listed kinds come in the list order, with repeats, gaps and other kinds between', () => {
  const order = { id: 'order', path: 'kind', across: true, in_order: ['hook', 'body', 'ask'], says: 'Parts come in this order.' };
  const kinds = (...list) => blocks(...list.map(kind => ({ kind })));
  assert.deepEqual([run([order], kinds('hook', 'body', 'ask')).passed, run([order], kinds('hook', 'body', 'ask')).score], [true, 100]);
  const scrambled = run([order], kinds('ask', 'hook', 'body'));
  assert.deepEqual([scrambled.passed, scrambled.score, scrambled.findings.length], [false, 0, 1]);
  assert.match(scrambled.lines[0], /"ask", "hook", "body" is not in the order "hook", "body", "ask"/);
  assert.equal(run([order], kinds('hook', 'body')).passed, true);   // a part not there yet is not out of order
  assert.equal(run([order], kinds('hook', 'aside', 'ask')).passed, true);
  assert.equal(run([order], kinds('hook', 'body', 'body', 'ask')).passed, true);
  assert.throws(() => makeJudge([{ ...order, in_order: [] }]), /in_order/);
});

test('in_order reads any value the blocks carry, scoped by kind, and selecting nothing is a finding', () => {
  const labels = { id: 'labels', kinds: ['heading'], path: 'label', across: true, in_order: ['Opening', 'Middle', 'Closing'], says: 'x' };
  const ordered = [
    { kind: 'paragraph', label: 'Closing' }, { kind: 'heading', label: 'Opening' }, { kind: 'paragraph', label: 'Opening' },
    { kind: 'heading', label: 'Middle' }, { kind: 'heading', label: 'Closing' },
  ];
  assert.equal(makeJudge([labels])(blocks(...ordered)).length, 0);
  assert.equal(makeJudge([labels])(blocks(ordered[0], ordered[3], ordered[1], ordered[4])).length, 1);
  assert.deepEqual(makeJudge([labels])(blocks({ kind: 'heading' })).map(item => item.found), [null]);
});

test('lengths are counts of what a pattern selects: characters, words, or blocks of a kind', () => {
  const chars = { id: 'chars', pattern: '[\\s\\S]', across: true, count_at_least: 5, count_at_most: 50, says: 'x' };
  assert.equal(run([chars], text('hello world')).passed, true);
  assert.match(run([{ ...chars, count_at_least: 20 }], text('too short')).lines[0], /9 found, at least 20 needed/);
  assert.match(run([{ ...chars, count_at_most: 5 }], text('this is too long')).lines[0], /16 found, at most 5 allowed/);
  const words = { id: 'words', pattern: '\\S+', across: true, count_at_least: 3, count_at_most: 5, says: 'x' };
  assert.equal(run([words], text('one two three')).passed, true);
  assert.equal(run([words], text('one two')).passed, false);
  assert.equal(run([words], text('one two three four five six')).passed, false);
  const headline = { ...words, kinds: ['headline'] };
  const scoped = run([headline, { id: 'any', pattern: '¶', says: 'y' }],
    blocks({ kind: 'headline', text: 'Short head' }, { kind: 'body', text: 'Very long body text that is ignored anyway' }));
  assert.deepEqual([scoped.passed, scoped.findings.map(item => item.rule)], [false, ['words']]);
  const pictures = { id: 'pictures', path: 'kind', where: 'image', across: true, count_at_least: 1, count_at_most: 3, says: 'x' };
  assert.equal(run([pictures], blocks({ kind: 'text', text: 'hello' })).passed, false);
  assert.equal(run([pictures], blocks({ kind: 'image' }, { kind: 'image' }, { kind: 'text', text: 'body' })).passed, true);
});

test('a capped finding does not fail the piece; an uncapped one does', () => {
  const short = { id: 'too-short', pattern: '[\\s\\S]', across: true, count_at_least: 200, at_most: 'warn', says: 'Longer, perhaps.' };
  const shortClean = run([noDash, short], text('Short text.'));
  assert.deepEqual([shortClean.status, shortClean.findings.map(item => item.rule)], ['held', ['too-short']]);
  const withDash = run([noDash, short], text('Short—with dash.'));
  assert.deepEqual([withDash.status, withDash.findings.map(item => item.rule)], ['failed', ['no-long-dash', 'too-short']]);
});
