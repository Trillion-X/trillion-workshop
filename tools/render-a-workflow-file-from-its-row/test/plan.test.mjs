// The renderer plans one row: its file, its kit, the gate words it carries, and the colon-body rule. Stub rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gateWordsIn, usedIn, kitFromRow, canonical, bodyOf, planRender, fileFromRow } from '../read-data/render.mjs';

const stub = JSON.parse(readFileSync(new URL('./fixtures/stub-row.json', import.meta.url), 'utf8'));

test('gate words are the words the recipe check reports, found case-insensitively and listed once', () => {
  assert.deepEqual(gateWordsIn('Sam uses -connection; see instagram:acct and @someone'), ['-connection', '@someone', 'instagram:acct']);
  assert.deepEqual(gateWordsIn('Pat works at Acme.co and acme_x', ['Acme.co', 'acme']), ['Acme.co', 'acme']);
});

test('the tools and workflows a definition uses come from its ask text, its tool keys and its definition ids', () => {
  const definition = {
    steps: [
      { id: 'read', kind: 'ask', config: { name: 'tool:run-sql-in-my-database', input: { do: 'then call tool:send-an-email and workflow:keep-thing#a', submit: {} } } },
      { id: 'sub', kind: 'action', config: { definition_id: 'workflow:other-thing' } },
    ],
  };
  const used = usedIn(definition);
  assert.deepEqual([...used.tools].sort(), ['tool:run-sql-in-my-database', 'tool:send-an-email']);
  assert.deepEqual([...used.workflows].sort(), ['workflow:keep-thing', 'workflow:other-thing']);
});

test('a kit lists only recipe ids in workflows, always names the run tool, and carries its worked example', () => {
  const kit = kitFromRow(stub, { tools: new Set(['tool:one']), workflows: new Set(['workflow:x:body', 'workflow:y']) });
  assert.deepEqual(kit.workflows, [stub.recipe, 'workflow:y']);
  assert.deepEqual(kit.tools, ['tool:one', 'tool:run-workflow-definition']);
  assert.equal(kit.worked_examples[0].workflow, stub.recipe);
});

test('canonical JSON ignores key order, so a body copy and its row compare equal', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

test('a two-colon id is a body of its parent, and a three-part id is not', () => {
  assert.equal(bodyOf('workflow:parent:body'), 'workflow:parent');
  assert.equal(bodyOf('workflow:plain'), null);
});

test('a body row that matches its parent copy is skipped; one that differs is refused', () => {
  const copy = { id: 'workflow:parent:body', kind: 'workflow', steps: [{ id: 'a', kind: 'return', config: { value: 1 } }] };
  const body = { ...stub, recipe: 'workflow:parent:body', definition: copy };
  const same = planRender(body, { parent: { uses: [copy] } });
  assert.match(same.note, /skipped: a body rides in its parent/);
  const differs = planRender(body, { parent: { uses: [{ ...copy, steps: [] }] } });
  assert.match(differs.problems.join('\n'), /REFUSED: body/);
});

test('a row missing its job is reported as incomplete and planned no file', () => {
  const plan = planRender({ ...stub, job: '' }, {});
  assert.match(plan.problems.join('\n'), /row is incomplete: .*job is empty/);
  assert.equal(plan.recipe, null);
});

test('a render that would drop an origin step is refused unless the step is named as moved', () => {
  const origin = { records: [{ payload: { definition: { steps: [{ id: 'gone', kind: 'return', config: {} }] } } }] };
  const plan = planRender({ ...stub }, { origin });
  assert.match(plan.problems.join('\n'), /lost against origin file: step gone/);
  const allowed = planRender({ ...stub }, { origin, allowLost: ['step gone'] });
  assert.doesNotMatch(allowed.problems.join('\n'), /lost against origin file/);
});

test('a dropped kit entry is carried under see_also, never removed', () => {
  const originKit = { tools: ['tool:old-one'], workflows: [] };
  const plan = planRender({ ...stub }, { originKit });
  assert.deepEqual(plan.kit.dropped, ['tools: tool:old-one']);
  assert.deepEqual(plan.kit.see_also, ['tool:old-one']);
});

test('history notes (changed_by) stay in the row and never reach the rendered file', () => {
  const row = { ...stub, definition: { steps: [{ id: 'a', kind: 'return', config: { value: 1, context: { changed_by: '2026-11-22: a note', step_id: 'a' } } }] } };
  const file = fileFromRow(row);
  assert.doesNotMatch(JSON.stringify(file), /changed_by|2026-11-22: a note/);
  assert.equal(file.records[0].payload.definition.steps[0].config.context.step_id, 'a');
  assert.match(JSON.stringify(row), /changed_by/, 'the row itself is not changed');
});

test('a row with no steps is planned as a problem, never a crash', () => {
  const plan = planRender({ ...stub, definition: { steps: [] } }, { origin: null, originKit: null, parent: null, allowLost: [] });
  assert.ok(plan.problems.includes('definition has no steps'));
});

test('fires_when provenance (evidence) stays in the row and never reaches the rendered file', () => {
  const fires_when = [{ label: 'someone wants a map', state: 'Off', made_by: 'lead session', evidence: 'Written 2026-11-14 from the Geo Kit Sam shared' }];
  const row = { ...stub, fires_when };
  const file = fileFromRow(row);
  assert.doesNotMatch(JSON.stringify(file), /evidence|Sam shared/);
  assert.equal(file.records[0].payload.fires_when[0].made_by, 'lead session');
  assert.match(JSON.stringify(row), /Sam shared/, 'the row itself is not changed');
});
