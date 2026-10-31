// tools/workflows/do-work/rebuild-recipes.mjs
//
// recipes/workflows.json is generated, never edited by hand. The workflows are rows in a list (the public view of it is
// published into published/workflows.json and published/workflow-steps.json by tool:publish-a-list-view-as-a-file);
// this makes the recipe rows the validator and the engine's recipe row source read from those two files.
//
//   node tools/workflows/do-work/rebuild-recipes.mjs           writes recipes/workflows.json
//   node tools/workflows/do-work/rebuild-recipes.mjs --check   exit 1 when the file on disk is not what the two published files make
//   node tools/workflows/do-work/rebuild-recipes.mjs --row-updates FILE  applies explicit pending local row DATA to the saved views, then rebuilds recipes/

import { readFileSync, writeFileSync } from 'node:fs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { applyWorkflowRowUpdates, recipesFromViews } from '../read-data/recipe-rows.mjs';

const PUBLISHED = new URL('../published/', import.meta.url);
const TARGET = new URL('../recipes/workflows.json', import.meta.url);

// The text of recipes/workflows.json that the two published view files make.
export function rebuiltRecipesText(published = PUBLISHED) {
  const view = name => JSON.parse(readFileSync(new URL(name, published), 'utf8'));
  const workflows = view('workflows.json');
  const steps = view('workflow-steps.json');
  const recipes = recipesFromViews(workflows, steps);
  const pending = workflows.source?.local_update_status === 'pending-account-row-sync';
  const about = pending
    ? 'Generated from local workflow row patch data layered over published views by do-work/rebuild-recipes.mjs; canonical account rows have not been synchronized or read back. The account row owner remains the source of truth.'
    : 'Generated from published/workflows.json and published/workflow-steps.json by do-work/rebuild-recipes.mjs; edit the list those files publish, never this file.';
  return `${JSON.stringify({ about, records: recipes.map(payload => ({ payload })) }, null, 2)}\n`;
}

const canonical = value => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value));

function patchedView(view, accountRowSync) {
  const body = { fields: view.fields, rows: view.rows };
  return { ...view, source: { ...view.source, blake3: makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(body))).slice(3),
    local_update_status: 'pending-account-row-sync', account_row_sync: accountRowSync } };
}

/** Apply local row DATA to the checked view snapshots and regenerate both public projections. */
export function workflowViewsWithRowUpdates(workflows, steps, updateData) {
  const patched = applyWorkflowRowUpdates(workflows, steps, updateData);
  return {
    workflows: patchedView(patched.workflows, patched.account_row_sync),
    steps: patchedView(patched.steps, patched.account_row_sync),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const updatePath = process.argv.includes('--row-updates') ? process.argv[process.argv.indexOf('--row-updates') + 1] : null;
  if (process.argv.includes('--row-updates') && !updatePath) { console.error('Give the row DATA file after --row-updates.'); process.exit(2); }
  if (updatePath && process.argv.includes('--check')) { console.error('--row-updates writes the pending local view projections; do not combine it with --check.'); process.exit(2); }
  if (updatePath) {
    const updates = JSON.parse(readFileSync(updatePath, 'utf8'));
    const readView = name => JSON.parse(readFileSync(new URL(name, PUBLISHED), 'utf8'));
    const views = workflowViewsWithRowUpdates(readView('workflows.json'), readView('workflow-steps.json'), updates);
    writeFileSync(new URL('workflows.json', PUBLISHED), `${JSON.stringify(views.workflows, null, 1)}\n`);
    writeFileSync(new URL('workflow-steps.json', PUBLISHED), `${JSON.stringify(views.steps, null, 1)}\n`);
  }
  const text = rebuiltRecipesText();
  if (process.argv.includes('--check')) {
    if (readFileSync(TARGET, 'utf8') !== text) { console.error('recipes/workflows.json is not what the published files make: run rebuild-recipes.mjs.'); process.exit(1); }
  } else writeFileSync(TARGET, text);
}
