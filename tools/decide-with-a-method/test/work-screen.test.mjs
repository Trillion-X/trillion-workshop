// The Decisions/Home screen read (read-data/work-screen.mjs, tool:see-my-decisions) over the made-up in-memory door.
// Carried from where the screen lived before: trillion-rust src/local_account/decision_screen_source/values.rs (its six
// unit tests) and tests/record_scope_links.rs, and the old app's test/work-screen-space-timeout.test.mjs,
// test/decision-progress.test.mjs, test/check-uses.test.mjs (the decision result chronology) and
// test/native-browser-commercial.test.mjs (allowance metadata reads no decision). Every record is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryDoor } from './fixtures.mjs';
import steps from '../read-data/decision-progress.json' with { type: 'json' };
import {
  checkUses, choiceLinks, helpedItem, nativeWorkScreen, progressFromSteps, recordScopeMethods, seeMyDecisions, whatHelpedOf,
} from '../read-data/work-screen.mjs';
import { decisionResult } from '../read-data/decision-outcome.mjs';

const base = () => ({
  input: { goal: 'Choose', options: [{ id: 'a', label: 'A' }] }, status: 'needs_outcome', decision: { option_id: 'a' },
  created_at: '2026-01-01T00:00:00Z', decided_at: '2026-01-02T00:00:00Z',
});
// One decision on its own in a door, and the screen's page of it.
async function pageOf(value, more = {}) {
  const door = memoryDoor();
  door.put('decision-1', 'decision', value);
  for (const [id, [type, row]] of Object.entries(more)) door.put(id, type, row);
  return seeMyDecisions({ native_collection_page: true }, { door });
}

test('a decision summary keeps the pursuits it cites and its current checked result (values.rs)', async () => {
  const page = await pageOf({ ...base(), outcome_checks: [{ result: 'met', observed_at: '2026-01-03T00:00:00Z', decision_generation: 1 }], cited_pursuits: { 'pursuit-1': true } },
    { 'pursuit-1': ['pursuit', { title: 'Kept title' }] });
  const [summary] = page.summaries;
  assert.deepEqual(summary.pursuits, [{ id: 'pursuit-1', title: 'Kept title' }]);
  assert.equal(summary.result_checked, true);
  assert.equal(summary.progress, '2 of 3 steps finished (67%) · Result checked');
});

test('a person\'s result with no signed-in source does not count as checked (values.rs)', async () => {
  const page = await pageOf({ ...base(), reports: [{ result: 'met', observed_at: '2026-01-03T00:00:00Z', answered_by: 'person' }] });
  const [summary] = page.summaries;
  assert.equal(summary.status, 'needs_outcome');
  assert.equal(summary.result_checked, false);
  assert.equal(summary.progress, '1 of 3 steps finished (33%) · Decided');
});

test('what helped keeps the decision\'s id, its numeric cost and its checks that were not refused (values.rs)', async () => {
  const page = await pageOf({ ...base(), decision_usage: { tokens: 3 },
    guidance: [{ step_id: 'step-1', answered_at: '2026-01-02T00:00:00Z', usage: { tokens: 2, model: 'x' }, checklist: [{ id: 'check-a' }, { id: 'check-b' }], answer: { checklist: { 'check-b': { handled: false } } } }] });
  const [item] = page.helped_items;
  assert.equal(item.id, 'decision-1');
  assert.equal(item.cost.tokens, 5);
  assert.deepEqual(item.uses, [{ check_id: 'check-a', verdict: 'passed' }, { check_id: 'check-b', verdict: 'skipped' }]);
});

test('a checklist kept as { checks } keeps its revised verdict (values.rs)', () => {
  const item = helpedItem({ ...base(), guidance: [{ step_id: 'step-1', checklist: { checks: [{ id: 'check-a' }] }, answer: { checklist: { 'check-a': { changed_answer: true } } } }] });
  assert.deepEqual(item.uses, [{ check_id: 'check-a', verdict: 'revised' }]);
});

test('a later failed outcome overrides an earlier success, and history is not rewritten (values.rs)', async () => {
  const value = { ...base(), outcome_checks: [{ result: 'met', observed_at: '2026-01-03T00:00:00Z' }, { result: 'failed', observed_at: '2026-01-04T00:00:00Z' }] };
  const page = await pageOf(value);
  assert.equal(page.summaries[0].status, 'correction_needed');
  assert.equal(page.helped_items[0].result.result, 'failed');
  assert.equal(value.outcome_checks.length, 2);
});

test('needs_decision keeps its early exit whatever the outcome says (values.rs)', async () => {
  const page = await pageOf({ ...base(), status: 'needs_decision', outcome_checks: [{ result: 'failed', observed_at: '2026-01-04T00:00:00Z' }] });
  assert.equal(page.summaries[0].status, 'needs_decision');
});

