// The decision tools over the person's own records, with a made-up method (rows and a saved view) and made-up decisions.
// Ported from the old app's run-decision, one-pass and outcome tests where they do not depend on the old store: one source
// opens one decision, a decision is made when every row of its method has an answer, a decision needs its fields, a known
// option and its own evidence, a new decision needs a failed result first, and the records keep the old store's layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addDecisionEvidence, caseIdFor, endDecisions, makeTheDecision, reportADecisionResult, sayWhatWasDone, startADecision } from '../read-data/decisions.mjs';
import { shareADecision } from '../read-data/share-a-decision.mjs';
import { joinDecision, readDecision, readStep, recordsOf, writeDecision } from '../read-data/decision-records.mjs';
import { similarDecisions } from '../read-data/similar-decisions.mjs';
import { caseView, memoryDoor, METHOD_VIEW, STEP_ROW, refsOfCase, today } from './fixtures.mjs';
import { account, answerAll, seedSteps } from './old-engine-for-tests.mjs';
import { methodAnswered, recordMethodAnswers } from '../method-rows/answers.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const CHECK_REVISION = settings.records.record_revision.check !== false;
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);

const opened = {
  source_id: 'chat:pottery-1', goal: 'Decide the pottery camp price for spring',
  evidence: [{ ref: 'e1', claim: 'Last spring twelve families signed up at the old price' }, { ref: 'e2', claim: 'The kiln costs went up this year' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};
const decision = { option_id: 'raise', reason: 'Kiln costs went up and families still came', next_action: 'Email the families the new price', success_measure: 'Twelve sign ups by May', evidence_refs: ['e1', 'e2'], who_it_changes: 'The twelve families pay a little more and keep their camp' };

// A decision kept before methods were rows kept its method snapshot and answered steps on it; the layout still reads, so the tests
// of the layout seed that shape: the snapshot, and an answer to a step written as an answered step.
const legacyMethod = () => ({ id: 'plain', name: 'A made-up method', steps: [{ id: 'scope', question: 'What is being decided?' }, { id: 'outcome', question: 'What should be true after?' }] });
const scope = { evidence_refs: ['e1'] };
const outcomeAnswer = { evidence_refs: ['e1', 'e2'] };

// The laid-apart item `index` of a list as the case holds it: its key carries the identity the root's refs name for it.
function itemNow(door, id, list, index) {
  const { type, digits } = settings.records.laid_apart[list];
  const ref = refsOfCase(door, id).items?.[list]?.[index];
  return door.value(`${type}:${id}:${String(index).padStart(digits, '0')}${ref ? `:c${ref}` : ''}`);
}

// A decision opened with answered steps kept the way earlier decisions have them, and every row of its method answered through the pair.
async function answered(door) {
  const { case_id: id } = await startADecision(opened, { door });
  await seedSteps(door, id, ['scope', 'outcome', 'proof']);
  const kept = await answerAll(door, id);
  assert.equal(kept.refused.length, 0, 'every answer is recorded');
  return id;
}

// The answers a decision holds for the rows of its method.
const methodAnsweredCount = async (door, id) => (await methodAnswered(door, id, METHOD_VIEW)).answered;

test('one source opens one decision: the same input is that decision, different input is refused', async () => {
  const door = account();
  const first = await startADecision(opened, { door });
  assert.equal(first.case_id, caseIdFor(opened.source_id));
  assert.equal(first.method, METHOD_VIEW, 'the decision is opened with the default method, a saved view');
  assert.match(first.ai_instructions[0], /tool:read-a-method/);
  const root = caseView(door, first.case_id);
  assert.deepEqual(root.answered_steps, []);
  assert.equal(root.method_view, METHOD_VIEW, 'the decision keeps the saved view it was opened with');
  const kept = door.value(first.case_id);
  assert.equal(kept.input.evidence, undefined, 'the root holds no evidence itself');
  assert.deepEqual(kept.input.options, opened.options, 'its options stay on the root');
  assert.equal(kept.method, undefined, 'nor its method snapshot');
  assert.deepEqual(kept.counts, { evidence: 2, candidates: 0, reports: 0, carried_out: 0, decision_history: 0, cited_pursuits: 0, answered_steps: 0 });
  assert.deepEqual(itemNow(door, first.case_id, 'evidence', 1), opened.evidence[1], 'each evidence row is a record of its own');
  assert.equal(root.status, 'needs_decision');
  assert.equal((await startADecision(opened, { door })).case_id, first.case_id);
  await assert.rejects(startADecision({ ...opened, goal: 'Something else entirely' }, { door }), /already has decision/);
  await assert.rejects(startADecision({ ...opened, options: [opened.options[0]] }, { door }), /at least two options/);
  await assert.rejects(startADecision({ ...opened, source_id: 'x', evidence: [{ ref: 'e1', claim: 'a' }, { ref: 'e1', claim: 'b' }] }, { door }), /unique ref/);
  await assert.rejects(startADecision(opened, { door: memoryDoor() }), /There is no saved method/);
  await assert.rejects(startADecision({ ...opened, source_id: 'y', method: 'list-view:method-rows:nowhere' }, { door }), /There is no saved method/);
});

test('a decision needs every question, its fields, a known option and the decision\'s own evidence', async () => {
  const door = account();
  const { case_id: early } = await startADecision({ ...opened, source_id: 'chat:early' }, { door });
  await assert.rejects(makeTheDecision({ decision_id: early, decision }, { door }), /has 3 of its 3 rows without an answer, the first of them record:method-row:universal-steps~%2Foutcome/);
  await answerAll(door, early, { steps: ['scope'] });
  await assert.rejects(makeTheDecision({ decision_id: early, decision }, { door }), /has 2 of its 3 rows without an answer/, 'one row answered leaves the rest to answer');
  const id = await answered(door);
  const { next_action: _next, ...withoutField } = decision;
  await assert.rejects(makeTheDecision({ decision_id: id, decision: withoutField }, { door }), /Decision needs/);
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'maybe' } }, { door }), /unknown option \("maybe"\)/);
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { ...decision, evidence_refs: ['nowhere'] } }, { door }), /must cite existing evidence/);
  const made = await makeTheDecision({ decision_id: id, decision, usage: { model_calls: 3 } }, { door });
  assert.equal(made.decision.option_id, 'raise');
  assert.match(made.resume.instruction, /Email the families the new price/);
  assert.match(made.ai_instructions[0], /tool:say-what-was-done with decision_id/);
  const root = caseView(door, id);
  assert.equal(root.status, 'needs_outcome');
  assert.equal(root.decision_generation, 1);
  assert.deepEqual(root.decision_usage, { model_calls: 3 });
  assert.equal((await makeTheDecision({ decision_id: id, decision }, { door })).already_decided, true);
  await assert.rejects(makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'keep' } }, { door }), /needs a failed result/);
});

