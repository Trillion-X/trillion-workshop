// Every Workshop item ships with its kit (L082, tools/workflows/kit-template.json). The kit of an item is one file beside
// it: <the item's folder>/kits/<item id without its tool: or workflow: prefix>.json, a tool's in its own tool folder, a
// workflow's in tools/workflows. One shape, one validator (kitProblems). The items that shipped before kits are named in
// test/items-without-a-kit.json, dated; that file may only shrink: an id there that now has a kit, or is gone, must come
// out, a kit-less item not named there is refused, and a push that adds an id to it is refused (the push gate hands this
// file the copy of the list at the tip the push lands on). Read by test/every-item-has-its-kit.test.mjs and run by the push
// gate push-time-workshop-every-item-ships-its-kit.py, so a push that adds an item with no kit stops.
//
//   node test-helpers/every-item-kit.mjs [--before FILE] [--changed FILE] [--before-recipes FILE]
//     prints every problem and exits 1, or exits 0 in silence
//     --before FILE          the allowance list as it stood before this change; an id in the current list but not in FILE is refused
//     --changed FILE         the paths this change touches, one per line
//     --before-recipes FILE  tools/workflows/recipes/workflows.json as it stood before this change
//   With rules.refuse_changed_items true (tools/workflows/kit-template.json), an item still on the allowance list that this
//   change touches (a file in its tool folder outside kits/, or its workflow recipe) is refused until it has its kit.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, rows, rowsOf, folders, tools as TOOLS } from './tool-rows.mjs';
import { KIT_TEMPLATE, kitProblems } from '../tools/workflows/read-data/kit-problems.mjs';

export const OWED_FILE = resolve(root, 'test/items-without-a-kit.json');
const RECIPES = resolve(root, 'tools/workflows/recipes/workflows.json');

const slugOf = id => id.slice(id.indexOf(':') + 1);
export const kitFileOf = (folder, id) => resolve(root, 'tools', folder, 'kits', `${slugOf(id)}.json`);
// The folder a tool's kit goes in: the folder whose tool-rows.json offers the row. A row a tool-row-source lists from a records
// folder is offered by the folder holding the source, so its kit sits there, not in the records folder.
function offeringFolders() {
  const offered = new Map();
  for (const folder of folders) {
    if (!existsSync(resolve(TOOLS, folder, 'tool-rows.json'))) continue;
    for (const { folder: where, payload } of rowsOf(folder)) if (!offered.has(payload.id)) offered.set(payload.id, folder);
  }
  return offered;
}
const readKit = file => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);

/** Every item: workflow recipes and tool rows, each with its id, kind, kit file and kit problems (null when it has no kit file). */
export function items() {
  const recipes = JSON.parse(readFileSync(RECIPES, 'utf8')).records.map(record => record.payload);
  const offered = offeringFolders();
  const tools = rows().filter(({ payload }) => payload.kind === 'ai-tool-descriptor').map(({ folder, payload }) => ({ folder: offered.get(payload.id) ?? folder, payload }));
  const make = (kind, item, file, problemsOf) => {
    const id = item.id;
    const kit = readKit(file);
    return { id, kind, file, item, problems: kit === undefined ? null : problemsOf(kit) };
  };
  return [
    ...recipes.map(recipe => make('workflow', recipe, kitFileOf('workflows', recipe.id), kit => kitProblems(kit, { recipe }))),
    ...tools.map(({ folder, payload }) => make('tool', payload, kitFileOf(folder, payload.id), kit => kitProblems(kit, { tool: payload }))),
  ];
}

/** The ids of the items this change touches: a tool whose folder has a changed file outside kits/, a workflow whose recipe is new or differs from `beforeRecipes`. */
export function touchedIds({ changed = [], beforeRecipes = null } = {}) {
  const touched = new Set();
  const offered = offeringFolders();
  const inFolder = new Map(rows().map(({ folder, payload }) => [payload.id, offered.get(payload.id) ?? folder]));
  for (const [id, folder] of inFolder) {
    if (changed.some(path => path.startsWith(`tools/${folder}/`) && !path.startsWith(`tools/${folder}/kits/`))) touched.add(id);
  }
  if (beforeRecipes) {
    const was = new Map(beforeRecipes.records.map(record => [record.payload.id, JSON.stringify(record.payload)]));
    const now = JSON.parse(readFileSync(RECIPES, 'utf8')).records.map(record => record.payload);
    for (const recipe of now) if (was.get(recipe.id) !== JSON.stringify(recipe)) touched.add(recipe.id);
  }
  return touched;
}

const idsOf = owed => new Set([...(owed.workflows ?? []), ...(owed.tools ?? [])]);

/** Every problem across the Workshop, as plain lines; none when every item ships its kit or is owed one from before.
 *  `before` is the allowance list as it stood at the commit or push this is compared with (none: no comparison). */
export function kitGateProblems({ owed = JSON.parse(readFileSync(OWED_FILE, 'utf8')), before = null, touched = new Set(), rules = KIT_TEMPLATE.rules } = {}) {
  const problems = [];
  const owedIds = idsOf(owed);
  const all = items();
  const byId = new Map(all.map(item => [item.id, item]));
  for (const item of all) {
    if (item.problems === null && !owedIds.has(item.id)) problems.push(`${item.id} ships with no kit: add ${item.file.slice(root.length + 1)} (tools/workflows/kit-template.json shows every part).`);
    for (const problem of item.problems ?? []) problems.push(`${item.id}: ${problem}`);
  }
  for (const [part, kind] of [['workflows', 'workflow'], ['tools', 'tool']]) {
    for (const id of owed[part] ?? []) {
      const item = byId.get(id);
      if (!item || item.kind !== kind) problems.push(`test/items-without-a-kit.json names ${id}, which is not a ${kind} here: take it out.`);
      else if (item.problems !== null) problems.push(`test/items-without-a-kit.json names ${id}, which now has its kit: take it out.`);
    }
  }
  if (rules.refuse_changed_items) {
    for (const item of all) {
      if (item.problems === null && owedIds.has(item.id) && touched.has(item.id)) problems.push(`${item.id} is changed here and still has no kit: touching an item from before kits ends its exemption, so add ${item.file.slice(root.length + 1)}.`);
    }
  }
  if (before) {
    const was = idsOf(before);
    for (const id of owedIds) if (!was.has(id)) problems.push(`test/items-without-a-kit.json gained ${id}: the list only shrinks, so give ${id} its kit instead.`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const given = flag => { const at = process.argv.indexOf(flag); return at > 0 && existsSync(process.argv[at + 1]) ? readFileSync(process.argv[at + 1], 'utf8') : null; };
  const [beforeText, changedText, recipesText] = [given('--before'), given('--changed'), given('--before-recipes')];
  const touched = touchedIds({ changed: changedText ? changedText.split('\n').filter(Boolean) : [], beforeRecipes: recipesText ? JSON.parse(recipesText) : null });
  const problems = kitGateProblems({ before: beforeText ? JSON.parse(beforeText) : null, touched });
  if (problems.length) {
    console.error(`Every Workshop item ships with its kit (L082). ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map(line => `- ${line}`).join('\n')}`);
    process.exit(1);
  }
}
