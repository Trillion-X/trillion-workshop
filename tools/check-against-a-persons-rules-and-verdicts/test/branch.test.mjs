// tools/check-against-a-persons-rules-and-verdicts: one judge for every check, reading one check list by branch.
// Made-up rows only: a made-up base, a made-up branch extending it, and a made-up grandchild carrying check_lists and
// judge_settings, kept in an in-memory records door that counts its calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BranchRefusal, checksOfBranch, lineageOf } from '../do-work/branch.mjs';
import { checkABranch, readingQuestion, readingRow, rulesOfBranch } from '../do-work/check-a-branch.mjs';
import { makeJudge, SELECTOR_NAMES } from '../../judge-words/do-work/judge-words.mjs';
import { atomsOf, pieceRow, pieceRows } from '../do-work/pieces.mjs';
import { readFileSync } from 'node:fs';
import SETTINGS_OF_BRANCH from '../read-data/branch.json' with { type: 'json' };

const SETTINGS = { fold: { lowercase: true, collapse_space: true }, stage: { default: 'final' }, stance_rule: 'their-stance',
  novel: { rule: 'novel', says: 'Nothing of theirs judges this.' }, agree_clears: { rules: [] }, kept_at: 'made-up-place' };
const methods = () => [
  { id: 'made-up-base', name: 'Any made-up thing' },
  { id: 'made-up-branch', name: 'A made-up read thing', extends: 'made-up-base' },
  { id: 'made-up-grandchild', name: 'A made-up post', extends: 'made-up-branch', check_lists: ['list:made-up-voice'], judge_settings: SETTINGS },
  { id: 'made-up-other', name: 'Another made-up thing', extends: 'made-up-base' },
];
const checks = () => [
  { id: 'no-glitter', method: 'made-up-base', words: ['glitter'], says: 'No glitter.', came_from: { list: 'list:made-up-word-checks', record_id: 'record:made-up-word-check:1' } },
  // A step row: its check is question text, which judge-words would refuse as an unknown check name.
  { id: 'base-question', method: 'made-up-base', step: 'outcome', check: 'Have you named what changes?', good_answer: 'Names it.' },
  { id: 'no-sparkle', method: 'made-up-branch', words: ['sparkle'], says: 'No sparkle.' },
  { id: 'no-wibble', method: 'made-up-branch', on: 'Off', words: ['wibble'], says: 'No wibble.' },
  { id: 'no-zorblax', method: 'made-up-grandchild', kinds: ['title'], words: ['zorblax'], says: 'Never zorblax.' },
  { id: 'no-frobnicate', method: 'made-up-other', words: ['frobnicate'], says: 'Not here.' },
];
const voiceRows = () => [{ id: 'no-blorp', kinds: ['title'], words: ['blorp'], says: 'Never blorp.' }];

function memoryDoor({ methodRows = methods(), checkRows = checks(), lists = { 'list:made-up-voice': { row_type: 'writing-voice' } }, listRows = { 'writing-voice': voiceRows() } } = {}) {
  const records = [
    ...methodRows.map(value => ({ id: `record:method:${value.id}`, type: 'record:method', value })),
    ...checkRows.map(value => ({ id: `record:check:${value.id}`, type: 'record:check', value })),
    ...Object.entries(lists).map(([id, value]) => ({ id, type: 'list', value })),
    ...Object.entries(listRows).flatMap(([rowType, rows]) => rows.map(value => ({ id: `record:${rowType}:${value.id}`, type: `record:${rowType}`, value }))),
  ];
  const calls = [];
  const matches = (record, where) => !where || Object.entries(where).every(([name, value]) => JSON.stringify(record.value?.[name]) === JSON.stringify(value));
  return {
    calls,
    async read(type, id) { calls.push({ op: 'read', type, id }); return records.find(record => record.type === type && record.id === id)?.value ?? null; },
    async *list(query) {
      calls.push({ op: 'list', ...query });
      for (const record of records) if (record.type === query.type && matches(record, query.where)) yield record;
    },
    write() { throw new Error('the branch mode writes nothing'); },
  };
}

