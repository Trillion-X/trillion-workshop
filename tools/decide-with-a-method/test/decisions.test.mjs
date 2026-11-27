// The decision tools over the person's own records, with a made-up method (rows and a saved view) and made-up decisions.
// Ported from the old app's run-decision, one-pass and outcome tests where they do not depend on the old store: one source
// opens one decision, a decision is made when every row of its method has an answer, a decision needs its fields, a known
// option and its own evidence, a new decision needs a failed result first, and the records keep the old store's layout.
import { rightsOf } from '../../../test-helpers/run-a-row.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addDecisionEvidence, caseIdFor, endDecisions, makeTheDecision, reportADecisionResult, sayWhatWasDone, startADecision } from '../read-data/decisions.mjs';
import { shareADecision } from '../read-data/share-a-decision.mjs';
import { joinDecision, readDecision, recordsOf, writeDecision } from '../read-data/decision-records.mjs';
import { similarDecisions } from '../read-data/similar-decisions.mjs';
import { caseView, memoryDoor, METHOD_VIEW, STEP_ROW, refsOfCase, run, heldOf } from './fixtures.mjs';
import { account, answerAll, seedSteps } from './old-engine-for-tests.mjs';
import { methodAnswered, recordMethodAnswers } from '../method-rows/answers.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const rows = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records.map(row => row.payload);
// The largest record the store holds, measured as the record alone (its id, type and value as JSON). A change's own list also
// carries the `expected` each record is checked against, so the store's records are what a record's size is measured on.
const storedRecordBytes = door => Math.max(...[...door.records].map(([id, kept]) => Buffer.byteLength(JSON.stringify({ id, type: kept.type, value: kept.value }))));

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
  const { case_id: id } = await run(door, startADecision, opened);
  await seedSteps(door, id, ['scope', 'outcome', 'proof']);
  const kept = await answerAll(door, id);
  assert.equal(kept.refused.length, 0, 'every answer is recorded');
  return id;
}

// The answers a decision holds for the rows of its method.
const methodAnsweredCount = (door, id) => methodAnswered(heldOf(door), id, METHOD_VIEW).answered;

test('one source opens one decision: the same input is that decision, different input is refused', async () => {
  const door = account();
  const first = await run(door, startADecision, opened);
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
  assert.equal((await run(door, startADecision, opened)).case_id, first.case_id);
  await assert.throws(() => run(door, startADecision, { ...opened, goal: 'Something else entirely' }), /already has decision/);
  await assert.throws(() => run(door, startADecision, { ...opened, options: [opened.options[0]] }), /at least two options/);
  await assert.throws(() => run(door, startADecision, { ...opened, source_id: 'x', evidence: [{ ref: 'e1', claim: 'a' }, { ref: 'e1', claim: 'b' }] }), /unique ref/);
  await assert.throws(() => run(memoryDoor(), startADecision, opened), /There is no saved method/);
  await assert.throws(() => run(door, startADecision, { ...opened, source_id: 'y', method: 'list-view:method-rows:nowhere' }), /There is no saved method/);
});

test('a decision needs every question, its fields, a known option and the decision\'s own evidence', async () => {
  const door = account();
  const { case_id: early } = await run(door, startADecision, { ...opened, source_id: 'chat:early' });
  await assert.throws(() => run(door, makeTheDecision, { decision_id: early, decision }), /has 3 of its 3 rows without an answer, the first of them record:method-row:universal-steps~%2Foutcome/);
  await answerAll(door, early, { steps: ['scope'] });
  await assert.throws(() => run(door, makeTheDecision, { decision_id: early, decision }), /has 2 of its 3 rows without an answer/, 'one row answered leaves the rest to answer');
  const id = await answered(door);
  const { next_action: _next, ...withoutField } = decision;
  await assert.throws(() => run(door, makeTheDecision, { decision_id: id, decision: withoutField }), /Decision needs/);
  await assert.throws(() => run(door, makeTheDecision, { decision_id: id, decision: { ...decision, option_id: 'maybe' } }), /unknown option \("maybe"\)/);
  await assert.throws(() => run(door, makeTheDecision, { decision_id: id, decision: { ...decision, evidence_refs: ['nowhere'] } }), /must cite existing evidence/);
  const made = await run(door, makeTheDecision, { decision_id: id, decision, usage: { model_calls: 3 } });
  assert.equal(made.decision.option_id, 'raise');
  assert.match(made.resume.instruction, /Email the families the new price/);
  assert.match(made.ai_instructions[0], /tool:say-what-was-done with decision_id/);
  const root = caseView(door, id);
  assert.equal(root.status, 'needs_outcome');
  assert.equal(root.decision_generation, 1);
  assert.deepEqual(root.decision_usage, { model_calls: 3 });
  assert.equal((await run(door, makeTheDecision, { decision_id: id, decision })).already_decided, true);
  await assert.throws(() => run(door, makeTheDecision, { decision_id: id, decision: { ...decision, option_id: 'keep' } }), /needs a failed result/);
});

