// tools/check-against-a-persons-rules-and-verdicts: tool:check-copy on made-up rules, lines, pages, decks and pictures. No
// person's rule, word or line is used; every rule here is invented for the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkCopy, CheckCopyRefusal } from '../do-work/check-copy.mjs';

const folder = resolve(import.meta.dirname, '..');
const RULES = [{ id: 'no-sparkle', words: ['sparkle'], says: 'No sparkle.' }];
const deck = words => `<script type="application/json" id="slide-words">${JSON.stringify(words.map((text, index) => ({ id: `s${index}`, fields: { text, slide: index + 1 } })))}</script>`;

test('a rule row fails the unit that breaks it and passes the one that does not', () => {
  const failed = checkCopy({ rules: RULES, texts: ['A sparkle for you.', 'Open any file you keep.'] });
  assert.equal(failed.exit, 1);
  assert.equal(failed.failing, 1);
  assert.equal(checkCopy({ rules: RULES, text: 'Open any file you keep.' }).exit, 0);
});

test('without rules the grammar rows judge, and nothing about words is kept', () => {
  assert.equal(checkCopy({ text: 'the the file opens.' }).status, 'failed');
});

test('words are read from JSON, a page and a deck, each under its own kind and place', () => {
  const result = checkCopy({ rules: RULES,
    sources: [{ where: 'pages.json', json: { pages: [{ heading: 'A sparkle for you', alt: 'A sparkle on a desk', id: 'home-page' }] } }],
    alt_keys: ['alt'], html: [{ where: '/home', html: '<html><body><p>Open every file you keep anywhere.</p><script>var a = 1;</script></body></html>' }],
    decks: [{ where: 'deck.html', html: deck(['Sparkle on slide one is a fail']) }] });
  const kinds = Object.fromEntries(result.results.map(one => [one.text, one.kind]));
  assert.equal(kinds['A sparkle on a desk'], 'alt');
  assert.equal(kinds['Sparkle on slide one is a fail'], 'deck');
  assert.equal(kinds['Open every file you keep anywhere.'], 'copy');
  assert.equal(result.exit, 1);
});

test('Markdown reads headings, paragraphs, lists, GFM table cells and fenced display text', () => {
  const result = checkCopy({ rules: RULES, markdown: [{ where: 'book.md', document_heading_level: 1, document_heading_is_metadata: true,
    text: '# Working manuscript\n\n## Chapter one\n\nA first paragraph\nwrapped onto another line.\n\n- Choose one action.\n\nHeader | Detail\n------- | ------\nOne | Two\n\nThe expression a | b stays in this sentence.\n\n~~~text\nA visible display line.\n~~~' }] });
  assert.equal(result.exit, 0);
  assert.deepEqual(result.results.map(unit => unit.text), [
    'Chapter one', 'A first paragraph wrapped onto another line.', 'Choose one action.', 'Header', 'Detail', 'One', 'Two',
    'The expression a | b stays in this sentence.', 'A visible display line.',
  ]);
  assert.ok(result.results.every(unit => unit.where.startsWith('book.md:')));
  assert.equal(result.results.find(unit => unit.text === 'Chapter one').facts.markdown_role, 'heading');
  assert.ok(result.results.find(unit => unit.text === 'A first paragraph wrapped onto another line.').context_requires_review_checks === undefined);
  assert.ok(result.results.find(unit => unit.text === 'Header').context_requires_review_checks.includes('ends-with-stop'));
});

test('sentence checks hold on Markdown fragments, but still fail on incomplete paragraph sentences', () => {
  const result = checkCopy({ rules: [
    { id: 'sentence-stop', check: 'ends-with-stop', says: 'A sentence ends with punctuation.' },
    { id: 'sentence-cap', check: 'starts-with-capital', says: 'A sentence starts with a capital.' },
  ], markdown: [{ where: 'fragments.md', document_heading_level: 1, document_heading_is_metadata: true,
    text: '# Working manuscript\n\n## A fragment heading\n\nA paragraph sentence\nthat ends without punctuation\n\n```text\nwith precision in the diagram\n```' }] });
  const byText = Object.fromEntries(result.results.map(unit => [unit.text, unit]));
  assert.equal(byText['A fragment heading'].verdict, 'uncertain');
  assert.deepEqual(byText['A fragment heading'].uncertain.map(finding => finding.rule).sort(), ['context-policy-unqualified', 'sentence-stop']);
  assert.equal(byText['A paragraph sentence that ends without punctuation'].verdict, 'fail');
  assert.equal(byText['with precision in the diagram'].verdict, 'uncertain');
  assert.ok(byText['with precision in the diagram'].uncertain.some(finding => finding.rule === 'sentence-cap'));
  assert.ok(result.results.find(unit => unit.text === 'A paragraph sentence that ends without punctuation').facts.markdown_role === 'paragraph');
});

