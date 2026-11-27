// tools/check-against-a-persons-rules-and-verdicts: each row's own sample, run the way the tool container runs it (the
// input on standard input, the answer on the last line), gives what the row's verify says; a request it cannot check is
// refused with what to send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runRow } from '../../../test-helpers/run-a-row.mjs';

const folder = resolve(import.meta.dirname, '..');
const rows = JSON.parse(readFileSync(resolve(folder, 'what-this-tool-does-and-how-to-run-it.json'), 'utf8')).records.map(record => record.payload);
const at = (value, selector) => selector.replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter(Boolean).reduce((node, key) => node?.[key], value);
const run = (argv, input) => spawnSync(process.execPath, argv, { cwd: folder, input: JSON.stringify(input), encoding: 'utf8' });

for (const row of rows) {
  test(`${row.id} answers its own sample on the last line`, async () => {
    for (const sample of row.verify.filter(item => item.kind === 'sample-run')) {
      // Every sample runs as the container runs it (its argv at its /opt paths); records are in its input.
      const ran = await runRow(row, sample.input, {});
      assert.equal(ran.status ?? ran.code, 0, ran.stderr ?? ran.stdout);
      const answer = at(JSON.parse(ran.stdout.trim().split('\n').at(-1)), row.result_selector);
      assert.ok(String(at(answer, sample.output_selector)).includes(sample.contains), JSON.stringify(answer));
    }
  });
}

test('a request with no rules, or an incomplete rule document, is refused with what to send', () => {
  const none = run(['do-work/check-against-their-rules-and-verdicts.mjs'], { rules: [], units: [{ text: 'x', kind: 'line' }] });
  assert.equal(none.status, 1);
  assert.match(JSON.parse(none.stdout.trim().split('\n').at(-1)).error, /non-empty list of rule rows/);
  const doc = run(['do-work/examples-from-where-they-stand.mjs'], { verdict_rules: { rows: [] } });
  assert.equal(doc.status, 1);
  assert.match(JSON.parse(doc.stdout.trim().split('\n').at(-1)).error, /Missing: fold/);
});

test('in the branch mode, run as the container runs it, a made-up reading row is asked once a unit and is answered by id on the second run', async () => {
  const row = rows.find(each => each.id === 'tool:check-against-a-persons-rules-and-verdicts');
  const records = [
    { id: 'record:check:made-up-base', type: 'record:check', value: { id: 'made-up-base', kind: 'branch', reading_settings: { calibration: { status: 'usable', t_pass: 0.2, t_fail: 0.8 } } } },
    { id: 'record:check:made-up-word', type: 'record:check', value: { id: 'made-up-word', part_of: 'made-up-base', words: ['glitter'], says: 'No glitter.' } },
    { id: 'record:check:made-up-note', type: 'record:check', value: { id: 'made-up-note', part_of: 'made-up-base', kind: 'check', says: 'A made-up note.', tags: ['made-up'] } },
  ];
  const units = [{ text: 'One made-up sentence. Two made-up sentences. Three made-up sentences.', kind: 'line' }];
  const answerOf = ran => JSON.parse(ran.stdout.trim().split('\n').at(-1)).result;
  const first = answerOf(await runRow(row, { branch: 'made-up-base', units, records }, {}));
  assert.equal(first.status, 'uncertain');
  assert.deepEqual(first.rows_used.skipped, { branch: 0, step: 0, off: 0, no_test: 0 });
  assert.deepEqual(first.questions.map(entry => [entry.rule, entry.asked]), [['made-up-note', [{ id: '0:made-up-note:0' }]]]);
  const pass = answerOf(await runRow(row, { branch: 'made-up-base', units, answers: { '0:made-up-note:0': { yes: 0.05 } }, records }, {}));
  assert.equal(pass.status, 'passed');
  const fail = answerOf(await runRow(row, { branch: 'made-up-base', units, answers: { '0:made-up-note:0': { yes: 0.9 } }, records }, {}));
  assert.equal(fail.status, 'failed');
  assert.deepEqual(fail.results[0].breaks.map(finding => finding.rule), ['made-up-note']);
});

