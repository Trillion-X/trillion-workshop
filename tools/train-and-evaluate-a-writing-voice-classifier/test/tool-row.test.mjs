// The rows run the way the engine runs them: one JSON request on standard input, the answer on the last line. Every
// sample in tool-rows.json gives what its verify item says; the evaluate row reads its endpoint and model from a
// made-up list:settings row and plays recorded replies in place of the classifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { answer, playRecordedReplies } from '../do-work/evaluate-voice.mjs';

const folder = fileURLToPath(new URL('..', import.meta.url));
const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records.map(record => record.payload);
const pick = (value, path) => path.replace(/^\$\.?/, '').split(/[.[\]]+/).filter(Boolean).reduce((at, key) => at?.[key], value);
const binary = JSON.parse(readFileSync(new URL('./fixtures/binary-challenge.json', import.meta.url), 'utf8'));
const recorded = JSON.parse(readFileSync(new URL('./fixtures/binary-results.json', import.meta.url), 'utf8'));
const evaluateRow = rows.find(row => row.id === 'tool:evaluate-a-writing-voice-classifier');
const sample = evaluateRow.verify[0].input;
// An in-memory records door holding made-up rows (the door's read answers a record's value or null).
const doorOf = records => ({ read: async (type, id) => structuredClone(records.find(one => one.id === id && one.type === type)?.value ?? null) });
const door = doorOf(evaluateRow.verify[0].records);

function run(row, input) {
  const [program, script] = row.invoke.argv;
  const result = spawnSync(program === 'node' ? process.execPath : program, [script.replace(`/opt/${'train-and-evaluate-a-writing-voice-classifier'}/`, '')], { cwd: folder, input: JSON.stringify(input), encoding: 'utf8' });
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('every sample run gives what its verify item says', async () => {
  for (const row of rows) for (const item of row.verify ?? []) {
    if (item.kind !== 'sample-run') continue;
    const out = item.records ? { result: await answer(item.input, { door: doorOf(item.records) }) } : run(row, item.input);
    assert.ok(out.result, `${row.id}: ${out.error}`);
    assert.deepEqual(pick(out.result, item.output_selector), item.equals, row.id);
  }
});

test('evaluating from recorded replies gives the recorded decisions, and the report checks against the same recordings', async () => {
  const replies = recorded.items.flatMap(row => row.request_evidence.exchanges);
  const report = await answer({ ...sample, data: binary, replies, include_evidence: true }, { door });
  assert.equal(report.complete, true);
  assert.equal(report.serving_identity_assurance, 'observed-health-and-response');
  for (const row of report.items) {
    const old = recorded.items.find(one => one.id === row.id);
    for (const [id, check] of Object.entries(row.checks)) {
      assert.equal(check.decision, old.checks[id].decision);
      assert.deepEqual(check.probabilities, old.checks[id].probabilities);
    }
  }
  assert.deepEqual(report.summary, recorded.summary);
  const checked = await answer({ action: 'check-report', data: binary, settings_record: sample.settings_record, report: recorded }, { door });
  assert.deepEqual(checked, { valid: true, complete: true, covered: binary.items.length, identity_assurance: 'observed-health-and-response' });
});

test('a request with no recorded reply is an error kept as an error, never a pass', async () => {
  const report = await answer({ ...sample, data: binary, replies: [] }, { door });
  assert.equal(report.items.length, 0);
  assert.equal(report.errors.length, binary.items.length);
  assert.match(report.errors[0].error, /no recorded reply/);
  await assert.rejects(playRecordedReplies({ replies: [] })('http://127.0.0.1:1/v1/systemone', { body: '{}' }), /no recorded reply/);
});

test('settings come from the person\'s row for this tool, and their absence is refused in words', async () => {
  await assert.rejects(answer({ data: binary }), /No classifier settings: give settings_record/);
  const [kept] = evaluateRow.verify[0].records;
  await assert.rejects(answer({ data: binary, settings_record: 'record:setting:some-other-tool~person~made-up-writer' }, { door }), error => error.code === 'other_tool');
  await assert.rejects(answer({ data: binary, settings_record: sample.settings_record }, { door: doorOf([]) }), error => error.code === 'missing');
  await assert.rejects(answer({ data: binary, settings_record: sample.settings_record }, { door: doorOf([{ ...kept, value: { ...kept.value, status: 'retired' } }]) }), error => error.code === 'not_active');
  await assert.rejects(answer({ data: binary, settings_record: sample.settings_record }), error => error.code === 'no_door');
  await assert.rejects(answer({ data: binary, settings_record: sample.settings_record }, { door: doorOf([{ ...kept, value: { ...kept.value, settings: { model: 'm' } } }]) }), /settings need endpoint/);
  await assert.rejects(answer({ data: binary, endpoint: 'not-an-address', model: 'm' }), /endpoint/);
});

test('plan sends the passage and criterion context only, and an unknown action is refused', async () => {
  const { plans } = await answer({ action: 'plan', data: binary });
  assert.equal(plans.length, binary.items.length);
  assert.equal(plans[0].content, `Passage: ${binary.items[0].text}`);
  await assert.rejects(answer({ action: 'guess', data: binary, settings_record: sample.settings_record }, { door }), /Unknown action/);
  const out = run(evaluateRow, { action: 'evaluate' });
  assert.match(out.error, /Give data/);
});