test('a lineage is nearest first, up to the base; an unknown id or a cycle is refused', () => {
  assert.deepEqual(lineageOf(methods(), 'made-up-grandchild'), ['made-up-grandchild', 'made-up-branch', 'made-up-base']);
  assert.deepEqual(lineageOf(methods(), 'made-up-base'), ['made-up-base']);
  assert.throws(() => lineageOf(methods(), 'made-up-nowhere'), BranchRefusal);
  assert.throws(() => lineageOf([{ id: 'a', extends: 'gone' }], 'a'), /extends gone/);
  assert.throws(() => lineageOf([{ id: 'a', extends: 'b' }, { id: 'b', extends: 'a' }], 'a'), /cycle/);
  const lineage = lineageOf(methods(), 'made-up-branch');
  assert.deepEqual(checksOfBranch([...checks(), { id: 'everyone' }], lineage).map(row => row.id), ['no-glitter', 'base-question', 'no-sparkle', 'no-wibble', 'everyone']);
});

test('each branch of the lineage is read with where { method }, never the whole Checks list, and nothing is written', async () => {
  const door = memoryDoor();
  const { lineage, rows_used } = await rulesOfBranch(door, 'made-up-grandchild');
  const checkCalls = door.calls.filter(call => call.type === 'record:check');
  assert.deepEqual(checkCalls.map(call => call.where), lineage.map(method => ({ method })));
  assert.equal(checkCalls.length, 3);
  assert.deepEqual(rows_used, { branches: { 'made-up-grandchild': 1, 'made-up-branch': 2, 'made-up-base': 2 }, lists: { 'list:made-up-voice': 1 }, skipped: { step: 1, off: 1, no_test: 0 } });
  assert.equal(door.calls.length, 1 + 3 + 2, 'the methods once, each branch once, the list record and its rows once');
});

test('a step row never reaches makeJudge and an Off row is not judged', async () => {
  const { rules, verdict_rules } = await rulesOfBranch(memoryDoor(), 'made-up-grandchild');
  const ids = [...rules, ...verdict_rules.rows].map(row => row.id);
  assert.ok(!ids.includes('base-question'));
  assert.ok(!ids.includes('no-wibble'));
  assert.throws(() => makeJudge([checks().find(row => row.step)]), /names the check/, 'the step row would break the judge');
  // Judged whole: a question row's check would be refused by judge-words as an unknown check, so this run proves it never got there.
  const answer = await checkABranch({ branch: 'made-up-grandchild', units: [{ text: 'A wibble of things', kind: 'title' }], stage: 'review' }, memoryDoor());
  assert.ok(!answer.results.flatMap(result => result.breaks).some(item => item.rule === 'no-wibble'));
});

test('the rows of the grandchild and of its check_lists are verdict rows under its judge_settings; inherited rows are generic rules', async () => {
  const { rules, verdict_rules } = await rulesOfBranch(memoryDoor(), 'made-up-grandchild');
  assert.deepEqual(verdict_rules.rows.map(row => row.id), ['no-zorblax', 'no-blorp']);
  assert.deepEqual(rules.map(row => row.id), ['no-sparkle', 'no-glitter']);
  assert.equal(verdict_rules.kept_at, 'made-up-place');
  assert.equal(verdict_rules.stance_rule, 'their-stance');
  const answer = await checkABranch({ branch: 'made-up-grandchild', units: [{ text: 'Blorp', kind: 'title' }] }, memoryDoor());
  assert.equal(answer.status, 'failed');
  assert.deepEqual(answer.results[0].breaks.map(item => item.rule), ['no-blorp']);
  assert.deepEqual(answer.lineage, ['made-up-grandchild', 'made-up-branch', 'made-up-base']);
  assert.equal(answer.branch, 'made-up-grandchild');
});

test('a branch with no judge_settings judges every row of its lineage as a generic rule, and leaves out other branches', async () => {
  const { rules, verdict_rules, lineage } = await rulesOfBranch(memoryDoor(), 'made-up-branch');
  assert.equal(verdict_rules, null);
  assert.deepEqual(lineage, ['made-up-branch', 'made-up-base']);
  assert.deepEqual(rules.map(row => row.id), ['no-sparkle', 'no-glitter']);
  const answer = await checkABranch({ branch: 'made-up-branch', units: [{ text: 'Sparkle and frobnicate', kind: 'line' }] }, memoryDoor());
  assert.deepEqual(answer.results[0].breaks.map(item => item.rule), ['no-sparkle']);
});

