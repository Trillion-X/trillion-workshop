// tools/workflows: the kit validator (L082). The template's own example is a whole kit; each part it asks for is refused
// when it is missing, and each part it asks for names what the item's own steps name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KIT_TEMPLATE, kitProblems } from '../read-data/kit-problems.mjs';

const step = (id, words = '') => ({ id, title: id, do: `Do ${id}. ${words}`, submit: { type: 'object' } });
const recipe = {
  kind: 'workflow-recipe', id: 'workflow:answer-comments-and-messages', job: 'Answer messages.',
  steps: [step('pick-a-template', 'Read list:reply-templates.'), step('fill', 'Call tool:expand-a-reply-template, tool:pull-my-instagram-messages and tool:check-copy.')],
};
const whole = () => structuredClone(KIT_TEMPLATE.example);

test('the template\'s example is a whole kit for a recipe whose steps it covers', () => {
  assert.deepEqual(kitProblems(whole(), { recipe }), []);
});

test('no kit at all is refused, and names the template', () => {
  assert.deepEqual(kitProblems(undefined, { recipe }), ['The item has no kit: add one (tools/workflows/kit-template.json shows every part).']);
});

test('a list with fewer than two example rows, or rows that fill fields it does not have, is refused', () => {
  const kit = whole();
  kit.lists[0].example_rows = [{ id: 'price', values: { match_words: ['price'], colour: 'red' } }];
  assert.deepEqual(kitProblems(kit, { recipe }), [
    'kit.lists[0].example_rows must hold at least 2 filled-in example rows, so the person starts from rows, not from an empty list.',
    'kit.lists[0].example_rows[0].values.colour is not one of the list\'s fields.',
  ]);
});

test('a list the steps name, a tool they call and a workflow they run must each be in the kit', () => {
  const kit = whole();
  const named = { ...recipe, steps: [...recipe.steps, step('more', 'Write list:gaps, call tool:tell-the-person and run workflow:set-up-your-checks.')] };
  assert.deepEqual(kitProblems(kit, { recipe: named }), [
    'kit.lists must carry list:gaps, which the item\'s steps name, with example rows.',
    'kit.workflows must name workflow:set-up-your-checks, which the item uses.',
    'kit.tools must name tool:tell-the-person, which the item uses.',
  ]);
});

test('a worked example names the MCP call and a real step of the workflow', () => {
  const kit = whole();
  kit.worked_examples[0].step = 'no-such-step';
  delete kit.worked_examples[0].mcp;
  assert.deepEqual(kitProblems(kit, { recipe }), [
    'kit.worked_examples[0].mcp must name the MCP server, the MCP tool the AI calls and its exact input ({ server, tool, input }).',
    'kit.worked_examples[0].step must be one of this workflow\'s steps: pick-a-template, fill.',
  ]);
});

test('the pour must use the pour tool, ask for at least 80% and pour one of the kit\'s lists', () => {
  const kit = whole();
  kit.pour = { tool: 'tool:copy-rows', least_coverage: 0.5, how: 'Copy them.', example: { kit_list: 'list:other', into: {} } };
  assert.deepEqual(kitProblems(kit, { recipe }), [
    'kit.pour.tool must be tool:pour-example-rows-into-my-list.',
    'kit.pour.least_coverage must be a share from 0.8 to 1 of the kit\'s fields a person\'s list must match.',
    'kit.pour.example must pour one of the kit\'s lists (kit_list) into a filled-in list of the person\'s (into: { list, row_type, fields }).',
  ]);
});

test('a tool\'s kit names the tool itself, and a kit with no lists says why', () => {
  const tool = { id: 'tool:fixture', job: 'Do a fixture.', invoke: { argv: ['node', 'x.mjs'] } };
  const kit = { ...whole(), lists: [], tools: [], workflows: [] };
  delete kit.pour;
  assert.deepEqual(kitProblems(kit, { tool }), [
    'kit.lists is empty: give the item\'s lists with example rows, or say in no_lists_because why it keeps none.',
    'kit.tools must name tool:fixture, which the item is.',
    'kit.workflows and kit.tools are both empty: name what the item runs.',
  ]);
});