test('the packed film descriptor reads public plans and recordings from stdin and refuses absent or changed origin evidence', async () => {
  const row = rows.find(each => each.id === 'tool:check-a-films-copy');
  const sample = structuredClone(row.verify.find(each => each.kind === 'sample-run'));
  const settings = sample.input.settings_record.value.settings;
  settings.spoken_spans = { cites_plan: 'never', words_json: ['takes/{clip}.json'],
    tsv: { path: 'tables/moments.tsv', clip: 'clip', from: 'start', to: 'end', text: 'text' }, speaker_unverified: '^UNCHECKED' };
  settings.origin_words = { own: 'recorded', added: 'added', unverified: 'unverified' };
  sample.input.records.find(record => record.id === 'record:check:no-sparkle').value.held_when = { path: 'origin', where: 'recorded' };
  const plan = { segments: [{ clip: 'C1', from: 2, to: 3 }, { clip: 'C2', from: 2, to: 3 }] };
  const input = { ...sample.input, files: [{ name: 'SCRIPT.md',
    text: '| # | line |\n|---|---|\n| 1 | Word sparkle. |\n| 2 | Moment sparkle. |\n' }],
    plan: 'public.json', plans: { 'public.json': plan }, recordings: {
      words: { C1: [{ text: 'Word', start: 2, end: 2.4 }, { text: 'sparkle', start: 2.4, end: 3 }] },
      tsv: 'clip\tstart\tend\ttext\nC2\t2\t3\tMoment sparkle.\n' } };
  for (const key of Object.keys(input)) assert.ok(Object.hasOwn(row.input_schema.properties, key), `${key} is declared`);
  for (const [name, extra, status, origin, verdict] of [
    ['recorded', {}, 'uncertain', 'recorded', 'uncertain'],
    ['missing plan', { plans: {} }, 'unqualified', null, null],
    ['missing recordings', { recordings: {} }, 'failed', 'added', 'fail'],
    ['changed recordings', { recordings: { words: { C1: [{ text: 'Other', start: 2, end: 3 }] },
      tsv: 'clip\tstart\tend\ttext\nC2\t2\t3\tDifferent words.\n' } }, 'failed', 'added', 'fail'],
    ['unverified speakers', { plans: { 'public.json': { segments: plan.segments.map(segment => ({ ...segment, speaker: 'UNCHECKED: who' })) } } },
      'failed', 'unverified', 'fail'],
  ]) {
    const ran = await runRow(row, { ...input, ...extra, records: sample.input.records }, {});
    assert.equal(ran.code, 0, `${name}: ${ran.stderr}`);
    const answer = JSON.parse(ran.stdout.trim().split('\n').at(-1)).result;
    assert.equal(answer.status, status, name);
    assert.equal(answer.exit_code, status === 'uncertain' ? 3 : status === 'unqualified' ? 2 : 1, name);
    assert.deepEqual(answer.results.map(result => [result.facts.origin, result.verdict]), origin === null ? [] : [[origin, verdict], [origin, verdict]], name);
  }
});

test('a model question asked once is answered by id on the second run', () => {
  const input = { rules: [{ id: 'sounds-off', ask: { question: 'Does it sound off?', options: ['yes', 'no'], fail: 'yes', calibration: { status: 'usable', t_pass: 0.3, t_fail: 0.7 } }, says: 'Sounds off.' }],
    units: [{ text: 'Plain words.', kind: 'line' }] };
  const first = JSON.parse(run(['do-work/check-against-their-rules-and-verdicts.mjs'], input).stdout.trim().split('\n').at(-1)).result;
  assert.equal(first.status, 'uncertain');
  const answers = Object.fromEntries(first.questions.map(question => [question.id, { yes: 0.05 }]));
  const second = JSON.parse(run(['do-work/check-against-their-rules-and-verdicts.mjs'], { ...input, answers }).stdout.trim().split('\n').at(-1)).result;
  assert.equal(second.status, 'passed');
});