test('the nearest branch row wins over an inherited row with the same id', async () => {
  const rows = [...checks(), { id: 'no-sparkle', method: 'made-up-grandchild', kinds: ['title'], words: ['shimmer'], says: 'No shimmer here.' }];
  const { rules, verdict_rules } = await rulesOfBranch(memoryDoor({ checkRows: rows }), 'made-up-grandchild');
  assert.deepEqual(verdict_rules.rows.find(row => row.id === 'no-sparkle').words, ['shimmer']);
  assert.ok(!rules.some(row => row.id === 'no-sparkle'));
});

test('an unknown branch, a missing check list, a list of another row type, and rules beside a branch are refused', async () => {
  await assert.rejects(rulesOfBranch(memoryDoor(), 'made-up-nowhere'), /no method made-up-nowhere/);
  await assert.rejects(rulesOfBranch(memoryDoor(), ''), /branch must be/);
  await assert.rejects(rulesOfBranch(memoryDoor({ lists: {} }), 'made-up-grandchild'), /names the check list list:made-up-voice, which is not/);
  await assert.rejects(rulesOfBranch(memoryDoor({ lists: { 'list:made-up-voice': { row_type: 'made-up-secret' } } }), 'made-up-grandchild'), /rows are made-up-secret/);
  await assert.rejects(rulesOfBranch(memoryDoor({ methodRows: [] }), 'made-up-base'), /no method rows/);
  await assert.rejects(rulesOfBranch(memoryDoor({ checkRows: [] }), 'made-up-base'), /has no check rows/);
  await assert.rejects(checkABranch({ branch: 'made-up-base', rules: [{ id: 'x', words: ['x'] }], units: [{ text: 'x', kind: 'line' }] }, memoryDoor()), /not both/);
});

test('the row may read, and only read, the method rows, the Checks list, lists and every check list row type it allows', () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
  const rights = rows.find(row => row.id === 'tool:check-against-a-persons-rules-and-verdicts').invoke.records.rights;
  const kinds = [SETTINGS_OF_BRANCH.method_type, SETTINGS_OF_BRANCH.check_type, ...SETTINGS_OF_BRANCH.check_list_row_types.map(type => `record:${type}`)];
  assert.deepEqual(rights.map(right => right.kind).sort(), [...kinds, SETTINGS_OF_BRANCH.list_type].sort());
  for (const right of rights) assert.deepEqual(right.operations, right.kind === SETTINGS_OF_BRANCH.list_type ? ['records:read'] : ['records:list']);
});

// A made-up row that states no test but says something, with the made-up words it is about.
const noted = (id, method, extra = {}) => ({ id, method, kind: 'check', says: `Made-up note ${id}.`, made_up_words: `Made-up words of ${id}.`, tags: ['made-up'], ...extra });
const CALIBRATED = { calibration: { status: 'usable', t_pass: 0.2, t_fail: 0.8 }, model: { name: 'made-up-model' } };

