// tools/workflows/read-data/derived-records.mjs
//
// What a workflow row holds that is made from the rest of it, never written by hand, when recipes are published
// (do-work/rebuild-recipes.mjs) and checked on every shipped recipe (test/derived-records.test.mjs):
//   - `records`: the rights a run of the row holds when its tool takes them from the row (trillion-rust from_listed_row):
//     `runs`, every tool id a step asks and every tool a tools:run step names with values given in the step (a server's
//     tool keyed `<host>/<tool>`), and `rights`, one per ask the run's door answers (ask-rights.json) whose input names
//     what it is over with a value given in the step. A row with neither holds none. A fact carries what it can, so no
//     reader tool is added for the facts a row's wakes hear.
//   - the wakes of its conditions: one per fires_when condition that is not off, on the fact the choosing run tells
//     (branches/fires-when.json chosen_wake), matching this workflow and that condition, with the condition's input.
// Every other wake the row declares is kept as written. Nothing here names a workflow, a tool or a condition.

import { readFileSync } from 'node:fs';
import { definitionOf } from '../../write-a-job-done-in-several-steps-have/read-data/workflows.mjs';

const read = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const FIRES_WHEN = read('../branches/fires-when.json');
const ASK_RIGHTS = read('../ask-rights.json').asks;
const TOOL = /^tool:[a-z0-9][a-z0-9-]*$/;
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const parsed = value => (typeof value === 'string' ? JSON.parse(value) : value);

/** Every ask of a definition and the definitions it uses: { name, input }. */
function asksOf(definition) {
  const asks = [];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!object(value)) return;
    if (value.kind === 'ask' && object(value.config) && typeof value.config.name === 'string') asks.push({ name: value.config.name, input: value.config.input });
    Object.values(value).forEach(walk);
  };
  walk(definition);
  return asks;
}

/** The rights a run of `recipe` holds, made from its asks: { runs?, rights? }, or null when it needs none. */
export function recordsOf(recipe) {
  const asks = asksOf(definitionOf(recipe));
  const runs = new Set(asks.map(ask => ask.name).filter(name => TOOL.test(name)));
  const rights = [];
  for (const { name, input } of asks) {
    const right = ASK_RIGHTS[name];
    if (right?.runs_from && object(input)) {
      const tool = input[right.runs_from];
      const address = right.host_from ? input[right.host_from] : undefined;
      if (typeof tool === 'string' && tool && address === undefined) { if (TOOL.test(tool)) runs.add(tool); }
      else if (typeof tool === 'string' && tool && typeof address === 'string') {
        const host = URL.canParse(address) ? new URL(address).hostname : '';
        if (host.includes('.')) runs.add(`${host}/${tool}`);
      }
      continue;
    }
    const id = right?.at && object(input) ? input[right.id_from] : undefined;
    if (typeof id !== 'string' || !id) continue;
    const held = rights.find(item => item.at === right.at && item.id === id);
    if (held) { if (!held.operations.includes(name)) held.operations.push(name); continue; }
    rights.push({ at: right.at, id, operations: [name] });
  }
  rights.sort((a, b) => `${a.at} ${a.id}`.localeCompare(`${b.at} ${b.id}`));
  const ran = [...runs].sort();
  return ran.length || rights.length ? { ...(rights.length ? { rights } : {}), ...(ran.length ? { runs: ran } : {}) } : null;
}

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The wakes `recipe`'s conditions make: one per condition not off, on the fact a choosing run tells. */
export function chosenWakesOf(recipe) {
  const wake = FIRES_WHEN.chosen_wake;
  const conditions = parsed(recipe[FIRES_WHEN.field]) ?? [];
  if (!Array.isArray(conditions)) return [];
  const first = recipe.definition?.steps?.[0]?.id ?? recipe.steps?.[0]?.id;
  return conditions.filter(condition => object(condition) && typeof condition.label === 'string' && !FIRES_WHEN.off_states.includes(condition.state))
    .map(condition => ({
      id: `${wake.id_start}${slug(condition.label)}`,
      on: { fact: { kind: wake.kind, from: wake.from, match: { workflow: recipe.id, condition: condition.label } } },
      budget: object(condition.budget) ? condition.budget : wake.budget,
      input: { ...(first ? { start_at: first } : {}), ...(object(condition.input) ? condition.input : {}) },
    }));
}

/** `recipe` with its made fields made again: `records` and its conditions' wakes (other wakes kept, in their order). Each
 *  field stays where it was in the row, so a row whose made fields are already right is the same row. */
export function withDerivedRecords(recipe) {
  const records = recordsOf(recipe);
  const own = (recipe.wakes ?? []).filter(wake => !String(wake.id).startsWith(FIRES_WHEN.chosen_wake.id_start));
  const wakes = [...own, ...chosenWakesOf(recipe)];
  const made = { ...recipe, wakes, records };
  if (!wakes.length) delete made.wakes;
  if (!records) delete made.records;
  return made;
}