test('a decision result follows current evidence chronology (check-uses.test.mjs)', () => {
  const precedence = { person_confirmed_wins: false };
  assert.equal(decisionResult({}, precedence), null);
  assert.deepEqual(decisionResult({ reports: [{ result: 'failed', reported_at: '2026-01-01' }] }, precedence), { result: 'failed', at: '2026-01-01', by: 'reported' });
  assert.equal(decisionResult({ reports: [{ result: 'failed' }], outcome_checks: [{ result: 'met', checked_at: '2026-01-02' }, { result: 'unknown', checked_at: '2026-01-03' }] }, precedence), null);
});

test('a refusal naming a check makes it revised, and one with no accepted answer stays refused (check-uses.test.mjs)', () => {
  const record = {
    id: 'decision-1', created_at: '2026-01-01T00:00:00Z',
    guidance: [{ step_id: 'outcome', answered_at: '2026-01-01T00:01:00Z', checklist: [{ id: 'first' }, { id: 'second' }], answer: { checklist: { second: { changed_answer: true } } } }],
    calls: [
      { route: 'guide', step_id: 'outcome', accepted: false, reason: 'first is not answered' },
      { route: 'guide', step_id: 'outcome', accepted: true },
      { route: 'guide', step_id: 'proof', accepted: false, reason: 'third is missing' },
    ],
  };
  const uses = checkUses(record, ['first', 'second', 'third']);
  assert.deepEqual(uses.map(use => [use.check_id, use.verdict, use.changed_by]), [['first', 'revised', 'refused'], ['second', 'revised', 'answer'], ['third', 'refused', null]]);
});

test('below the minimum what helped gives counts only (check-uses.test.mjs)', () => {
  const view = whatHelpedOf([{ created_at: '2026-01-01T00:00:00Z', decided_at: '2026-01-01T00:10:00Z', result: { result: 'met', by: 'checked', at: '2026-01-02T00:00:00Z' }, cost: {}, uses: [{ check_id: 'first', verdict: 'revised' }] }], { checkText: { first: 'Is it first?' } });
  assert.equal(view.decisions, 1);
  assert.deepEqual(view.goal, { hit_goal: 1, with_result: 1, waiting: 0, share_shown: false });
  assert.equal(view.time.deciding.compared, false);
  assert.equal(view.questions[0].question, 'Is it first?');
});

test('progress counts only the steps the decision\'s own facts show (decision-progress.test.mjs)', () => {
  assert.equal(progressFromSteps({ decided: false }, steps), '0 of 3 steps finished (0%)');
  assert.equal(progressFromSteps({ decided: true, carried_out: false, result_checked: false }, steps), '1 of 3 steps finished (33%) · Decided');
  assert.equal(progressFromSteps({ decided: true, carried_out: true, result_checked: false }, steps), '2 of 3 steps finished (67%) · Next action carried out');
  assert.equal(progressFromSteps({ decided: true, carried_out: true, result_checked: true }, steps), '3 of 3 steps finished (100%) · Result checked');
  assert.equal(progressFromSteps({ decided: 'yes' }, steps), '0 of 3 steps finished (0%)', 'a word is never a fact');
  assert.equal(progressFromSteps(null, steps), 'Not measured');
});

