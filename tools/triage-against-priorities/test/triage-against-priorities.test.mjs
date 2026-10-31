// tools/triage-against-priorities: the brief the caller's AI judges from, the settling of its answer, the fail-closed
// decision, and the folder's vocabulary. Carried from the old commander-triage package's five checks (completed, exactly
// one answer, confidence, disposition admitted, objective for the launch kind) and its fail-closed decision; that package
// had only records and no code, so these tests are written for the rules its records declared. All data is made up.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { briefFor, checkRows, settleTriage } from '../read-data/triage.mjs';

const folder = join(import.meta.dirname, '..');

const dispositions = [
  { ref: 'keep-note', label: 'Keep the note', blocked_default: false },
  { ref: 'order-flour', label: 'Order more flour', blocked_default: true, note: 'spends money' },
  { ref: 'try-recipe', label: 'Try a new recipe', needs_objective: true, blocked_default: false },
  { ref: 'hold', label: 'Hold for the baker', fallback: true },
];
const priorities = [{ id: 'p1', text: 'Never run out of flour' }, { id: 'p2', text: 'Try one new loaf a month' }];
const item = { ref: 'note:1', version: 'v1', text: 'Flour bin is nearly empty' };
const base = { item, priorities, dispositions, min_confidence: 0.6 };
const good = { disposition_ref: 'keep-note', confidence: 0.8, rationale: 'Worth keeping.', target_ref: '' };

test('the brief carries the item, the listed dispositions, the priorities and the fail-closed rule with the person\'s floor', () => {
  const brief = briefFor(base);
  assert.deepEqual(brief.dispositions.map(row => row.ref), ['keep-note', 'order-flour', 'try-recipe', 'hold']);
  assert.equal(brief.dispositions[1].note, 'spends money');
  assert.equal(brief.priorities.length, 2);
  assert.match(brief.rules.join(' '), /under 0\.6[^.]*answer hold/);
  assert.match(brief.rules.join(' '), /try-recipe an objective and acceptance_criteria are mandatory/);
  assert.ok(brief.answer_shape.objective);
});

test('a brief with no kind that needs an objective asks for none', () => {
  const brief = briefFor({ ...base, dispositions: dispositions.filter(row => row.ref !== 'try-recipe') });
  assert.equal(brief.answer_shape.objective, undefined);
  assert.doesNotMatch(brief.rules.join(' '), /mandatory/);
});

test('a held answer settles on its disposition and is blocked only as its row says', () => {
  const kept = settleTriage({ ...base, answers: [good] });
  assert.equal(kept.disposition_ref, 'keep-note');
  assert.equal(kept.blocked, false);
  assert.equal(kept.fail_closed, false);
  assert.deepEqual(kept.reasons, []);
  assert.equal(kept.id, 'triage-decision:note%3A1:v1');
  assert.equal(kept.rationale, 'Worth keeping.');
  const spend = settleTriage({ ...base, answers: [{ ...good, disposition_ref: 'order-flour' }] });
  assert.equal(spend.blocked, true);
  assert.equal(spend.fail_closed, false);
});

test('a disposition row with no blocked_default is blocked: unmarked means not cleared', () => {
  const rows = [{ ref: 'a', label: 'A' }, { ref: 'b', label: 'B', fallback: true }];
  assert.equal(settleTriage({ ...base, dispositions: rows, answers: [{ disposition_ref: 'a', confidence: 0.9 }] }).blocked, true);
});

