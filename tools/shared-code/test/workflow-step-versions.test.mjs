// Ported from old trillion test/workflow-step-versions.test.mjs (tag old-trillion-before-worker-retire, b6ae0ebf81), deleted
// by Trillion-X/trillion #243. The old tests drove the whole MCP server (test/in-process-mcp.mjs over old src/workflows.mjs);
// no repository runs the /workflows routes now (searched workflows/save, workflows/upgrade, start_workflow handlers in
// trillion-workshop tools/, trillion-rust src/, trillion-apps web/), so each check is made on the code that does its work today:
// src/workflow-step-versions.mjs (saving's pin, describe's step_versions, a run's upgrade_needed, the upgrade),
// tools/workflows/read-data/recipe-problems.mjs (a malformed pin), src/workflow-authoring-guidance.mjs (the notes) and
// tools/let-an-ai-find-a-workflow-for-a-job-read/src/workflow-tools.mjs (save_workflow's schema). Left out, as only the engine
// did them: that a run with an unchanged contract finishes and runs the tool once, that a waiting run ran nothing, that a new
// run after the upgrade runs the new version with the new input, that a started run keeps its recipe, and that only this
// account's own workflow is upgraded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeProblems } from '../../workflows/read-data/recipe-problems.mjs';
import { compareToPin, pinOf, pinnedRecipe, runsKeepWords, stepVersionsOf, toolStepsOf, upgradeNeeded, upgradedRecipe } from '../src/workflow-step-versions.mjs';
import { authoringNotes } from '../src/workflow-authoring-guidance.mjs';
import { workflowTools } from '../../let-an-ai-find-a-workflow-for-a-job-read/src/workflow-tools.mjs';
import guidance from '../src/workflow-authoring-guidance.json' with { type: 'json' };

// The tool definitions as the Workshop answers them now; a publisher's new release changes them.
const describer = descriptors => async tool_id => descriptors[tool_id] ?? null;

