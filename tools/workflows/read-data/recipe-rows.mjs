// tools/workflows/read-data/recipe-rows.mjs
//
// A workflow recipe is a row in a person's list of workflows, and its steps are rows in their list of workflow steps.
// A row holds no nested value, so what is nested (a recipe's input schema, source and wakes, a step's schema, checks,
// tool and actor policy) is kept as JSON text and read back here by parsing it. This module is that reading, and only
// that: it makes the recipe `payload` the validator and the runner take from the rows of one recipe.
//
//   recipeFromRows(recipeValues, stepValues[]) -> payload      one recipe from its row and its step rows
//   recipesFromViews(workflowsView, stepsView) -> payload[]    every recipe of two published view files (or door pages)
//
// A row is `{ id, values }` (a published view file) or `{ id, value }` (the records door); both are read.

const JSON_FIELDS = {
  recipe: ['input_schema', 'source', 'wakes', 'definition'],
  step: ['checks', 'run_tool', 'actor_policy'],
};

const valuesOf = row => row?.values ?? row?.value ?? {};

/** Apply a checked local patch to exact editable list rows, preserving their row order. */
export function applyWorkflowRowUpdates(workflowsView, stepsView, updateData) {
  if (updateData?.account_row_sync?.status !== 'pending' || updateData.account_row_sync.canonical_rows_readback !== false) {
    throw new Error('Local workflow row updates require explicit pending account synchronization and no canonical row readback.');
  }
  const apply = (view, updates, label) => {
    if (!Array.isArray(view?.rows) || !Array.isArray(updates)) throw new Error(`${label} view and updates must be arrays of rows.`);
    const rows = view.rows.map(row => ({ ...row, values: { ...valuesOf(row) } }));
    for (const update of updates) {
      if (!update || typeof update.id !== 'string' || !update.values || typeof update.values !== 'object' || Array.isArray(update.values)) {
        throw new Error(`Every ${label} row update needs an id and values object.`);
      }
      const target = rows.find(row => row.id === update.id);
      if (target) target.values = { ...target.values, ...update.values };
      else {
        if (update.values.recipe === undefined) throw new Error(`New ${label} row ${update.id} must include its recipe link.`);
        rows.push({ id: update.id, values: { ...update.values } });
      }
    }
    return { ...view, rows };
  };
  return {
    workflows: apply(workflowsView, updateData.workflow_rows, 'workflow'),
    steps: apply(stepsView, updateData.step_rows, 'workflow step'),
    account_row_sync: updateData.account_row_sync,
  };
}

function parsed(text, where) {
  try { return JSON.parse(text); } catch { throw new Error(`${where} holds text that is not JSON.`); }
}

function present(values, fields, where, into) {
  for (const field of fields) if (values[field] !== undefined && values[field] !== '') into[field] = parsed(values[field], `${where} ${field}`);
}

// One recipe's payload from its row and the rows of its steps (any order: the steps' `position` orders them).
export function recipeFromRows(recipeRow, stepRows) {
  const values = valuesOf(recipeRow);
  const where = `Recipe ${values.recipe ?? recipeRow?.id}`;
  if (typeof values.recipe !== 'string' || !values.recipe.startsWith('workflow:')) throw new Error(`${where} has no recipe id ("workflow:...").`);
  const payload = { kind: 'workflow-recipe', id: values.recipe, label: values.title, job: values.job };
  if (values.produces) payload.produces = values.produces;
  if (Array.isArray(values.made_from) && values.made_from.length) payload.made_from = values.made_from;
  present(values, JSON_FIELDS.recipe, where, payload);
  const ordered = stepRows.map(valuesOf).sort((a, b) => a.position - b.position);
  if (ordered.length === 0 && payload.definition === undefined) throw new Error(`${where} has no steps.`);
  if (ordered.length) {
    payload.steps = ordered.map(step => {
      const made = { id: step.step, title: step.title, do: step.do, submit: parsed(step.submit, `${where} step ${step.step} submit`) };
      present(step, JSON_FIELDS.step, `${where} step ${step.step}`, made);
      return made;
    });
  }
  return payload;
}

// Every recipe of the two views, ordered by id. A step row links to its recipe row by that row's id; a step that links
// to no recipe row is refused, so a view that lost a recipe cannot pass as a smaller catalogue.
export function recipesFromViews(workflowsView, stepsView) {
  const stepsOf = new Map();
  for (const row of stepsView.rows) {
    const link = valuesOf(row).recipe?.[0];
    if (typeof link !== 'string') throw new Error(`Step ${row.id} links to no recipe.`);
    if (!stepsOf.has(link)) stepsOf.set(link, []);
    stepsOf.get(link).push(row);
  }
  const known = new Set(workflowsView.rows.map(row => row.id));
  for (const link of stepsOf.keys()) if (!known.has(link)) throw new Error(`Steps link to recipe ${link}, which the workflows view does not hold.`);
  return workflowsView.rows
    .map(row => recipeFromRows(row, stepsOf.get(row.id) ?? []))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