test('Markdown fields select the right rule without collapsing identical words from different roles', () => {
  const result = checkCopy({ rules: [{ id: 'body-only-sparkle', words: ['sparkle'], fields: ['body'], says: 'No sparkle in body copy.' }],
    markdown: [{ where: 'fielded.md', document_heading_level: 1, document_heading_is_metadata: true, fields: { heading: 'title', paragraph: 'body' },
      text: '# Sparkle\n\n## Sparkle\n\nSparkle' }] });
  const same = result.results.filter(unit => unit.text === 'Sparkle');
  assert.equal(same.length, 2);
  assert.equal(same.find(unit => unit.facts.markdown_role === 'heading').field, 'title');
  assert.equal(same.find(unit => unit.facts.markdown_role === 'paragraph').field, 'body');
  assert.equal(same.find(unit => unit.facts.markdown_role === 'heading').verdict, 'uncertain');
  assert.equal(same.find(unit => unit.facts.markdown_role === 'paragraph').verdict, 'fail');
});

test('Markdown quotes and text before a declared document title hold coverage open', () => {
  const result = checkCopy({ rules: RULES, markdown: [{ where: 'book.md', document_heading_level: 1, document_heading_is_metadata: true,
    text: 'Unclassified preamble.\n\n# Working manuscript\n\n## Chapter one\n\n> Source quotation.' }] });
  assert.equal(result.exit, 1);
  assert.deepEqual(result.problems, ['book.md:1: preamble_content', 'book.md:7: unresolved_quote_role']);
  assert.ok(!JSON.stringify(result).includes('Source quotation.'));
});

test('a missing Markdown body is refused, never read as the word "undefined"', () => {
  assert.throws(() => checkCopy({ rules: RULES, markdown: [{ where: 'empty.md' }] }), CheckCopyRefusal);
});

test('a source or a deck with no words is refused, never passed', () => {
  assert.throws(() => checkCopy({ rules: RULES, texts: [] }), CheckCopyRefusal);
  assert.throws(() => checkCopy({ rules: RULES, decks: [{ where: 'x', html: '<p>no block</p>' }] }), /no slide-words block/);
});

test('a locked line or a promised feature that is no longer in the words fails, and only the person\'s own words approve its removal', () => {
  const required = { locked_lines: [{ id: 'sig', alternatives: ['Open every file you keep'] }], entries: [{ id: 'match', name: 'The matcher', lines: ['Start with the reason to meet'] }] };
  const gone = checkCopy({ rules: RULES, text: 'Something else entirely.', required });
  assert.equal(gone.exit, 1);
  assert.deepEqual(gone.results.filter(one => one.verdict === 'fail').flatMap(one => one.breaks.map(rule => rule.rule)).sort(), ['required:feature:match', 'required:locked-line:sig']);
  const there = checkCopy({ rules: RULES, text: 'Open every file you keep. Start with the reason to meet.', required });
  assert.equal(there.exit, 0);
  const approvals = [{ id: 'match', words: 'drop the matcher', source_text: 'Fine, drop the matcher.' }, { id: 'sig', words: 'words never said', source_text: 'Fine, drop the matcher.' }];
  const approved = checkCopy({ rules: RULES, text: 'Something else entirely.', required: { ...required, approvals } });
  assert.match(approved.problems.join('\n'), /approval for sig is not|approval for sig/i);
  assert.ok(!approved.results.some(one => one.breaks.some(rule => rule.rule === 'required:feature:match')));
});

test('an id in the baseline that is gone fails', () => {
  const result = checkCopy({ rules: RULES, text: 'Open every file you keep.', required: { entries: [], baseline_ids: ['a-promised-thing'] } });
  assert.equal(result.exit, 1);
  assert.match(result.problems.join('\n'), /a-promised-thing is in the baseline and is gone/);
});

