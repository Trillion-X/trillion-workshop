// tools/workflows/read-data/start-a-recipe-run.mjs
//
// Starts a run of one recipe by writing one job for the person's AI into the person's own database (the table ai_job,
// sql/001-ai-job.sql), and nothing else: no step is done here, nothing is scheduled and nothing is kept outside that row.
// The engine runs this for a recipe row because the recipes' row source names it in `invoke_with`, with the recipe's id in
// `input.row`. A wake starts it with the wake's input and its cause in the task; the AI that next connects picks the job
// up (select ... from ai_job where status = 'waiting').
//
//   startARecipeRun({ input: { row, ...wake input }, task: { request_key, cause } }, { sql })
//     -> { job: <ai_job id>, status: 'written' | 'already-there' | 'nothing-arrived' }
//
// The recipe is the person's own row first (their tables workflow_recipe and workflow_step, made into a recipe by
// recipe-rows.mjs), and otherwise a public recipe the Workshop carries (recipes/). When both hold the id, the person's own
// row wins. The table names are DATA (arrivals/recipe-row-types.json).
//
// A wake whose input names an arrival source (arrivals/arrival-sources.json) starts the run only from the changed rows that
// source keeps, each mapped to a seed in the run's input; when it keeps none, nothing is written (status
// 'nothing-arrived'), so an AI reply arriving beside a person's message starts nothing of its own.
//
// The job's id is `ai-job:<recipe id>:<request key>`. A wake's request key is its cause key, one per firing, and a
// call brings its own retry key, so a firing or a call that comes again finds its job and changes nothing: the insert
// does nothing when the id is there (`on conflict do nothing`), however many firings race.
//
// Every job carries its recipe's kit (L082: the lists with example rows, the tools, numbered instructions and a worked
// example), so no run starts without one: the kit the Workshop ships beside the recipe (kits/<slug>.json), else the kit on
// the person's own recipe row (its `kit` field), else the kit drafted from the recipe's own steps at this moment
// (draft-a-kit.mjs), marked `draft: true` with what it still lacks in `owes`. A recipe is never refused for lacking a kit:
// the person's older workflows (written before kits) keep running, each with the kit its own rows make.

import { readFileSync } from 'node:fs';
import { recipeFromRows } from './recipe-rows.mjs';
import { readJob, runId } from './step-agents.mjs';
import { publicRecipe } from './public-recipes.mjs';
import { kitFor } from './kit-for-a-run.mjs';
export { kitFor };
import { identifier } from './sql.mjs';
import { filterRecords } from '../../formulas/do-work/requests.mjs';

const JOB_KIND = 'ai-job';
const TABLES = JSON.parse(readFileSync(new URL('../arrivals/recipe-row-types.json', import.meta.url), 'utf8'));
const ARRIVALS = JSON.parse(readFileSync(new URL('../arrivals/arrival-sources.json', import.meta.url), 'utf8'));

// The person's own recipe with this id: its row in their table of workflows and the rows of its steps, or nothing.
async function ownRecipe(id, sql) {
  const slug = id.replace(/^workflow:/, '');
  const [row] = await sql(`select value from ${identifier(TABLES.recipe.table)} where id = $1`, [slug]);
  if (!row) return null;
  const steps = await sql(`select value from ${identifier(TABLES.step.table)} where recipe = $1 order by position, id`, [slug]);
  // A row with no steps and no definition only adds to an installed recipe (for example its own fires_when), so the
  // installed recipe runs.
  if (!steps.length && (row.value.definition === undefined || row.value.definition === '')) return null;
  return recipeFromRows({ value: row.value }, steps.map(step => ({ value: step.value })));
}

const parsed = (text, where) => { if (text === undefined || text === null || text === '') return null; if (typeof text !== 'string') return text; try { return JSON.parse(text); } catch { throw new Error(`${where} is not JSON.`); } };
const atPath = (row, path) => (Array.isArray(path) ? path : [path]).reduce((value, key) => (value == null ? undefined : value[key]), row);

// The seeds that arrived: the changed rows the cause names, kept by the source row's filter and mapped by its seed paths.
async function arrivedSeeds(sourceId, cause, sql) {
  const [found] = await sql(`select value from ${identifier(ARRIVALS.table)} where id = $1`, [sourceId]);
  if (!found) throw new Error(`There is no arrival source ${sourceId}.`);
  const source = found.value;
  if (source.state === 'Off') return [];
  if (typeof source.read_table !== 'string' || !source.read_table) throw new Error(`Arrival source ${sourceId} names no read_table.`);
  const filter = parsed(source.filter, `Arrival source ${sourceId} filter`);
  const seed = parsed(source.seed, `Arrival source ${sourceId} seed`);
  if (!seed?.words) throw new Error(`Arrival source ${sourceId} names no seed.words path.`);
  const rows = [];
  for (const change of cause?.detail?.changes ?? []) {
    if (change?.deleted || typeof change?.id !== 'string') continue;
    const [read] = await sql(`select value from ${identifier(source.read_table)} where id = $1`, [change.id]);
    if (read) rows.push({ ...read.value, id: change.id });
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


export async function startARecipeRun({ input = {}, task = {} } = {}, { sql }) {
  const { row, ...given } = input;
  if (typeof row !== 'string' || !row) throw new Error('input.row must name the recipe to start.');
  if (typeof task.request_key !== 'string' || !task.request_key) throw new Error('task.request_key is missing.');
  const recipe = (await ownRecipe(row, sql)) ?? publicRecipe(row);
  const id = runId(row, task.request_key);
  if (await readJob(sql, id)) return { job: id, status: 'already-there' };
  if (given[ARRIVALS.input_field] !== undefined) {
    const seeds = await arrivedSeeds(given[ARRIVALS.input_field], task.cause, sql);
    if (!seeds.length) return { job: null, status: 'nothing-arrived' };
    given[ARRIVALS.seeds_field] = seeds;
  }
  const value = {
    kind: JOB_KIND,
    status: 'waiting',
    row,
    label: recipe.label,
    // What the run is for, as words: the outcome a finish of this job is checked against (hand-work-to-ais checkOutcome
    // reads `outcome` before `job`, and `job` here is the step list, so without it no run could ever be finished).
    outcome: recipe.job ?? recipe.label,
    job: recipe.steps,
    kit: kitFor(recipe),
    input: given,
    cause: task.cause ?? null,
  };
  const written = await sql('insert into ai_job (id, value) values ($1, $2::jsonb) on conflict (id) do nothing returning id', [id, JSON.stringify(value)]);
  return { job: id, status: written.length ? 'written' : 'already-there' };
}
