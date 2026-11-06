// tools/check-against-a-persons-rules-and-verdicts: tool:check-a-films-copy and its parts, on made-up films only. The
// person's layouts, spans, profiles, owners, origin words and reader-knowledge rows are a made-up settings row; their
// rules are made-up rows of a made-up branch of their one Checks list, kept in an in-memory records door. Ported from
// the launch-video copy gate's tests (tests/check.test.mjs, decider-kinds.test.mjs, place-reports.test.mjs), which ran
// on the person's own rules: here every rule and line is made up, and each test names the old one it carries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAFilmsCopy, filmUnits, knowledgeOf, readingUnits, readSourceBytes } from '../do-work/check-a-films-copy.mjs';
import { dedupe, readFile, readMarkdown } from '../do-work/read-film-copy.mjs';
import { citedSpans, holding as holdingSpans, spansOfPlan } from '../do-work/spans-of-a-plan.mjs';
import { withSpokenOrigins } from '../do-work/spoken-origins.mjs';
import { build, contextFromSpec, contextFromText, holding } from '../do-work/unit-context.mjs';

const here = new URL('..', import.meta.url).pathname;
const SETTINGS_ID = 'record:setting:check-against-a-persons-rules-and-verdicts~person~made-up-person';

// A made-up person's layouts: the shape of their settings row (list:settings), never theirs.
const LAYOUTS = {
  table_first_header_in: ['#', 'c'], table_skip_if_header_has: ['views'],
  files: { 'SCRIPT.md': { line: { kind: 'voiceover' }, 'big words': { kind: 'onscreen', quotes_are_units: true }, text: { kind: 'onscreen' } },
    'TITLES.md': { title: { kind: 'title' }, 'thumbnail text': { kind: 'thumbnail' } }, '*': { line: { kind: 'voiceover' }, title: { kind: 'title' } } },
  fenced_blocks: { 'POST.md': 'post' }, blockquotes: 'description', skip_sections: ['Credits'],
  cell_drop_if: ['^~~.*~~$', '^-$', '^$'], cell_strip: ['\\*\\*', '~~[^~]*~~', '\\s*\\((?:v\\d|cut in v\\d)[^)]*\\)\\s*$'],
  cell_split: [' · '], split_parts_kind: 'label', cell_join: [' / '],
  paragraph_files: { 'DESCRIPTION.md': { kind: 'description', after: '^---$' } },
};
const SPOKEN = { cites_plan: '^Plan: `([^`]+\\.json)`', words_json: ['words/{clip}.words.json'],
  tsv: { path: 'moments.tsv', clip: 'clip', from: 'start_s', to: 'end_s', text: 'text' }, pad_s: 1, speaker_unverified: '^UNCHECKED' };
