// tools/workflows/read-data/start-a-recipe-run.mjs
//
// Starts a run of one recipe by writing one job for the person's AI into the person's own records, and nothing else:
// no step is done here, nothing is scheduled and nothing is kept outside that record. The engine runs this for a
// recipe row because the recipes' row source names it in `invoke_with`, with the recipe's id in `input.row`. A wake
// starts it with the wake's input and its cause in the task; the AI that next connects picks the job up.
//
//   startARecipeRun({ input: { row, ...wake input }, task: { request_key, cause } }, { door })
//     -> { job: <record id>, status: 'written' | 'already-there' }
//
// The job's id is `ai-job:<recipe id>:<request key>`. A wake's request key is its cause key, one per firing, and a
// call at the door brings its own retry key, so a firing or a call that comes again finds its job and changes nothing.

import { readdirSync, readFileSync } from 'node:fs';

const RECIPES = new URL('../recipes/', import.meta.url);
const JOB_KIND = 'ai-job';

// The recipe row with this id, read from the recipe files beside this module.
function recipeRow(id) {
  for (const name of readdirSync(RECIPES).filter(file => file.endsWith('.json'))) {
    const found = JSON.parse(readFileSync(new URL(name, RECIPES), 'utf8')).records.find(record => record.payload?.id === id);
    if (found) return found.payload;
  }
  throw new Error(`No recipe ${id} is in the recipes folder.`);
}

export async function startARecipeRun({ input = {}, task = {} } = {}, { door }) {
  const { row, ...given } = input;
  if (typeof row !== 'string' || !row) throw new Error('input.row must name the recipe to start.');
  if (typeof task.request_key !== 'string' || !task.request_key) throw new Error('task.request_key is missing.');
  const recipe = recipeRow(row);
  const id = `${JOB_KIND}:${row}:${task.request_key}`;
  if (await door.read(JOB_KIND, id)) return { job: id, status: 'already-there' };
  const value = {
    kind: JOB_KIND,
    status: 'waiting',
    row,
    label: recipe.label,
    job: recipe.steps,
    input: given,
    cause: task.cause ?? null,
  };
  await door.write([{ id, type: JOB_KIND, value }], { key: id });
  return { job: id, status: 'written' };
}