test('every way an answer can fail closes to the fallback, blocked, with the reason in words', () => {
  const cases = [
    [{ ...base, priorities: [], answers: [good] }, /no priorities/],
    [{ ...base, answers: [] }, /no answer/],
    [{ ...base, answers: undefined }, /no answer/],
    [{ ...base, answers: [good, good] }, /2 answers/],
    [{ ...base, answers: ['text'] }, /not a record/],
    [{ ...base, answers: [{ ...good, confidence: 0.59 }] }, /0\.59 is under the least, 0\.6/],
    [{ ...base, answers: [{ ...good, confidence: undefined }] }, /Confidence is missing/],
    [{ ...base, answers: [{ ...good, confidence: 1.2 }] }, /1\.2 is over 1/],
    [{ ...base, answers: [{ ...good, confidence: Number.NaN }] }, /Confidence is missing/],
    [{ ...base, answers: [{ ...good, disposition_ref: 'invented' }] }, /not one of the listed refs/],
    [{ ...base, answers: [{ ...good, disposition_ref: 'try-recipe' }] }, /needs an objective[\s\S]*needs acceptance_criteria/],
    [{ ...base, answers: [{ ...good, disposition_ref: 'try-recipe', objective: 'Bake a rye loaf', acceptance_criteria: [''] }] }, /needs acceptance_criteria/],
  ];
  for (const [input, pattern] of cases) {
    const decision = settleTriage(input);
    assert.equal(decision.disposition_ref, 'hold', String(pattern));
    assert.equal(decision.blocked, true);
    assert.equal(decision.fail_closed, true);
    assert.equal(decision.confidence, 0);
    assert.match(decision.reasons.join(' '), pattern);
  }
});

test('a negative confidence fails closed even when the least is 0', () => {
  const zero = { ...base, min_confidence: 0 };
  const decision = settleTriage({ ...zero, answers: [{ ...good, confidence: -0.5 }] });
  assert.equal(decision.fail_closed, true);
  assert.match(decision.reasons.join(' '), /-0\.5 is under 0: it is a number from 0 to 1/);
  assert.equal(settleTriage({ ...zero, answers: [{ ...good, confidence: 0 }] }).fail_closed, false);
});

test('a confidence of exactly the least and exactly 1 both hold', () => {
  assert.equal(settleTriage({ ...base, answers: [{ ...good, confidence: 0.6 }] }).fail_closed, false);
  assert.equal(settleTriage({ ...base, answers: [{ ...good, confidence: 1 }] }).fail_closed, false);
});

test('the brief carries the guidance for an objective: smallest safe reversible, and what it may never authorize', () => {
  const rule = briefFor(base).rules.find(text => /^For try-recipe/.test(text));
  assert.match(rule, /smallest safe, reversible assignment that produces evidence/);
  for (const never of ['sending messages', 'spending', 'publishing', 'promises to others', 'credential changes', 'changes to a live system', 'illegal', 'deceiving', 'harassing', 'belongs to another party']) {
    assert.ok(rule.includes(never), never);
  }
});

test('word limits are the person\'s: told in the brief and the answer shape, enforced when settling, absent when not given', () => {
  const limited = { ...base, max_words: { rationale: 5, objective: 8 } };
  const brief = briefFor(limited);
  assert.deepEqual(brief.max_words, { rationale: 5, objective: 8 });
  assert.match(brief.rules.join(' '), /rationale is at most 5 words/);
  assert.match(brief.rules.join(' '), /objective is at most 8 words/);
  assert.match(brief.answer_shape.rationale, /at most 5 words/);
  assert.match(brief.answer_shape.objective, /at most 8 words/);
  assert.equal(briefFor(base).max_words, undefined);
  assert.doesNotMatch(briefFor(base).answer_shape.rationale, /at most/);
  const plan = { disposition_ref: 'try-recipe', confidence: 0.7, acceptance_criteria: ['A loaf is photographed'] };
  const fits = settleTriage({ ...limited, answers: [{ ...plan, rationale: 'one two three four five', objective: 'Bake one rye loaf by Friday evening ok' }] });
  assert.equal(fits.fail_closed, false);
  const over = settleTriage({ ...limited, answers: [{ ...plan, rationale: 'one two three four five six', objective: 'Bake one rye loaf by Friday evening ok now' }] });
  assert.equal(over.fail_closed, true);
  assert.match(over.reasons.join(' '), /rationale has 6 words; at most 5[\s\S]*objective has 9 words; at most 8/);
  assert.equal(settleTriage({ ...base, answers: [{ ...plan, rationale: 'word '.repeat(80), objective: 'word '.repeat(80) }] }).fail_closed, false);
  const onlyOne = settleTriage({ ...base, max_words: { rationale: 2 }, answers: [{ ...good, rationale: 'a b c' }] });
  assert.match(onlyOne.reasons.join(' '), /rationale has 3 words/);
});