const counter = (extra = {}) => ({ id: 'tool:count-words', label: 'Count words', job: 'Count the words of a text', input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, invoke: { kind: 'test' }, ...extra });
const workflow = {
  id: 'workflow:draft-and-count', label: 'Draft and count', job: 'Write a draft and count its words with a tool',
  input_schema: { type: 'object', properties: { topic: { type: 'string' } } },
  steps: [
    { id: 'draft', title: 'Write the draft', do: 'Write a short draft on the input topic.', submit: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
    { id: 'count', title: 'Count its words', do: 'Trillion counts the words.', run_tool: { tool_id: 'tool:count-words', input: { text: { from: ['steps', 'draft', 'text'] } } }, submit: { type: 'object', required: ['words'], properties: { words: { type: 'integer' } } } },
  ],
};

test('saving pins each tool step; a release that keeps the contract runs, a changed contract waits for an explicit upgrade', async () => {
  const descriptors = { 'tool:count-words': counter() };
  const describe = describer(descriptors);
  // Saving fills each tool step's pin from the tool as it is now.
  const saved = await pinnedRecipe(workflow, describe);
  const pinned = saved.steps[1].run_tool.pinned;
  assert.deepEqual(pinned, pinOf(counter()), 'the step keeps the tool version it was saved with');
  assert.deepEqual(await stepVersionsOf(saved, describe), [{ step_id: 'count', tool_id: 'tool:count-words', pinned: pinned.version, current: pinned.version, upgrade_available: false }]);
  assert.deepEqual(recipeProblems({ ...workflow, steps: [workflow.steps[0], { ...workflow.steps[1], run_tool: { ...workflow.steps[1].run_tool, pinned: { version: 'v2' } } }] }).filter(problem => /pinned/.test(problem)).length, 1, 'a malformed pin is refused');

  // A new release with the same contract (only its description changed) runs.
  descriptors['tool:count-words'] = counter({ description: 'Faster counting' });
  assert.equal(compareToPin(pinned, descriptors['tool:count-words']).runs, true);
  const contractSame = (await stepVersionsOf(saved, describe))[0];
  assert.equal(contractSame.upgrade_available, true);
  assert.equal(contractSame.waits_for_upgrade, undefined, 'an unchanged contract does not wait');

  // A release that changes the input contract makes the step wait, naming the changed fields and the upgrade call.
  descriptors['tool:count-words'] = counter({ input_schema: { type: 'object', required: ['text', 'language'], properties: { text: { type: 'string' }, language: { type: 'string' } } } });
  const compared = compareToPin(pinned, descriptors['tool:count-words']);
  assert.equal(compared.runs, false);
  const waiting = upgradeNeeded({ workflow_id: workflow.id, step_id: 'count', tool_id: 'tool:count-words', compared });
  assert.equal(waiting.state, 'upgrade_needed');
  assert.deepEqual(waiting.changed_fields, ['input_schema']);
  assert.deepEqual(waiting.next_call, { tool: 'upgrade_workflow_steps', arguments: { workflow_id: workflow.id, step_ids: ['count'] } });

  // The upgrade is refused while the step does not give an input the tool now requires.
  const refused = await upgradedRecipe(saved, describe);
  assert.ok(refused.problems.length);
  assert.match(refused.problems.join(' '), /now requires language/);

  // Once the step gives it, the upgrade moves the pin; upgrading again changes nothing.
  const fixed = { ...saved, steps: [saved.steps[0], { ...saved.steps[1], run_tool: { ...saved.steps[1].run_tool, input: { ...workflow.steps[1].run_tool.input, language: 'en' } } }] };
  assert.deepEqual((await pinnedRecipe(fixed, describe)).steps[1].run_tool.pinned, pinned, 'saving again never moves a pin');
  const upgraded = await upgradedRecipe(fixed, describe, ['count']);
  assert.deepEqual(upgraded.problems, []);
  assert.deepEqual(upgraded.upgraded.map(item => [item.step_id, item.from, item.to, item.changed_fields]), [['count', pinned.version, pinOf(descriptors['tool:count-words']).version, ['input_schema']]]);
  assert.match(runsKeepWords(), /Runs already started keep/);
  assert.deepEqual((await upgradedRecipe(upgraded.row, describe)).upgraded, [], 'upgrading again changes nothing');
  assert.equal(toolStepsOf(upgraded.row)[0].pinned.version, pinOf(descriptors['tool:count-words']).version);
});

test('save_workflow carries DATA guidance on its fields and returns authoring notes that never refuse the save', async () => {
  const describe = describer({ 'tool:count-words': counter() });
  const schema = workflowTools(async () => ({})).find(item => item.name === 'save_workflow').inputSchema.properties.workflow;
  for (const row of guidance.fields) {
    let at = schema;
    for (const key of row.schema_path) at = at[key];
    assert.equal(at.description, row.says, row.schema_path.join('.'));
  }
  const long = 'x'.repeat(61);
  const noisy = {
    ...workflow, id: 'workflow:noisy', label: long,
    steps: [
      { ...workflow.steps[0], title: 'Write the draft about the Q3 launch of the Ledgerline product for Ana' },
      { ...workflow.steps[1], run_tool: { tool_id: 'tool:count-words', input: { topic: 'Q3 launch', words: { from: ['input', 'audience'] } } } },
    ],
  };
  assert.deepEqual(recipeProblems(noisy), [], 'notes never refuse a save');
  const notes = await authoringNotes(noisy, describe);
  const kinds = notes.map(note => [note.kind, note.at.join('/')]);
  assert.deepEqual(kinds, [
    ['longer_than', 'label'],
    ['longer_than', 'steps/0/title'],
    ['input_not_declared', 'input_schema/properties/audience'],
    ['literal_could_bind', 'steps/count/input/topic'],
    ['tool_input_missing', 'steps/count/input/text'],
  ]);
  assert.match(notes[3].says, /\{ "from": \["input", "topic"\] \}/);
  assert.deepEqual(await authoringNotes(workflow, describe), [], 'a workflow written to the guidance has no notes');
});