test('a result is the person\'s; a failed one opens the decision for a new one, and the first is kept', async () => {
  const door = account();
  const id = await answered(door);
  await assert.rejects(reportADecisionResult({ decision_id: id, result: 'met', summary: 'It worked', answered_by: 'agent' }, { door }), /Ask your person/);
  await assert.rejects(reportADecisionResult({ decision_id: id, result: 'met', summary: 'It worked', answered_by: 'person' }, { door }), /no decision yet/);
  await makeTheDecision({ decision_id: id, decision }, { door });
  const failed = await reportADecisionResult({ decision_id: id, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' }, { door });
  assert.equal(failed.status, 'correction_needed');
  assert.equal(failed.report.attribution_basis, 'caller_claim', 'nothing here marks a report verified by a trusted source');
  assert.equal((await reportADecisionResult({ decision_id: id, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' }, { door })).repeated, true);
  const second = await makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'keep', reason: 'Families left at the higher price' } }, { door });
  assert.equal(second.decision.option_id, 'keep');
  const root = caseView(door, id);
  assert.equal(root.decision_generation, 2);
  assert.equal(root.decision_history.length, 1);
  assert.equal(root.decision_history[0].decision.option_id, 'raise');
  const met = await reportADecisionResult({ decision_id: id, result: 'met', summary: 'Twelve families signed up', answered_by: 'person' }, { door });
  assert.equal(met.status, 'needs_outcome', 'a person\'s claim alone never verifies the outcome');
  await assert.rejects(reportADecisionResult({ decision_id: id, result: 'met', summary: 'x', answered_by: 'person', observed_at: '2999-01-01T00:00:00Z' }, { door }), /at or before now/);
});

test('saying what was done keeps it with the decision generation it carried out', async () => {
  const door = account();
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  await assert.rejects(sayWhatWasDone({ decision_id: id, state: 'maybe', what_happened: 'x' }, { door }), /Say state/);
  const said = await sayWhatWasDone({ decision_id: id, state: 'done', what_happened: 'Sent the email to all twelve families', by: 'test-agent' }, { door });
  assert.equal(said.carried_out.decision_generation, 1);
  assert.equal((await makeTheDecision({ decision_id: id, decision }, { door })).carried_out, true);
});

test('a decision kept whole is laid apart at its next change, its calls kept as records of their own, its root written last', async () => {
  const door = account();
  const id = caseIdFor('chat:whole');
  const calls = Array.from({ length: 300 }, (_, n) => ({ route: 'guide', accepted: true, at: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`, submission: { secret: 'never kept' } }));
  door.put(id, 'decision', { id, source_id: 'chat:whole', input: { ...opened, source_id: 'chat:whole' }, method: legacyMethod(), status: 'needs_decision', decision: null, created_at: '2026-01-01T00:00:00.000Z', guidance: [{ step_id: 'scope', answer: scope, answered_at: '2026-01-01T00:00:01.000Z' }], calls });
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door });
  const root = caseView(door, id);
  assert.equal(root.guidance, undefined);
  assert.equal(root.calls, undefined);
  assert.equal(root.call_count, 300);
  assert.deepEqual(root.answered_steps.map(stub => stub.step_id), ['scope']);
  assert.deepEqual(root.input.evidence.map(row => row.ref), ['e1', 'e2', 'e3'], 'its evidence is laid apart too');
  assert.equal(door.value(id).input.evidence, undefined);
  assert.equal(door.value(id).method, undefined);
  assert.equal(root.method.id, 'plain', 'its method snapshot is kept once, beside it');
  for (const write of door.writes) assert.ok(write.bytes <= 64 * 1024);
  assert.equal(door.value(`decision-call:${id}:000299`).route, 'guide');
  assert.equal(door.value(`decision-call:${id}:000000`).submission, undefined, 'a call keeps no payload');
  assert.deepEqual(door.writes.at(-1).ids, [id, `decision-revision:${id}`], 'the root and its revision are written after their parts');
});

// Every record kind a decision is laid out in (read-data/decision-records.mjs).
const decisionKinds = ['decision', 'decision-step', 'decision-call', ...Object.values(settings.records.laid_apart).map(list => list.type), settings.records.method, settings.records.part.type, settings.records.refs, settings.records.record_revision.type];

test('the tool rows reach only the decision records, the person\'s pursuits and the rows of their methods', () => {
  const tools = ['tool:start-a-decision', 'tool:add-decision-evidence', 'tool:make-the-decision', 'tool:report-a-decision-result', 'tool:say-what-was-done', 'tool:end-a-decision'];
  const methodKinds = ['list', 'list-view', 'method-answer', "record:method-row"];
  for (const id of tools) {
    const row = rows.find(each => each.id === id);
    assert.ok(row, `${id} has a row`);
    const rights = row.invoke.records.rights;
    for (const right of rights) assert.ok([...decisionKinds, 'pursuit', ...methodKinds].includes(right.kind), `${id} reaches ${right.kind}`);
    // Ending a large old-layout decision goes through its record layout, so every decision tool reaches each laid-apart kind.
    for (const kind of decisionKinds.filter(each => each !== 'decision-call')) assert.ok(rights.some(right => right.kind === kind), `${id} reaches ${kind}, where a decision keeps its parts`);
    // Only the tools that name or check a method reach its rows, and none writes a row of the method or the saved view.
    const reachesMethod = rights.some(right => methodKinds.includes(right.kind));
    assert.equal(reachesMethod, ['tool:start-a-decision', 'tool:make-the-decision'].includes(id), `${id} reaches the person's methods only where it names or checks one`);
    for (const right of rights.filter(each => ['list', 'list-view', "record:method-row"].includes(each.kind))) assert.ok(!right.operations.includes('records:write'), `${id} never writes ${right.kind}`);
    if (id === 'tool:make-the-decision') assert.deepEqual(rights.find(right => right.kind === 'method-answer')?.operations, ['records:list'], 'making a decision only lists the answers its method has');
    assert.ok(!rights.some(right => right.kind === 'pursuit' && right.operations.includes('records:write')), `${id} never writes a pursuit`);
  }
});

test('a decided decision is shared only after the plain pass and a re-identification verdict bound to its exact words', async () => {
  const door = account();
  door.put(`record:${settings.share.never_publish_row}:1`, `record:${settings.share.never_publish_row}`, { [settings.share.never_publish_field]: 'pottery camp' });
  const id = await answered(door);
  await assert.rejects(shareADecision({ decision_id: id }, { door }), /no decision yet/);
  await makeTheDecision({ decision_id: id, decision }, { door });
  const asked = await shareADecision({ decision_id: id }, { door });
  assert.equal(asked.next, 'rewrite');
  assert.equal(asked.facts.goal, 'Decide the [removed] price for spring', 'the person\'s never-publish phrase is redacted before the AI rewrites');
  assert.deepEqual(asked.shape.map(field => field.name), ['situation', 'options', 'chosen', 'why', 'measured_by']);
  const rewrite = { situation: 'Someone running a small seasonal class weighed raising its price after their costs went up.', options: ['Keep the price', 'Raise the price'], chosen: 'Raise the price', why: 'Costs went up and most people still came.', measured_by: 'About as many sign ups as last season.' };
  await assert.rejects(shareADecision({ decision_id: id, rewrite: { ...rewrite, why: 'The pottery camp costs went up.' } }, { door }), /could still point to someone: \[removed\]/);
  await assert.rejects(shareADecision({ decision_id: id, rewrite: { ...rewrite, measured_by: 'Twelve families by 2027.' } }, { door }), /could still point to someone: \[removed\]/, 'a refusal never repeats the detail it found');
  await assert.rejects(shareADecision({ decision_id: id, rewrite: { situation: 'A class price.' } }, { door }), /A rewrite is/);
  const check = await shareADecision({ decision_id: id, rewrite }, { door });
  assert.equal(check.next, 'check');
  assert.equal(check.check.tool, settings.share.check_tool);
  assert.deepEqual(check.check.rubric, settings.share.reidentification);
  assert.match(check.check.input_identity, /^blake3:[0-9a-f]{64}$/);
  // A verdict about other words, or one that was not accepted, is not this rewrite's.
  const other = await shareADecision({ decision_id: id, rewrite, reidentification: { accepted: true, review_binding: { input_identity: `blake3:${'0'.repeat(64)}` } } }, { door });
  assert.equal(other.next, 'check');
  const rejected = await shareADecision({ decision_id: id, rewrite, reidentification: { accepted: false, review_binding: { input_identity: check.check.input_identity } } }, { door });
  assert.equal(rejected.next, 'check');
  assert.equal(caseView(door, id).shared, undefined, 'nothing is kept as shared before an accepted verdict for these words');
  const shared = await shareADecision({ decision_id: id, rewrite, reidentification: { accepted: true, review_binding: { input_identity: check.check.input_identity } } }, { door });
  assert.deepEqual(shared.send, { tool: settings.share.pool_tool, entry: rewrite });
  assert.equal(caseView(door, id).shared.review_identity, check.check.input_identity);
  const changed = await shareADecision({ decision_id: id, rewrite: { ...rewrite, why: 'Costs rose and most people still came.' } }, { door });
  assert.notEqual(changed.check.input_identity, check.check.input_identity, 'the verdict binds exactly the words it reviewed');
});

test('sharing reads only the decision and the person\'s never-publish rows, and packs the tools it imports', () => {
  const row = rows.find(each => each.id === 'tool:share-a-decision');
  const rights = row.invoke.records.rights;
  for (const right of rights) assert.ok([...decisionKinds, `record:${settings.share.never_publish_row}`].includes(right.kind), right.kind);
  assert.deepEqual(rights.find(right => right.kind === `record:${settings.share.never_publish_row}`).operations, ['records:list']);
  const packed = row.invoke.files.package_files.map(item => item.package ?? item.module);
  for (const name of ['decide-with-a-method', 'learn-from-everyones-results', 'ask-a-small-model-for-a-verdict', 'content-identity', '@noble/hashes']) assert.ok(packed.includes(name), name);
});

test('two evidence adds to one case at the same time both land: the case changed under the first is read again and written under a fresh key', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const [first, second] = await Promise.all([
    addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door }),
    addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e4', claim: 'The seller agreed to a trial week' }] }, { door }),
  ]);
  assert.equal(first.added.length + second.added.length, 2);
  const refs = caseView(door, id).input.evidence.map(row => row.ref);
  assert.ok(refs.includes('e3') && refs.includes('e4'), `both rows are kept: ${refs}`);
});

test('an evidence add of eight rows lands as eight single adds do, with refs long enough that a key naming every ref would pass the request-key bound', async () => {
  const rows = Array.from({ length: 8 }, (_, n) => ({ ref: `ref-${n}-${'pottery-kiln-cost-record-'.repeat(2)}${n}`, claim: `Claim ${n}: ${'the kiln bill for this spring was higher than last spring '.repeat(3)}` }));
  const batch = account();
  const { case_id: id } = await startADecision(opened, { door: batch });
  const one = await addDecisionEvidence({ decision_id: id, evidence: rows }, { door: batch });
  assert.equal(one.added.length, 8);
  const singles = account();
  assert.equal((await startADecision(opened, { door: singles })).case_id, id);
  for (const row of rows) await addDecisionEvidence({ decision_id: id, evidence: [row] }, { door: singles });
  const kept = view => caseView(view, id).input.evidence.map(({ ref, claim }) => ({ ref, claim }));
  assert.deepEqual(kept(batch), kept(singles), 'the case keeps the same rows either way');
  assert.equal(caseView(batch, id).input.evidence.length, caseView(singles, id).input.evidence.length);
});

test('evidence added at any time is kept with when it came in, the same start still opens that decision, and an answer may cite the new evidence', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const citing = { row: STEP_ROW('scope'), answer: 'A made-up answer that rests on the second family request', evidence_refs: ['e1', 'e3'] };
  const early = await recordMethodAnswers({ decision_id: id, method: METHOD_VIEW, answers: [citing] }, { door });
  assert.deepEqual([early.recorded.length, early.refused.length], [0, 1], 'evidence not yet added cannot be cited');
  const added = await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door });
  assert.equal(added.evidence, 3);
  assert.equal(added.added.length, 1);
  assert.ok(added.added[0].added_at, 'the row keeps when it came in');
  assert.equal(caseView(door, id).input.evidence[0].added_at, undefined, 'evidence the decision started with keeps no time of its own');
  assert.equal((await startADecision(opened, { door })).case_id, id, 'the same start is still that decision after evidence is added');
  await assert.rejects(startADecision({ ...opened, goal: 'Something else entirely' }, { door }), /already has decision/);
  const again = await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door });
  assert.equal(again.replayed, true);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Something else' }] }, { door }), /its own ref/);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [] }, { door }), /from 1 to 64/);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e4' }] }, { door }), /needs a ref and either a claim/);
  const next = await recordMethodAnswers({ decision_id: id, method: METHOD_VIEW, answers: [citing] }, { door });
  assert.deepEqual([next.recorded.length, next.refused.length], [1, 0], 'the evidence once added can be cited');
});

