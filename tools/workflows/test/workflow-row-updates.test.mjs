import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { applyWorkflowRowUpdates } from '../read-data/recipe-rows.mjs';
import { workflowViewsWithRowUpdates } from '../do-work/rebuild-recipes.mjs';

const view = (name, rows) => ({ schema: 'list-view-file/v1', source: { view: `list-view:${name}:public`, list: name, blake3: 'old' },
  fields: [{ id: 'title', kind: 'text' }], rows });
const canonical = value => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value));

test('local workflow updates overlay exact rows, add a linked step and mark account sync pending', () => {
  const workflows = view('workflows', [{ id: 'keep-pages-cited-by-answer-engines', values: { recipe: 'workflow:keep-pages-cited-by-answer-engines', job: 'Old' } }]);
  const steps = view('workflow-steps', [{ id: 'keep-pages-cited-by-answer-engines--ask', values: { recipe: ['keep-pages-cited-by-answer-engines'], step: 'ask', position: 1, do: 'Old', submit: '{"type":"object"}' } }]);
  const updates = {
    account_row_sync: { status: 'pending', canonical_rows_readback: false },
    workflow_rows: [{ id: 'keep-pages-cited-by-answer-engines', values: { job: 'Updated' } }],
    step_rows: [
      { id: 'keep-pages-cited-by-answer-engines--ask', values: { do: 'Updated ask' } },
      { id: 'keep-pages-cited-by-answer-engines--measure', values: { recipe: ['keep-pages-cited-by-answer-engines'], step: 'measure', position: 2, do: 'Measure', submit: '{"type":"object"}' } },
    ],
  };
  const patched = workflowViewsWithRowUpdates(workflows, steps, updates);
  assert.equal(patched.workflows.rows[0].values.job, 'Updated');
  assert.deepEqual(patched.steps.rows.map(row => row.id), [
    'keep-pages-cited-by-answer-engines--ask', 'keep-pages-cited-by-answer-engines--measure',
  ]);
  assert.equal(patched.steps.source.local_update_status, 'pending-account-row-sync');
  assert.equal(patched.workflows.source.account_row_sync.canonical_rows_readback, false);
  assert.match(patched.steps.source.blake3, /^[a-f0-9]{64}$/);
  assert.equal(patched.steps.source.blake3, makeHashCodeHexFromBytes(new TextEncoder().encode(canonical({ fields: patched.steps.fields, rows: patched.steps.rows }))).slice(3));
});

test('refuses local fallback patches that claim account synchronization or introduce unlinked rows', () => {
  const workflows = view('workflows', []);
  const steps = view('workflow-steps', []);
  assert.throws(() => applyWorkflowRowUpdates(workflows, steps, {
    account_row_sync: { status: 'complete', canonical_rows_readback: true }, workflow_rows: [], step_rows: [],
  }), /pending account synchronization/);
  assert.throws(() => applyWorkflowRowUpdates(workflows, steps, {
    account_row_sync: { status: 'pending', canonical_rows_readback: false }, workflow_rows: [], step_rows: [{ id: 'unlinked', values: { step: 'x' } }],
  }), /must include its recipe link/);
});