test('a row for the wrong audience, a short offer and an unpublished count are problems', () => {
  const line = id => ({ id });
  const result = checkCopy({ rules: RULES, text: 'Open every file you keep.',
    audience: { rows: [{ id: 'r1', audience: 'customer' }, { id: 'r2', audience: 'operator' }, { id: 'r3' }], allowed: ['customer'] },
    offers: { list_field: 'lines', id_field: 'id', offers: [{ id: 'free', lines: [line('a')] }, { id: 'paid', lines: [line('a'), line('b')] }] },
    counts: [{ label: 'catalog.json', document: { schema: 'folder-walk' } }, { label: 'view.json', document: { schema: 'list-view-file/v1', source: { view: 'list-view:x:y' } } }] });
  const said = result.problems.join('\n');
  assert.match(said, /Row r2 is public with audience "operator"/);
  assert.match(said, /Row r3 is public with audience null/);
  assert.match(said, /Offer free lists 1 of the 2 lines/);
  assert.match(said, /catalog.json carries counts but is not a published list view/);
  assert.doesNotMatch(said, /view.json/);
});

test('a picture with no reading is a problem; a read picture is judged as image-text and typing rows skip it', () => {
  const pictures = [{ path: 'a.png', blake3: 'aa' }, { path: 'b.png', blake3: 'bb' }];
  const result = checkCopy({ rules: [...RULES, ...JSON.parse('[{"id":"doubled-word","check":"doubled-word","says":"Twice.","not_for_kinds":["image-text"]}]')],
    text: 'Open every file you keep.', pictures, readings: { bb: { text: 'the the sparkle' } } });
  assert.match(result.problems.join('\n'), /a.png has no recorded reading/);
  const picture = result.results.find(one => one.kind === 'image-text');
  assert.deepEqual(picture.breaks.map(rule => rule.rule), ['no-sparkle']);
});

test('a row naming a kind covers the kinds its alias lists', () => {
  const rules = [{ id: 'only-copy', kinds: ['public'], words: ['sparkle'], says: 'No sparkle.' }];
  const result = checkCopy({ rules, kind_aliases: { public: ['public', 'alt'] }, units: [{ kind: 'alt', text: 'A sparkle on a desk' }] });
  assert.equal(result.exit, 1);
});

test('the tool runs the way the container runs it: input on standard input, the answer on the last line', () => {
  const run = input => {
    const done = spawnSync('node', ['do-work/check-copy-words.mjs'], { cwd: folder, input: JSON.stringify(input), encoding: 'utf8' });
    return JSON.parse(done.stdout.trim().split('\n').at(-1));
  };
  assert.equal(run({ rules: RULES, text: 'A sparkle for you.' }).result.status, 'failed');
  assert.match(run({ rules: RULES }).error, /Nothing to check/);
});

// The tool ships mechanical grammar only. A quoted phrase list (words, a pattern or an exact line) in the rows it keeps, or a
// word list written into its code, is a person's or a product's rules in a public tool: this test refuses it.
import { readFileSync, readdirSync } from 'node:fs';
import GRAMMAR_ROWS from '../read-data/copy-grammar-rules.json' with { type: 'json' };

test('the rows the tool keeps are named grammar checks, never a quoted phrase list', () => {
  assert.ok(GRAMMAR_ROWS.rules.length > 0);
  for (const row of GRAMMAR_ROWS.rules) {
    assert.ok(typeof row.check === 'string', `${row.id} names a grammar check`);
    for (const selector of ['words', 'pattern', 'exact', 'groups', 'evidence', 'path']) assert.equal(row[selector], undefined, `${row.id} must not carry ${selector}`);
  }
});

test('the tool\'s code and wording DATA hold no quoted phrase list', () => {
  for (const file of ['do-work/check-copy.mjs', 'do-work/read-words.mjs', 'do-work/check-copy-words.mjs']) {
    const code = readFileSync(resolve(folder, file), 'utf8');
    assert.doesNotMatch(code.replace(/\/\/.*$/gm, ''), /words\s*:\s*\[\s*['"`][^\]]{2,}['"`]\s*,/, `${file} writes a word list`);
  }
  const said = readFileSync(resolve(folder, 'read-data/copy-words.json'), 'utf8');
  assert.doesNotMatch(said, /"words"\s*:/);
  assert.deepEqual(readdirSync(resolve(folder, 'read-data')).filter(name => name.startsWith('copy-')).sort(), ['copy-grammar-rules.json', 'copy-words.json']);
});
