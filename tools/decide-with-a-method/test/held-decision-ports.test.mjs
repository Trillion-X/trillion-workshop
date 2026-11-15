import test from 'node:test';
import assert from 'node:assert/strict';
import { answerWords } from '../read-data/answer-words.mjs';
import { decisionNotice, decisionEvent } from '../read-data/decision-notice.mjs';
import { freeDecisionRequest, openRun, sealRun, runStore } from '../read-data/free-run.mjs';
import { methodCatalogue } from '../read-data/method.mjs';
import { account, fill, judged } from './old-engine-for-tests.mjs';
import { plainMethod } from './fixtures.mjs';

const methods = [plainMethod()];
const sealing = { roots: [new Uint8Array(32).fill(19)], person: 'synthetic-person', methods };
const opened = () => ({ source_id: 'synthetic:free', goal: 'Choose a sample price', method: 'plain', evidence: [{ ref: 'e1', claim: 'Sample materials cost more this year' }], options: [{ id: 'a', label: 'Keep price' }, { id: 'b', label: 'Raise price' }] });
const record = () => ({ id: 'source:c3ludGhldGljOmZyZWU', source_id: opened().source_id, input: opened(), method: methodCatalogue(methods).snapshotMethod('plain'), guidance: [], created_at: '2026-01-01T00:00:00Z' });
const rules = { decision_words: { opening: '{app} decided {question}.', opening_no_app: 'Decided {question}.', chosen: 'Chosen: {chosen}.', next: 'Next: {next_action}.', case: 'Case {case_id}.' }, decision_event: { type: 'decision.made', next_tool: 'synthetic-read-decision' } };

test('answer words retain method labels, choice/list/observer/date shapes and attribution without scope internals', () => {
  const words = answerWords({ decision: { chosen: '{value}.' }, answerers: { person: 'from you' } });
  const method = { observers: [{ id: 'person', says: '{name} checks it', fields: [{ name: 'name' }] }] };
  const rows = words.answerRows([{ name: 'items', label: 'Found', kind: 'list', item_fields: [{ name: 'label' }], says: '{label}' }, { name: 'choice', label: 'Which', kind: 'choice', choice_words: { yes: 'Keep it' } }, { name: 'on', label: 'When', kind: 'date' }, { name: 'observer', label: 'Who', kind: 'observer' }], { items: [{ label: 'A sample place' }], choice: 'yes', on: '2026-11-08', observer: { kind: 'person', name: 'Sample person' }, answered_by: { choice: 'person' } }, method);
  assert.deepEqual(rows, [{ label: 'Found', text: 'A sample place' }, { label: 'Which (from you)', text: 'Keep it' }, { label: 'When', text: 'November 8, 2026' }, { label: 'Who', text: 'Sample person checks it' }]);
  const r = record();
  r.guidance = [{ step_id: 'scope', answer: { decision_context: { worth_weighing: true } } }, { step_id: 'outcome', answer: { desired_result: 'A useful sample result', current_state: '' } }];
  assert.deepEqual(words.workedSteps(r).map(step => step.rows), [[{ label: 'Where you want it', text: 'A useful sample result' }]]);
  assert.deepEqual(words.checkRows(r, { handled: false, because: 'A sample reason' }, []), [{ label: 'Why it does not apply', text: 'A sample reason' }]);
  assert.equal(words.decisionWords('chosen', { value: 'Sample.  ' }), 'Sample.');
});

