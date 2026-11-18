// tools/write-a-job-done-in-several-steps-have/read-data/run-a-workflow.mjs
//
// A person's workflow run on the workflow engine in one call: the recipe (its payload, or its row and its step rows as
// the person's lists keep them) and its input go in, with the answers known so far, and the run comes back: `paused`
// at the first step with no answer (the steps it waits on are in `waiting`), or finished. The recipe becomes an engine
// definition through the older version's own definitionOf (read-data/workflows.mjs, moved here whole), and the engine is the
// one-call runner (tools/run-a-workflow-definition-on-the-workflow-engine-in-one-call). Nothing is stored: no queue, no
// table, no records door. The kit a run carries is chosen before the engine is called (kitFor), never inside it.
//
// Invariants:
//   - A recipe with its own `definition` runs as that definition; ordered steps run as definitionOf makes them (an ask
//     per step, and after a step with checks the steps that judge them, with the lookups' definitions in `uses`).
//   - An answer is given by step id; a step's checks run on the engine as ordinary steps, so a bad answer fails the
//     run there, naming the rule and the values that break it, never judged here.
import { readFileSync } from 'node:fs';
import { definitionOf } from './workflows.mjs';
import { recipeFromRows } from '../../workflows/read-data/recipe-rows.mjs';
import { kitFor } from '../../workflows/read-data/kit-for-a-run.mjs';
import { makeWorkflowDefinitionRunner } from '../../run-a-workflow-definition-on-the-workflow-engine-in-one-call/src/workflow-definition-runner.mjs';

const ENGINE = new URL('../../build-engine-modules-for-web-hosts/built-stored-bytes/workflow-engine/', import.meta.url);
let loaded = null;

/** The built workflow engine (wasm), loaded once per process. */
export async function workflowEngine() {
  loaded ??= (async () => {
    const engine = await import(new URL('workflow_engine.js', ENGINE).href);
    await engine.default({ module_or_path: readFileSync(new URL('workflow_engine_bg.wasm', ENGINE)) });
    return engine;
  })();
  return loaded;
}

/** The recipe as its payload: given as one, or made from the person's recipe row and step rows. */
export function recipeOf({ recipe = null, row = null, steps = [] }) {
  if (recipe) return recipe;
  if (row) return recipeFromRows(row, steps);
  throw new Error('Give recipe (a recipe payload) or row with its steps (the rows the person keeps).');
}

/** The kit the run carries, chosen before the engine runs. */
export const kitOf = recipe => kitFor(recipe);

/** One run: { recipe | row + steps, input?, answers? } → { definition, run } where run.status is the engine's. */
export async function runAWorkflow({ recipe = null, row = null, steps = [], input = {}, answers = {}, partition = 'person' } = {}, { engine = workflowEngine } = {}) {
  const payload = recipeOf({ recipe, row, steps });
  const definition = definitionOf(payload);
  const runner = makeWorkflowDefinitionRunner(engine);
  const run = await runner.runWorkflowDefinition({ definitions: [definition, ...(definition.uses ?? [])], workflow_id: definition.id, input, answers, partition });
  return { definition, run };
}

/** tool:run-workflow-definition: given definitions and a workflow_id, those run as they are; given a recipe (or its row
 *  and step rows), it is made a definition first. Returns the run (status, waiting, each step's output), and the
 *  definition made when a recipe was given. */
export async function runWorkflow({ definitions = null, workflow_id = null, recipe = null, row = null, steps = [], input = {}, answers = {}, partition = 'person' } = {}, { engine = workflowEngine } = {}) {
  if (definitions) {
    if (recipe || row) throw new Error('Give definitions with a workflow_id, or a recipe (or its row and steps), not both.');
    return makeWorkflowDefinitionRunner(engine).runWorkflowDefinition({ definitions, workflow_id, input, answers, partition });
  }
  const { definition, run } = await runAWorkflow({ recipe, row, steps, input, answers, partition }, { engine });
  return { ...run, definition };
}
