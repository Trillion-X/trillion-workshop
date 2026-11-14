// tools/workflows/read-data/choose-the-workflows-that-fire.mjs
//
// Every workflow is a candidate branch of the one tree. Each says when it fires on its own row (branches/fires-when.json):
// a list of conditions, each the {fields, tree} tool:filter-rows-by-rules takes, evaluated over one seed part. This reads
// every workflow the person has (their list of workflows, under each row type arrivals/recipe-row-types.json names) and
// every recipe this Workshop installs (recipes/), the person's own row winning, and lets the formulas engine say which
// conditions keep which parts. Nothing here names a workflow, a branch or a tag: a workflow added, or a kit installed,
// is a candidate at once.
//
//   chooseTheWorkflowsThatFire({ parts, operators? }, { door })
//     -> { workflows, own, catalog_only, chosen: [{ workflow, label, part, condition, made_by, from }],
//          unfinished: [{ workflow, condition, incomplete }], unconditioned: [{ workflow, label }], unmatched_parts }
//
// A condition that is Off, unfinished (a rule the engine cannot evaluate) or has no rule at all chooses nothing; the
// last two are named so the run can fix them. A workflow with no condition is named in unconditioned, so the run can
// judge it by its words and write the condition it judged back onto the workflow's row.

import { readdirSync, readFileSync } from 'node:fs';
import { filterRecords } from '../../formulas/do-work/requests.mjs';

const RECIPES = new URL('../recipes/', import.meta.url);
const ROW_TYPES = JSON.parse(readFileSync(new URL('../arrivals/recipe-row-types.json', import.meta.url), 'utf8'));
export const FIRES_WHEN = JSON.parse(readFileSync(new URL('../branches/fires-when.json', import.meta.url), 'utf8'));

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const parsed = (value, where) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw new Error(`${where} is not JSON.`); }
};

// Every problem with one workflow's conditions, as sentences; none when they are absent.
export function conditionProblems(conditions, where = FIRES_WHEN.field) {
  if (conditions === undefined) return [];
  if (!Array.isArray(conditions)) return [`${where} must be a list of conditions { label, condition: { fields, tree }, made_by, state }.`];
  const problems = [];
  conditions.forEach((item, index) => {
    const name = `${where}[${index}]`;
    if (!object(item) || typeof item.label !== 'string' || !item.label.trim()) { problems.push(`${name} must have a label saying the condition in words.`); return; }
    if (!object(item.condition) || !Array.isArray(item.condition.fields) || !object(item.condition.tree)) { problems.push(`${name}.condition must be { fields, tree } as tool:filter-rows-by-rules takes them.`); return; }
    if (typeof item.made_by !== 'string' || !item.made_by) problems.push(`${name}.made_by must say who wrote the condition.`);
    let answer;
    try { answer = filterRecords({ records: [], fields: item.condition.fields, tree: item.condition.tree }); } catch (error) { problems.push(`${name}.condition is refused: ${error.message}`); return; }
    if (answer.incomplete.length) problems.push(`${name}.condition has unfinished rules: ${JSON.stringify(answer.incomplete)}.`);
    if (!answer.reads.length) problems.push(`${name}.condition reads no field, so it would keep every part.`);
  });
  return problems;
}

// The installed catalog: every recipe of the files beside this module, by id.
function catalogRecipes() {
  const byId = new Map();
  for (const name of readdirSync(RECIPES).filter(file => file.endsWith('.json')).sort()) {
    for (const { payload } of JSON.parse(readFileSync(new URL(name, RECIPES), 'utf8')).records ?? []) {
      if (payload?.id && !byId.has(payload.id)) byId.set(payload.id, { label: payload.label, conditions: payload[FIRES_WHEN.field] });
    }
  }
  return byId;
}

// The person's own workflow rows, by recipe id; the first row type that holds an id wins.
async function ownWorkflows(door) {
  const byId = new Map();
  for (const type of ROW_TYPES.recipe.types) {
    for await (const row of door.list({ type, prefix: ROW_TYPES.recipe.id_prefix })) {
      const value = row.value ?? {};
      const id = typeof value.recipe === 'string' && value.recipe ? value.recipe : `workflow:${row.id.slice(ROW_TYPES.recipe.id_prefix.length)}`;
      if (byId.has(id)) continue;
      byId.set(id, { label: value.title, conditions: parsed(value[FIRES_WHEN.field], `${row.id} ${FIRES_WHEN.field}`) });
    }
  }
  return byId;
}

export async function chooseTheWorkflowsThatFire(input = {}, { door }) {
  const { parts, operators } = input;
  if (!Array.isArray(parts) || !parts.length || !parts.every(object)) throw new Error('parts must be a list of the seed\'s parts, each an object of its typed fields.');
  const catalog = catalogRecipes();
  const own = await ownWorkflows(door);
  const ids = [...new Set([...own.keys(), ...catalog.keys()])].sort();
  const chosen = [], unfinished = [], unconditioned = [];
  for (const workflow of ids) {
    const mine = own.get(workflow), shipped = catalog.get(workflow);
    const label = mine?.label ?? shipped?.label;
    const [conditions, from] = mine?.conditions !== undefined ? [mine.conditions, 'own'] : [shipped?.conditions, mine ? 'catalog-condition' : 'catalog'];
    const live = (Array.isArray(conditions) ? conditions : []).filter(item => !FIRES_WHEN.off_states.includes(item?.state));
    if (!live.length) { unconditioned.push({ workflow, label }); continue; }
    for (const item of live) {
      const wrong = conditionProblems([item], `${workflow} ${FIRES_WHEN.field}`);
      if (wrong.length) { unfinished.push({ workflow, condition: item?.label ?? null, incomplete: wrong }); continue; }
      const answer = filterRecords({ records: parts, fields: item.condition.fields, tree: item.condition.tree, ...(operators ? { operators } : {}) });
      for (const part of answer.matches) chosen.push({ workflow, label, part, condition: item.label, made_by: item.made_by, from });
    }
  }
  const routed = new Set(chosen.map(item => item.part));
  return {
    workflows: ids.length,
    own: own.size,
    catalog_only: ids.filter(id => !own.has(id)).length,
    chosen,
    unfinished,
    unconditioned,
    unmatched_parts: parts.map((_, at) => at).filter(at => !routed.has(at)),
  };
}