test('an evidence row can be brought in from another of the person\'s decisions: copied as it stood, with where it came from', async () => {
  const door = account();
  const source = await answered(door);
  const { case_id: id } = await startADecision({ ...opened, source_id: 'chat:pottery-2', evidence: [{ ref: 'e1', claim: opened.evidence[0].claim }] }, { door });
  const bringing = await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e9', from: { decision_id: source, ref: 'e1' } }] }, { door });
  assert.deepEqual(bringing.added[0].from, { decision_id: source, ref: 'e1' });
  assert.equal(bringing.added[0].claim, opened.evidence[0].claim);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e9', from: { decision_id: source, ref: 'missing' } }] }, { door }), /no evidence missing/);
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e8', from: { decision_id: id, ref: 'e1' } }]  }, { door }), /revise it instead/);
});

// A root as the layout before this one wrote it: its evidence, options, results, history and cited pursuits inside it,
// its method snapshot inline, its answered steps' summaries on it and its original input kept whole.
function asOldRoot(door, id) {
  const view = caseView(door, id);
  const { counts: _counts, input_identity: _identity, method_identity: _method, ...old } = { ...view, counts: null };
  for (const key of [...door.records.keys()]) if (/^decision-(evidence|answered-step|option|candidate|report|carried-out|history|cited-pursuit):/.test(key)) door.records.delete(key);
  for (const key of [...door.records.keys()]) {
    const [, plain] = /^(decision-step:.+:\d{3}):c1f:[0-9a-f]+$/.exec(key) ?? [];
    if (plain) { door.put(plain, 'decision-step', door.value(key)); door.records.delete(key); }
  }
  door.put(id, 'decision', old);
  return old;
}

test('a root written the old way still reads, and is laid apart at its next change, its root written last', async () => {
  const door = account();
  door.put('pursuit:camp', 'pursuit', { title: 'Keep the camp running', now: 'Losing money', after: 'Covering costs', status: 'active' });
  const id = await answered(door);
  await makeTheDecision({ decision_id: id, decision }, { door });
  await reportADecisionResult({ decision_id: id, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' }, { door });
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door });
  const old = asOldRoot(door, id);
  door.put(id, 'decision', { id: id, ...old, original_input: opened, cited_pursuits: { 'pursuit:camp': 'Keep the camp running: now Losing money; should be Covering costs' } });
  assert.equal(door.value(id).input.evidence.length, 3, 'the old root holds its evidence');
  assert.equal(door.value(id).answered_steps.length, 3);

  assert.equal((await readDecision(door, id, ['scope'])).guidance[0].step_id, 'scope', 'it reads as it is');
  assert.equal((await startADecision(opened, { door })).case_id, id, 'its original input still opens it');
  door.writes.length = 0;
  await makeTheDecision({ decision_id: id, decision: { ...decision, option_id: 'keep', evidence_refs: ['e3'] } }, { door });
  const root = door.value(id);
  assert.equal(root.input.evidence, undefined, 'its next change lays it apart');
  for (const field of ['answered_steps', 'original_input', 'reports', 'decision_history', 'cited_pursuits', 'method']) assert.equal(root[field], undefined, `${field} leaves the root`);
  assert.equal(root.counts.evidence, 3);
  assert.equal(itemNow(door, id, 'evidence', 2).ref, 'e3');
  assert.equal(itemNow(door, id, 'reports', 0).result, 'failed');
  assert.equal(itemNow(door, id, 'decision_history', 0).decision.option_id, 'raise');
  assert.equal(itemNow(door, id, 'cited_pursuits', 0).ref, 'pursuit:camp');
  assert.equal(itemNow(door, id, 'answered_steps', 2).step_id, 'proof');
  assert.equal(caseView(door, id).method_view, METHOD_VIEW, 'it keeps the saved view it was opened with');
  assert.deepEqual(door.writes.at(-1).ids.at(0), id, 'the root is in the last write');
  const view = caseView(door, id);
  assert.equal(view.decision.option_id, 'keep');
  assert.equal(view.decision_history.length, 1);
  assert.equal((await startADecision(opened, { door })).case_id, id, 'the identity of its original input is kept');
  await assert.rejects(startADecision({ ...opened, goal: 'Something else entirely' }, { door }), /already has decision/);
});

