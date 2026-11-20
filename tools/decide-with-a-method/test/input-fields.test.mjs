import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { run } from './fixtures.mjs';
// A call's fields are checked against its tool row's input_schema: a field the call does not declare is refused by name, and
// a field a free-form object holds that the call declares at its top level (decision.usage) is refused where it belongs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTheDecision, startADecision } from '../read-data/decisions.mjs';
import { account, answerAll, settings } from './old-engine-for-tests.mjs';

const input = {
  source_id: 'input-fields', goal: 'Get the call fields checked by name',
  evidence: [{ ref: 'user-verbatim', claim: 'Check the fields a caller sends' }],
  options: [{ id: 'check', label: 'Check every field' }, { id: 'skip', label: 'Skip the check' }],
};

const decision = { option_id: 'check', reason: 'Fields are checked by name', next_action: 'Check them', success_measure: 'No stray field passes', evidence_refs: ['user-verbatim'] };

async function allAnswered() {
  const door = account();
  const { case_id: id } = await run(door, startADecision, input);
  await answerAll(door, id, { ref: 'user-verbatim' });
  return { door, id };
}

test('a field kept inside the decision that the call declares at its top level is refused where it belongs', async () => {
  const { door, id } = await allAnswered();
  assert.throws(() => run(door, makeTheDecision, { decision_id: id, decision: { ...decision, usage: { model_calls: 1 } } }), error => {
    assert.match(error.message, /"usage" belongs at the top level of the call, not inside "decision"/, error.message);
    return true;
  });
});

test('a field the call does not declare is refused by name, with the fields it does declare', async () => {
  const { door, id } = await allAnswered();
  assert.throws(() => run(door, makeTheDecision, { decision_id: id, decision, verdict_notes: 'extra' }), error => {
    assert.match(error.message, /"verdict_notes" is not a field of this call/, error.message);
    assert.match(error.message, /The fields it declares are: decision_id, decision, .*usage/, error.message);
    return true;
  });
});

// The installed run folder holds this tool's read-data and the sibling tools its code imports, and no tool-rows.json: the
// installed copy must read its input schemas from read-data alone.
const SIBLINGS = ['ask-a-small-model-for-a-verdict', 'content-identity', 'learn-from-everyones-results', 'records-door'];
const SKIPPED = new Set(['test', 'tool-rows.json', 'README.md', 'node_modules']);
const notSkipped = path => !SKIPPED.has(basename(path));

test('the input schemas the code reads are the tool rows\' input schemas', async () => {
  const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(row => row.payload);
  const shipped = settings.input_schemas;
  for (const row of rows.filter(row => row.input_schema)) assert.deepEqual(shipped[row.id], row.input_schema, `${row.id} matches its row`);
  assert.equal(Object.keys(shipped).length, rows.filter(row => row.input_schema).length);
});

test('the installed copy, without tool-rows.json, runs make-the-decision', async () => {
  const installed = tempFolder(join(tmpdir(), 'dwam-installed-'));
  try {
    const tools = new URL('../../', import.meta.url);
    const opt = join(installed, 'opt');
    mkdirSync(opt);
    symlinkSync(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(opt, 'node_modules'));
    cpSync(fileURLToPath(new URL('.', new URL('../', import.meta.url))), join(opt, 'decide-with-a-method'), { recursive: true, filter: notSkipped });
    for (const sibling of SIBLINGS) cpSync(fileURLToPath(new URL(sibling, tools)), join(opt, sibling), { recursive: true, filter: notSkipped });
    // The rows pack the formula engine the formulas folder imports at /opt/node_modules/trillion-workshop/tools/formula-engine;
    // here /opt/node_modules is the repository's own, so the copy sits one folder up, where the same lookup reaches it.
    cpSync(fileURLToPath(new URL('formula-engine', tools)), join(installed, 'node_modules', 'trillion-workshop', 'tools', 'formula-engine'), { recursive: true, filter: notSkipped });
    const copied = await import(pathToFileURL(join(opt, 'decide-with-a-method', 'read-data', 'decisions.mjs')).href);
    const door = account();
    const { case_id: id } = await run(door, copied.startADecision, input);
    await answerAll(door, id, { ref: 'user-verbatim' });
    assert.throws(() => run(door, copied.makeTheDecision, { decision_id: id, decision: { ...decision, usage: {} } }), /"usage" belongs at the top level/);
    const made = await run(door, copied.makeTheDecision, { decision_id: id, decision });
    assert.equal(made.case_id, id);
  } finally {
    rmSync(installed, { recursive: true, force: true });
  }
});
