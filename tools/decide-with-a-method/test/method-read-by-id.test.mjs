// A method and its checks are read by id, never by a scan whose cost grows with the Checks list. Over a made-up account
// whose Checks list holds 50,000 rows, starting a decision reads one row per method of its lineage (the depth of the
// method tree), a question reads one row per check its step lists as its parts, and no call lists record:check at all.
// Only a step written before it named its parts is read by `where` on its step, and only an account with no row for the
// method named nor the default lists its branch rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerADecisionQuestion, makeTheDecision, nextDecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { memoryDoor, plainChecks, plainMethod, today } from './fixtures.mjs';

const settings = JSON.parse(readFileSync(new URL('../read-data/decide-with-a-method.json', import.meta.url), 'utf8'));
const { check_row: CHECK, default_method: DEFAULT, step_parts_field: PARTS } = settings.records;
const checkType = `record:${CHECK}`;
const FILLER = 50000;

// The made-up method under the default's id, each step listing the check rows that are its parts, and two methods below
// it, so the deepest is three rows from its root.
const withParts = (method, parts) => ({ ...method, steps: method.steps.map(step => (step.kind === 'scope' ? step : { ...step, [PARTS]: parts[step.id] ?? [] })) });
const root = () => withParts({ ...plainMethod(), id: DEFAULT }, { outcome: ['outcome-before-after'], existing: ['existing-where'] });
const middle = { id: 'made-up-middle', kind: 'branch', part_of: DEFAULT, name: 'Made-up middle method' };
const deepest = { id: 'made-up-deepest', kind: 'branch', part_of: ['made-up-middle'], name: 'Made-up deepest method' };
const checks = () => plainChecks().map(row => ({ ...row, part_of: DEFAULT }));

// An account whose Checks list holds FILLER other rows (checks of other steps, other branches, rules), and a door that
// counts every row a list walks over and every read by type.
function bigAccount({ method = root(), parts = true } = {}) {
  const door = memoryDoor();
  const put = row => door.put(`${checkType}:${row.id}`, checkType, row);
  put(parts ? method : { ...method, steps: method.steps.map(({ [PARTS]: _parts, ...step }) => step) });
  put(middle);
  put(deepest);
  for (const row of checks()) put(row);
  for (let n = 0; n < FILLER; n += 1) put({ id: `made-up-filler-${n}`, kind: n % 7 ? 'check' : 'branch', part_of: `made-up-other-${n % 50}`, step: `made-up-step-${n % 40}`, check: `Made-up check ${n}?` });
  const reads = [];
  const scanned = new Map();
  const { read, list } = door;
  door.read = async (type, id) => { reads.push({ type, id }); return read(type, id); };
  door.list = async function* (query) {
    for await (const row of list(query)) { scanned.set(query.type, (scanned.get(query.type) ?? 0) + 1); yield row; }
  };
  // The records door walks every row of a type to answer a `where` on an engine without declared orders: its cost is the list's size.
  const walked = () => door.lists.filter(call => call.type === checkType).length;
  const checkReads = () => reads.filter(call => call.type === checkType).length;
  const mark = () => ({ reads: checkReads(), lists: walked() });
  return { door, reads, scanned, walked, checkReads, mark };
}

const opened = {
  source_id: 'chat:made-up-big-account', goal: 'Decide the made-up pottery camp price for spring',
  evidence: [{ ref: 'e1', claim: 'Last spring twelve made-up families signed up at the old price' }, { ref: 'e2', claim: 'The made-up kiln costs went up this year' }],
  options: [{ id: 'keep', label: 'Keep the price' }, { id: 'raise', label: 'Raise the price' }],
};
const scope = { decision_context: { worth_weighing: true, compare_existing: false }, omission_reasons: { compare_existing: { searched: ['the camp price list'], evidence_refs: ['e1'] } }, evidence_refs: ['e1'] };
const outcomeAnswer = {
  desired_result: 'Twelve families sign up at a price covering the kiln',
  current_state: 'The old price no longer covers the kiln costs',
  checklist: { 'outcome-before-after': { handled: true, how: 'Before: price below kiln costs; after: twelve families at a covering price', evidence_refs: ['e2'] } },
  evidence_refs: ['e1', 'e2'],
};
const judged = [{ check: 'outcome-before-after', meets: true, rests_on: 'e2', graded_by: 'second-judge-test' }];
const proofAnswer = { check_by: today(), measure: 'Count the spring sign ups', evidence_refs: ['e1'] };
const decision = { option_id: 'raise', reason: 'Kiln costs went up and families still came', next_action: 'Email the families the new price', success_measure: 'Twelve sign ups by May', evidence_refs: ['e1', 'e2'], who_it_changes: 'The twelve families pay a little more and keep their camp' };

