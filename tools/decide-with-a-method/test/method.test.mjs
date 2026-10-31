// Ported from the old app's test/method-data.test.mjs and test/method-catalogue.test.mjs, over a made-up method: the
// method is built on its stages (every step in one stage, in order, none switchable off), a template rewords and
// presets, the default for a purpose is the row that says so, a set that does not resolve is refused whole, and turning
// a switch off takes the reason that switch asks for, with the exact shape that is taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertBackbone, methodCatalogue } from '../read-data/method.mjs';
import { plainChecks, plainMethod } from './fixtures.mjs';

const evidence = new Set(['e1']);
const opened = method => ({ id: 'd1', input: { goal: 'Pick the next training focus', evidence: [{ ref: 'e1', claim: 'The last match video' }], options: [] }, method, guidance: [] });

test('the method is built on its stages: every step sits in one stage, in order, and no stage can be switched off', () => {
  const cat = methodCatalogue([plainMethod()], plainChecks());
  const plain = cat.snapshotMethod('plain');
  assert.doesNotThrow(() => assertBackbone(plain));
  const switchable = structuredClone(plain);
  switchable.steps.find(step => step.id === 'proof').when = 'compare_existing';
  assert.throws(() => assertBackbone(switchable), /stage test can be switched off/);
  const orphan = structuredClone(plain);
  orphan.steps.push({ id: 'extra', question: 'q', fields: [] });
  assert.throws(() => assertBackbone(orphan), /step extra belongs to no stage/);
  assert.throws(() => methodCatalogue([{ ...plainMethod(), backbone: switchable.backbone, steps: switchable.steps }]), /can be switched off/, 'a set that does not resolve whole is refused');
  assert.throws(() => methodCatalogue([{ id: 'child', extends: 'nowhere' }]), /Unknown method nowhere/);
  assert.throws(() => methodCatalogue([]), /at least one method/);
});

test('the default for each purpose is the row that says so, and a template rewords questions and presets switches', () => {
  const quick = { id: 'quick', name: 'Quick', extends: 'plain', default_for: ['message'], questions: { outcome: 'What should change about this training?' }, checks: { worth_weighing: false } };
  const cat = methodCatalogue([plainMethod(), quick], plainChecks());
  assert.deepEqual(cat.listMethods().map(method => method.id), ['plain', 'quick']);
  assert.equal(cat.defaultMethodId(), 'plain');
  assert.equal(cat.defaultMethodId('message'), 'quick');
  assert.equal(cat.defaultMethodId('a purpose nobody named'), 'plain', 'an unnamed purpose uses the decision default');
  const record = opened(cat.snapshotMethod('quick'));
  const scope = cat.currentQuestion(record);
  assert.deepEqual(scope.checks.map(check => check.id), ['compare_existing'], 'a preset switch is not asked');
  record.guidance.push({ step_id: 'scope', answer: { decision_context: { compare_existing: true }, evidence_refs: ['e1'] } });
  assert.match(cat.currentQuestion(record).question, /training/);
  assert.throws(() => cat.snapshotMethod('no-such-method'), /Unknown method/);
});

test('switching a check family off takes the reason that switch itself asks for, never one sentence', () => {
  const cat = methodCatalogue([plainMethod()], plainChecks());
  const record = opened(cat.snapshotMethod('plain'));
  const [scope] = cat.stepsFor(record);
  const answer = reason => ({ decision_context: { worth_weighing: true, compare_existing: false }, omission_reasons: { compare_existing: reason }, evidence_refs: ['e1'] });
  assert.throws(() => cat.validateMethodAnswer(record, scope, answer('Not part of this choice'), evidence), /Explain why compare_existing is omitted: Where did you look/);
  assert.throws(() => cat.validateMethodAnswer(record, scope, answer({ searched: [], evidence_refs: ['e1'] }), evidence), /searched needs at least 1 item/);
  assert.throws(() => cat.validateMethodAnswer(record, scope, answer({ searched: ['coach notes'], evidence_refs: ['no-such-ref'] }), evidence), /must cite case evidence/);
  assert.doesNotThrow(() => cat.validateMethodAnswer(record, scope, answer({ searched: ['coach notes', 'last season drills'], evidence_refs: ['e1'] }), evidence));
});

