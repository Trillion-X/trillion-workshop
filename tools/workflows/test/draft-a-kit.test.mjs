// tools/workflows: a kit drafted from an item's own row (L082): whole when the row gives every part, refused with the missing
// part's words when it does not, and nothing in the draft is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { draftKit } from '../read-data/draft-a-kit.mjs';

const tool = {
  id: 'tool:fixture-sum', label: 'Add two numbers', job: 'Add two numbers and answer the total.', description: 'Reads a and b and answers their total.',
  input_schema: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } } },
  output_schema: { type: 'object', properties: { total: { type: 'number' } } },
  verify: [{ kind: 'sample-run', input: { a: 1, b: 2 }, output_selector: '$.total', contains: '3' }],
};
const recipe = {
  kind: 'workflow-recipe', id: 'workflow:fixture-greet', label: 'Greet', job: 'Greet a person by the name they give.',
  input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', description: 'Who to greet.' } } },
  steps: [
    { id: 'say', title: 'Say it', do: 'Call tool:fixture-sum to count the greetings, then say hello.', submit: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
    { id: 'done', title: 'Done', do: 'Say it is finished.', submit: { type: 'object' } },
  ],
};

test('a tool with a sample run is drafted whole, its example is the sample and its answer is the sample\'s', () => {
  const { kit, problems } = draftKit({ tool });
  assert.deepEqual(problems, []);
  assert.equal(kit.draft, undefined, 'a whole draft shows a real run, so it is not marked draft');
  assert.match(kit.drafted_from, /own row/);
  assert.deepEqual(kit.tools, ['tool:fixture-sum']);
  assert.deepEqual(kit.worked_examples[0].mcp.input.input, { tool: 'tool:fixture-sum', input: { a: 1, b: 2 } });
  assert.match(kit.worked_examples[0].hands_back, /contains "3"/);
});

test('a tool with no sample run is not given a made-up run: the draft is refused with the gap named', () => {
  const { kit, problems } = draftKit({ tool: { ...tool, verify: [] } });
  assert.equal(kit.worked_examples.length, 0);
  assert.ok(problems.some(problem => /it has no sample run/.test(problem)));
});

test('a tool\'s observed run is its worked example: the real answer, the rows it kept and the input it ran on', () => {
  const seen = [{ sample: { input: { a: 1, b: 2 }, records: [{ id: 'sum:old', type: 'sum', value: {} }] }, answer: { total: 3 }, kept: ['sum:new'] }];
  const { kit, problems } = draftKit({ tool, observed: seen });
  assert.deepEqual(problems, []);
  assert.match(kit.worked_examples[0].hands_back, /^It answered \{"total":3\}, and kept sum:new\.$/);
  assert.match(kit.worked_examples[0].given, /1 example row \(sum\) already kept/);
  assert.match(kit.start_here, /\{"a":1,"b":2\}.*\{"total":3\}/);
});

test('a tool whose own words name a list is refused: its example rows cannot be drawn from its row', () => {
  const { problems } = draftKit({ tool: { ...tool, description: 'Reads list:scores and answers the total.' } });
  assert.deepEqual(problems, ['kit.lists must carry list:scores, which the item\'s steps name, with example rows.']);
});

test('a workflow is drafted from its steps, and a step that runs a tool shows that tool\'s observed run', () => {
  const runs = { ...recipe, input_schema: { type: 'object' }, steps: [{ ...recipe.steps[0], run_tool: { tool_id: 'tool:fixture-sum', input: {} }, done_when: 'the total is said' }, recipe.steps[1]] };
  const observed = new Map([['tool:fixture-sum', [{ sample: { input: { a: 1, b: 2 } }, answer: { total: 3 }, kept: [] }]]]);
  const { kit, problems } = draftKit({ recipe: runs, observed });
  assert.deepEqual(problems, []);
  assert.deepEqual(kit.workflows, ['workflow:fixture-greet']);
  assert.deepEqual(kit.tools, ['tool:start-a-recipe-run', 'tool:fixture-sum']);
  assert.equal(kit.worked_examples[0].step, 'say');
  assert.match(kit.worked_examples[0].hands_back, /"total":3/);
  assert.match(kit.instructions[1], /Say it: done when the total is said/);
});

test('a workflow whose input needs values, or whose steps run no observed tool, is refused with the gap named', () => {
  const { problems } = draftKit({ recipe });
  assert.ok(problems.some(problem => /start_here needs real values for its input: name \(Who to greet\.\)/.test(problem)));
  assert.ok(problems.some(problem => /No real run of a step can be shown/.test(problem)));
});

test('an item with a kit that names a tool its row never mentions is not drafted from outside its row', () => {
  const { kit } = draftKit({ tool });
  assert.equal(kit.lists.length, 0);
  assert.ok(kit.no_lists_because.length > 20);
});

test('a list another kit already holds is reused when the item names it, with a pour for it; a list nobody holds stays a gap', () => {
  const held = { list: 'list:scores', label: 'Scores', row_type: 'record:score', holds: 'One score per row.', fields: [{ id: 'name', kind: 'text', label: 'Name' }, { id: 'points', kind: 'number', label: 'Points' }],
    example_rows: [{ id: 'a', values: { name: 'A', points: 1 } }, { id: 'b', values: { name: 'B', points: 2 } }], alike: ['a score sheet'] };
  const named = { ...tool, description: 'Reads list:scores and answers the total.' };
  const { kit, problems } = draftKit({ tool: named, keptLists: new Map([['list:scores', held]]) });
  assert.deepEqual(problems, []);
  assert.deepEqual(kit.lists, [held]);
  assert.equal(kit.pour.example.kit_list, 'list:scores');
  assert.equal(draftKit({ tool: named }).problems.length, 1);
});