test('decision notices follow method fields and generation, narrow moves, event bound and reader refs', () => {
  const r = record();
  assert.equal(decisionNotice(r, {}, rules), null);
  r.guidance = [{ step_id: 'scope', answer: { decision_context: { worth_weighing: true } } }];
  r.decision = { option_id: 'b', reason: 'A sample reason', who_it_changes: 'Sample families', next_action: 'Tell sample families' };
  const notice = decisionNotice(r, { app: 'Sample App', from_reader: 'sample-reader' }, rules);
  assert.match(notice.said, /Chosen: Raise price/);
  assert.match(notice.said, /Who it changes beyond you: Sample families/);
  assert.equal(notice.key, `${r.id}:1`);
  assert.equal(notice.from_reader, 'sample-reader');
  r.decision_generation = 2;
  r.decision.move = 'Try a smaller price first';
  assert.match(decisionNotice(r, {}, rules).said, /Chosen: Try a smaller price first/);
  assert.equal(decisionNotice(r, {}, rules).key, `${r.id}:2`);
  const event = decisionEvent({ ...notice, said: 'x'.repeat(500) }, rules);
  assert.equal(event.summary.length, 300);
  assert.deepEqual(event.next_call, { tool: 'synthetic-read-decision', arguments: { case_id: r.id } });
});

test('free-run seal keeps only routing state, opens rotated roots, refuses another person and tampering', async () => {
  const r = record();
  r.guidance = [{ step_id: 'scope', answer: { decision_context: { worth_weighing: false }, private_answer: 'PRIVATE SAMPLE ANSWER' } }, { step_id: 'outcome', answer: { desired_result: 'PRIVATE SAMPLE RESULT' } }];
  r.scratchpad = ['PRIVATE SAMPLE NOTE'];
  const token = await sealRun(r, sealing);
  const run = await openRun(token, { ...sealing, roots: [new Uint8Array(32).fill(20), ...sealing.roots] });
  assert.deepEqual(run.guidance.map(step => step.step_id), ['scope', 'outcome']);
  assert.deepEqual(run.guidance[0].answer, { decision_context: { worth_weighing: false } });
  assert.deepEqual(run.guidance[1].answer, {});
  assert.equal(JSON.stringify(run).includes('PRIVATE SAMPLE'), false);
  assert.deepEqual(run.input.evidence, [{ ref: 'e1', claim: 'e1' }]);
  await assert.rejects(openRun(token, { ...sealing, person: 'another-person' }), /changed or belongs/);
  const bytes = Buffer.from(token.slice(4), 'base64url'); bytes[14] ^= 1;
  await assert.rejects(openRun(`run_${bytes.toString('base64url')}`, sealing), /changed or belongs/);
  await assert.rejects(openRun(token, { ...sealing, roots: [] }), /root key/);
  const store = runStore(r); const copy = await store.read(); copy.cases[r.id].input.goal = 'Changed';
  assert.notEqual(store.current().cases[r.id].input.goal, 'Changed');
});

const context = () => {
  const door = account();
  let used = 0;
  return { door, sealing, allowance: { count: 5, used: 0 }, words: { left: ({ used }) => `${5 - used} left`, keeps: 'This sample keeps nothing.', usedUp: 'Sample allowance used.', pitch: facts => `Sample choice: ${facts.chosen}` }, countDecision: async () => { used += 1; }, get counted() { return used; } };
};
const call = async (ctx, path, body) => {
  const response = await freeDecisionRequest(new Request(`https://sample.invalid${path}`, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), ctx);
  return { status: response.status, body: await response.json() };
};

test('free decision walks every question through current tools, counts once and never persists a decision', async () => {
  const ctx = context();
  let reply = await call(ctx, '/cases', opened());
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  let token = reply.body.case_id;
  assert.ok(token.startsWith('run_'));
  assert.equal(ctx.counted, 1);
  for (let n = 0; reply.body.question && n < 8; n += 1) {
    const question = reply.body.question;
    reply = await call(ctx, `/cases/${token}/guide`, { step_id: question.step_id, answer: fill(question, { refs: ['e1'] }), verdicts: judged(question, 'e1') });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    token = reply.body.case_id;
  }
  assert.equal(reply.body.question, null);
  reply = await call(ctx, `/cases/${token}/agent-decision`, { option_id: 'b', reason: 'Sample materials cost more', next_action: 'Tell sample families tomorrow', success_measure: 'Twelve sample sign ups', evidence_refs: ['e1'] });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.decision.option_id, 'b');
  assert.ok(reply.body.ai_instructions.includes('Sample choice: Raise price'));
  assert.equal(ctx.counted, 1);
  assert.equal(ctx.door.writes.length, 0);
  assert.equal([...ctx.door.records.values()].filter(row => row.type === 'decision').length, 0);
});