test('a row that states no test but says something becomes a reading row; a piece or a row with nothing to say is skipped', async () => {
  const noTest = { id: 'made-up-belief', method: 'made-up-branch', says: 'A made-up belief with no test to run.' };
  const silent = { id: 'made-up-silent', method: 'made-up-branch', says: '  ', tags: ['made-up'] };
  const piece = { id: 'piece-000000000000000000000000', kind: 'piece', method: 'made-up-base', says: 'Made-up lead', text: 'Made-up lead text.', tags: [], kinds: [], checked_by: [] };
  assert.throws(() => makeJudge([noTest]), /needs words/, 'the row would refuse the whole branch if it reached makeJudge');
  const door = memoryDoor({ checkRows: [...checks(), noTest, silent, piece] });
  const { rules, rows_used, read_by_a_model } = await rulesOfBranch(door, 'made-up-branch');
  assert.deepEqual(rules.map(row => row.id), ['made-up-belief', 'no-sparkle', 'no-glitter']);
  assert.equal(rows_used.skipped.no_test, 2, 'only the piece and the row with no words are skipped');
  assert.deepEqual(read_by_a_model, { rows: [{ id: 'made-up-belief', says: 'A made-up belief with no test to run.' }], more: 0, settings_from: null });
  const reading = rules[0];
  assert.deepEqual({ ...reading, ask: undefined }, { ...noTest, ask: undefined }, 'the row itself is unchanged');
  assert.deepEqual(Object.keys(reading.ask).sort(), ['fail', 'options', 'per', 'question']);
  assert.equal(reading.ask.per, 'unit');
  assert.equal(reading.ask.fail, SETTINGS_OF_BRANCH.reading.fail);
  assert.deepEqual(reading.ask.options, SETTINGS_OF_BRANCH.reading.options);
  assert.ok(reading.ask.question.includes('A made-up belief with no test to run.'));
  const answer = await checkABranch({ branch: 'made-up-branch', units: [{ text: 'Sparkle', kind: 'line' }] }, memoryDoor({ checkRows: [...checks(), noTest] }));
  assert.equal(answer.status, 'failed');
  assert.deepEqual(answer.read_by_a_model.rows.map(row => row.id), ['made-up-belief']);
});

test('a reading row\'s question is made from read-data/branch.json: each string part filled, a field part only when the row has words there that says does not hold', () => {
  const parts = [...SETTINGS_OF_BRANCH.reading.question];
  const field = parts.find(part => typeof part === 'object').field;
  const strings = parts.filter(part => typeof part === 'string');
  const row = { id: 'made-up-row', says: 'Made-up says.', [field]: 'Made-up other words.' };
  const question = readingQuestion(row);
  assert.equal(question.split('\n').length, parts.length);
  assert.ok(question.includes('Made-up says.') && question.includes('Made-up other words.'));
  assert.equal(readingQuestion({ ...row, [field]: undefined }).split('\n').length, strings.length, 'no words at the field: the part is left out');
  assert.equal(readingQuestion({ ...row, says: 'Made-up says: Made-up other words.' }).split('\n').length, strings.length, 'says already holds them: not said twice');
  assert.equal(readingRow(row).ask.question, question);
});

test('the nearest branch\'s reading_settings give every reading row of its lineage their calibration and model', async () => {
  const methodRows = methods().map(row => (row.id === 'made-up-branch' ? { ...row, reading_settings: CALIBRATED }
    : row.id === 'made-up-base' ? { ...row, reading_settings: { calibration: { status: 'unseparable' } } } : row));
  const door = memoryDoor({ methodRows, checkRows: [...checks(), noted('made-up-a', 'made-up-base'), noted('made-up-b', 'made-up-branch')] });
  const { rules, read_by_a_model } = await rulesOfBranch(door, 'made-up-branch');
  assert.equal(read_by_a_model.settings_from, 'made-up-branch');
  for (const id of ['made-up-a', 'made-up-b']) {
    const ask = rules.find(row => row.id === id).ask;
    assert.deepEqual(ask.calibration, CALIBRATED.calibration);
    assert.deepEqual(ask.model, CALIBRATED.model);
  }
  const base = await rulesOfBranch(memoryDoor({ methodRows, checkRows: [noted('made-up-a', 'made-up-base')] }), 'made-up-base');
  assert.equal(base.read_by_a_model.settings_from, 'made-up-base');
  assert.equal(base.rules[0].ask.calibration.status, 'unseparable');
});

