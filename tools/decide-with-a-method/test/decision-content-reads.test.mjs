// Ported from old trillion test/decision-content-reads.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81),
// deleted by Trillion-X/trillion #243. The old store's contentOf (src/decision-store.mjs) is this tool's readDecision
// (read-data/decision-records.mjs) over the records the caller hands in: a decision laid apart by recordsOf (the old "split"
// shape) reads its own fields and answers and never a `decision-call` record or a pursuit. The old SQL statement and byte
// counts are the records the caller hands the read (old-engine-for-tests.mjs `counting`), on one in-memory store instead of
// two record engines. The outcome reader's view is statedOutcome and checkPlan of
// tools/keep-and-wake-ai-sessions-on-this-computer/src/outcome-checks.mjs over that read.
// Changed as the owner behaves: a root still kept whole (the old "whole" shape, calls inline) "reads as it is" until its
// next change lays it apart (README, Record layout), so its content is the root as written, calls with it, from one read.
// Left out, no running owner: storyFacts and storyPrivateTerms (old src/stories.mjs; only a .held copy in
// tools/turn-a-finished-decision-into-an-anonymous-public), checkOutcome's unavailable model judge, and the last test's
// PersonStore story, share, share-result and outcome retries (writeOneStory, share, shareResultAgain, checkOutcomeNow;
// searched the three repos for those names: no running code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { holding, readDecision, recordsOf } from '../read-data/decision-records.mjs';
import { checkPlan, statedOutcome } from '../../keep-and-wake-ai-sessions-on-this-computer/src/outcome-checks.mjs';
import { memoryDoor, heldOf } from './fixtures.mjs';
import { counting } from './old-engine-for-tests.mjs';

const id = 'source:model-retry';
const at = '2026-10-08T12:00:00Z';
const record = calls => ({
  id, source_id: 'synthetic:model-content', created_at: at, status: 'needs_outcome',
  input: { goal: 'Choose how Priyanka Ostrowski trains at Oakridge',
    evidence: [{ ref: 'coach', claim: 'Coach Delacroix observed the grip.' }],
    options: [{ id: 'grip', label: 'Fix the grip' }, { id: 'club', label: 'Change clubs' }] },
  method: { id: 'universal' },
  decision: { option_id: 'grip', reason: 'The grip can improve.', next_action: 'Train daily.', success_measure: 'Most serves land.' },
  guidance: [
    { step_id: 'scope', answer: { switches: {} }, answered_at: at },
    { step_id: 'outcome', answer: { desired_result: 'Priyanka wins more serves', current_state: 'Four serves out of ten' },
      checklist: [{ id: 'kept-check', says: 'Read the actual facts.' }], answered_at: at },
    { step_id: 'proof', answer: { success_observation: 'Most first serves land', failure_signal: 'Fewer than half land',
      check_by: { kind: 'page', url: 'https://example.com/score', look_for: 'first serves' } }, answered_at: at },
  ],
  scratchpad: [{ text: 'Maria Delacroix wrote the observation.' }],
  reports: [{ result: 'met', summary: 'More serves landed.', reported_at: at }],
  method_history: [{ method: { id: 'earlier' }, guidance: [{ step_id: 'old', answer: { notes: 'Retained earlier thinking' } }] }],
  calls: Array.from({ length: calls }, (_, n) => ({ route: 'guide', step_id: 'proof', accepted: false,
    at, reason: `Refused attempt ${n}: ${'The diagnostic explains why this attempt could not be accepted. '.repeat(8)}`,
    submission: { private_diagnostic: 'x'.repeat(512) } })),
});

