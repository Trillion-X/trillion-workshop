// Every Workshop item ships with its kit (L082, tools/workflows/kit-template.json). The kit of an item is one file beside
// it: <the item's folder>/kits/<item id without its tool: or workflow: prefix>.json, a tool's in its own tool folder, a
// workflow's in tools/workflows. One shape, one validator (kitProblems). The items that shipped before kits are named in
// test/items-without-a-kit.json, dated; that file may only shrink: an id there that now has a kit, or is gone, must come
// out, a kit-less item not named there is refused, and a push that adds an id to it is refused (the push gate hands this
// file the copy of the list at the tip the push lands on). Read by test/every-item-has-its-kit.test.mjs and run by the push
// gate push-time-workshop-every-item-ships-its-kit.py, so a push that adds an item with no kit stops.
//
//   node test-helpers/every-item-kit.mjs [--before FILE]    prints every problem and exits 1, or exits 0 in silence
//     --before FILE  the allowance list as it stood before this change; an id in the current list but not in FILE is refused

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, rows } from './tool-rows.mjs';
import { kitProblems } from '../tools/workflows/read-data/kit-problems.mjs';

export const OWED_FILE = resolve(root, 'test/items-without-a-kit.json');
const RECIPES = resolve(root, 'tools/workflows/recipes/workflows.json');

const slugOf = id => id.slice(id.indexOf(':') + 1);
export const kitFileOf = (folder, id) => resolve(root, 'tools', folder, 'kits', `${slugOf(id)}.json`);
const readKit = file => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);

/** Every item: workflow recipes and tool rows, each with its id, kind, kit file and kit problems (null when it has no kit file). */
export function items() {
  const recipes = JSON.parse(readFileSync(RECIPES, 'utf8')).records.map(record => record.payload);
  const tools = rows().filter(({ payload }) => payload.kind === 'ai-tool-descriptor');
  const make = (kind, id, file, problemsOf) => {
    const kit = readKit(file);
    return { id, kind, file, problems: kit === undefined ? null : problemsOf(kit) };
  };
  return [
    ...recipes.map(recipe => make('workflow', recipe.id, kitFileOf('workflows', recipe.id), kit => kitProblems(kit, { recipe }))),
    ...tools.map(({ folder, payload }) => make('tool', payload.id, kitFileOf(folder, payload.id), kit => kitProblems(kit, { tool: payload }))),
  ];
}

const idsOf = owed => new Set([...(owed.workflows ?? []), ...(owed.tools ?? [])]);

/** Every problem across the Workshop, as plain lines; none when every item ships its kit or is owed one from before.
 *  `before` is the allowance list as it stood at the commit or push this is compared with (none: no comparison). */
export function kitGateProblems({ owed = JSON.parse(readFileSync(OWED_FILE, 'utf8')), before = null } = {}) {
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
  if (before) {
    const was = idsOf(before);
    for (const id of owedIds) if (!was.has(id)) problems.push(`test/items-without-a-kit.json gained ${id}: the list only shrinks, so give ${id} its kit instead.`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const at = process.argv.indexOf('--before');
  const before = at > 0 && existsSync(process.argv[at + 1]) ? JSON.parse(readFileSync(process.argv[at + 1], 'utf8')) : null;
  const problems = kitGateProblems({ before });
  if (problems.length) {
    console.error(`Every Workshop item ships with its kit (L082). ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map(line => `- ${line}`).join('\n')}`);
    process.exit(1);
  }
}