const SETTINGS = {
  readers: LAYOUTS, spoken_spans: SPOKEN, fields_by_kind: { title: 'title', thumbnail: 'title' },
  origin_words: { own: 'my-words', added: 'added-words', unverified: 'unverified-speaker' },
  profiles: { 'sectioned-prose': { title_kind: 'title', sections: [{ heading: 'Article', kind: 'narrator' }, { heading: 'Spoken video script', kind: 'voiceover' }],
    required: ['Article', 'Spoken video script'], fields: { title: 'title', narrator: 'body', voiceover: 'body' } },
  'cue-narration': { kind: 'voiceover', field: 'body', cue_heading_level: 2, cue_id_pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$', frontmatter: { fields: { voice: 'string' }, required: [] } } },
  json_owners: { 'made-up-titles': { kind: 'title', field: 'title', paths: ['title'] } },
  reader_knowledge: { parser: { model: 'made-up-model', version: '0' }, heading_kinds: ['title'], rules: [], word_classes: {} },
};
const JUDGE = { fold: { lowercase: true, collapse_space: true, strip_trailing: '[.!?]+' }, stage: { default: 'final' }, stance_rule: 'their-stance',
  novel: { rule: 'novel-made-up', says: 'Nothing of theirs judges this.' }, agree_clears: { rules: ['no-zorblax'] } };
const BRANCHES = [{ id: 'made-up-universal' }, { id: 'made-up-writing', part_of: 'made-up-universal' },
  { id: 'made-up-video', part_of: 'made-up-writing', judge_settings: JUDGE }];
const CHECKS = [
  { id: 'no-zorblax', part_of: 'made-up-writing', words: ['zorblax'], says: 'Use a concrete word.', held_when: { path: 'origin', where: 'my-words' } },
  { id: 'no-glorp', part_of: 'made-up-writing', words: ['glorp'], says: 'Never glorp.' },
  { id: 'starts-with-capital', part_of: 'made-up-universal', check: 'starts-with-capital', says: 'A title starts with a capital.', fields: ['title'] },
  { id: 'title-no-wibble', part_of: 'made-up-video', kinds: ['title'], words: ['wibble'], says: 'Not in a title.', because: ['a made-up note'] },
  { id: 'title-is-short', part_of: 'made-up-video', kinds: ['title'], pattern: '^.{1,60}$', required: true, at_most: 'uncertain', says: 'A title is short.', because: ['a made-up note'] },
  // A row of theirs for every line kind, so a line is never novel here.
  { id: 'line-no-wibble', part_of: 'made-up-video', kinds: ['voiceover', 'onscreen', 'card'], words: ['wibble'], says: 'Not in a line.', because: ['a made-up note'] },
];
const ASK = { id: 'is-it-plain', part_of: 'made-up-writing', kinds: ['title'], says: 'Plain words.',
  ask: { question: 'Is this line plain?', options: ['yes', 'no'], fail: 'no', calibration: { status: 'usable', t_pass: 0.3, t_fail: 0.6 } } };

const settingRecord = (settings = SETTINGS) => ({ id: SETTINGS_ID, type: 'record:setting', value: { name: 'A made-up film\'s copy readers', tool: 'tool:check-a-films-copy',
  scope_kind: 'person', scope_id: 'made-up-person', settings: JSON.stringify(settings), from: 'made-up@0', status: 'active' } });
function records({ settings = SETTINGS, checks = CHECKS } = {}) {
  return [settingRecord(settings),
    ...BRANCHES.map(value => ({ id: `record:check:${value.id}`, type: 'record:check', value: { kind: 'branch', ...value } })),
    ...checks.map(value => ({ id: `record:check:${value.id}`, type: 'record:check', value }))];
}
function memoryDoor(held = records()) {
  const matches = (record, where) => !where || Object.entries(where).every(([name, value]) => JSON.stringify(record.value?.[name]) === JSON.stringify(value));
  return {
    async read(type, id) { return held.find(record => record.type === type && record.id === id)?.value ?? null; },
    async *list(query) { for (const record of held) if (record.type === query.type && matches(record, query.where)) yield record; },
    write() { throw new Error('a film check writes nothing'); },
  };
}
const run = (files, extra = {}, door = memoryDoor()) => checkAFilmsCopy({ branch: 'made-up-video', settings_record: SETTINGS_ID, files,
  reader_knowledge: { findings: [] }, ...extra }, door);
const script = (rows, header = '| # | line | words |') => `${header}\n|---|---|---|\n${rows.map((row, at) => `| ${at + 1} | ${row} | 3 |`).join('\n')}\n`;

// ---- The film readers (old tests 'SCRIPT.md: the line column is read...' and 'POST.md: fenced post text...') ---------
test('SCRIPT.md: the line column is read, cut lines and version marks are skipped', () => {
  const text = '| # | slot | line | words |\n|---|---|---|---|\n| 1 | 1 | A made-up line. | 4 |\n'
    + '| 8 | 3 | ~~A cut line.~~ (cut in v5) | 0 |\n| 9 | 3 | Another made-up line. (v4) | 8 |\n';
  assert.deepEqual(readFile('SCRIPT.md', null, text, LAYOUTS).map(u => [u.text, u.kind]), [['A made-up line.', 'voiceover'], ['Another made-up line.', 'voiceover']]);
});

test('POST.md: fenced post text is read outside skipped sections; a SCRIPT.md fenced header is not', () => {
  assert.deepEqual(readFile('POST.md', null, '# POST\n\n## X\n```\nA made-up post.\n```\n## Credits\n```\nA credit.\n```\n', LAYOUTS).map(u => [u.text, u.kind]), [['A made-up post.', 'post']]);
  assert.deepEqual(readFile('SCRIPT.md', null, '## Piece header\n```\npiece: one-place\n```\n', LAYOUTS), []);
});

test('TITLES.md columns, quoted big words, split labels, joined quotes and a paragraph file each read as the layouts say', () => {
  const titles = '| # | Title | Thumbnail text | Views |\n|---|---|---|---|\n| 1 | A **made-up** title | BIG / WORDS | 3 |\n';
  assert.deepEqual(readMarkdown('TITLES.md', titles, LAYOUTS), [], 'a table whose header has a skip word is not copy');
  const kept = '| # | Title | Thumbnail text |\n|---|---|---|\n| 1 | A **made-up** title | BIG / WORDS |\n';
  assert.deepEqual(readMarkdown('TITLES.md', kept, LAYOUTS).map(u => [u.text, u.kind]), [['A made-up title', 'title'], ['BIG WORDS', 'thumbnail']]);
  const big = '| # | big words | text |\n|---|---|---|\n| 1 | "One quote" and "Two quote" | First · Second |\n| 2 | “A “nested” one” | - |\n';
  assert.deepEqual(readMarkdown('SCRIPT.md', big, LAYOUTS).map(u => [u.text, u.kind]),
    [['One quote', 'onscreen'], ['Two quote', 'onscreen'], ['First', 'label'], ['Second', 'label'], ['A “nested” one', 'onscreen']]);
  assert.deepEqual(readMarkdown('notes.md', '> First half\n> second half.\n\n> Another.\n', LAYOUTS).map(u => [u.text, u.kind]),
    [['First half second half.', 'description'], ['Another.', 'description']]);
  assert.deepEqual(readMarkdown('DESCRIPTION.md', 'Private note.\n---\nA made-up description.\n# heading\n', LAYOUTS).map(u => u.text), ['A made-up description.']);
});

test('plain lines and JSON lines: one unit a line or a row, curly apostrophes straight, the same line once with also_at', () => {
  assert.deepEqual(readFile('lines.txt', null, '# note\nIt’s made up.\n\nIt’s made up.\n', LAYOUTS).map(u => [u.text, u.kind, u.where]),
    [["It's made up.", 'voiceover', 'lines.txt:2'], ["It's made up.", 'voiceover', 'lines.txt:4']]);
  assert.deepEqual(readFile('rows.json', null, JSON.stringify([{ text: 'A row.', kind: 'card' }, 'A string.']), LAYOUTS).map(u => [u.text, u.kind]),
    [['A row.', 'card'], ['A string.', 'voiceover']]);
  assert.deepEqual(readFile('w.json', 'narrator', JSON.stringify({ text: 'One words file.' }), LAYOUTS).map(u => u.kind), ['narrator']);
  const once = dedupe(readFile('lines.txt', null, 'Same.\nSame.\nOther.\n', LAYOUTS));
  assert.deepEqual(once.map(u => [u.text, u.also_at]), [['Same.', ['lines.txt:2']], ['Other.', []]]);
});

// ---- Where a line's words come from (old tests on his words, --plan and also spans) -----------------------------------
const WORDS = { C1: [{ text: 'so', start: 0.5, end: 0.7 }, { text: 'three', start: 2, end: 2.3 }, { text: 'months', start: 2.3, end: 2.8 }, { text: 'later', start: 9, end: 9.4 }] };
const TSV = 'clip\tstart_s\tend_s\ttext\nC2\t\t\tthe untimed row\nC1\t2\t3\tthree months\n';
const sources = (plans, { words = WORDS, tsv = TSV } = {}) => ({ ...Object.fromEntries(Object.entries(plans).map(([name, plan]) => [name, JSON.stringify(plan)])),
  ...Object.fromEntries(Object.entries(words).map(([clip, list]) => [`words/${clip}.words.json`, JSON.stringify({ words: list })])), ...(tsv ? { 'moments.tsv': tsv } : {}) });

test('a plan\'s spans hold the words said inside each (padded), the overlapping rows, untimed rows for an untimed segment, and also spans in order', () => {
  const plan = { segments: [{ kind: 'question', clip: null }, { clip: 'C1', from: 2, to: 3 }, { clip: 'C2' },
    { clip: 'C1', from: 2, to: 3, also: { clip: 'C1', from: 9, to: 9.5 } }, { clip: 'C1', from: 2, to: 3, speaker: 'UNCHECKED: who' }] };
  holdingSpans({ settings: SETTINGS, files: sources({ 'plans/made-up.json': plan }) });
  const spans = spansOfPlan('plans/made-up.json');
  assert.deepEqual(spans.map(span => [span.clip, span.speaker_verified, span.text]), [
    ['C1', true, 'three months\nthree months'], ['C2', true, '\nthe untimed row'],
    ['C1', true, 'three months\nthree months\nlater'], ['C1', false, 'three months\nthree months']]);
  assert.equal(citedSpans('# A piece\nPlan: `plans/made-up.json`\n').length, 4);
  assert.deepEqual(citedSpans('No plan here.\n'), []);
  holdingSpans({ settings: SETTINGS, files: {} });
  assert.throws(() => citedSpans('Plan: `plans/made-up.json`\n'), error => error.code === 'ENOENT', 'a plan not handed in is never guessed');
});

test('a line inside a cited span is the person\'s words in their own origin word; a joined line only in the also order; unchecked speakers are added words', () => {
  const plan = { segments: [{ clip: 'C1', from: 2, to: 3, also: { clip: 'C1', from: 9, to: 9.5 } }, { clip: 'C1', from: 9, to: 9.5, speaker: 'UNCHECKED' }] };
  holdingSpans({ settings: SETTINGS, files: sources({ 'p.json': plan }, { tsv: null }) });
  const spans = spansOfPlan('p.json');
  const units = [{ text: 'Three months later.', kind: 'onscreen' }, { text: 'Later three months.', kind: 'onscreen' }, { text: 'Later.', kind: 'onscreen' }];
  assert.deepEqual(withSpokenOrigins(units, spans, { fold: JUDGE.fold, origins: SETTINGS.origin_words }).map(u => u.facts.origin),
    ['my-words', 'added-words', 'my-words'], 'a verified span is tried first');
  assert.deepEqual(withSpokenOrigins([{ text: 'Later.', kind: 'onscreen' }], [spans[1]], { fold: JUDGE.fold, origins: SETTINGS.origin_words })[0].facts.origin, 'unverified-speaker');
});

// ---- The whole film check through the branch (old CLI and check tests) ------------------------------------------------
test('a film\'s rules are read from the branch through the door; a branch\'s rows are verdict rows and the rows above are generic rules', async () => {
  const answer = await run([{ name: 'TITLES.md', text: '| # | Title |\n|---|---|\n| 1 | A wibble title |\n| 2 | A fine title |\n| 3 | a glorp title |\n' }]);
  assert.deepEqual(answer.lineage, ['made-up-video', 'made-up-writing', 'made-up-universal']);
  assert.deepEqual(answer.results.map(r => [r.text, r.verdict, r.breaks.map(f => f.rule).sort()]), [
    ['A wibble title', 'fail', ['title-no-wibble']], ['A fine title', 'pass', []], ['a glorp title', 'fail', ['no-glorp', 'starts-with-capital']]]);
  assert.equal(answer.status, 'failed');
  assert.equal(answer.exit_code, 1);
  assert.equal(answer.rules.count, 3);
  assert.equal(answer.verdict_rules.count, 3);
  await assert.rejects(checkAFilmsCopy({ branch: 'made-up-video', settings_record: SETTINGS_ID, files: [], rules: [] }, memoryDoor()), /Send a branch/);
});

test('a row for added words holds, never fails, on the person\'s own recorded words named in their own origin word', async () => {
  const files = [{ name: 'lines.txt', text: 'Plan: `plan.json`\nThree months zorblax.\nA zorblax line.\n' }];
  const words = { C1: [...WORDS.C1, { text: 'zorblax', start: 2.8, end: 3 }] };
  const answer = await run(files, { kind: 'voiceover', sources: sources({ 'plan.json': { segments: [{ clip: 'C1', from: 2, to: 3 }] } }, { words }) });
  const [own, added] = answer.results.filter(r => r.text.includes('zorblax'));
  assert.equal(own.facts.origin, 'my-words');
  assert.deepEqual([own.verdict, own.advisory, own.breaks], ['uncertain', true, []]);
  assert.ok(own.uncertain.some(f => f.rule === 'no-zorblax'));
  assert.deepEqual(added.breaks.map(f => f.rule), ['no-zorblax']);
  const missing = await run(files, { kind: 'voiceover' });
  assert.equal(missing.status, 'unqualified', 'a plan the piece names but nobody handed in is unqualified, never guessed');
});

test('an ask row\'s questions go back by id with the unit\'s context, and its answers pass, hold or fail the title; without answers it never passes (exit 3)', async () => {
  const door = memoryDoor(records({ checks: [...CHECKS, ASK] }));
  const files = [{ name: 'TITLES.md', text: '| # | Title |\n|---|---|\n| 1 | A fine title |\n' }];
  const context = [{ text: 'A fine title', context: { on_screen_with: ['Another'] } }];
  const first = await run(files, { context }, door);
  assert.equal(first.status, 'uncertain');
  assert.equal(first.exit_code, 3);
  const id = first.questions[0].asked[0].id;
  assert.equal(first.results[0].context.on_screen_with[0], 'Another');
  for (const [p, verdict] of [[0.1, 'pass'], [0.4, 'uncertain'], [0.9, 'fail']]) {
    assert.equal((await run(files, { context, answers: { [id]: { yes: 1 - p, no: p } } }, door)).results[0].verdict, verdict, String(p));
  }
  assert.equal((await run(files, { context, no_model: true, answers: { [id]: { yes: 1, no: 0 } } }, door)).results[0].verdict, 'uncertain', 'no-model keeps every question unknown');
});

test('an ask row reaches only the kinds it lists: a title is asked, a JSON plan and a kind it does not list are not (old decider-kinds)', async () => {
  const door = memoryDoor(records({ checks: [...CHECKS, ASK] }));
  const titled = await run([{ name: 'TITLES.md', text: '| # | Title |\n|---|---|\n| 1 | A fine title |\n' }], {}, door);
  assert.equal(titled.questions.length, 1);
  const plan = await run([{ name: 'plan.json', text: JSON.stringify({ events: [{ type: 'pause' }] }) }], { artifact_kind: 'plan' }, door);
  assert.equal(plan.questions.length, 0);
  const other = await run([{ name: 'lines.txt', text: 'Some made-up words.\n' }], { kind: 'plan-notes' }, door);
  assert.equal(other.questions.length, 0);
});

test('reader-knowledge findings reach each line in reading order; a check that could not run holds every line', async () => {
  const files = [{ name: 'lines.txt', text: 'A plain line.\nA second line.\nA third line.\n' }];
  const findings = [{ rule: 'unintroduced-reference', outcome: 'uncertain', line: 1, span: 'the thing', why: 'not mentioned before', sentence: 'A second line.' },
    { rule: 'label-colon-command', outcome: 'fail', line: 2, span: 'A third line.', why: 'a command', sentence: 'A third line.' }];
  const answer = await run(files, { reader_knowledge: { findings } });
  assert.deepEqual(answer.results.map(r => r.verdict), ['pass', 'uncertain', 'fail']);
  assert.equal(answer.results[2].breaks[0].rule, 'reader-knowledge/label-colon-command');
  const notRun = await run(files, { reader_knowledge: { not_run: 'no spaCy here' } });
  assert.ok(notRun.results.every(r => r.verdict === 'uncertain' && r.uncertain.some(f => f.rule === 'reader-knowledge-not-run')));
  const { reader_knowledge: _, ...without } = SETTINGS;
  assert.deepEqual((await run(files, {}, memoryDoor(records({ settings: without })))).results.map(r => r.verdict), ['pass', 'pass', 'pass'], 'a person with no reader-knowledge rows is not held by them');
  assert.deepEqual(knowledgeOf(2, null, 'why').map(found => found[0].rule), ['reader-knowledge-not-run', 'reader-knowledge-not-run']);
});

test('a file with no copy, or with a source quote the reader cannot place, is unqualified (exit 2) and its report keeps none of its text', async () => {
  const empty = await run([{ name: 'empty.txt', text: '' }]);
  assert.deepEqual([empty.status, empty.exit_code, empty.results.length], ['unqualified', 2, 0]);
  const quoted = await run([{ name: 'prose.md', text: '# A made-up title\n\nPrivate preamble words.\n\n## Article\nAuthored words.\n> Quoted source words.\n\n## Spoken video script\nSpoken words.\n' }],
    { reader: 'sectioned-prose' });
  assert.equal(quoted.status, 'unqualified');
  const said = JSON.stringify(quoted);
  assert.ok(!said.includes('Private preamble words.') && !said.includes('Quoted source words.'));
  assert.equal((await run([{ name: 'w.json', text: '{"title":"A title"}' }], { reader: 'json-words' })).status, 'unqualified', 'json-words needs an owner');
  assert.equal((await run([{ name: 'w.json', text: '{"title":"A title"}' }], { reader: 'json-words', owner: 'not-an-owner' })).status, 'unqualified');
  assert.equal((await run([{ name: 'w.json', text: '{"title":"A made-up title"}' }], { reader: 'json-words', owner: 'made-up-titles' })).results[0].field, 'title');
});

test('auto reads the declared prose shape or the film tables, and cue narration keeps its cue ids', async () => {
  const prose = await run([{ name: 'prose.md', text: '# A made-up title\n\n## Article\nAuthored words.\n\n## Spoken video script\nSpoken words.\n' }], { reader: 'auto' });
  assert.equal(prose.coverage.files[0].reader, 'sectioned-prose');
  const table = await run([{ name: 'any.md', text: script(['A made-up line.']) }], { reader: 'auto' });
  assert.equal(table.coverage.files[0].reader, 'film');
  const cues = await run([{ name: 'n.md', text: '---\nvoice: made-up\n---\n## one\nA made-up cue line.\n' }], { reader: 'cue-narration' });
  assert.deepEqual([cues.coverage.files[0].cue_ids, cues.coverage.files[0].frontmatter, cues.results[0].cue_id], [['one'], { voice: 'made-up' }, 'one']);
});

test('the report binds its inputs by BLAKE3 and is the same on a repeat; the settings come from the person\'s row, refused when missing', async () => {
  const files = [{ name: 'lines.txt', text: 'A made-up line.\n' }];
  const [first, again] = [await run(files), await run(files)];
  for (const key of ['checker_blake3', 'settings_blake3']) assert.match(first[key], /^[0-9a-f]{64}$/);
  assert.match(first.coverage.files[0].source_blake3, /^[0-9a-f]{64}$/);
  assert.deepEqual([first.rules, first.coverage, first.reader], [again.rules, again.coverage, again.reader]);
  assert.equal(first.schema, 'copy-check-report-v1');
  await assert.rejects(checkAFilmsCopy({ branch: 'made-up-video', settings_record: 'record:setting:check-against-a-persons-rules-and-verdicts~person~nobody', files }, memoryDoor()));
});

test('the units the computer run hands reader_knowledge.py are the ones the check reads, in the same order', () => {
  const { units } = filmUnits({ files: [{ name: 'lines.txt', text: 'One.\nTwo.\nOne.\n' }] }, SETTINGS);
  assert.deepEqual(readingUnits(units), [{ text: 'One.', kind: 'voiceover', where: 0 }, { text: 'Two.', kind: 'voiceover', where: 1 }]);
});

// ---- The context of a line (old test 'unit-context reads a line's neighbours...') -------------------------------------
test('unit-context reads a line\'s neighbours within its own line, and an on-screen string\'s option and spoken words, only from the files handed in', () => {
  holding({ 'lines.txt': 'Other take. Not this one.\nFirst one. The judged line. Last one.\n',
    'spec.json': JSON.stringify({ edit: { overlay: { at: 10 } }, duration_s: 2, events: [{ type: 'x', title: 'add', steps: [{ text: 'remove' }], src: 'add' }] }),
    'words.json': JSON.stringify([{ w: 'early', s: 1, e: 2 }, { w: 'then', s: 8, e: 8.5 }, { w: 'add', s: 11, e: 11.4 }, { w: 'late', s: 20, e: 21 }]) });
  assert.deepEqual(contextFromText('lines.txt', 'The judged line.').context, { before: 'First one.', after: 'Last one.' });
  assert.equal(contextFromText('lines.txt', 'Missing line.').context, null);
  assert.deepEqual(contextFromSpec('spec.json', 'add', { words: 'words.json', textKeys: '^(text|title)$', leadS: 3 }).context, { on_screen_with: ['remove'], spoken: 'then add' });
  assert.equal(contextFromSpec('spec.json', 'question', { words: 'words.json', textKeys: '^(text|title)$' }).context, null);
  const built = build({ units: [{ text: 'The judged line.', source: { text_file: 'lines.txt' } }, { text: 'X.', source: { text_file: 'not-handed-in.txt' } }] },
    { 'lines.txt': 'First one. The judged line. Last one.\n' });
  assert.deepEqual(built.map(unit => unit.context), [{ before: 'First one.', after: 'Last one.' }, null]);
  assert.match(built[1].why, /not handed in/);
  const command = spawnSync(process.execPath, [join(here, 'do-work/unit-context.mjs')], { input: JSON.stringify({ sources: { units: [{ text: 'The judged line.', source: { text_file: 'a.txt' } }] }, files: { 'a.txt': 'Before. The judged line.' } }), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(command.stdout.trim().split('\n').at(-1)).result.units[0].context, { before: 'Before.' });
});

// ---- The computer run (old CLI tests: exit codes, no-model, readback, links and FIFOs) --------------------------------
function computer(files, extra = [], held = records()) {
  const dir = mkdtempSync(join(tmpdir(), 'film-copy-'));
  const paths = files.map(([name, text]) => { const path = join(dir, name); writeFileSync(path, text); return path; });
  const door = join(dir, 'records.json'), report = join(dir, 'report.json');
  writeFileSync(door, JSON.stringify(held));
  const cli = join(here, 'do-work/check-a-films-copy.mjs');
  const done = spawnSync(process.execPath, [cli, ...paths, '--branch', 'made-up-video', '--settings-record', SETTINGS_ID, '--door-records', door,
    '--reader-knowledge-python', '/nonexistent/python', '--report', report, ...extra], { encoding: 'utf8', cwd: dir });
  let read = null;
  try { read = JSON.parse(readFileSync(report, 'utf8')); } catch { read = null; }
  return { status: done.status, stdout: done.stdout, stderr: done.stderr, report: read, dir };
}

test('the computer run: exit 0 when every line passes, 1 when a rule fails, 2 on a file with no copy, 3 when only held', () => {
  const { reader_knowledge: _, ...plain } = SETTINGS;
  const held = records({ settings: plain });
  assert.equal(computer([['lines.txt', 'A made-up line.\n']], ['--no-model'], held).status, 0);
  assert.equal(computer([['lines.txt', 'A glorp line.\n']], ['--no-model'], held).status, 1);
  assert.equal(computer([['empty.txt', '']], ['--no-model'], held).status, 2);
  const rk = computer([['lines.txt', 'A made-up line.\n']], ['--no-model']);
  assert.equal(rk.status, 3, 'the reader-knowledge check could not run in a Python that is not there, so the line is held');
  assert.ok(rk.report.results[0].uncertain.some(f => f.rule === 'reader-knowledge-not-run'));
});

test('the computer run hands every question to the decider\'s answer command and judges with its answers; --no-model never calls it', () => {
  const { reader_knowledge: _, ...plain } = SETTINGS;
  const held = records({ settings: plain, checks: [...CHECKS, ASK] });
  const dir = mkdtempSync(join(tmpdir(), 'decider-'));
  const layer = join(dir, 'decider_layer.py'), seen = join(dir, 'seen.json');
  writeFileSync(layer, `import json, sys\nasks = json.load(sys.stdin)\nassert sys.argv[1:] == ["answer", "--mode", "live"], sys.argv\nopen(${JSON.stringify(seen)}, "w").write(json.dumps(asks))\nprint(json.dumps([{"yes": 0.95, "no": 0.05} for _ in asks]))\n`);
  const python = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();
  const titles = [['TITLES.md', '| # | Title |\n|---|---|\n| 1 | A fine title |\n']];
  const answered = computer(titles, ['--decider', 'live', '--decider-python', python, '--decider-layer', layer], held);
  assert.equal(answered.status, 0, answered.stderr);
  assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')).map(ask => [ask.question, ask.text, ask.options]), [['Is this line plain?', 'A fine title', ['yes', 'no']]]);
  const none = computer(titles, ['--no-model', '--decider-python', python, '--decider-layer', layer], held);
  assert.equal(none.status, 3);
  assert.equal(computer(titles, ['--no-model', '--decider', 'live'], held).status, 2, '--no-model and --decider together are refused');
  assert.equal(computer(titles, [], held).status, 3, 'no decider here: every question stays unknown');
});

test('the computer run refuses a link or a FIFO as a source, and reads a regular file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'film-descriptor-'));
  const file = join(dir, 'words.txt'), link = join(dir, 'link.txt'), fifo = join(dir, 'pipe.txt');
  writeFileSync(file, 'A made-up line.');
  symlinkSync(file, link);
  assert.throws(() => readSourceBytes(link), /regular/);
  assert.equal(spawnSync('/usr/bin/mkfifo', [fifo]).status, 0);
  assert.throws(() => readSourceBytes(fifo), /regular/);
  assert.equal(readSourceBytes(file).toString(), 'A made-up line.');
});

test('reader_knowledge.py takes its rules as input and refuses a request without them, before any parser loads', () => {
  const tool = join(here, 'do-work/reader_knowledge.py');
  const refused = spawnSync('python3', ['-I', tool, 'run'], { input: JSON.stringify({ units: [{ text: 'A line.', kind: 'voiceover', where: 0 }] }), encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.match(JSON.parse(refused.stdout.trim()).error, /reader_knowledge block/);
});

// ---- The place it runs (old place-reports test 'the gate names no home folder...') ------------------------------------
test('the film check names no home folder, install folder, fixed local port, film folder or person', () => {
  const files = ['do-work/check-a-films-copy.mjs', 'do-work/read-film-copy.mjs', 'do-work/spans-of-a-plan.mjs', 'do-work/unit-context.mjs', 'do-work/reader_knowledge.py', 'read-data/film-copy.json'];
  const tie = /homedir\(\)|Path\.home\(\)|\/opt\/homebrew\/|\/Users\/[^/]+\/|127\.0\.0\.1:\d+|localhost:\d+|device="mps"|films\/[a-z]/;
  const found = files.flatMap(name => readFileSync(join(here, name), 'utf8').split('\n').map((line, at) => [name, at + 1, line]))
    .filter(([, , line]) => tie.test(line)).map(([name, at, line]) => `${name}:${at}: ${line.trim()}`);
  assert.deepEqual(found, []);
});