test('a decision of any size fits: every record and every door write stays under the 64 KiB cap, and the root does not grow', async t => {
  const door = memoryDoor();
  const names = Array.from({ length: 43 }, (_, n) => `part-${String(n).padStart(2, '0')}`);
  account({ door, steps: names });
  for (let n = 0; n < 30; n += 1) door.put(`pursuit:p${n}`, 'pursuit', { title: `Made-up pursuit ${n} with a long title for the test`, now: 'Where it stands now in plain words', after: 'Where it should end up in plain words', status: 'active' });
  const claim = n => `Made-up fact ${n}: a measured detail about the synthetic placement, its owner, its cost and its timing, written out at length so the case grows.`;
  const start = { source_id: 'chat:big', goal: 'Decide where the made-up service is placed', evidence: Array.from({ length: 300 }, (_, n) => ({ ref: `e${n + 1}`, claim: claim(n) })), options: opened.options };
  const { case_id: id } = await startADecision(start, { door });
  const pursuits = Array.from({ length: 30 }, (_, p) => `pursuit:p${p}`);
  const recorded = await answerAll(door, id, { steps: names, ref: 'e1' });
  assert.equal(recorded.refused.length, 0);
  for (let call = 0; call < 4; call += 1) {
    const evidence = Array.from({ length: 50 }, (_, n) => ({ ref: `added-${call}-${n}`, claim: claim(1000 + call * 50 + n) }));
    await addDecisionEvidence({ decision_id: id, evidence }, { door });
  }
  for (let round = 0; round < 3; round += 1) {
    await makeTheDecision({ decision_id: id, decision: { ...decision, option_id: round % 2 ? 'keep' : 'raise', evidence_refs: ['e1', ...pursuits] } }, { door });
    for (let n = 0; n < 4; n += 1) await sayWhatWasDone({ decision_id: id, state: 'done', what_happened: `Round ${round} step ${n}: ${'what was done, in long made-up words. '.repeat(100)}` }, { door });
    await reportADecisionResult({ decision_id: id, result: 'failed', summary: `Round ${round} did not work: ${'the made-up measure was missed. '.repeat(20)}`, answered_by: 'person' }, { door });
  }
  const made = await makeTheDecision({ decision_id: id, decision: { ...decision, evidence_refs: ['e1', 'added-3-49'] } }, { door });
  assert.equal(made.decision.evidence_refs[1], 'added-3-49', 'the decision cites evidence added late');

  const view = caseView(door, id);
  assert.equal(view.input.evidence.length, 500);
  assert.equal(view.decision_history.length, 3);
  assert.equal(view.reports.length, 3);
  assert.equal(view.carried_out.length, 12);
  assert.equal(Object.keys(view.cited_pursuits).length, 30);
  assert.equal((await methodAnsweredCount(door, id)), 43, 'every row of the method keeps its own answer record');

  const bytes = value => Buffer.byteLength(JSON.stringify(value));
  const mine = [...door.records.entries()].filter(([key]) => key === id || key.includes(`:${id}:`));
  const total = mine.reduce((sum, [key, kept]) => sum + bytes({ id: key, type: kept.type, value: kept.value }), 0);
  assert.ok(total > 64 * 1024, `the case is larger than one write (${total} bytes)`);
  const largestWrite = Math.max(...door.writes.map(write => write.bytes));
  assert.ok(largestWrite <= 64 * 1024, `every door write is under the cap (largest ${largestWrite})`);
  const largestCarried = Math.max(...door.writes.map(write => write.carried));
  assert.ok(largestCarried <= 64 * 1024, `every door write is under the cap however it is carried (largest ${largestCarried})`);
  const largest = {};
  for (const [key, kept] of mine) {
    const type = key === id ? 'decision' : kept.type;
    largest[type] = Math.max(largest[type] ?? 0, bytes({ id: key, type: kept.type, value: kept.value }));
  }
  for (const [type, size] of Object.entries(largest)) assert.ok(size <= (type === 'decision' ? 4096 : settings.record_bytes), `${type} records stay small (${size})`);
  const roots = door.writes.filter(write => write.ids.includes(id)).length;
  assert.ok(roots >= 20, 'the root was written at every change');

  // A reader that reads synchronously joins the same records with the same pure function: `joinDecision` over what the door
  // holds, never the door, is the decision `readDecision` returns.
  const get = (type, key) => (door.records.get(key)?.type === type ? structuredClone(door.records.get(key).value) : null);
  const synchronous = joinDecision(id, door.value(id), get, []);
  assert.deepEqual(synchronous, await readDecision(door, id, []));
  assert.equal(synchronous.input.evidence.length, 500);
  t.diagnostic(`case ${total} bytes; largest write ${largestWrite}; largest record by type ${JSON.stringify(largest)}`);
});

test('an earlier decision laid apart comes back as similar with its chosen option and its result', async () => {
  const door = account();
  const first = await answered(door);
  await makeTheDecision({ decision_id: first, decision }, { door });
  await reportADecisionResult({ decision_id: first, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' }, { door });
  const { case_id: second } = await startADecision({ ...opened, source_id: 'chat:pottery-again' }, { door });
  const { similar_decisions: found } = await similarDecisions({ decision_id: second }, { door });
  assert.deepEqual(found.map(item => [item.case_id, item.decision, item.status, item.reported.length]), [[first, 'Raise the price', 'correction_needed', 1]]);
});

test('options stay on the root, bounded at start: too many or too long is refused with the limit', async () => {
  const door = account();
  const many = Array.from({ length: settings.options.most + 1 }, (_, n) => ({ id: `o${n}`, label: `Option ${n}` }));
  await assert.rejects(startADecision({ ...opened, source_id: 'chat:many', options: many }, { door }), new RegExp(`at most ${settings.options.most} options, ${settings.options.most_bytes} bytes.*group similar options`));
  const long = [{ id: 'a', label: 'A long made-up option label. '.repeat(400) }, { id: 'b', label: 'B' }];
  await assert.rejects(startADecision({ ...opened, source_id: 'chat:long', options: long }, { door }), /shorten their labels/);
  const most = Array.from({ length: settings.options.most }, (_, n) => ({ id: `o${n}`, label: `Option ${n}` }));
  const { case_id: id } = await startADecision({ ...opened, source_id: 'chat:most', options: most }, { door });
  assert.deepEqual(door.value(id).input.options, most);
});

test('a root written while options were laid apart reads them back and folds them into the root at its next change', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const root = door.value(id);
  const { options, ...input } = root.input;
  options.forEach((option, n) => door.put(`decision-option:${id}:${String(n).padStart(3, '0')}`, 'decision-option', option));
  door.put(id, 'decision', { id: id, ...root, input, counts: { ...root.counts, options: options.length } });
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door });
  const folded = door.value(id);
  assert.deepEqual(folded.input.options, opened.options, 'its options are back on the root');
  assert.equal(folded.counts.options, undefined);
  assert.equal(door.value(`decision-option:${id}:000`), null, 'and their records are removed');
  assert.equal((await startADecision(opened, { door })).case_id, id, 'the same start is still that decision');
});