test('a result is the person\'s; a failed one opens the decision for a new one, and the first is kept', async () => {
  const door = account();
  const id = await answered(door);
  await assert.throws(() => run(door, reportADecisionResult, { decision_id: id, result: 'met', summary: 'It worked', answered_by: 'agent' }), /Ask your person/);
  await assert.throws(() => run(door, reportADecisionResult, { decision_id: id, result: 'met', summary: 'It worked', answered_by: 'person' }), /no decision yet/);
  await run(door, makeTheDecision, { decision_id: id, decision });
  const failed = await run(door, reportADecisionResult, { decision_id: id, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' });
  assert.equal(failed.status, 'correction_needed');
  assert.equal(failed.report.attribution_basis, 'caller_claim', 'nothing here marks a report verified by a trusted source');
  assert.equal((await run(door, reportADecisionResult, { decision_id: id, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' })).repeated, true);
  const second = await run(door, makeTheDecision, { decision_id: id, decision: { ...decision, option_id: 'keep', reason: 'Families left at the higher price' } });
  assert.equal(second.decision.option_id, 'keep');
  const root = caseView(door, id);
  assert.equal(root.decision_generation, 2);
  assert.equal(root.decision_history.length, 1);
  assert.equal(root.decision_history[0].decision.option_id, 'raise');
  const met = await run(door, reportADecisionResult, { decision_id: id, result: 'met', summary: 'Twelve families signed up', answered_by: 'person' });
  assert.equal(met.status, 'needs_outcome', 'a person\'s claim alone never verifies the outcome');
  await assert.throws(() => run(door, reportADecisionResult, { decision_id: id, result: 'met', summary: 'x', answered_by: 'person', observed_at: '2999-01-01T00:00:00Z' }), /at or before now/);
});

test('saying what was done keeps it with the decision generation it carried out', async () => {
  const door = account();
  const id = await answered(door);
  await run(door, makeTheDecision, { decision_id: id, decision });
  await assert.throws(() => run(door, sayWhatWasDone, { decision_id: id, state: 'maybe', what_happened: 'x' }), /Say state/);
  const said = await run(door, sayWhatWasDone, { decision_id: id, state: 'done', what_happened: 'Sent the email to all twelve families', by: 'test-agent' });
  assert.equal(said.carried_out.decision_generation, 1);
  assert.equal((await run(door, makeTheDecision, { decision_id: id, decision })).carried_out, true);
});

test('a decision kept whole is laid apart at its next change, its calls kept as records of their own, its root written last', async () => {
  const door = account();
  const id = caseIdFor('chat:whole');
  const calls = Array.from({ length: 300 }, (_, n) => ({ route: 'guide', accepted: true, at: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`, submission: { secret: 'never kept' } }));
  door.put(id, 'decision', { id, source_id: 'chat:whole', input: { ...opened, source_id: 'chat:whole' }, method: legacyMethod(), status: 'needs_decision', decision: null, created_at: '2026-01-01T00:00:00.000Z', guidance: [{ step_id: 'scope', answer: scope, answered_at: '2026-01-01T00:00:01.000Z' }], calls });
  await run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] });
  const root = caseView(door, id);
  assert.equal(root.guidance, undefined);
  assert.equal(root.calls, undefined);
  assert.equal(root.call_count, 300);
  assert.deepEqual(root.answered_steps.map(stub => stub.step_id), ['scope']);
  assert.deepEqual(root.input.evidence.map(row => row.ref), ['e1', 'e2', 'e3'], 'its evidence is laid apart too');
  assert.equal(door.value(id).input.evidence, undefined);
  assert.equal(door.value(id).method, undefined);
  assert.equal(root.method.id, 'plain', 'its method snapshot is kept once, beside it');
  assert.ok(storedRecordBytes(door) <= settings.record_bytes, 'every record the case holds is under record_bytes');
  assert.equal(door.value(`decision-call:${id}:000299`).route, 'guide');
  assert.equal(door.value(`decision-call:${id}:000000`).submission, undefined, 'a call keeps no payload');
  assert.deepEqual(door.writes.at(-1).ids.slice(-2), [`decision-revision:${id}`, id], 'the revision and then the root are written after their parts');
});

// Every record kind a decision is laid out in (read-data/decision-records.mjs).
const decisionKinds = ['decision', 'decision-step', 'decision-call', ...Object.values(settings.records.laid_apart).map(list => list.type), settings.records.method, settings.records.part.type, settings.records.refs, settings.records.record_revision.type];


test('a decided decision is shared only after the plain pass and a re-identification verdict bound to its exact words', async () => {
  const door = account();
  const never_publish = ['pottery camp'];
  const id = await answered(door);
  await assert.throws(() => run(door, shareADecision, { never_publish, decision_id: id }), /no decision yet/);
  await run(door, makeTheDecision, { decision_id: id, decision });
  const asked = await run(door, shareADecision, { never_publish, decision_id: id });
  assert.equal(asked.next, 'rewrite');
  assert.equal(asked.facts.goal, 'Decide the [removed] price for spring', 'the person\'s never-publish phrase is redacted before the AI rewrites');
  assert.deepEqual(asked.shape.map(field => field.name), ['situation', 'options', 'chosen', 'why', 'measured_by']);
  const rewrite = { situation: 'Someone running a small seasonal class weighed raising its price after their costs went up.', options: ['Keep the price', 'Raise the price'], chosen: 'Raise the price', why: 'Costs went up and most people still came.', measured_by: 'About as many sign ups as last season.' };
  await assert.throws(() => run(door, shareADecision, { never_publish, decision_id: id, rewrite: { ...rewrite, why: 'The pottery camp costs went up.' } }), /could still point to someone: \[removed\]/);
  await assert.throws(() => run(door, shareADecision, { never_publish, decision_id: id, rewrite: { ...rewrite, measured_by: 'Twelve families by 2027.' } }), /could still point to someone: \[removed\]/, 'a refusal never repeats the detail it found');
  await assert.throws(() => run(door, shareADecision, { never_publish, decision_id: id, rewrite: { situation: 'A class price.' } }), /A rewrite is/);
  const check = await run(door, shareADecision, { never_publish, decision_id: id, rewrite });
  assert.equal(check.next, 'check');
  assert.equal(check.check.tool, settings.share.check_tool);
  assert.deepEqual(check.check.rubric, settings.share.reidentification);
  assert.match(check.check.input_identity, /^blake3:[0-9a-f]{64}$/);
  // A verdict about other words, or one that was not accepted, is not this rewrite's.
  const other = await run(door, shareADecision, { never_publish, decision_id: id, rewrite, reidentification: { accepted: true, review_binding: { input_identity: `blake3:${'0'.repeat(64)}` } } });
  assert.equal(other.next, 'check');
  const rejected = await run(door, shareADecision, { never_publish, decision_id: id, rewrite, reidentification: { accepted: false, review_binding: { input_identity: check.check.input_identity } } });
  assert.equal(rejected.next, 'check');
  assert.equal(caseView(door, id).shared, undefined, 'nothing is kept as shared before an accepted verdict for these words');
  const shared = await run(door, shareADecision, { never_publish, decision_id: id, rewrite, reidentification: { accepted: true, review_binding: { input_identity: check.check.input_identity } } });
  assert.deepEqual(shared.send, { tool: settings.share.pool_tool, entry: rewrite });
  assert.equal(caseView(door, id).shared.review_identity, check.check.input_identity);
  const changed = await run(door, shareADecision, { never_publish, decision_id: id, rewrite: { ...rewrite, why: 'Costs rose and most people still came.' } });
  assert.notEqual(changed.check.input_identity, check.check.input_identity, 'the verdict binds exactly the words it reviewed');
});

test('sharing needs the never-publish list handed in: a call without it, or with a malformed one, is refused, and an empty list goes through', async () => {
  const door = account();
  const id = await answered(door);
  await run(door, makeTheDecision, { decision_id: id, decision });
  await assert.throws(() => run(door, shareADecision, { decision_id: id }), /Sharing needs never_publish/, 'a missing list is refused, not read as empty');
  await assert.throws(() => run(door, shareADecision, { decision_id: id, never_publish: 'pottery camp' }), /Sharing needs never_publish/);
  await assert.throws(() => run(door, shareADecision, { decision_id: id, never_publish: [''] }), /Sharing needs never_publish/);
  const asked = await run(door, shareADecision, { decision_id: id, never_publish: [] });
  assert.equal(asked.next, 'rewrite', 'an empty list means the caller read it and it is empty');
});

test('a never-publish word the decision holds is redacted, and a rewrite that keeps it is refused', async () => {
  const door = account();
  const id = await answered(door);
  await run(door, makeTheDecision, { decision_id: id, decision });
  const never_publish = ['pottery camp'];
  const asked = await run(door, shareADecision, { decision_id: id, never_publish });
  assert.equal(asked.facts.goal, 'Decide the [removed] price for spring');
  const rewrite = { situation: 'Someone running a small seasonal class weighed raising its price.', options: ['Keep the price', 'Raise the price'], chosen: 'Raise the price', why: 'The pottery camp costs went up.', measured_by: 'About as many sign ups as last season.' };
  await assert.throws(() => run(door, shareADecision, { decision_id: id, never_publish, rewrite }), /could still point to someone: \[removed\]/);
});

test('sharing reads only the decision and the never_publish list it is handed, and packs the tools it imports', () => {
  const row = rows.find(each => each.id === 'tool:share-a-decision');
  assert.deepEqual(rightsOf(row), [], 'the row reads no store: what it reads is handed in');
  assert.deepEqual(row.input_schema.required, ['decision_id', 'never_publish']);
  assert.equal(row.input_schema.properties.never_publish.type, 'array');
  const packed = row.invoke.files.package_files.flatMap(item => [item.package ?? item.module, ...(item.packages ?? []).map(name => name.replace(/^node_modules\//, ''))]);
  for (const name of ['decide-with-a-method', 'learn-from-everyones-results', 'ask-a-small-model-for-a-verdict', 'content-identity', '@noble/hashes']) assert.ok(packed.includes(name), name);
});

test('two evidence adds to one case at the same time both land', async () => {
  const door = account();
  const { case_id: id } = await run(door, startADecision, opened);
  const [first, second] = await Promise.all([
    run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] }),
    run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e4', claim: 'The seller agreed to a trial week' }] }),
  ]);
  assert.equal(first.added.length + second.added.length, 2);
  const refs = caseView(door, id).input.evidence.map(row => row.ref);
  assert.ok(refs.includes('e3') && refs.includes('e4'), `both rows are kept: ${refs}`);
});

test('an evidence add of eight rows lands as eight single adds do, with refs long enough to make a long record key', async () => {
  const rows = Array.from({ length: 8 }, (_, n) => ({ ref: `ref-${n}-${'pottery-kiln-cost-record-'.repeat(2)}${n}`, claim: `Claim ${n}: ${'the kiln bill for this spring was higher than last spring '.repeat(3)}` }));
  const batch = account();
  const { case_id: id } = await run(batch, startADecision, opened);
  const one = await run(batch, addDecisionEvidence, { decision_id: id, evidence: rows });
  assert.equal(one.added.length, 8);
  const singles = account();
  assert.equal((await run(singles, startADecision, opened)).case_id, id);
  for (const row of rows) await run(singles, addDecisionEvidence, { decision_id: id, evidence: [row] });
  const kept = view => caseView(view, id).input.evidence.map(({ ref, claim }) => ({ ref, claim }));
  assert.deepEqual(kept(batch), kept(singles), 'the case keeps the same rows either way');
  assert.equal(caseView(batch, id).input.evidence.length, caseView(singles, id).input.evidence.length);
});

test('evidence added at any time is kept with when it came in, the same start still opens that decision, and an answer may cite the new evidence', async () => {
  const door = account();
  const { case_id: id } = await run(door, startADecision, opened);
  const citing = { row: STEP_ROW('scope'), answer: 'A made-up answer that rests on the second family request', evidence_refs: ['e1', 'e3'] };
  const early = await run(door, recordMethodAnswers, { decision_id: id, method: METHOD_VIEW, answers: [citing] });
  assert.deepEqual([early.recorded.length, early.refused.length], [0, 1], 'evidence not yet added cannot be cited');
  const added = await run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] });
  assert.equal(added.evidence, 3);
  assert.equal(added.added.length, 1);
  assert.ok(added.added[0].added_at, 'the row keeps when it came in');
  assert.equal(caseView(door, id).input.evidence[0].added_at, undefined, 'evidence the decision started with keeps no time of its own');
  assert.equal((await run(door, startADecision, opened)).case_id, id, 'the same start is still that decision after evidence is added');
  await assert.throws(() => run(door, startADecision, { ...opened, goal: 'Something else entirely' }), /already has decision/);
  const again = await run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] });
  assert.equal(again.replayed, true);
  await assert.throws(() => run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e3', claim: 'Something else' }] }), /its own ref/);
  await assert.throws(() => run(door, addDecisionEvidence, { decision_id: id, evidence: [] }), /from 1 to 64/);
  await assert.throws(() => run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e4' }] }), /needs a ref and either a claim/);
  const next = await run(door, recordMethodAnswers, { decision_id: id, method: METHOD_VIEW, answers: [citing] });
  assert.deepEqual([next.recorded.length, next.refused.length], [1, 0], 'the evidence once added can be cited');
});

test('an evidence row can be brought in from another of the person\'s decisions: copied as it stood, with where it came from', async () => {
  const door = account();
  const source = await answered(door);
  const { case_id: id } = await run(door, startADecision, { ...opened, source_id: 'chat:pottery-2', evidence: [{ ref: 'e1', claim: opened.evidence[0].claim }] });
  const bringing = await run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e9', from: { decision_id: source, ref: 'e1' } }] });
  assert.deepEqual(bringing.added[0].from, { decision_id: source, ref: 'e1' });
  assert.equal(bringing.added[0].claim, opened.evidence[0].claim);
  await assert.throws(() => run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e9', from: { decision_id: source, ref: 'missing' } }] }), /no evidence missing/);
  await assert.throws(() => run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e8', from: { decision_id: id, ref: 'e1' } }]  }), /revise it instead/);
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
  await run(door, makeTheDecision, { decision_id: id, decision });
  await run(door, reportADecisionResult, { decision_id: id, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' });
  await run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] });
  const old = asOldRoot(door, id);
  door.put(id, 'decision', { id: id, ...old, original_input: opened, cited_pursuits: { 'pursuit:camp': 'Keep the camp running: now Losing money; should be Covering costs' } });
  assert.equal(door.value(id).input.evidence.length, 3, 'the old root holds its evidence');
  assert.equal(door.value(id).answered_steps.length, 3);

  assert.equal((await readDecision(heldOf(door), id, ['scope'])).guidance[0].step_id, 'scope', 'it reads as it is');
  assert.equal((await run(door, startADecision, opened)).case_id, id, 'its original input still opens it');
  door.writes.length = 0;
  await run(door, makeTheDecision, { decision_id: id, decision: { ...decision, option_id: 'keep', evidence_refs: ['e3'] } });
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
  assert.deepEqual(door.writes.at(-1).ids.at(-1), id, 'the root is in the last write');
  const view = caseView(door, id);
  assert.equal(view.decision.option_id, 'keep');
  assert.equal(view.decision_history.length, 1);
  assert.equal((await run(door, startADecision, opened)).case_id, id, 'the identity of its original input is kept');
  await assert.throws(() => run(door, startADecision, { ...opened, goal: 'Something else entirely' }), /already has decision/);
});

test('a decision of any size fits: every record stays under record_bytes, and the root does not grow', async t => {
  const door = memoryDoor();
  const names = Array.from({ length: 43 }, (_, n) => `part-${String(n).padStart(2, '0')}`);
  account({ door, steps: names });
  for (let n = 0; n < 30; n += 1) door.put(`pursuit:p${n}`, 'pursuit', { title: `Made-up pursuit ${n} with a long title for the test`, now: 'Where it stands now in plain words', after: 'Where it should end up in plain words', status: 'active' });
  const claim = n => `Made-up fact ${n}: a measured detail about the synthetic placement, its owner, its cost and its timing, written out at length so the case grows.`;
  const start = { source_id: 'chat:big', goal: 'Decide where the made-up service is placed', evidence: Array.from({ length: 300 }, (_, n) => ({ ref: `e${n + 1}`, claim: claim(n) })), options: opened.options };
  const { case_id: id } = await run(door, startADecision, start);
  const pursuits = Array.from({ length: 30 }, (_, p) => `pursuit:p${p}`);
  const recorded = await answerAll(door, id, { steps: names, ref: 'e1' });
  assert.equal(recorded.refused.length, 0);
  for (let call = 0; call < 4; call += 1) {
    const evidence = Array.from({ length: 50 }, (_, n) => ({ ref: `added-${call}-${n}`, claim: claim(1000 + call * 50 + n) }));
    await run(door, addDecisionEvidence, { decision_id: id, evidence });
  }
  for (let round = 0; round < 3; round += 1) {
    await run(door, makeTheDecision, { decision_id: id, decision: { ...decision, option_id: round % 2 ? 'keep' : 'raise', evidence_refs: ['e1', ...pursuits] } });
    for (let n = 0; n < 4; n += 1) await run(door, sayWhatWasDone, { decision_id: id, state: 'done', what_happened: `Round ${round} step ${n}: ${'what was done, in long made-up words. '.repeat(100)}` });
    await run(door, reportADecisionResult, { decision_id: id, result: 'failed', summary: `Round ${round} did not work: ${'the made-up measure was missed. '.repeat(20)}`, answered_by: 'person' });
  }
  const made = await run(door, makeTheDecision, { decision_id: id, decision: { ...decision, evidence_refs: ['e1', 'added-3-49'] } });
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
  assert.ok(total > settings.record_bytes, `the case is larger than one record (${total} bytes)`);
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
  assert.deepEqual(synchronous, await readDecision(heldOf(door), id, []));
  assert.equal(synchronous.input.evidence.length, 500);
  t.diagnostic(`case ${total} bytes; largest record by type ${JSON.stringify(largest)}`);
});

test('an earlier decision laid apart comes back as similar with its chosen option and its result', async () => {
  const door = account();
  const first = await answered(door);
  await run(door, makeTheDecision, { decision_id: first, decision });
  await run(door, reportADecisionResult, { decision_id: first, result: 'failed', summary: 'Only four families signed up', answered_by: 'person' });
  const { case_id: second } = await run(door, startADecision, { ...opened, source_id: 'chat:pottery-again' });
  const { similar_decisions: found } = await run(door, similarDecisions, { decision_id: second });
  assert.deepEqual(found.map(item => [item.case_id, item.decision, item.status, item.reported.length]), [[first, 'Raise the price', 'correction_needed', 1]]);
});

test('options stay on the root, bounded at start: too many or too long is refused with the limit', async () => {
  const door = account();
  const many = Array.from({ length: settings.options.most + 1 }, (_, n) => ({ id: `o${n}`, label: `Option ${n}` }));
  await assert.throws(() => run(door, startADecision, { ...opened, source_id: 'chat:many', options: many }), new RegExp(`at most ${settings.options.most} options, ${settings.options.most_bytes} bytes.*group similar options`));
  const long = [{ id: 'a', label: 'A long made-up option label. '.repeat(400) }, { id: 'b', label: 'B' }];
  await assert.throws(() => run(door, startADecision, { ...opened, source_id: 'chat:long', options: long }), /shorten their labels/);
  const most = Array.from({ length: settings.options.most }, (_, n) => ({ id: `o${n}`, label: `Option ${n}` }));
  const { case_id: id } = await run(door, startADecision, { ...opened, source_id: 'chat:most', options: most });
  assert.deepEqual(door.value(id).input.options, most);
});

test('a root written while options were laid apart reads them back and folds them into the root at its next change', async () => {
  const door = account();
  const { case_id: id } = await run(door, startADecision, opened);
  const root = door.value(id);
  const { options, ...input } = root.input;
  options.forEach((option, n) => door.put(`decision-option:${id}:${String(n).padStart(3, '0')}`, 'decision-option', option));
  door.put(id, 'decision', { id: id, ...root, input, counts: { ...root.counts, options: options.length } });
  await run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] });
  const folded = door.value(id);
  assert.deepEqual(folded.input.options, opened.options, 'its options are back on the root');
  assert.equal(folded.counts.options, undefined);
  assert.equal(door.value(`decision-option:${id}:000`), null, 'and their records are removed');
  assert.equal((await run(door, startADecision, opened)).case_id, id, 'the same start is still that decision');
});

test('ending decisions keeps every field they had, adds what they were, when, who and why, and deletes nothing', async () => {
  const door = memoryDoor();
  const a = 'source:camp-a', b = 'source:camp-b';
  const first = { id: a, status: 'needs_outcome', goal: 'Pick a made-up venue', decision: { option_id: 'venue-1', reason: 'It was closer.' }, carried_out: [{ state: 'done', what_happened: 'Booked it.' }], answered_steps: [{ step_id: 'scope' }] };
  const second = { id: b, status: 'invalid_source', goal: 'A made-up goal' };
  door.put(a, 'decision', first);
  door.put(b, 'decision', second);
  const count = door.records.size;
  const answer = await run(door, endDecisions, { decisions: [{ decision_id: a, because: 'No one will carry it on.' }, { decision_id: b, because: 'Its source was never valid.' }], by: 'test-agent' });
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
  const again = await run(door, endDecisions, { decisions: [{ decision_id: a, because: 'Again.' }, { decision_id: b, because: 'Again.' }], by: 'test-agent' });
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
  const answer = await run(door, endDecisions, { decisions: kept.map(value => ({ decision_id: value.id, because: 'Tidying.' })), by: 'test-agent' });
  assert.equal(answer.ended, 0);
  assert.equal(answer.not_ended, 3);
  for (const [n, item] of answer.decisions.entries()) {
    assert.equal(item.ended, false);
    assert.equal(item.status, statuses[n]);
    assert.deepEqual(door.value(kept[n].id), kept[n], 'unchanged');
  }
  assert.equal(door.writes.length, 0);
});

test('an ending whose decision changed after it was read is refused whole: nothing ends, and a missing decision is not there', () => {
  const door = memoryDoor();
  door.put('source:camp-a', 'decision', { id: 'source:camp-a', status: 'needs_outcome', goal: 'A made-up goal' });
  door.put('source:camp-b', 'decision', { id: 'source:camp-b', status: 'needs_outcome', goal: 'Another made-up goal' });
  const answer = endDecisions({ records: door.all(), decisions: [{ decision_id: 'source:camp-a', because: 'Done with it.' }, { decision_id: 'source:camp-b', because: 'Done with it.' }, { decision_id: 'source:camp-missing', because: 'Done with it.' }], by: 'test-agent' });
  assert.deepEqual(answer.decisions.map(item => item.ended), [true, true, false]);
  assert.equal(answer.decisions[2].reason, 'No decision has that id.');
  assert.equal(answer.ended, 2);
  assert.equal(answer.not_ended, 1);
  // Another writer changes one of them after this ending read it: the store refuses the whole ending, as it refuses any change whose expected record moved.
  door.put('source:camp-b', 'decision', { status: 'decided', goal: 'Changed by another writer' });
  assert.throws(() => door.write(answer.keep), { code: 'original_command_conflict' });
  assert.equal(door.value('source:camp-a').status, 'needs_outcome', 'nothing is ended');
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
  for (const input of bad) await assert.throws(() => run(door, endDecisions, input), /Name 1 to 256 decisions/);
  assert.equal(door.writes.length, 0);
});

// A made-up decision in the old layout: its evidence rows, its method snapshot and its answered steps inline on a root of
// about 70 KB, larger than one record (`record_bytes`).
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

test('a decision whose root is too large for one record is ended whole, beside a small one', async () => {
  const door = memoryDoor();
  const big = 'source:old-large', small = 'source:camp-small';
  const root = oldLargeRoot(big);
  const size = Buffer.byteLength(JSON.stringify(root));
  assert.ok(size > 65000 && size < 80000, `the root is about 70 KB (${size})`);
  door.put(big, 'decision', root);
  putOldSteps(door, big);
  door.put(small, 'decision', { id: small, status: 'needs_outcome', goal: 'A made-up goal' });
  const answer = await run(door, endDecisions, { decisions: [{ decision_id: big, because: 'No one will carry it on.' }, { decision_id: small, because: 'Done with it.' }], by: 'test-agent' });
  assert.equal(answer.ended, 2);
  assert.deepEqual(answer.decisions.map(item => item.ended), [true, true]);
  assert.equal(answer.decisions[0].previous_status, 'needs_outcome');
  assert.equal(door.writes.length, 1, 'both endings are one write');
  const view = caseView(door, big);
  assert.equal(view.status, 'ended');
  assert.equal(view.previous_status, 'needs_outcome');
  assert.equal(view.ended_by, 'test-agent');
  assert.equal(view.ended_because, 'No one will carry it on.');
  assert.equal(view.input.goal, root.input.goal);
  assert.deepEqual(view.input.evidence.map(row => row.claim), root.input.evidence.map(row => row.claim));
  assert.deepEqual(view.answered_steps.map(step => step.step_id), root.answered_steps.map(step => step.step_id));
  assert.equal(door.value(small).status, 'ended');
});

test('a large decision that changed after it was read is not ended, and nothing of it is written', () => {
  const door = memoryDoor();
  const big = 'source:old-large';
  door.put(big, 'decision', oldLargeRoot(big));
  putOldSteps(door, big);
  const answer = endDecisions({ records: door.all(), decisions: [{ decision_id: big, because: 'Done with it.' }], by: 'test-agent' });
  assert.equal(answer.decisions[0].ended, true);
  door.put(big, 'decision', { id: big, ...oldLargeRoot(big), status: 'decided' });
  const writes = door.writes.length;
  const records = door.records.size;
  assert.throws(() => door.write(answer.keep), { code: 'original_command_conflict' });
  assert.equal(door.writes.length, writes, 'nothing was written');
  assert.equal(door.records.size, records);
  assert.equal(door.value(big).status, 'decided', 'the other writer\'s value is kept');
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

test('an old-layout root whose one evidence claim is about 67 KB ends whole, losing nothing', async () => {
  const door = memoryDoor();
  const id = 'source:old-huge-claim';
  const root = oldRootWithHugeClaim(id);
  const claimBytes = Buffer.byteLength(JSON.stringify(root.input.evidence[0].claim));
  assert.ok(claimBytes > 67000 && claimBytes < 68500, `the claim is about 67 KB (${claimBytes})`);
  door.put(id, 'decision', root);
  const answer = await run(door, endDecisions, { decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' });
  assert.equal(answer.ended, 1);
  const view = caseView(door, id);
  assert.equal(view.status, 'ended');
  assert.equal(view.previous_status, 'needs_decision');
  assert.deepEqual(view.input.evidence, root.input.evidence, 'both claims, word for word');
  for (const field of ['goal', 'options', 'source_id', 'method']) assert.deepEqual(view.input[field], root.input[field], `input.${field}`);
  for (const field of ['source_id', 'created_at', 'scratchpad', 'checks', 'actions']) assert.deepEqual(view[field], root[field], field);
  assert.deepEqual(view.method, root.method);
});

test('a single evidence row of any size, added to a decision, is kept in records that each fit record_bytes, and ends whole', async () => {
  const door = account();
  const { case_id: id } = await run(door, startADecision, opened);
  const line = n => `Row ${n}: "quoted \\ slashed" — naïve café 🏕️🙂 日本語\n\t{"nested": "\\"json\\""}\n`;
  let claim = '';
  for (let n = 0; claim.length < 250000; n += 1) claim += line(n);
  await run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e3', claim }] });
  const answer = await run(door, endDecisions, { decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' });
  assert.equal(answer.ended, 1);
  assert.ok(storedRecordBytes(door) <= settings.record_bytes, 'every record the case holds is under record_bytes');
  const view = caseView(door, id);
  assert.equal(view.status, 'ended');
  assert.deepEqual(view.input.evidence, [...opened.evidence, { ...view.input.evidence[2], ref: 'e3', claim }], 'every claim word for word');
});

// A made-up old-layout root of the shape measured on a real account: one field, `method_history`, far larger than the
// record_bytes (here about 300 KB, with quotes and characters past ASCII), beside small fields of a few hundred bytes each.
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

test('an old-layout root with a 300 KB field is ended as it was read, and reads back the same', async () => {
  const door = memoryDoor();
  const id = 'source:old-history';
  const root = oldRootWithLargeField(id);
  const size = Buffer.byteLength(JSON.stringify(root.method_history));
  assert.ok(size > 280000 && size < 340000, `the field is about 300 KB (${size})`);
  door.put(id, 'decision', root);
  const answer = await run(door, endDecisions, { decisions: [{ decision_id: id, because: 'No one will carry it on.' }], by: 'test-agent' });
  assert.equal(answer.decisions[0].ended, true);
  assert.equal(answer.decisions[0].previous_status, 'needs_outcome');
  assert.ok(door.writes.length > 0);
  const kept = door.value(id);
  assert.equal(kept.fields_in_parts, undefined, 'an ending keeps the root as it was read: no field is laid apart');
  for (const field of ['id', 'status', 'previous_status', 'ended_at', 'ended_by', 'ended_because', 'created_at', 'source_id', 'decision']) assert.ok(field in kept, `${field} stays on the root`);
  const view = caseView(door, id);
  assert.deepEqual(view.method_history, root.method_history);
  assert.equal(view.fields_in_parts, undefined);
  const { original_input: _laidElsewhere, ...rest } = root;
  for (const [field, value] of Object.entries(rest)) {
    if (field === 'status') assert.equal(view.status, 'ended');
    else assert.deepEqual(view[field], value, `${field} reads back the same`);
  }
  assert.equal(view.previous_status, 'needs_outcome');
  const read = await readDecision(heldOf(door), id);
  assert.deepEqual(read.method_history, root.method_history, 'readDecision puts the field back');
  assert.equal(read.fields_in_parts, undefined);
  // A list that names only some fields still sees the small ones on the root.
  const listed = [];
  for await (const row of door.list({ type: 'decision', fields: ['status', 'source_id', 'decision'] })) listed.push(row.value);
  assert.deepEqual(listed, [{ status: 'ended', source_id: root.source_id, decision: root.decision }]);
  // Its next change keeps it whole: written again, it still reads back the same.
  door.writes.length = 0;
  door.write(writeDecision(heldOf(door), recordsOf(read)));
  assert.ok(storedRecordBytes(door) <= settings.record_bytes, 'the next change lays the large field into records under record_bytes');
  assert.deepEqual((await readDecision(heldOf(door), id)).method_history, root.method_history);
});

test('a root under the bound is written as before, with no fields in parts', async () => {
  const door = memoryDoor();
  const id = 'source:old-small';
  const root = { ...oldRootWithLargeField(id), method_history: [{ at: '2026-01-02T03:04:05.000Z', from: 'plain', to: 'universal', because: 'A made-up switch' }] };
  door.put(id, 'decision', root);
  const answer = await run(door, endDecisions, { decisions: [{ decision_id: id, because: 'Done with it.' }], by: 'test-agent' });
  assert.equal(answer.decisions[0].ended, true);
  const kept = door.value(id);
  assert.equal(kept.fields_in_parts, undefined);
  assert.equal(kept.root_fields_in_parts, undefined);
  assert.ok(![...door.records.keys()].some(key => key.includes(':root-fields')), 'no root-field parts are written');
  const [records] = [recordsOf(await readDecision(heldOf(door), id))];
  assert.equal(records[0].value.fields_in_parts, undefined);
  assert.ok(!records.some(record => record.id.includes(':root-fields')));
});

test('a write made from an older read of the case is refused as changed, and nothing of it is written', async () => {
  const door = account();
  const id = await answered(door);
  const records = door.all();
  const added = addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e9', claim: 'A made-up fact added late' }], records });
  door.put(`decision-revision:${id}`, 'decision-revision', { revision: 99 });
  const writes = door.writes.length;
  assert.throws(() => door.write(added.keep), { code: 'original_command_conflict' });
  assert.equal(door.writes.length, writes, 'nothing of it is written');
  assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'e9'), false, 'the late evidence is not kept');
});

test('a write too large for one record, made from an older read of the case, lands no part', async () => {
  const door = account();
  const id = await answered(door);
  const records = door.all();
  const added = addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e9', claim: 'A made-up fact. '.repeat(9000) }], records });
  assert.ok(added.keep.some(record => record.type === settings.records.part.type), 'the change is written in parts');
  door.put(`decision-revision:${id}`, 'decision-revision', { revision: 99 });
  const writes = door.writes.length;
  assert.throws(() => door.write(added.keep), { code: 'original_command_conflict' });
  assert.equal(door.writes.length, writes, 'no part of the stale change is written');
  assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'e9'), false, 'the late evidence is not kept, not even in part');
});


test('an evidence add made from a case that another add changed first is refused as changed, and a fresh read keeps both', async () => {
  const door = account();
  const { case_id: id } = await run(door, startADecision, opened);
  const late = addDecisionEvidence({ decision_id: id, evidence: [{ ref: 'e5', claim: 'A fact that came in late' }], records: door.all() });
  await run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e6', claim: 'A fact that came in at the same time' }] });
  assert.throws(() => door.write(late.keep), { code: 'original_command_conflict' });
  assert.deepEqual(caseView(door, id).input.evidence.map(row => row.ref), ['e1', 'e2', 'e6'], 'the late add is not kept');
  await run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e5', claim: 'A fact that came in late' }] });
  assert.deepEqual(caseView(door, id).input.evidence.map(row => row.ref), ['e1', 'e2', 'e6', 'e5'], 'both adds are kept once the late one is read again');
});

test('a change the store refuses as a whole leaves nothing visible: the case reads as it was before the change', async () => {
  const door = account();
  const { case_id: id } = await run(door, startADecision, opened);
  await run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e3', claim: 'Two families asked for a lower price' }] });
  const write = door.write.bind(door);
  let refused = false;
  // The store refuses the change at its root (the last record it is given) after its parts were given, so none of it lands.
  door.write = (records, options) => {
    if (!refused && records.at(-1).id === id) {
      refused = true;
      throw Object.assign(new Error('busy'), { code: 'selected_owner_unavailable' });
    }
    return write(records, options);
  };
  assert.throws(() => run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'e4', claim: 'A made-up fact. '.repeat(9000) }] }), /busy/);
  assert.equal(refused, true, 'the change was refused at its root');
  assert.deepEqual(caseView(door, id).input.evidence.map(row => row.ref), ['e1', 'e2', 'e3'], 'the refused add is not in the case');
  assert.equal((await readDecision(heldOf(door), id)).input.evidence.length, 3, 'and reads as it was');
});

test('a change refused before it lands does not move the case: a writer that read the case before it is not refused as changed', async () => {
  const door = account();
  const id = await answered(door);
  const read = door.all();
  const write = door.write.bind(door);
  door.write = records => {
    if (records.at(-1).id === id && records.some(record => record.type === settings.records.part.type)) throw Object.assign(new Error('busy'), { code: 'selected_owner_unavailable' });
    return write(records);
  };
  assert.throws(() => run(door, addDecisionEvidence, { decision_id: id, evidence: [{ ref: 'eB', claim: 'A made-up fact. '.repeat(9000) }] }), /busy/);
  door.write = write;
  const made = makeTheDecision({ decision_id: id, decision, records: read });
  assert.equal(made.decision.option_id, 'raise', 'the decision is made from the case as it was');
  door.write(made.keep);
  assert.equal(caseView(door, id).decision.option_id, 'raise', 'the other writer\'s refusal did not move the case');
  assert.equal(caseView(door, id).input.evidence.some(row => row.ref === 'eB'), false, 'the refused write is not in the case');
});