test('reading rows are asked once a unit, never once a sentence, and no unit passes on them uncalibrated or unanswered', async () => {
  const rows = [noted('made-up-a', 'made-up-base'), noted('made-up-b', 'made-up-base'), noted('made-up-c', 'made-up-base')];
  const units = [{ text: 'One made-up sentence. Two made-up sentences. Three.', kind: 'line' }, { text: 'Another made-up unit.', kind: 'line' }];
  // Uncalibrated: every question is asked, and the units are uncertain, never passed, whatever the answers say.
  const bare = await checkABranch({ branch: 'made-up-base', units }, memoryDoor({ checkRows: rows }));
  assert.equal(bare.questions.length, rows.length * units.length, 'one question a reading row a unit');
  assert.deepEqual(bare.questions.map(question => question.text), [...rows.map(() => units[0].text), ...rows.map(() => units[1].text)]);
  const allPass = Object.fromEntries(bare.questions.map(question => [question.id, { yes: 0.01 }]));
  const uncalibrated = await checkABranch({ branch: 'made-up-base', units, answers: allPass }, memoryDoor({ checkRows: rows }));
  assert.equal(uncalibrated.status, 'uncertain');
  assert.ok(uncalibrated.results.every(result => result.uncertain.some(finding => finding.qualified === false && finding.rule === 'made-up-a')));
  // Calibrated: unanswered is uncertain, low answers pass, one answer at or over t_fail fails the unit on that row.
  const methodRows = methods().map(row => (row.id === 'made-up-base' ? { ...row, reading_settings: CALIBRATED } : row));
  const door = () => memoryDoor({ methodRows, checkRows: rows });
  const asked = await checkABranch({ branch: 'made-up-base', units }, door());
  assert.equal(asked.status, 'uncertain');
  assert.ok(asked.questions.every(question => question.model?.name === 'made-up-model'));
  const passed = await checkABranch({ branch: 'made-up-base', units, answers: allPass }, door());
  assert.equal(passed.status, 'passed');
  const oneBad = { ...allPass, [asked.questions.find(question => question.rule === 'made-up-b' && question.id.startsWith('0:')).id]: { yes: 0.93 } };
  const failed = await checkABranch({ branch: 'made-up-base', units, answers: oneBad }, door());
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.results[0].breaks.map(finding => [finding.rule, finding.p_fail]), [['made-up-b', 0.93]]);
  assert.equal(failed.results[1].verdict, 'pass');
  const missing = Object.fromEntries(Object.entries(allPass).slice(1));
  assert.equal((await checkABranch({ branch: 'made-up-base', units, answers: missing }, door())).status, 'uncertain');
});

test('reading rows under judge_settings are the person\'s reading rows, asked once a unit', async () => {
  const methodRows = methods().map(row => (row.id === 'made-up-grandchild' ? { ...row, reading_settings: CALIBRATED } : row));
  const door = memoryDoor({ methodRows, checkRows: [...checks(), noted('made-up-own', 'made-up-grandchild')] });
  const { verdict_rules } = await rulesOfBranch(door, 'made-up-grandchild');
  assert.ok(verdict_rules.rows.some(row => row.id === 'made-up-own' && row.ask.per === 'unit'));
  const unit = { text: 'A made-up title. With two sentences.', kind: 'title' };
  const answer = await checkABranch({ branch: 'made-up-grandchild', units: [unit] }, memoryDoor({ methodRows, checkRows: [...checks(), noted('made-up-own', 'made-up-grandchild')] }));
  assert.deepEqual(answer.questions.map(question => [question.rule, question.text]), [['made-up-own', unit.text]]);
});

test('a row with ask or part states its test and is not skipped', async () => {
  const asks = { id: 'made-up-ask', method: 'made-up-base', says: 'Reads oddly.', ask: { question: 'Does it read oddly?', options: ['yes', 'no'], fail: 'yes' } };
  const part = { id: 'made-up-part', method: 'made-up-base', says: 'Read the voice.', part: { kind: 'voice' } };
  const { rules, rows_used } = await rulesOfBranch(memoryDoor({ checkRows: [asks, part] }), 'made-up-base');
  assert.deepEqual(rules.map(row => row.id), ['made-up-ask', 'made-up-part']);
  assert.equal(rows_used.skipped.no_test, 0);
});