test('ending decisions keeps every field they had, adds what they were, when, who and why, and deletes nothing', async () => {
  const door = memoryDoor();
  const a = 'source:camp-a', b = 'source:camp-b';
  const first = { id: a, status: 'needs_outcome', goal: 'Pick a made-up venue', decision: { option_id: 'venue-1', reason: 'It was closer.' }, carried_out: [{ state: 'done', what_happened: 'Booked it.' }], answered_steps: [{ step_id: 'scope' }] };
  const second = { id: b, status: 'invalid_source', goal: 'A made-up goal' };
  door.put(a, 'decision', first);
  door.put(b, 'decision', second);
  const count = door.records.size;
  const answer = await endDecisions({ decisions: [{ decision_id: a, because: 'No one will carry it on.' }, { decision_id: b, because: 'Its source was never valid.' }], by: 'test-agent' }, { door });
  assert.equal(answer.ended, 2);
  assert.equal(answer.not_ended, 0);
  for (const [old, because] of [[first, 'No one will carry it on.'], [second, 'Its source was never valid.']]) {
    const now = door.value(old.id);
    assert.equal(now.status, 'ended');
    assert.equal(now.previous_status, old.status);
    assert.equal(now.ended_by, 'test-agent');
    assert.equal(now.ended_because, because);
    assert.ok(!Number.isNaN(Date.parse(now.ended_at)), 'ended_at is a time');
    for (const [name, value] of Object.entries(old)) if (name !== 'status') assert.deepEqual(now[name], value, `${name} is kept`);
    assert.deepEqual(Object.keys(now).sort(), [...Object.keys(old), 'previous_status', 'ended_at', 'ended_by', 'ended_because'].sort());
  }
  assert.equal(door.writes.length, 1, 'one write');
  assert.equal(door.records.size, count, 'nothing deleted');
  const again = await endDecisions({ decisions: [{ decision_id: a, because: 'Again.' }, { decision_id: b, because: 'Again.' }], by: 'test-agent' }, { door });
  assert.deepEqual(again.decisions.map(item => item.already), [true, true]);
  assert.equal(again.ended, 2);
  assert.equal(door.writes.length, 1, 'ending again writes nothing');
});

test('a decision with a checked result or a correction to keep is never ended', async () => {
  const door = memoryDoor();
  const statuses = settings.ending.keeps_open;
  assert.deepEqual(statuses, ['outcome_verified', 'correction_needed', 'verification']);
  const kept = statuses.map((status, n) => ({ id: `source:camp-${n}`, status, goal: 'A made-up goal' }));
  for (const value of kept) door.put(value.id, 'decision', value);
  const answer = await endDecisions({ decisions: kept.map(value => ({ decision_id: value.id, because: 'Tidying.' })), by: 'test-agent' }, { door });
  assert.equal(answer.ended, 0);
  assert.equal(answer.not_ended, 3);
  for (const [n, item] of answer.decisions.entries()) {
    assert.equal(item.ended, false);
    assert.equal(item.status, statuses[n]);
    assert.deepEqual(door.value(kept[n].id), kept[n], 'unchanged');
  }
  assert.equal(door.writes.length, 0);
});

