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
const valuesOf = row => row?.values ?? row?.value ?? {};

// The text of recipes/workflows.json that the two published view files make.
export function rebuiltRecipesText(published = PUBLISHED) {
  const view = name => JSON.parse(readFileSync(new URL(name, published), 'utf8'));
  const workflows = view('workflows.json');
  const steps = view('workflow-steps.json');
  const recipes = recipesFromViews(workflows, steps);
  const pending = workflows.source?.local_update_status === 'pending-account-row-sync';
  const pendingIds = workflows.source?.account_row_sync?.workflow_ids ?? [];
  const about = pending
    ? `Generated from published workflow views by do-work/rebuild-recipes.mjs; canonical account rows have been read back where synchronized. Pending account workflow rows: ${pendingIds.join(', ') || 'unidentified rows'}. The account row owner remains the source of truth.`
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

function readbackPayloads(readback) {
  const lines = typeof readback === 'string' ? readback.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : readback;
  if (!Array.isArray(lines)) throw new Error('Account readback must be a JSONL file or an array of result lines.');
  return lines.flatMap(line => {
    const answer = line?.answer ?? line;
    if (Array.isArray(answer?.records)) return answer.records;
    return answer && typeof answer.id === 'string' ? [answer] : [];
  });
}

function recordValues(record) {
  const value = record?.value;
  const values = value?.values ?? value;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Account readback ${record?.id} has no values object.`);
  return values;
}

function recipeLinkId(value) {
  const link = Array.isArray(value) ? value[0] : value;
  return typeof link === 'string' ? link.replace(/^workflow:/, '') : null;
}

function setViewIdentity(view) {
  const body = { fields: view.fields, rows: view.rows };
  const source = { ...view.source, blake3: makeHashCodeHexFromBytes(new TextEncoder().encode(canonical(body))).slice(3) };
  return { ...view, source };
}

/**
 * Replace exact rows from the account's records:read results, then clear only pending recipe ids whose
 * recipe and every currently projected step were included in that readback.
 */
export function workflowViewsWithAccountReadback(workflows, steps, readback, syncScope) {
  const records = readbackPayloads(readback);
  const workflowList = records.find(record => record.id === 'list:workflows' && record.type === 'list');
  const stepList = records.find(record => record.id === 'list:workflow-steps' && record.type === 'list');
  if (!workflowList || !stepList) throw new Error('Read back both list:workflows and list:workflow-steps before syncing projections.');
  const recipePrefix = 'record:workflow-recipe:';
  const stepPrefix = 'record:workflow-step:';
  const recipes = records.filter(record => record?.id?.startsWith(recipePrefix));
  const stepRows = records.filter(record => record?.id?.startsWith(stepPrefix));
  if (!recipes.length && !stepRows.length) throw new Error('Account readback contains no workflow recipe or step rows.');

  const replaceRows = (view, rowRecords, prefix, label) => {
    const rows = view.rows.map(row => ({ ...row, values: { ...valuesOf(row) } }));
    const seen = new Set();
    for (const record of rowRecords) {
      const id = record.id.slice(prefix.length);
      if (!id || seen.has(id)) throw new Error(`Account readback has an empty or repeated ${label} id.`);
      seen.add(id);
      const values = recordValues(record);
      const index = rows.findIndex(row => row.id === id);
      if (index < 0) rows.push({ id, values });
      else rows[index] = { id, values };
    }
    return { ...view, rows };
  };

  const recipeFields = recordValues(workflowList).fields;
  const stepFields = recordValues(stepList).fields;
  if (!Array.isArray(recipeFields) || !Array.isArray(stepFields)) throw new Error('Account list readback has no fields arrays.');
  let nextWorkflows = replaceRows({ ...workflows, fields: recipeFields }, recipes, recipePrefix, 'recipe');
  let nextSteps = replaceRows({ ...steps, fields: stepFields }, stepRows, stepPrefix, 'step');

  const recipeIds = new Set(recipes.map(record => record.id.slice(recipePrefix.length)));
  const readStepIds = new Set(stepRows.map(record => record.id.slice(stepPrefix.length)));
  const scopeRecipeIds = new Set((syncScope?.workflow_rows ?? []).map(row => row?.id).filter(id => typeof id === 'string'));
  const scopeStepRows = syncScope?.step_rows;
  if (syncScope && (!Array.isArray(syncScope.workflow_rows) || !Array.isArray(scopeStepRows))) {
    throw new Error('The account sync scope must contain workflow_rows and step_rows arrays.');
  }
  const scopeStepIdsByRecipe = new Map();
  for (const row of scopeStepRows ?? []) {
    if (typeof row?.id !== 'string' || !row.values || typeof row.values !== 'object') throw new Error('Every account sync scope step needs an id and values.');
    const recipeId = recipeLinkId(row.values.recipe)
      ?? [...scopeRecipeIds].sort((left, right) => right.length - left.length).find(id => row.id.startsWith(`${id}--`));
    if (!recipeId) throw new Error(`Account sync scope step ${row.id} has no recipe link or matching recipe id prefix.`);
    if (!scopeStepIdsByRecipe.has(recipeId)) scopeStepIdsByRecipe.set(recipeId, []);
    scopeStepIdsByRecipe.get(recipeId).push(row.id);
  }
  const pending = nextWorkflows.source?.account_row_sync;
  if (pending?.status === 'pending') {
    const completed = (pending.workflow_ids ?? []).filter(id => {
      if (!recipeIds.has(id)) return false;
      if (syncScope) {
        const candidateSteps = scopeStepIdsByRecipe.get(id) ?? [];
        return scopeRecipeIds.has(id) && candidateSteps.every(stepId => readStepIds.has(stepId));
      }
      const projectedSteps = nextSteps.rows.filter(row => recipeLinkId(valuesOf(row).recipe) === id).map(row => row.id);
      return projectedSteps.every(stepId => readStepIds.has(stepId));
    });
    const remaining = (pending.workflow_ids ?? []).filter(id => !completed.includes(id));
    if (remaining.length) {
      const updatedSync = {
        ...pending,
        canonical_rows_readback: false,
        canonical_workflow_ids: [...new Set([...(pending.canonical_workflow_ids ?? []), ...completed])],
        workflow_ids: remaining,
      };
      nextWorkflows = { ...nextWorkflows, source: { ...nextWorkflows.source, account_row_sync: updatedSync, local_update_status: 'pending-account-row-sync' } };
      nextSteps = { ...nextSteps, source: { ...nextSteps.source, account_row_sync: updatedSync, local_update_status: 'pending-account-row-sync' } };
    } else {
      const workflowSource = { ...nextWorkflows.source };
      const stepSource = { ...nextSteps.source };
      delete workflowSource.account_row_sync;
      delete workflowSource.local_update_status;
      delete stepSource.account_row_sync;
      delete stepSource.local_update_status;
      nextWorkflows = { ...nextWorkflows, source: workflowSource };
      nextSteps = { ...nextSteps, source: stepSource };
    }
  }
  return { workflows: setViewIdentity(nextWorkflows), steps: setViewIdentity(nextSteps) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const updatePath = process.argv.includes('--row-updates') ? process.argv[process.argv.indexOf('--row-updates') + 1] : null;
  const readbackPath = process.argv.includes('--account-readback') ? process.argv[process.argv.indexOf('--account-readback') + 1] : null;
  if (process.argv.includes('--row-updates') && !updatePath) { console.error('Give the row DATA file after --row-updates.'); process.exit(2); }
  if (process.argv.includes('--account-readback') && !readbackPath) { console.error('Give the account JSONL readback file after --account-readback.'); process.exit(2); }
  if (updatePath && readbackPath) { console.error('Use either --row-updates or --account-readback, not both.'); process.exit(2); }
  if ((updatePath || readbackPath) && process.argv.includes('--check')) { console.error('Projection update modes write published views; do not combine them with --check.'); process.exit(2); }
  if (updatePath) {
    const updates = JSON.parse(readFileSync(updatePath, 'utf8'));
    const readView = name => JSON.parse(readFileSync(new URL(name, PUBLISHED), 'utf8'));
    const views = workflowViewsWithRowUpdates(readView('workflows.json'), readView('workflow-steps.json'), updates);
    writeFileSync(new URL('workflows.json', PUBLISHED), `${JSON.stringify(views.workflows, null, 1)}\n`);
    writeFileSync(new URL('workflow-steps.json', PUBLISHED), `${JSON.stringify(views.steps, null, 1)}\n`);
  }
  if (readbackPath) {
    const readView = name => JSON.parse(readFileSync(new URL(name, PUBLISHED), 'utf8'));
    const readback = readFileSync(readbackPath, 'utf8');
    const scopePath = process.argv.includes('--row-scope') ? process.argv[process.argv.indexOf('--row-scope') + 1] : null;
    if (process.argv.includes('--row-scope') && !scopePath) { console.error('Give the exact account row scope DATA file after --row-scope.'); process.exit(2); }
    const scope = scopePath ? JSON.parse(readFileSync(scopePath, 'utf8')) : null;
    const views = workflowViewsWithAccountReadback(readView('workflows.json'), readView('workflow-steps.json'), readback, scope);
    writeFileSync(new URL('workflows.json', PUBLISHED), `${JSON.stringify(views.workflows, null, 1)}\n`);
    writeFileSync(new URL('workflow-steps.json', PUBLISHED), `${JSON.stringify(views.steps, null, 1)}\n`);
  }
  const text = rebuiltRecipesText();
  if (process.argv.includes('--check')) {
    if (readFileSync(TARGET, 'utf8') !== text) { console.error('recipes/workflows.json is not what the published files make: run rebuild-recipes.mjs.'); process.exit(1); }
  } else writeFileSync(TARGET, text);
}
