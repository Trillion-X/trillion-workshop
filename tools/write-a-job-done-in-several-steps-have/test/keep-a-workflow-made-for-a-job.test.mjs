// Keeping a workflow made for one job as a row of the person's own workflows: the run drafts it (an ask the engine checks),
// then makes or widens workflow_recipes, keeps the row and reads it back, each through tool:run-sql-in-my-database.
// The JSON values go to the database as JSON text, never as a driver's array. Made-up values only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { workflowEngine } from '../read-data/run-a-workflow.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';

const { definitions } = JSON.parse(await readFile(new URL('../../workflows/definitions/keep-a-workflow-made-for-a-job.json', import.meta.url), 'utf8'));
const run = answers => makeWorkflowDefinitionRunner(workflowEngine).runWorkflowDefinition(
  { definitions, workflow_id: 'workflow:keep-a-workflow-made-for-a-job', input: {}, answers });
const draft = {
  recipe: 'workflow:share-footage-with-a-friend', title: 'Share footage with a friend', store: 'my-own-database',
  definition: { id: 'workflow:share-footage-with-a-friend', name: 'Share footage with a friend', kind: 'workflow', is_active: true, version: 1,
    steps: [{ id: 'find', kind: 'ask', config: { name: 'tool:find-my-files', input: {} } }, { id: 'send', kind: 'ask', config: { name: 'tool:share-links', input: {} } }],
    edges: [{ from: 'find', to: 'send', kind: 'always' }] },
  fires_when: [{ label: 'a friend asks for footage', condition: { fields: [{ id: 'kinds', kind: 'tags', path: ['kinds'] }], tree: { kind: 'group', combinator: 'and', negate: false, rules: [{ kind: 'rule', field: 'kinds', operator: 'has_any_of', params: { values: ['asks-for-footage'] } }] } } }],
};
const done = { columns: [], rows: [], row_count: 0 };

test('the run starts at the draft, the engine checks its shape, then the table is made and widened', async () => {
  const asked = await run({});
  assert.equal(asked.status, 'paused');
  assert.equal(asked.waiting[0].step_id, 'draft');
  const next = await run({ draft });
  assert.equal(next.waiting[0].step_id, 'make-the-table');
  assert.equal(next.waiting[0].input.credential_name, 'my-own-database');
  assert.match(next.waiting[0].input.sql, /CREATE TABLE IF NOT EXISTS workflow_recipes/);
});

test('the kept row carries fires_when and the definition as JSON text', async () => {
  const at = await run({ draft, 'make-the-table': done, 'widen-the-table': done });
  assert.equal(at.waiting[0].step_id, 'keep');
  const [recipe, title, firesWhen, definition] = at.waiting[0].input.params;
  assert.equal(recipe, draft.recipe);
  assert.equal(title, draft.title);
  const asJson = value => (typeof value === 'string' ? JSON.parse(value) : value);
  assert.deepEqual(asJson(firesWhen), draft.fires_when);
  assert.deepEqual(asJson(definition), draft.definition);
  // A list given to the database driver as itself becomes a Postgres array, which ::jsonb refuses: both go as JSON text.
  const keep = definitions[0].steps.find(step => step.id === 'keep').config.input.params;
  for (const param of keep.slice(2)) assert.deepEqual(param.select.transform, [{ op: 'op:core.stringify' }]);
});

test('a draft with no conditions or a one-step definition is refused', async () => {
  const refused = async bad => { try { return (await run({ draft: bad })).status; } catch { return 'refused'; } };
  assert.notEqual(await refused({ ...draft, fires_when: [] }), 'completed');
  assert.notEqual((await run({ draft: { ...draft, fires_when: [] } }).catch(() => ({ waiting: [{ step_id: 'draft' }] }))).waiting?.[0]?.step_id, 'make-the-table');
  assert.notEqual((await run({ draft: { ...draft, definition: { ...draft.definition, steps: draft.definition.steps.slice(0, 1) } } }).catch(() => ({ waiting: [{ step_id: 'draft' }] }))).waiting?.[0]?.step_id, 'make-the-table');
});