test('a refused omission reason says the shape that is taken, and filling in that shape is taken', () => {
  const cat = methodCatalogue([plainMethod()], plainChecks());
  const record = opened(cat.snapshotMethod('plain'));
  const [scope] = cat.stepsFor(record);
  const sentence = { decision_context: { worth_weighing: true, compare_existing: false }, omission_reasons: { compare_existing: 'Nothing like this exists, see the match video.' }, evidence_refs: ['e1'] };
  const refusal = (() => { try { cat.validateMethodAnswer(record, scope, sentence, evidence); } catch (error) { return error; } })();
  assert.equal(refusal.problems.length, 1);
  const [, shape] = /Send omission_reasons\.compare_existing as (\{.*\})$/.exec(refusal.problems[0]);
  const fill = value => (Array.isArray(value) ? value.map(fill) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, fill(inner)]))
    : value === '<case evidence ref>' ? 'e1' : String(value).replace(/^<(.*)>$/, 'Checked for this training choice: $1'));
  assert.doesNotThrow(() => cat.validateMethodAnswer(record, scope, { ...sentence, omission_reasons: { compare_existing: fill(JSON.parse(shape)) } }, evidence));
});

test('each step carries the checks its switches turn on, and the answer schema is built from the same rows', () => {
  const cat = methodCatalogue([plainMethod()], plainChecks());
  const record = opened(cat.snapshotMethod('plain'));
  record.guidance.push({ step_id: 'scope', answer: { decision_context: { worth_weighing: true, compare_existing: true }, evidence_refs: ['e1'] } });
  assert.deepEqual(cat.stepsFor(record).map(step => step.id), ['scope', 'outcome', 'proof', 'existing']);
  const existing = cat.stepsFor(record).find(step => step.id === 'existing');
  assert.deepEqual(cat.checklistFor(record, existing).map(row => row.id), ['existing-where']);
  record.guidance.push({ step_id: 'outcome' }, { step_id: 'proof' });
  const question = cat.currentQuestion(record);
  assert.equal(question.step_id, 'existing');
  assert.deepEqual(question.answer_schema.required, ['evidence_refs', 'found', 'checklist']);
  assert.deepEqual(question.answer_schema.properties.checklist.required, ['existing-where']);
  assert.deepEqual(question.verdict_checks, ['existing-where']);
  assert.equal(question.stage.id, 'test');
  assert.ok(!JSON.stringify(question).includes('"source"'), 'where a step came from never leaves');
});

test('a check is asked of its own method and the methods extending it, never of another method with the same step', () => {
  const quick = { id: 'quick', name: 'Quick', extends: 'plain' };
  const other = { ...plainMethod(), id: 'other', default_for: [] };
  const foreign = { id: 'other-outcome', method: 'other', step: 'outcome', check: 'A check only the other method asks', good_answer: 'Anything' };
  const cat = methodCatalogue([plainMethod(), quick, other], [...plainChecks(), foreign]);
  const asked = id => {
    const record = opened(cat.snapshotMethod(id));
    record.guidance.push({ step_id: 'scope', answer: { decision_context: { worth_weighing: true, compare_existing: true }, evidence_refs: ['e1'] } });
    return cat.checklistFor(record, cat.stepsFor(record).find(step => step.id === 'outcome')).map(row => row.id);
  };
  assert.deepEqual(asked('plain'), ['outcome-before-after']);
  assert.deepEqual(asked('quick'), ['outcome-before-after'], 'an extending method asks its parent\'s checks');
  assert.deepEqual(asked('other'), ['other-outcome']);
});