test('a decision that changed after it was read is not ended, the others are, and a missing one is not there', async () => {
  const door = memoryDoor();
  door.put('source:camp-a', 'decision', { id: 'source:camp-a', status: 'needs_outcome', goal: 'A made-up goal' });
  door.put('source:camp-b', 'decision', { id: 'source:camp-b', status: 'needs_outcome', goal: 'Another made-up goal' });
  const read = door.read.bind(door);
  door.read = async (type, id) => {
    const value = await read(type, id);
    if (id === 'source:camp-b') door.put(id, 'decision', { status: 'decided', goal: 'Changed by another writer' });
    return value;
  };
  const answer = await endDecisions({ decisions: [{ decision_id: 'source:camp-a', because: 'Done with it.' }, { decision_id: 'source:camp-b', because: 'Done with it.' }, { decision_id: 'source:camp-missing', because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.equal(answer.decisions[0].ended, true);
  assert.deepEqual({ ended: answer.decisions[1].ended, conflict: answer.decisions[1].conflict }, { ended: false, conflict: true });
  assert.equal(answer.decisions[2].ended, false);
  assert.equal(answer.decisions[2].reason, 'No decision has that id.');
  assert.equal(answer.ended, 1);
  assert.equal(answer.not_ended, 2);
  assert.equal(door.value('source:camp-a').status, 'ended');
  assert.deepEqual(door.value('source:camp-b'), { status: 'decided', goal: 'Changed by another writer' }, 'the other writer\'s value is kept');
});

test('ending refuses a call that is not 1 to 256 decisions, each named once with a because, by someone', async () => {
  const door = memoryDoor();
  door.put('source:camp-a', 'decision', { id: 'source:camp-a', status: 'needs_outcome' });
  const one = { decision_id: 'source:camp-a', because: 'Done with it.' };
  const bad = [
    { decisions: Array.from({ length: 257 }, (_, n) => ({ decision_id: `source:camp-${n}`, because: 'Done.' })), by: 'test-agent' },
    { decisions: [], by: 'test-agent' },
    { decisions: [{ decision_id: 'source:camp-a' }], by: 'test-agent' },
    { decisions: [one, one], by: 'test-agent' },
    { decisions: [one] },
  ];
  for (const input of bad) await assert.rejects(endDecisions(input, { door }), /Name 1 to 256 decisions/);
  assert.equal(door.writes.length, 0);
});

// A made-up decision in the old layout: its evidence rows, its method snapshot and its answered steps inline on a root of
// about 70 KB, so the root and its `expected` cannot fit one 64 KiB door message together.
// The steps' own records, at the plain keys the old layout kept them under.
function putOldSteps(door, id) {
  door.put(`decision-step:${id}:000`, 'decision-step', { step_id: 'scope', answer: scope, answered_at: '2026-01-02T03:04:05.000Z', version: 1 });
  door.put(`decision-step:${id}:001`, 'decision-step', { step_id: 'outcome', answer: outcomeAnswer, answered_at: '2026-01-02T03:05:05.000Z', version: 1 });
}
function oldLargeRoot(id) {
  const evidence = Array.from({ length: 300 }, (_, n) => ({ ref: `e${n + 1}`, claim: `Made-up fact ${n}: a synthetic detail about the camp venue, its cost and its timing, written out so the root grows.` }));
  const method = { ...legacyMethod(), about: 'A made-up method with a long description, kept inline as roots once were. '.repeat(340) };
  const answered_steps = [
    { step_id: 'scope', answered_at: '2026-01-02T03:04:05.000Z', version: 1, needs_recheck: false },
    { step_id: 'outcome', answered_at: '2026-01-02T03:05:05.000Z', checks: 1, graded: 1, graded_by: 'second-judge-test', version: 1, needs_recheck: false },
  ];
  return { id, source_id: 'chat:old-large', status: 'needs_outcome', created_at: '2026-01-02T03:00:00.000Z', input: { source_id: 'chat:old-large', goal: 'Pick the made-up camp venue', options: opened.options, evidence }, method, answered_steps, decision: { option_id: 'raise', reason: 'A made-up reason' } };
}

test('a decision whose root is too large for one conditioned write is ended through its layout, beside a small one', async () => {
  const door = memoryDoor();
  const big = 'source:old-large', small = 'source:camp-small';
  const root = oldLargeRoot(big);
  const size = Buffer.byteLength(JSON.stringify(root));
  assert.ok(size > 65000 && size < 80000, `the root is about 70 KB (${size})`);
  door.put(big, 'decision', root);
  putOldSteps(door, big);
  door.put(small, 'decision', { id: small, status: 'needs_outcome', goal: 'A made-up goal' });
  const answer = await endDecisions({ decisions: [{ decision_id: big, because: 'No one will carry it on.' }, { decision_id: small, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.equal(answer.ended, 2);
  assert.deepEqual(answer.decisions.map(item => [item.ended, item.laid_apart ?? false]), [[true, true], [true, false]]);
  assert.equal(answer.decisions[0].previous_status, 'needs_outcome');
  assert.ok(door.writes.every(write => write.bytes <= 64 * 1024), 'no write is over the cap');
  assert.equal(door.writes.filter(write => write.ids.includes(big)).at(-1), door.writes.findLast(write => write.ids.some(key => key === big || key.includes(`:${big}:`))), 'the root is written last');
  const view = caseView(door, big);
  assert.equal(view.status, 'ended');
  assert.equal(view.previous_status, 'needs_outcome');
  assert.equal(view.ended_by, 'test-agent');
  assert.equal(view.ended_because, 'No one will carry it on.');
  assert.equal(view.input.goal, root.input.goal);
  assert.deepEqual(view.input.evidence.map(row => row.claim), root.input.evidence.map(row => row.claim));
  assert.deepEqual(view.answered_steps.map(step => step.step_id), root.answered_steps.map(step => step.step_id));
  assert.ok(Buffer.byteLength(JSON.stringify(door.value(big))) < 4096, 'the root is laid apart');
  assert.equal(door.value(small).status, 'ended');
});

test('a large decision that changed between its two reads is not ended and nothing of it is written', async () => {
  const door = memoryDoor();
  const big = 'source:old-large';
  door.put(big, 'decision', oldLargeRoot(big));
  putOldSteps(door, big);
  const read = door.read.bind(door);
  let raw = 0;
  door.read = async (type, id) => {
    if (type === 'decision' && id === big && ++raw === 3) door.put(big, 'decision', { id: big, ...oldLargeRoot(big), status: 'decided' });
    return read(type, id);
  };
  const before = door.records.size;
  const answer = await endDecisions({ decisions: [{ decision_id: big, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.deepEqual({ ended: answer.decisions[0].ended, conflict: answer.decisions[0].conflict }, { ended: false, conflict: true });
  assert.equal(answer.decisions[0].reason, settings.words.end_changed);
  assert.equal(door.writes.length, 0, 'nothing was written');
  assert.equal(door.records.size, before);
  assert.equal(door.value(big).status, 'decided', 'the other writer\'s value is kept');
});

test('a door that answers 413 for a batch of several records still ends every decision', async () => {
  const door = memoryDoor();
  const ids = ['source:camp-a', 'source:camp-b', 'source:camp-c'];
  for (const id of ids) door.put(id, 'decision', { id: id, status: 'needs_outcome', goal: `A made-up goal for ${id}` });
  const write = door.write.bind(door);
  let refused = 0;
  door.write = async (list, options) => {
    if (list.length > 1) { refused += 1; throw Object.assign(new Error('413'), { code: 'http_413' }); }
    return write(list, options);
  };
  const answer = await endDecisions({ decisions: ids.map(decision_id => ({ decision_id, because: 'Done with it.' })), by: 'test-agent' }, { door });
  assert.equal(refused, 1);
  assert.equal(answer.ended, 3);
  for (const id of ids) assert.equal(door.value(id).status, 'ended');
});

test('a single conditioned record the door still refuses as 413 is ended through its layout', async () => {
  const door = memoryDoor();
  const id = 'source:camp-a';
  door.put(id, 'decision', { id, status: 'needs_outcome', goal: 'A made-up goal', input: { goal: 'A made-up goal', evidence: [{ ref: 'e1', claim: 'A made-up fact' }] } });
  const write = door.write.bind(door);
  let refusedOnce = false;
  door.write = async (list, options) => {
    if (!refusedOnce && list.some(record => record.type === 'decision')) {
      refusedOnce = true;
      throw Object.assign(new Error('413'), { code: 'http_413' });
    }
    return write(list, options);
  };
  const answer = await endDecisions({ decisions: [{ decision_id: id, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.deepEqual([answer.decisions[0].ended, answer.decisions[0].laid_apart], [true, true]);
  assert.equal(caseView(door, id).status, 'ended');
  assert.deepEqual(caseView(door, id).input.evidence, [{ ref: 'e1', claim: 'A made-up fact' }]);
});

// A made-up old-layout root of the shape measured on a real account: two evidence rows inline, one of them a whole
// incoming chat message of about 67 KB (quotes, backslashes, newlines and emoji), the method snapshot inline, nothing else.
function oldRootWithHugeClaim(id) {
  const line = n => `Line ${n}: "Sure," she said \\ he typed C:\\camp\\notes — "let's book the 🏕️ venue" 🙂🎉\n\tthen: {"ok": true} ✓ café naïve 日本\n`;
  let claim = '';
  for (let n = 0; Buffer.byteLength(JSON.stringify(claim)) < 67700; n += 1) claim += line(n);
  const source_id = 'message:2026-01-02T03:04:05.000Z:0a1b2c3d4e5f60718293a4b5c6d7e8f9';
  const method = { ...legacyMethod(), id: 'universal' };
  return {
    id, source_id, status: 'needs_decision', created_at: '2026-01-02T03:04:05.000Z',
    input: {
      source_id, method: 'universal',
      goal: 'Choose which made-up venue the camp books for the spring weekend, given the cost, the travel time and the rooms it has for everyone who signed up so far, and say why.',
      options: [{ id: 'lake', label: 'The made-up lake venue' }, { id: 'hill', label: 'The made-up hill venue' }],
      evidence: [{ ref: 'e1', claim }, { ref: 'e2', claim: 'A made-up fact: the lake venue answered first, and its quote came in under the budget we set.' }],
    },
    method, scratchpad: {}, checks: [], answered_steps: [], actions: [],
  };
}

test('an old-layout root whose one evidence claim is about 67 KB ends in writes that each fit the cap, losing nothing', async () => {
  const door = memoryDoor();
  const id = 'source:old-huge-claim';
  const root = oldRootWithHugeClaim(id);
  const claimBytes = Buffer.byteLength(JSON.stringify(root.input.evidence[0].claim));
  assert.ok(claimBytes > 67000 && claimBytes < 68500, `the claim is about 67 KB (${claimBytes})`);
  door.put(id, 'decision', root);
  const answer = await endDecisions({ decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' }, { door });
  assert.deepEqual([answer.ended, answer.decisions[0].laid_apart], [1, true]);
  for (const write of door.writes) assert.ok(write.bytes <= 64 * 1024 && write.carried <= 64 * 1024, `${write.key}: ${write.bytes} bytes, ${write.carried} as carried, is over the cap`);
  const view = caseView(door, id);
  assert.equal(view.status, 'ended');
  assert.equal(view.previous_status, 'needs_decision');
  assert.deepEqual(view.input.evidence, root.input.evidence, 'both claims, word for word');
  for (const field of ['goal', 'options', 'source_id', 'method']) assert.deepEqual(view.input[field], root.input[field], `input.${field}`);
  for (const field of ['source_id', 'created_at', 'scratchpad', 'checks', 'actions']) assert.deepEqual(view[field], root[field], field);
  assert.deepEqual(view.method, root.method);
  assert.ok(Buffer.byteLength(JSON.stringify(door.value(id))) < 4096, 'the root is laid apart');
});

test('a single evidence row of any size, added to a decision, is kept in writes that each fit the cap, and ends whole', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const line = n => `Row ${n}: "quoted \\ slashed" — naïve café 🏕️🙂 日本語\n\t{"nested": "\\"json\\""}\n`;
  let claim = '';
  for (let n = 0; claim.length < 250000; n += 1) claim += line(n);
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim }] }, { door });
  const answer = await endDecisions({ decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' }, { door });
  assert.equal(answer.ended, 1);
  for (const write of door.writes) assert.ok(write.bytes <= 64 * 1024 && write.carried <= 64 * 1024, `${write.key}: ${write.bytes} bytes, ${write.carried} as carried, is over the cap`);
  const view = caseView(door, id);
  assert.equal(view.status, 'ended');
  assert.deepEqual(view.input.evidence, [...opened.evidence, { ...view.input.evidence[2], ref: 'e3', claim }], 'every claim word for word');
});

test('a decision whose laid-apart write the door still refuses as 413 is answered not ended, and the others still end', async () => {
  const door = memoryDoor();
  const big = 'source:old-huge-claim', small = 'source:camp-small';
  door.put(big, 'decision', oldRootWithHugeClaim(big));
  door.put(small, 'decision', { id: small, status: 'needs_outcome', goal: 'A made-up goal' });
  const write = door.write.bind(door);
  door.write = async (list, options) => {
    if (list.some(record => record.id.includes(big))) throw Object.assign(new Error('The records door answered 413.'), { code: 'http_413' });
    return write(list, options);
  };
  const answer = await endDecisions({ decisions: [{ decision_id: big, because: 'Done with it.' }, { decision_id: small, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.deepEqual(answer.decisions.map(item => item.ended), [false, true]);
  assert.equal(answer.decisions[0].too_large, true);
  assert.equal(answer.decisions[0].reason, settings.words.end_too_large);
  assert.equal(door.value(big).status, 'needs_decision', 'the decision is as it was');
  assert.equal(door.value(small).status, 'ended');
});

// The engine keeps each request key with the input it first carried and refuses the key used again with other input.
function keyedDoor(door) {
  const seen = new Map();
  const write = door.write.bind(door);
  door.keys = seen;
  door.write = async (list, options = {}) => {
    const input = JSON.stringify(list);
    if (options.key && seen.has(options.key) && seen.get(options.key) !== input) throw Object.assign(new Error('The records changed while this tool was running.'), { code: 'original_command_conflict' });
    const answer = await write(list, options);
    if (options.key) seen.set(options.key, input);
    return answer;
  };
  return door;
}

test('a large old-layout decision whose first end failed partway is ended by the next call, under fresh keys', async () => {
  const door = keyedDoor(memoryDoor());
  const id = 'source:old-history-retry';
  door.put(id, 'decision', oldRootWithLargeField(id));
  const keyed = door.write;
  let refuseRoot = true;
  door.write = async (list, options) => {
    if (refuseRoot && list.some(record => record.id === id)) throw Object.assign(new Error('The records door answered 413.'), { code: 'http_413' });
    return keyed(list, options);
  };
  const first = await endDecisions({ decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' }, { door });
  assert.equal(first.decisions[0].ended, false);
  assert.equal(first.decisions[0].too_large, true);
  assert.equal(door.value(id).status, 'needs_outcome', 'the root is as it was');
  const firstKeys = [...door.keys.keys()];
  assert.ok(firstKeys.length > 0, 'the first call wrote some parts before the refusal');
  refuseRoot = false;
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await endDecisions({ decisions: [{ decision_id: id, because: 'Ended on the second try.' }], by: 'test-agent' }, { door });
  assert.equal(second.decisions[0].ended, true);
  assert.equal(second.decisions[0].laid_apart, true);
  assert.equal(door.value(id).status, 'ended');
  assert.equal(door.value(id).ended_because, 'Ended on the second try.');
  const secondKeys = [...door.keys.keys()].filter(key => !firstKeys.includes(key));
  assert.ok(secondKeys.length > 0 && secondKeys.every(key => key.startsWith(`end-a-decision:${id}:`)), 'the second call used fresh keys');
  assert.deepEqual((await readDecision(door, id)).method_history, oldRootWithLargeField(id).method_history);
});

test('a laid-apart end the engine refuses as a reused key answers that decision as a conflict, and the others still end', async () => {
  const door = memoryDoor();
  const big = 'source:old-history-conflict', small = 'source:camp-small-conflict';
  door.put(big, 'decision', oldRootWithLargeField(big));
  door.put(small, 'decision', { id: small, status: 'needs_outcome', goal: 'A made-up goal' });
  const write = door.write.bind(door);
  door.write = async (list, options) => {
    if (options?.key?.startsWith(`end-a-decision:${big}`)) throw Object.assign(new Error('The records changed while this tool was running.'), { code: 'original_command_conflict' });
    return write(list, options);
  };
  const answer = await endDecisions({ decisions: [{ decision_id: big, because: 'Done with it.' }, { decision_id: small, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.deepEqual(answer.decisions.map(item => item.ended), [false, true]);
  assert.equal(answer.decisions[0].conflict, true);
  assert.equal(answer.decisions[0].reason, settings.words.end_changed);
  assert.equal(door.value(big).status, 'needs_outcome');
  assert.equal(door.value(small).status, 'ended');
});

// A made-up old-layout root of the shape measured on a real account: one field, `method_history`, far larger than the
// door's cap (here about 300 KB, with quotes and characters past ASCII), beside small fields of a few hundred bytes each.
function oldRootWithLargeField(id) {
  const method_history = Array.from({ length: 1400 }, (_, n) => ({
    at: `2026-01-${String(1 + (n % 28)).padStart(2, '0')}T03:04:05.000Z`, from: n % 2 ? 'plain' : 'universal', to: n % 2 ? 'universal' : 'plain',
    because: `Made-up switch ${n}: "the camp venue" changed — café naïve 🏕️, so the method was weighed again and written out at length.`,
  }));
  const input = { source_id: 'chat:old-history', goal: 'Pick the made-up camp venue', options: opened.options, evidence: [{ ref: 'e1', claim: 'A made-up fact about the venue' }] };
  return {
    id, source_id: 'chat:old-history', status: 'needs_outcome', created_at: '2026-01-02T03:00:00.000Z',
    input, original_input: { ...input, note: 'As first given' }, method: legacyMethod(), method_history,
    carried_out: [{ decision_generation: 1, state: 'done', what_happened: 'A made-up receipt', by: 'test-agent', at: '2026-01-03T03:00:00.000Z' }],
    decision: { option_id: 'raise', reason: 'A made-up reason' },
  };
}

test('an old-layout root with a 300 KB field is ended in writes that each fit the cap, and reads back the same', async () => {
  const door = memoryDoor();
  const id = 'source:old-history';
  const root = oldRootWithLargeField(id);
  const size = Buffer.byteLength(JSON.stringify(root.method_history));
  assert.ok(size > 280000 && size < 340000, `the field is about 300 KB (${size})`);
  door.put(id, 'decision', root);
  const answer = await endDecisions({ decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' }, { door });
  assert.equal(answer.decisions[0].ended, true);
  assert.equal(answer.decisions[0].previous_status, 'needs_outcome');
  assert.ok(door.writes.length > 0);
  assert.ok(door.writes.every(write => write.bytes <= 64 * 1024 && write.carried <= 64 * 1024), 'every write fits the cap, plain and as carried');
  const kept = door.value(id);
  assert.deepEqual(kept.fields_in_parts, ['method_history'], 'only the largest field is moved');
  assert.ok(Buffer.byteLength(JSON.stringify(kept)) <= settings.record_bytes, 'the root fits one record');
  for (const field of ['id', 'status', 'previous_status', 'ended_at', 'ended_by', 'ended_because', 'created_at', 'source_id', 'method_id', 'method_identity', 'input_identity', 'counts', 'decision']) assert.ok(field in kept, `${field} stays on the root`);
  const view = caseView(door, id);
  assert.deepEqual(view.method_history, root.method_history);
  assert.equal(view.fields_in_parts, undefined);
  const { original_input: _laidElsewhere, ...rest } = root;
  for (const [field, value] of Object.entries(rest)) {
    if (field === 'status') assert.equal(view.status, 'ended');
    else assert.deepEqual(view[field], value, `${field} reads back the same`);
  }
  assert.equal(view.previous_status, 'needs_outcome');
  const read = await readDecision(door, id);
  assert.deepEqual(read.method_history, root.method_history, 'readDecision puts the field back');
  assert.equal(read.fields_in_parts, undefined);
  // A list that names only some fields still sees the small ones on the root.
  const listed = [];
  for await (const row of door.list({ type: 'decision', fields: ['status', 'source_id', 'decision'] })) listed.push(row.value);
  assert.deepEqual(listed, [{ status: 'ended', source_id: root.source_id, decision: root.decision }]);
  // Its next change keeps it whole: written again, it still reads back the same.
  door.writes.length = 0;
  await writeDecision(door, recordsOf(read), `again:${id}`);
  assert.ok(door.writes.every(write => write.bytes <= 64 * 1024 && write.carried <= 64 * 1024));
  assert.deepEqual((await readDecision(door, id)).method_history, root.method_history);
});

test('a root under the bound is written as before, with no fields in parts', async () => {
  const door = memoryDoor();
  const id = 'source:old-small';
  const root = { ...oldRootWithLargeField(id), method_history: [{ at: '2026-01-02T03:04:05.000Z', from: 'plain', to: 'universal', because: 'A made-up switch' }] };
  door.put(id, 'decision', root);
  const answer = await endDecisions({ decisions: [{ decision_id: id, because: 'Done with it.' }], by: 'test-agent' }, { door });
  assert.equal(answer.decisions[0].ended, true);
  const kept = door.value(id);
  assert.equal(kept.fields_in_parts, undefined);
  assert.equal(kept.root_fields_in_parts, undefined);
  assert.ok(![...door.records.keys()].some(key => key.includes(':root-fields')), 'no root-field parts are written');
  const [records] = [recordsOf(await readDecision(door, id))];
  assert.equal(records[0].value.fields_in_parts, undefined);
  assert.ok(!records.some(record => record.id.includes(':root-fields')));
});

test('a write made from an older read of the case is refused as changed, and nothing of it is written', async () => {
  const door = account();
  const id = await answered(door);
  const read = door.read.bind(door);
  let bumps = 0;
  door.read = async (type, key) => {
    const value = await read(type, key);
    if (type === 'decision-revision') {
      bumps += 1;
      door.put(`decision-revision:${id}`, 'decision-revision', { revision: 99 + bumps });
    }
    return value;
  };
  const added = addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e9', claim: 'A made-up fact added late' }] }, { door });
  if (CHECK_REVISION) {
    await assert.rejects(added, /case changed/);
    assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'e9'), false, 'the late evidence is not kept');
  } else {
    await added;
    assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'e9'), true, 'with the check off, the late evidence lands');
  }
});

test('a write is keyed by what it writes, so a different write under the same name is never a conflict', async () => {
  const door = memoryDoor();
  const keys = [];
  const write = door.write.bind(door);
  door.write = async (list, options) => { keys.push(options?.key); return write(list, options); };
  await writeDecision(door, [{ id: 'decision:k', type: 'decision', value: { a: 1 } }, { id: 'decision-revision:k', type: 'decision-revision', value: { revision: 1 } }], 'same-name');
  await writeDecision(door, [{ id: 'decision:k', type: 'decision', value: { a: 2 } }, { id: 'decision-revision:k', type: 'decision-revision', value: { revision: 2 } }], 'same-name');
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], 'different content under one name gets different keys');
  assert.ok(keys.every(key => key.startsWith('same-name:')));
});

test('a write too large for one message, made from an older read of the case, lands no part: the revision is claimed before the first part', async () => {
  const door = account();
  const id = await answered(door);
  const read = door.read.bind(door);
  let bumps = 0;
  door.read = async (type, key) => {
    const value = await read(type, key);
    if (type === 'decision-revision') {
      bumps += 1;
      door.put(`decision-revision:${id}`, 'decision-revision', { revision: 99 + bumps });
    }
    return value;
  };
  const before = door.writes.length;
  const added = addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e9', claim: 'A made-up fact. '.repeat(9000) }] }, { door });
  if (CHECK_REVISION) {
    await assert.rejects(added, /case changed/);
    assert.equal(door.writes.slice(before).some(write => write.ids.includes(id)), false, 'no root of the stale change reached the door');
    assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'e9'), false, 'the late evidence is not kept, not even in part');
  } else {
    await added;
    assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'e9'), true, 'with the check off, the late evidence lands');
  }
});

test('every decision tool declares the revision record beside its root, with the root\'s operations minus listing', () => {
  const revision = settings.records.record_revision.type;
  const declaring = rows.filter(row => (row.invoke?.records?.rights ?? []).some(item => item.kind === 'decision'));
  assert.ok(declaring.length >= 12, `the decision tools are declared: ${declaring.length}`);
  for (const row of declaring) {
    const rights = row.invoke.records.rights;
    const root = rights.find(item => item.kind === 'decision');
    const record = rights.find(item => item.kind === revision);
    assert.ok(record, `${row.id} declares ${revision}, or its read of a case is refused as not granted`);
    assert.deepEqual(record.operations, root.operations.filter(operation => operation !== 'records:list'), `${row.id} grants the revision as its root does`);
  }
});

test('an evidence add committed between a writer reading the case root and its revision is not lost: the revision is read before the root', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  const read = door.read.bind(door);
  // The writer's two reads of the case, in whichever order it makes them; another add commits before the second one.
  let racing = true, seen = 0, raced = false;
  door.read = async (type, key) => {
    const watched = racing && (key === id || key === `decision-revision:${id}`);
    if (watched && ++seen === 2 && !raced) {
      raced = true;
      racing = false;
      await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e6', claim: 'A fact that came in at the same time' }] }, { door });
    }
    return read(type, key);
  };
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e5', claim: 'A fact that came in late' }] }, { door });
  assert.equal(raced, true, 'the other add committed between the two reads');
  assert.deepEqual(caseView(door, id).input.evidence.map(row => row.ref), ['e1', 'e2', 'e6', 'e5'], 'both adds are kept');
});

test('a refused root write of a revision leaves nothing visible: the case reads as it was before the revision', async () => {
  const door = account();
  const { case_id: id } = await startADecision(opened, { door });
  await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }, { door });
  const write = door.write.bind(door);
  let refused = false;
  // The root of the revision is refused at the door after its parts were written (the change is too large for one message).
  door.write = async (records, options = {}) => {
    const last = records.at(-1);
    if (!refused && records.length === 2 && records[0].id === id && last?.type === 'decision-revision' && last.expected) {
      refused = true;
      throw Object.assign(new Error('busy'), { code: 'selected_owner_unavailable' });
    }
    return write(records, options);
  };
  await assert.rejects(addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e4', claim: 'A made-up fact. '.repeat(9000) }] }, { door }), /busy/);
  assert.equal(refused, true, 'the root of the revision was refused');
  assert.deepEqual(caseView(door, id).input.evidence.map(row => row.ref), ['e1', 'e2', 'e3'], 'the refused add is not in the case');
  assert.equal((await readDecision(door, id)).input.evidence.length, 3, 'and reads as it was');
});

test('a write refused before its root does not move the revision: a writer that read the case before it is not refused as changed', async () => {
  const door = account();
  const id = await answered(door);
  const read = door.read.bind(door);
  const write = door.write.bind(door);
  let racing = true, raced = false;
  door.read = async (type, key) => {
    const value = await read(type, key);
    if (racing && !raced && type === 'decision-revision') {
      // The first writer read the revision; a large evidence add lands its parts and is refused at its root before it returns.
      raced = true;
      door.write = async (records, options = {}) => {
        const last = records.at(-1);
        if (records.length === 2 && records[0].id === id && last?.type === 'decision-revision' && last.expected) throw Object.assign(new Error('busy'), { code: 'selected_owner_unavailable' });
        return write(records, options);
      };
      await addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'eB', claim: 'A made-up fact. '.repeat(9000) }] }, { door }).catch(() => {});
      door.write = write;
    }
    return value;
  };
  const made = await makeTheDecision({ decision_id: id, decision }, { door });
  racing = false;
  assert.equal(raced, true, 'the other write landed between the two reads');
  assert.equal(made.decision.option_id, 'raise', 'the decision is made from the case as it was');
  assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'eB'), false, 'the refused write is not in the case');
});

test('every decision tool row that writes the decision declares the kinds every write puts: the root, its revision, parts and refs', () => {
  // A write always adds its parts and refs record and moves the root and revision; a row that writes must declare each one.
  const everyWrite = ['decision', settings.records.record_revision.type, settings.records.part.type, settings.records.refs];
  const writers = rows.filter(row => (row.invoke?.records?.rights ?? []).some(right => right.kind === settings.records.record_revision.type && right.operations.includes('records:write')));
  assert.ok(writers.length >= 1, 'some decision tools write the decision');
  for (const row of writers) {
    const declared = new Set(row.invoke.records.rights.map(right => right.kind));
    const missing = everyWrite.filter(kind => !declared.has(kind));
    assert.deepEqual(missing, [], `${row.id} does not declare: ${missing.join(', ')}`);
  }
});
