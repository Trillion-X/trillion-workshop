// tools/pour-example-rows-into-my-list: a kit's example rows go into a list the person already keeps, field by field,
// only when enough of the kit's fields find a home; nothing is guessed and pouring twice changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pour } from '../do-work/pour.mjs';
import { kitProblems } from '../../workflows/read-data/kit-problems.mjs';

const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload;
const sample = row.verify[0].input;
const program = new URL('../do-work/pour.mjs', import.meta.url).pathname;

test('the sample pours both rows by the names the kit fields go by', () => {
  const answer = pour(sample);
  assert.equal(answer.poured, true);
  assert.equal(answer.coverage, 1);
  assert.deepEqual(answer.matched.map(item => [item.kit_field, item.your_field]), [['match_words', 'keywords'], ['text', 'body']]);
  assert.deepEqual(answer.write.input.records.map(record => record.id), ['record:saved-reply:kit-price', 'record:saved-reply:kit-hours']);
  assert.deepEqual(answer.write.input.records[0].value, { keywords: ['price', 'how much'], body: 'Hi {from}, it is 49 a month.' });
  assert.equal(answer.write.address, '@own-records');
  assert.equal(answer.write.method, 'records:write');
});

test('a list that matches under 80% of the kit fields gets nothing, and is told which fields have no home', () => {
  const kit = { ...sample.kit_list, fields: [...sample.kit_list.fields, { id: 'channel', kind: 'text', label: 'Channel' }, { id: 'tone', kind: 'text', label: 'Tone' }] };
  const answer = pour({ ...sample, kit_list: kit });
  assert.equal(answer.poured, false);
  assert.equal(answer.coverage, 0.5);
  assert.deepEqual(answer.unmatched, ['channel', 'tone']);
  assert.equal(answer.write, null);
  assert.match(answer.says, /under the 80%/);
});

test('the map wins, a label match counts, and a choice the person\'s list does not offer is dropped, never guessed', () => {
  const kit = { list: 'list:ideas', fields: [{ id: 'idea', kind: 'text', label: 'Idea' }, { id: 'stage', kind: 'choice', label: 'Stage' }],
    example_rows: [{ id: 'one', values: { idea: 'A talk', stage: 'Draft' } }, { id: 'two', values: { idea: 'A post', stage: 'Someday' } }] };
  const into = { list: 'list:my-ideas', row_type: 'record:my-idea', fields: [{ id: 'title', label: 'Title' }, { id: 'state', label: 'Stage', options: ['Draft', 'Done'] }] };
  const answer = pour({ kit_list: kit, into, field_map: { idea: 'title' } });
  assert.deepEqual(answer.matched.map(item => item.by), ['the map', 'the same label']);
  assert.deepEqual(answer.rows[0].value, { title: 'A talk', state: 'Draft' });
  assert.deepEqual(answer.rows[1].value, { title: 'A post' });
  assert.deepEqual(answer.rows[1].not_an_option, ['state: Someday']);
});

test('rows already in the list are left out, so pouring twice changes nothing', () => {
  const answer = pour({ ...sample, already_there: ['record:saved-reply:kit-price', 'record:saved-reply:kit-hours'] });
  assert.equal(answer.poured, false);
  assert.equal(answer.write, null);
  assert.equal(answer.left_out.length, 2);
});

test('a refusal says what to send, and the program answers it as its last line with exit 2', () => {
  const run = spawnSync(process.execPath, [program], { input: JSON.stringify({ kit_list: sample.kit_list, into: { list: 'saved' } }), encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(JSON.parse(run.stdout.trim().split('\n').at(-1)).error, /into must be the person's own list/);
  assert.throws(() => pour({ ...sample, field_map: { text: 'nothing-like-it' } }), /not a field of list:saved-replies/);
  assert.throws(() => pour({ ...sample, least_coverage: 0.5 }), /from 0.8 to 1/);
});

test('the tool ships its own kit', () => {
  assert.deepEqual(kitProblems(JSON.parse(readFileSync(new URL('../kits/pour-example-rows-into-my-list.json', import.meta.url), 'utf8')), { tool: row }), []);
});