test('invalid answers and exhausted allowances keep no decision and consume no count', async () => {
  const ctx = context();
  let reply = await call(ctx, '/cases', { ...opened(), options: [] });
  assert.equal(reply.status, 400);
  assert.equal(ctx.counted, 0);
  ctx.allowance.count = 0;
  reply = await call(ctx, '/cases', opened());
  assert.equal(reply.status, 402);
  assert.equal(ctx.counted, 0);
  assert.equal(ctx.door.writes.length, 0);
  const questions = await call(ctx, '/cases/one-pass/questions', opened());
  assert.equal(questions.status, 200, JSON.stringify(questions.body));
  assert.equal(ctx.counted, 0);
});

test('one-pass questions and answers reuse the current method and require every verdict', async () => {
  const ctx = context();
  let result = await call(ctx, '/cases/one-pass/questions', opened());
  const scope_answer = fill(result.body.questions[0], { refs: ['e1'] });
  result = await call(ctx, '/cases/one-pass/questions', { ...opened(), scope_answer });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.questions.map(question => question.step_id), ['scope', 'outcome', 'proof']);
  const answers = result.body.questions.map(question => ({ step_id: question.step_id, answer: fill(question, { refs: ['e1'] }), verdicts: judged(question, 'e1') }));
  const decision = { option_id: 'a', reason: 'A sample low cost change', next_action: 'Tell the sample families', success_measure: 'Twelve sample families sign up', evidence_refs: ['e1'] };
  const invalid = structuredClone(answers); invalid[1].verdicts = [];
  result = await call(ctx, '/cases/one-pass', { ...opened(), answers: invalid, decision });
  assert.equal(result.status, 400);
  assert.equal(ctx.counted, 0);
  result = await call(ctx, '/cases/one-pass', { ...opened(), answers, decision });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(ctx.counted, 1);
  assert.equal(result.body.decision.option_id, 'a');
  assert.equal(ctx.door.writes.length, 0);
});

test('one-pass questions include checks named by id as well as checks of that step', async () => {
  const ctx = context();
  const method = plainMethod();
  method.steps.find(step => step.id === 'proof').check_ids = ['sample-extra-check'];
  ctx.door.put('record:check:plain', 'record:check', method);
  ctx.door.put('record:check:sample-extra-check', 'record:check', { id: 'sample-extra-check', part_of: 'plain', check: 'Is this a concrete sample check?', good_answer: 'Names a sample count' });
  let result = await call(ctx, '/cases/one-pass/questions', opened());
  const scope_answer = fill(result.body.questions[0], { refs: ['e1'] });
  result = await call(ctx, '/cases/one-pass/questions', { ...opened(), scope_answer });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.questions.find(question => question.step_id === 'proof').checklist.some(check => check.id === 'sample-extra-check'));
  assert.equal(ctx.counted, 0);
  assert.equal(ctx.door.writes.length, 0);
});

test('free evidence additions corrections and retractions retain only the live refs in the next seal', async () => {
  const ctx = context();
  let result = await call(ctx, '/cases', opened());
  result = await call(ctx, `/cases/${result.body.case_id}/evidence`, { add: [{ ref: 'e2', claim: 'A second sample fact' }], correct: [{ ref: 'e1', claim: 'A corrected sample fact' }], retract: ['e1'] });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const run = await openRun(result.body.case_id, sealing);
  assert.deepEqual(run.input.evidence, [{ ref: 'e2', claim: 'e2' }]);
  result = await call(ctx, `/cases/${result.body.case_id}/evidence`, { retract: ['e2'] });
  assert.equal(result.status, 400);
  assert.equal(ctx.counted, 1);
  assert.equal(ctx.door.writes.length, 0);
});
