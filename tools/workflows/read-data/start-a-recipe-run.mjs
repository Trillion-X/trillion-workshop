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
// The recipe is the person's own row first (their list of workflows and its steps, read through the door and made into
// a recipe by recipe-rows.mjs), and otherwise a public recipe the Workshop carries (recipes/). When both hold the id, the
// person's own row wins.
//
// The person's own rows may be kept under more than one row type (arrivals/recipe-row-types.json); each is tried in order.
//
// A wake whose input names an arrival source (arrivals/arrival-sources.json) starts the run only from the changed rows that
// source keeps, each mapped to a seed in the run's input; when it keeps none, nothing is written (status
// 'nothing-arrived'), so an AI reply arriving beside a person's message starts nothing of its own.
//
// The job's id is `ai-job:<recipe id>:<request key>`. A wake's request key is its cause key, one per firing, and a
// call at the door brings its own retry key, so a firing or a call that comes again finds its job and changes nothing.

import { readdirSync, readFileSync } from 'node:fs';
import { recipeFromRows } from './recipe-rows.mjs';
import { filterRecords } from '../../formulas/do-work/requests.mjs';

const RECIPES = new URL('../recipes/', import.meta.url);
const JOB_KIND = 'ai-job';
const ROW_TYPES = JSON.parse(readFileSync(new URL('../arrivals/recipe-row-types.json', import.meta.url), 'utf8'));
const ARRIVALS = JSON.parse(readFileSync(new URL('../arrivals/arrival-sources.json', import.meta.url), 'utf8'));

// The person's own recipe with this id: its row in their list of workflows and the rows of its steps, or nothing.
async function ownRecipe(id, door) {
  const slug = id.replace(/^workflow:/, '');
  for (const type of ROW_TYPES.recipe.types) {
    const row = await door.read(type, `${ROW_TYPES.recipe.id_prefix}${slug}`);
    if (!row) continue;
    const steps = new Map();
    for (const stepType of ROW_TYPES.step.types) {
      for await (const step of door.list({ type: stepType, prefix: `${ROW_TYPES.step.id_prefix}${slug}--` })) if (step.value?.recipe?.[0] === slug && !steps.has(step.id)) steps.set(step.id, step);
    }
    return recipeFromRows({ value: row }, [...steps.values()]);
  }
  return null;
}

const parsed = (text, where) => { if (text === undefined || text === null || text === '') return null; if (typeof text !== 'string') return text; try { return JSON.parse(text); } catch { throw new Error(`${where} is not JSON.`); } };
const atPath = (row, path) => (Array.isArray(path) ? path : [path]).reduce((value, key) => (value == null ? undefined : value[key]), row);

// The seeds that arrived: the changed rows the cause names, kept by the source row's filter and mapped by its seed paths.
async function arrivedSeeds(sourceId, cause, door) {
  const source = await door.read(ARRIVALS.row_type, sourceId);
  if (!source) throw new Error(`There is no arrival source ${sourceId}.`);
  if (source.state === 'Off') return [];
  if (typeof source.read_type !== 'string' || !source.read_type) throw new Error(`Arrival source ${sourceId} names no read_type.`);
  const filter = parsed(source.filter, `Arrival source ${sourceId} filter`);
  const seed = parsed(source.seed, `Arrival source ${sourceId} seed`);
  if (!seed?.words) throw new Error(`Arrival source ${sourceId} names no seed.words path.`);
  const rows = [];
  for (const change of cause?.detail?.changes ?? []) {
    if (change?.deleted || typeof change?.id !== 'string') continue;
    const value = await door.read(source.read_type, change.id);
    if (value) rows.push({ ...value, id: change.id });
  }
  let kept = rows;
  if (filter && rows.length) {
    const answer = filterRecords({ records: rows, fields: filter.fields, tree: filter.tree });
    if (answer.incomplete?.length) throw new Error(`Arrival source ${sourceId} has an unfinished filter: ${JSON.stringify(answer.incomplete)}.`);
    kept = answer.matches.map(at => rows[at]);
  }
  return kept.map(row => ({ words: atPath(row, seed.words), came_from: atPath(row, seed.came_from ?? ['id']), ...(seed.at ? { at: atPath(row, seed.at) } : {}) }))
    .filter(item => typeof item.words === 'string' && item.words.trim());
}

// The public recipe with this id, read from the recipe files beside this module.
function publicRecipe(id) {
  for (const name of readdirSync(RECIPES).filter(file => file.endsWith('.json'))) {
    const found = JSON.parse(readFileSync(new URL(name, RECIPES), 'utf8')).records.find(record => record.payload?.id === id);
    if (found) return found.payload;
  }
  throw new Error(`No recipe ${id} is in the person's workflows or the recipes folder.`);
}

export async function startARecipeRun({ input = {}, task = {} } = {}, { door }) {
  const { row, ...given } = input;
  if (typeof row !== 'string' || !row) throw new Error('input.row must name the recipe to start.');
  if (typeof task.request_key !== 'string' || !task.request_key) throw new Error('task.request_key is missing.');
  const recipe = (await ownRecipe(row, door)) ?? publicRecipe(row);
  const id = `${JOB_KIND}:${row}:${task.request_key}`;
  if (await door.read(JOB_KIND, id)) return { job: id, status: 'already-there' };
  if (given[ARRIVALS.input_field] !== undefined) {
    const seeds = await arrivedSeeds(given[ARRIVALS.input_field], task.cause, door);
    if (!seeds.length) return { job: null, status: 'nothing-arrived' };
    given[ARRIVALS.seeds_field] = seeds;
  }
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