test('a branch with only rows that neither state a test nor say anything answers no-applicable-rule, never a refusal; its list of reading rows is bounded', async () => {
  const most = SETTINGS_OF_BRANCH.read_by_a_model_at_most;
  const silent = Array.from({ length: 4 }, (_, at) => ({ id: `made-up-silent-${at}`, method: 'made-up-base', tags: ['made-up'] }));
  const answer = await checkABranch({ branch: 'made-up-base', units: [{ text: 'Anything', kind: 'line' }] }, memoryDoor({ checkRows: silent }));
  assert.equal(answer.status, 'no-applicable-rule');
  assert.equal(answer.passed, false);
  assert.deepEqual(answer.results, []);
  assert.equal(answer.rows_used.skipped.no_test, 4);
  assert.deepEqual(answer.read_by_a_model, { rows: [], more: 0, settings_from: null });
  assert.match(answer.lines[0], /no row that states a test or says anything/);
  const many = Array.from({ length: most + 3 }, (_, at) => noted(`made-up-note-${String(at).padStart(3, '0')}`, 'made-up-base'));
  const read = await checkABranch({ branch: 'made-up-base', units: [{ text: 'Anything', kind: 'line' }] }, memoryDoor({ checkRows: many }));
  assert.equal(read.status, 'uncertain');
  assert.equal(read.rows_used.skipped.no_test, 0);
  assert.equal(read.read_by_a_model.rows.length, most);
  assert.equal(read.read_by_a_model.more, 3);
  assert.equal(read.questions.length, most + 3);
  // A branch with no rows at all is still refused: there is nothing to read either.
  await assert.rejects(rulesOfBranch(memoryDoor({ checkRows: [] }), 'made-up-base'), /has no check rows/);
});

test('a piece row from pieceRow, in a branch with one word row, never reaches makeJudge, and the branch judges the word row', async () => {
  const [atom] = atomsOf('## Made-up part\n\n**Made-up lead.** Made-up words of a made-up file.\n');
  const piece = { ...pieceRow(atom, { file: 'made-up.md', file_identity: '1f:' + 'e'.repeat(64) }), method: 'made-up-base' };
  const word = { id: 'no-glitter', method: 'made-up-base', words: ['glitter'], says: 'No glitter.' };
  // Under the old field name the piece reached makeJudge as a groups rule and refused the whole branch.
  const { tags, ...untagged } = piece;
  assert.throws(() => makeJudge([word, { ...untagged, kind: undefined, groups: tags }]), /groups/);
  // A piece names no selector, so it is not a test, and it is never read by a model as a rule.
  const { rules, rows_used, read_by_a_model } = await rulesOfBranch(memoryDoor({ checkRows: [word, piece] }), 'made-up-base');
  assert.deepEqual(rules.map(rule => rule.id), ['no-glitter']);
  assert.equal(rows_used.skipped.no_test, 1);
  assert.deepEqual(read_by_a_model.rows, [], 'a piece is never a reading row');
  // Without its kind it is a row that says something, so it is read, never judged by makeJudge.
  const unkinded = await rulesOfBranch(memoryDoor({ checkRows: [word, { ...piece, kind: undefined }] }), 'made-up-base');
  assert.deepEqual(unkinded.rules.map(rule => [rule.id, rule.ask?.per ?? null]), [['no-glitter', null], [piece.id, 'unit']].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  assert.equal(unkinded.rows_used.skipped.no_test, 0);
  const door = memoryDoor({ checkRows: [word, piece] });
  const failed = await checkABranch({ branch: 'made-up-base', units: [{ text: 'Made-up glitter', kind: 'line' }] }, door);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.results.some(result => result.rule === 'no-glitter' || JSON.stringify(result).includes('no-glitter')));
  const passed = await checkABranch({ branch: 'made-up-base', units: [{ text: 'Made-up plain words', kind: 'line' }] }, door);
  assert.notEqual(passed.status, 'failed');
});

test('no row pieceRow or pieceRows makes names any judge-words selector', () => {
  const text = '# Made-up\n\nA paragraph.\n\n## Part\n\n**Lead.** Words.\n\n1. An item\n\n| A | B |\n|---|---|\n| Row | b |\n\n```\nfenced\n```\n';
  const rows = [...atomsOf(text).map(atom => pieceRow(atom)), ...pieceRows([{ text, file: 'made-up.md' }, { text, file: 'again.md' }])];
  assert.ok(rows.length > 0);
  for (const row of rows) for (const name of SELECTOR_NAMES) assert.equal(name in row, false, `${row.id} must not carry ${name}`);
  assert.ok(SELECTOR_NAMES.includes('groups'), 'groups is a selector, which is why a piece row carries tags');
});