test('starting a decision under the default reads its one method row by id and lists no check row of 50,000', async () => {
  const account = bigAccount();
  const started = await startADecision(opened, { door: account.door });
  assert.equal(started.question.step_id, 'scope');
  assert.equal(account.walked(), 0, 'no record:check list, so no scan of the list');
  assert.equal(account.scanned.get(checkType) ?? 0, 0, 'not one check row is walked over');
  assert.deepEqual(account.reads.filter(call => call.type === checkType).map(call => call.id), [`${checkType}:${DEFAULT}`], 'the default is read by its id, once');
});

test('starting a decision under a method three deep reads three rows, its lineage up to the root', async () => {
  const account = bigAccount();
  const started = await startADecision({ ...opened, source_id: 'chat:made-up-deep', method: deepest.id }, { door: account.door });
  assert.equal(started.question.step_id, 'scope');
  assert.equal(account.walked(), 0);
  assert.deepEqual(account.reads.filter(call => call.type === checkType).map(call => call.id), [deepest.id, middle.id, DEFAULT].map(id => `${checkType}:${id}`), 'nearest first, one read per level of the tree');
  await assert.rejects(startADecision({ ...opened, source_id: 'chat:made-up-unknown', method: 'made-up-nowhere' }, { door: account.door }), /Unknown method made-up-nowhere/);
  assert.equal(account.walked(), 0, 'a method that is not there is refused without a scan');
});

test('every call of a whole decision reads at most the depth of its method tree plus its step\'s checks, and never lists a check', async () => {
  const account = bigAccount();
  const depth = 3;
  const { door } = account;
  const call = async run => {
    const before = account.mark();
    const reply = await run();
    const after = account.mark();
    assert.equal(after.lists, before.lists, 'no call lists record:check');
    // One step asks at most its own parts; the outcome step lists one check.
    assert.ok(after.reads - before.reads <= depth + 1, `a call made ${after.reads - before.reads} check reads, more than the method's depth and its step's checks`);
    return reply;
  };
  const { case_id: id } = await call(() => startADecision({ ...opened, method: deepest.id }, { door }));
  const scoped = await call(() => answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door }));
  assert.deepEqual(scoped.question.checklist, [{ id: 'outcome-before-after', check: plainChecks()[0].check }], 'the step\'s check, read by its id, is asked of the method below its root');
  await call(() => nextDecisionQuestion({ decision_id: id }, { door }));
  await call(() => nextDecisionQuestion({ decision_id: id, explain: ['outcome-before-after'] }, { door }));
  await call(() => answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: outcomeAnswer, verdicts: judged }, { door }));
  const ready = await call(() => answerADecisionQuestion({ decision_id: id, step_id: 'proof', answer: proofAnswer }, { door }));
  assert.equal(ready.ready_for_decision, true);
  const made = await call(() => makeTheDecision({ decision_id: id, decision }, { door }));
  assert.equal(made.decision.option_id, 'raise');
  assert.equal(account.scanned.get(checkType) ?? 0, 0, 'over the whole decision not one of the 50,000 rows is walked over');
});

test('a step that lists no parts yet is read by where on its step, never the whole list', async () => {
  const account = bigAccount({ parts: false });
  const { case_id: id } = await startADecision(opened, { door: account.door });
  const scoped = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: scope }, { door: account.door });
  assert.deepEqual(scoped.question.checklist, [{ id: 'outcome-before-after', check: plainChecks()[0].check }]);
  assert.deepEqual(account.door.lists.filter(call => call.type === checkType), [{ type: checkType, where: { [settings.records.check_step_field]: 'outcome' } }]);
});

test('an account with no row for the method named nor the default lists its branch rows, as before', async () => {
  const door = memoryDoor();
  door.put(`${checkType}:plain`, checkType, plainMethod());
  const started = await startADecision(opened, { door });
  assert.equal(started.question.step_id, 'scope');
  assert.deepEqual(door.lists.filter(call => call.type === checkType), [{ type: checkType, where: settings.records.method_where }]);
});
