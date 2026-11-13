// Every Workshop item ships with its kit (L082, tools/workflows/kit-template.json): each workflow recipe carries `kit`,
// each tool row `payload.kit`, and each kit passes kitProblems. The items that shipped before kits are named in
// test/items-without-a-kit.json; that file may only shrink: an item named there that now has a kit, or that is gone,
// must be taken out, and an item not named there with no kit is refused. Read by test/every-item-has-its-kit.test.mjs and
// run by .githooks/pre-commit and .githooks/pre-push, so a commit or push that adds an item with no kit stops.
//
//   node test-helpers/every-item-kit.mjs     prints every problem and exits 1, or exits 0 in silence

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, rows } from './tool-rows.mjs';
import { kitProblems } from '../tools/workflows/read-data/kit-problems.mjs';

export const OWED_FILE = resolve(root, 'test/items-without-a-kit.json');
const RECIPES = resolve(root, 'tools/workflows/recipes/workflows.json');

/** Every item: workflow recipes and tool rows, each with its id, kind and kit problems (null when it has no kit). */
export function items() {
  const recipes = JSON.parse(readFileSync(RECIPES, 'utf8')).records.map(record => record.payload);
  const tools = rows().filter(({ payload }) => payload.kind === 'ai-tool-descriptor').map(({ payload }) => payload);
  return [
    ...recipes.map(recipe => ({ id: recipe.id, kind: 'workflow', problems: recipe.kit === undefined ? null : kitProblems(recipe.kit, { recipe }) })),
    ...tools.map(tool => ({ id: tool.id, kind: 'tool', problems: tool.kit === undefined ? null : kitProblems(tool.kit, { tool }) })),
  ];
}

/** Every problem across the Workshop, as plain lines; none when every item ships its kit or is owed one from before. */
export function kitGateProblems({ owed = JSON.parse(readFileSync(OWED_FILE, 'utf8')) } = {}) {
  const problems = [];
  const owedIds = new Set([...(owed.workflows ?? []), ...(owed.tools ?? [])]);
  const all = items();
  const byId = new Map(all.map(item => [item.id, item]));
  for (const item of all) {
    if (item.problems === null && !owedIds.has(item.id)) problems.push(`${item.id} ships with no kit: add one (tools/workflows/kit-template.json shows every part).`);
    for (const problem of item.problems ?? []) problems.push(`${item.id}: ${problem}`);
  }
  for (const [part, kind] of [['workflows', 'workflow'], ['tools', 'tool']]) {
    for (const id of owed[part] ?? []) {
      const item = byId.get(id);
      if (!item || item.kind !== kind) problems.push(`test/items-without-a-kit.json names ${id}, which is not a ${kind} here: take it out.`);
      else if (item.problems !== null) problems.push(`test/items-without-a-kit.json names ${id}, which now has its kit: take it out.`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = kitGateProblems();
  if (problems.length) {
    console.error(`Every Workshop item ships with its kit (L082). ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map(line => `- ${line}`).join('\n')}`);
    process.exit(1);
  }
}