test('a choice\'s removal drops a parent, and the tree keeps the current order (record_scope_links.rs)', () => {
  const held = { 'record-scope:a': { not_pursuits: ['b'], pursuits: ['b'] }, 'record-scope:c': { pursuits: ['a'] } };
  const tree = recordScopeMethods.scopePursuitTree.call({ store: { eeaf: { read: id => held[id] ?? null } } }, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(tree.map(item => [item.id, item.parents, item.children]), [['a', [], ['c']], ['b', [], []], ['c', ['a'], []]]);
});

test('a choice kept before rooms were pursuits still names its room (record_scope_links.rs)', () => {
  const [link] = choiceLinks({ spaces: [' r '] });
  assert.equal(link.target, ' r ');
  assert.equal(link.target_kind, 'space');
  assert.equal(link.via, 'chosen');
});

test('the screen answers with its own pursuits when the Space pursuit read stalls (work-screen-space-timeout.test.mjs)', async () => {
  const screen = nativeWorkScreen({ owner: 'account', records: { read: () => null }, store: { settings: () => [] },
    engine: { summaries: async () => [], pursuits: async () => [{ id: 'pursuit:private', title: 'Private pursuit' }], mapDecided: async () => [] },
    setting: () => null, currentPolicy: async () => ({ access: { capabilities: [] } }),
    readAllowance: async () => { throw new Error('a plan with no decision limit reads no allowance'); },
    spacePursuits: () => new Promise(() => {}), checkQuestions: () => ({}) });
  const started = Date.now();
  const answer = await screen();
  assert.ok(Date.now() - started < 2500, 'the stalled Space read has a short bound');
  assert.equal(answer.space_pursuits.length, 0);
  assert.deepEqual(answer.pursuits.map(item => item.id), ['pursuit:private']);
});

test('allowance metadata reads no decision, and a free plan keeps nothing (native-browser-commercial.test.mjs)', async () => {
  const door = memoryDoor();
  door.put('decision-1', 'decision', base());
  const access = { capabilities: ['access:decision-method'], limits: { 'access:decision-method': [{ count: 3, per: 'week' }, { count: 5, per: 'week' }] } };
  const allowance = { count: 5, per: 'week', used: 1 };
  const kept = { ...access, capabilities: [...access.capabilities, 'access:decision-kept'] };
  const metadata = await seeMyDecisions({ metadata_only: true, access: kept, allowance }, { door });
  assert.deepEqual(door.lists, [], 'metadata lists no rows');
  assert.equal(metadata.free, false);
  assert.deepEqual(metadata.allowance, allowance);
  assert.equal(metadata.pursuits_words.measured, false);
  const free = await seeMyDecisions({ metadata_only: true, access, allowance }, { door });
  assert.equal(free.free, true);
  assert.deepEqual(free.summaries, []);
  await assert.rejects(seeMyDecisions({ access }, { door }), /send the allowance your place reports/);
});

test('one page covers what it read and says where the next starts; the whole view counts every decided decision', async () => {
  const door = memoryDoor();
  for (let n = 0; n < 102; n += 1) door.put(`decision-${n}`, 'decision', { ...base(), created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString() });
  door.put('pursuit:one', 'pursuit', { title: 'One', status: 'active' });
  door.put('pursuit:ended', 'pursuit', { title: 'Old', status: 'ended' });
  door.put('plan:one', 'plan', { title: 'Plan', goal: 'Go', status: 'active', updated_at: '2026-01-01T00:00:00Z' });
  door.put('record-stance:decision-101', 'record-stance', { stance: { said: 'agree' } });
  door.put('check-row-1', 'record:check', { id: 'check-a', kind: 'step', step: 'outcome', check: 'Is it a?', good_answer: 'Names a.' });
  // A word-check row and a piece of the same list carry no question: the screen never reads them as one.
  door.put('check-row-2', 'record:check', { id: 'no-glitter', kind: 'check', check: 'words', words: ['glitter'] });
  door.put('check-row-3', 'record:check', { id: 'piece-made-up', kind: 'piece', check: 'Made-up piece words' });
  door.put('setting:agent-work:one', 'setting', { value: { harness: 'made-up', checks: [] } });
  const page = await seeMyDecisions({ native_collection_page: true }, { door });
  assert.equal(page.summaries.length, 100);
  assert.deepEqual(page.collection_coverage, { scope: 'newest_decisions', limit: 100, more_decisions: true, more_pursuits: false, more_plans: false });
  assert.equal(page.next_before, page.summaries.at(-1).created_at);
  assert.deepEqual(page.summaries[0].stance, { said: 'agree' });
  assert.deepEqual(page.pursuits.map(item => [item.id, item.parents, item.children]), [['pursuit:one', [], []]]);
  assert.deepEqual(page.plans.map(plan => plan.id), ['plan:one']);
  assert.deepEqual(page.helped_check_text, { 'check-a': 'Is it a?' }, 'only step rows give question text');
  assert.ok(door.lists.some(call => call.type === 'record:check' && call.where?.kind === 'step'), 'the step rows are read with where, never the whole list');
  assert.deepEqual(page.agent_work, [{ harness: 'made-up', checks: [], id: 'setting:agent-work:one' }]);
  assert.equal(page.pursuits_words, null);
  const whole = await seeMyDecisions({}, { door });
  assert.equal(whole.summaries.length, 100);
  assert.equal(whole.helped.decisions, 102);
  assert.equal(whole.helped.agents.plans, 1);
});

test('no pursuits says so in the screen\'s words, and a request it cannot read is refused with what to send', async () => {
  const door = memoryDoor();
  const page = await seeMyDecisions({ native_collection_page: true }, { door });
  assert.equal(page.pursuits_words.measured, false);
  assert.match(page.pursuits_words.text, /what you are working toward/);
  await assert.rejects(seeMyDecisions({ metadata_only: 'yes' }, { door }), /metadata_only is true or false/);
  await assert.rejects(seeMyDecisions({ access: { capabilities: 'all' } }, { door }), /access is what your place reports/);
});