test('a word limit that is not a whole number of 1 or more, or names another field, is refused', () => {
  for (const max_words of [{ rationale: 0 }, { rationale: 2.5 }, { objective: '60' }, { summary: 10 }, 'ten', [5]]) {
    assert.throws(() => checkRows({ ...base, max_words }), /max_words/, JSON.stringify(max_words));
  }
});

test('an objective with proofs settles the kind that needs one, and keeps both', () => {
  const answer = { disposition_ref: 'try-recipe', confidence: 0.7, objective: 'Bake a rye loaf', acceptance_criteria: ['A loaf is photographed'] };
  const decision = settleTriage({ ...base, answers: [answer] });
  assert.equal(decision.fail_closed, false);
  assert.equal(decision.objective, 'Bake a rye loaf');
  assert.deepEqual(decision.acceptance_criteria, ['A loaf is photographed']);
});

test('the fallback is always blocked, even if its row says otherwise', () => {
  const rows = dispositions.map(row => (row.fallback ? { ...row, blocked_default: false } : row));
  assert.equal(settleTriage({ ...base, dispositions: rows, answers: [{ disposition_ref: 'hold', confidence: 0.9 }] }).blocked, true);
});

test('the same item at the same version has the same id; a new version has another', () => {
  const one = settleTriage({ ...base, answers: [good] }).id;
  assert.equal(settleTriage({ ...base, answers: [good] }).id, one);
  assert.notEqual(settleTriage({ ...base, item: { ...item, version: 'v2' }, answers: [good] }).id, one);
});

test('requests that cannot be briefed or settled are refused', () => {
  assert.throws(() => checkRows({ ...base, item: { text: 'no ref' } }), /needs a ref/);
  assert.throws(() => checkRows({ ...base, min_confidence: undefined }), /min_confidence/);
  assert.throws(() => checkRows({ ...base, min_confidence: 1.5 }), /0 to 1/);
  assert.throws(() => checkRows({ ...base, priorities: undefined }), /priorities must be a list/);
  assert.throws(() => checkRows({ ...base, dispositions: [] }), /must list/);
  assert.throws(() => checkRows({ ...base, dispositions: dispositions.map(row => ({ ...row, fallback: undefined })) }), /exactly one disposition must be the fallback \(fallback: true\); found 0/);
  assert.throws(() => checkRows({ ...base, dispositions: dispositions.map(row => ({ ...row, fallback: true })) }), /found 4/);
  assert.throws(() => checkRows({ ...base, dispositions: [...dispositions, { ref: 'keep-note', label: 'again' }] }), /listed twice/);
});

test('the commands read a request on standard input and print the answer as the last line', async () => {
  const send = (script, input) => new Promise((resolve, reject) => {
    const child = execFile('node', [join(folder, 'do-work', script)], (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout.trim().split('\n').pop())));
    child.stdin.end(JSON.stringify(input));
  });
  assert.equal(JSON.parse(await send('brief-a-triage.mjs', base)).result.item.ref, 'note:1');
  assert.equal(JSON.parse(await send('settle-a-triage.mjs', { ...base, answers: [good] })).result.decision.disposition_ref, 'keep-note');
  assert.match(JSON.parse(await send('settle-a-triage.mjs', { ...base, min_confidence: 2 })).error, /0 to 1/);
});

test('the code holds no priority, no disposition word and no threshold, and runs nothing', async () => {
  const files = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (path.endsWith('.mjs') && !path.includes('/test/')) files.push(path);
    }
  };
  await walk(join(folder, 'read-data'));
  await walk(join(folder, 'do-work'));
  const text = (await Promise.all(files.map(file => readFile(file, 'utf8')))).join('\n').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(text, /\bfounder\b|retain|launch|0\.6\b|blocked-by-policy|commander/i);
  assert.doesNotMatch(text, /fetch\s*\(|spawn\s*\(|execFile|credentials/);
});
