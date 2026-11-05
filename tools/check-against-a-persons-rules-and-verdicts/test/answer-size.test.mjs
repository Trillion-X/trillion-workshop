// tools/check-against-a-persons-rules-and-verdicts: the branch mode's answer at the size of a real list. Every row and
// word here is made up. A branch of n reading rows asks n questions of each unit, so the answer must not grow with n
// times the unit's text: the measured live failure was 446 voice rows on a 346-character unit answering 393,216 bytes
// against the engine's 262,144-byte bound on a run's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkABranch } from '../do-work/check-a-branch.mjs';

const ENGINE_OUTPUT_BOUND = 256 * 1024;
const SETTINGS = { fold: { lowercase: true, collapse_space: true }, stage: { default: 'final' }, stance_rule: 'their-stance',
  novel: { rule: 'novel', says: 'Nothing of theirs judges this.' }, agree_clears: { rules: [] }, kept_at: 'made-up-place' };
const CALIBRATION = { status: 'usable', t_pass: 0.2, t_fail: 0.8 };
const ADAPTER = { blake3: `b3:${'a'.repeat(64)}`, name: 'made-up-adapter' };

function door(rowCount) {
  const records = [
    { id: 'record:check:made-up-root', type: 'record:check', value: { id: 'made-up-root', kind: 'branch' } },
    { id: 'record:check:made-up-book', type: 'record:check', value: { id: 'made-up-book', kind: 'branch', part_of: 'made-up-root', judge_settings: SETTINGS,
      reading_settings: { calibration: CALIBRATION, model: 'made-up-model', adapter: ADAPTER } } },
    { id: 'record:check:no-glitter', type: 'record:check', value: { id: 'no-glitter', part_of: 'made-up-root', words: ['glitter'], says: 'No glitter.' } },
    ...Array.from({ length: rowCount }, (_, at) => ({ id: `record:check:voice-${at}`, type: 'record:check', value: { id: `voice-${at}`, part_of: 'made-up-book',
      says: `Made-up note ${at}: never write a made-up thing in a made-up way, since the made-up reader does not like it.`, his_words: `made-up words ${at}` } })),
  ];
  const matches = (record, where) => !where || Object.entries(where).every(([name, value]) => JSON.stringify(record.value?.[name]) === JSON.stringify(value));
  return {
    async read() { return null; },
    async *list(query) { for (const record of records) if (record.type === query.type && matches(record, query.where)) yield record; },
    write() { throw new Error('the branch mode writes nothing'); },
  };
}

// What one door message carries of a run's answer: it goes through twice in 65,536 bytes.
const DOOR_ANSWER_BOUND = 32_000;
const unit = { kind: 'book', text: 'x'.repeat(346) };
const ask = (rows, extra = {}) => checkABranch({ branch: 'made-up-book', units: [unit], ...extra }, door(rows));
const size = answer => Buffer.byteLength(JSON.stringify({ result: answer }));

for (const rows of [446, 1200]) {
  test(`${rows} reading rows on a 346-character unit answer in a page that fits one door message, and the pages together hold every question once`, async () => {
    const first = await ask(rows);
    assert.ok(size(first) < DOOR_ANSWER_BOUND && size(first) < ENGINE_OUTPUT_BOUND, `${size(first)} bytes`);
    assert.equal(first.status, 'uncertain');
    assert.equal(first.results[0].uncertain.filter(finding => finding.rule === 'reading-questions-unsettled').length, 1, 'one finding for the unit, never one a row');
    assert.ok(first.lines.length < 10, 'its lines are not one a row either');
    assert.equal(first.questions_page.rules, rows, 'the reading rows are the rules asked');
    const seen = [], asks = [];
    let page = first;
    for (;;) {
      assert.ok(size(page) < DOOR_ANSWER_BOUND, `a page of ${size(page)} bytes`);
      assert.deepEqual(page.ask_all.options, ['yes', 'no']);
      asks.push(...page.questions);
      seen.push(...page.questions.flatMap(entry => entry.asked.map(question => question.id)));
      if (page.questions_page.next === null) break;
      page = await ask(rows, { questions_after: page.questions_page.next });
    }
    assert.equal(asks.length, rows);
    assert.deepEqual([...seen].sort(), Array.from({ length: rows }, (_, at) => `0:voice-${at}:0`).sort(), 'every question once');
    assert.ok(asks.every(entry => entry.question.includes(`Made-up note ${entry.rule.slice('voice-'.length)}:`)), 'each entry carries its own question');
  });
}

test('a model that answers every question of 1,200 rows low passes the unit, in one small answer', async () => {
  const rows = 1200;
  const answers = Object.fromEntries(Array.from({ length: rows }, (_, at) => [`0:voice-${at}:0`, { yes: 0.01 }]));
  const answer = await ask(rows, { answers });
  assert.equal(answer.status, 'passed');
  assert.ok(size(answer) < DOOR_ANSWER_BOUND, `${size(answer)} bytes`);
});

test('one answer at or over t_fail among 1,200 fails the unit on that row alone', async () => {
  const rows = 1200;
  const answers = Object.fromEntries(Array.from({ length: rows }, (_, at) => [`0:voice-${at}:0`, { yes: at === 777 ? 0.95 : 0.01 }]));
  const answer = await ask(rows, { answers });
  assert.equal(answer.status, 'failed');
  assert.deepEqual(answer.results[0].breaks.map(finding => finding.rule), ['voice-777']);
  assert.ok(size(answer) < DOOR_ANSWER_BOUND);
});

test('questions_after that names no rule is refused', async () => {
  await assert.rejects(ask(5, { questions_after: 'made-up-nowhere' }), /not a rule of the questions/);
});
