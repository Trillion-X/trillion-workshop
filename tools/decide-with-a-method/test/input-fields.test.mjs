// A call's fields are checked against its tool row's input_schema: a field the call does not declare is refused by name, and
// a field a free-form object holds that the call declares at its top level (answer.verdicts) is refused where it belongs,
// not as verdicts_missing (the answer read no verdicts there and said nothing about them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { answerADecisionQuestion, startADecision } from '../read-data/decisions.mjs';
import { account, fill, judged, settings } from './old-engine-for-tests.mjs';

const input = {
  source_id: 'input-fields', goal: 'Get the call fields checked by name',
  evidence: [{ ref: 'user-verbatim', claim: 'Check the fields a caller sends' }],
  options: [{ id: 'check', label: 'Check every field' }, { id: 'skip', label: 'Skip the check' }],
};

async function atOutcome() {
  const door = account();
  const { case_id: id, question: scope } = await startADecision(input, { door });
  const { question } = await answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: fill(scope, { refs: ['user-verbatim'] }) }, { door });
  assert.equal(question.step_id, 'outcome');
  return { door, id, question };
}

test('verdicts sent inside the answer are refused where they belong, not as verdicts_missing', async () => {
  const { door, id, question } = await atOutcome();
  const answer = { ...fill(question, { refs: ['user-verbatim'] }), verdicts: judged(question, 'user-verbatim') };
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer }, { door }), error => {
    assert.doesNotMatch(error.message, /verdicts_missing|have none taken|waiting for/, error.message);
    assert.match(error.message, /"verdicts" belongs at the top level of the call, not inside "answer"/, error.message);
    return true;
  });
});

test('a field the call does not declare is refused by name, with the fields it does declare', async () => {
  const { door, id, question } = await atOutcome();
  const answer = fill(question, { refs: ['user-verbatim'] });
  await assert.rejects(answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer, verdicts: judged(question, 'user-verbatim'), verdict_notes: 'extra' }, { door }), error => {
    assert.match(error.message, /"verdict_notes" is not a field of this call/, error.message);
    assert.match(error.message, /decision_id, step_id, answer, verdicts, usage, from, revise, confirm/, error.message);
    return true;
  });
});

// The installed run folder holds this tool's read-data and the sibling tools its code imports, and no tool-rows.json: the
// installed copy must read its input schemas from read-data alone.
const SIBLINGS = ['ask-a-small-model-for-a-verdict', 'check-against-a-persons-rules-and-verdicts', 'content-identity', 'learn-from-everyones-results', 'records-door'];
const SKIPPED = new Set(['test', 'tool-rows.json', 'README.md', 'node_modules']);
const notSkipped = path => !SKIPPED.has(basename(path));

test('the input schemas the code reads are the tool rows\' input schemas', async () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);
  const shipped = settings.input_schemas;
  for (const row of rows.filter(row => row.input_schema)) assert.deepEqual(shipped[row.id], row.input_schema, `${row.id} matches its row`);
  assert.equal(Object.keys(shipped).length, rows.filter(row => row.input_schema).length);
});

test('the installed copy, without tool-rows.json, runs answer-a-decision-question', async () => {
  const installed = mkdtempSync(join(tmpdir(), 'dwam-installed-'));
  try {
    const tools = new URL('../../', import.meta.url);
    const opt = join(installed, 'opt');
    mkdirSync(opt);
    symlinkSync(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(opt, 'node_modules'));
    cpSync(fileURLToPath(new URL('.', new URL('../', import.meta.url))), join(opt, 'decide-with-a-method'), { recursive: true, filter: notSkipped });
    for (const sibling of SIBLINGS) cpSync(fileURLToPath(new URL(sibling, tools)), join(opt, sibling), { recursive: true, filter: notSkipped });
    const copied = await import(pathToFileURL(join(opt, 'decide-with-a-method', 'read-data', 'decisions.mjs')).href);
    const door = account();
    const { case_id: id, question: scope } = await copied.startADecision(input, { door });
    const { question } = await copied.answerADecisionQuestion({ decision_id: id, step_id: 'scope', answer: fill(scope, { refs: ['user-verbatim'] }) }, { door });
    assert.equal(question.step_id, 'outcome');
    await assert.rejects(copied.answerADecisionQuestion({ decision_id: id, step_id: 'outcome', answer: { ...fill(question, { refs: ['user-verbatim'] }), verdicts: judged(question, 'user-verbatim') } }, { door }), /"verdicts" belongs at the top level/);
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});