function seed(shape, calls) {
  const door = memoryDoor();
  if (shape === 'whole') door.put(id, 'decision', record(calls));
  // Laid apart as this tool lays a whole decision apart on its next change: every step, list and call a record of its own.
  else for (const item of recordsOf({ ...record(calls), whole: true })) if (item.value !== null) door.put(item.id, item.type, item.value);
  for (let n = 0; n < calls; n += 1) {
    const key = `pursuit:${String(n).padStart(4, '0')}`;
    door.put(key, 'pursuit', { id: key, title: `Unrelated pursuit ${n}`, status: 'active' });
  }
  return door;
}
const every = ['scope', 'outcome', 'proof'];

// The records a caller hands a content read of one decision: the records that name its id, of the types its content is kept
// in, and its method snapshot (kept under its identity, named by the root). Its tries (`decision-call`) and other decisions'
// records are not among them.
const CONTENT_TYPES = ['decision', 'decision-evidence', 'decision-option', 'decision-answered-step', 'decision-step', 'decision-part',
  'decision-report', 'decision-carried-out', 'decision-cited-pursuit', 'decision-history', 'decision-candidate', 'decision-refs',
  'decision-revision', 'decision-method'];
const contentOf = store => ({
  all: () => store.all().filter(record => CONTENT_TYPES.includes(record.type) && (record.id.includes(id) || record.type === 'decision-method')),
  write: list => store.write(list),
});

test('content reads retain actual answers, earlier method context and every privacy term on both engines and layouts', async () => {
  for (const shape of ['split', 'whole']) {
    const base = seed(shape, 24);
    const door = counting(contentOf(base));
    const actual = readDecision(holding(door.all()), id, every);
    const wanted = record(24);
    assert.deepEqual(actual, readDecision(heldOf(base), id, every), `${shape}: the unrelated pursuits and tries in the store change nothing`);
    assert.deepEqual(door.take().handed.filter(item => item.type === 'pursuit'), [], `${shape}: no pursuit is handed to the content read`);
    if (shape === 'whole') {
      assert.deepEqual(actual, { ...record(24), whole: true }, 'a whole root reads as it is');
    } else {
      assert.deepEqual(actual.calls, undefined);
      assert.equal(actual.input.goal, wanted.input.goal);
      assert.deepEqual(actual.input.evidence, wanted.input.evidence);
      assert.deepEqual(actual.decision, wanted.decision);
      assert.deepEqual(actual.scratchpad, wanted.scratchpad);
      assert.deepEqual(actual.method_history, wanted.method_history, `${shape}: earlier method context is kept`);
      assert.deepEqual(actual.reports, wanted.reports);
      assert.deepEqual(actual.guidance.map(step => step.answer), wanted.guidance.map(step => step.answer), `${shape}: no answer changes`);
      assert.equal(actual.calls, undefined);
    }
    assert.deepEqual(checkPlan(actual), checkPlan(record(24)));
    assert.deepEqual(statedOutcome(actual), statedOutcome(record(24)));
    assert.equal(actual.guidance[1].checklist[0].id, 'kept-check');
    assert.equal(readDecision(heldOf(base), 'source:missing'), null);
  }
});

test('content reads give the same answer with the diagnostic calls in the store or not, as calls quadruple', () => {
  for (const calls of [400, 1600]) {
    const base = seed('split', calls);
    const content = readDecision(holding(contentOf(base).all()), id, every);
    assert.equal(content.guidance.length, 3);
    assert.equal(content.calls, undefined);
    assert.deepEqual(content, readDecision(heldOf(base), id, every), `${calls} calls change nothing in the content`);
  }
});

test('an unavailable outcome judge gets every actual answer without its call history', () => {
  const base = seed('split', 320);
  const content = readDecision(holding(contentOf(base).all()), id, ['outcome', 'proof']);
  assert.deepEqual(content, readDecision(heldOf(base), id, ['outcome', 'proof']));
  assert.equal(content.guidance.length, 3);
  assert.equal(content.calls, undefined);
  assert.equal(checkPlan(content).url, 'https://example.com/score');
  assert.equal(statedOutcome(content).desired_result, 'Priyanka wins more serves');
  assert.equal(statedOutcome(content).failure_signal, 'Fewer than half land');
});
