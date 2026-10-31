// tools/workflows/do-work/tool-gaps.mjs
//
// Prints the tools the workflow recipes name that nothing offers: no Workshop tool row and no host tool (host-tools.json).
// The output is the list of tools to build or port next, and which recipes wait for each. It reads the recipes as they are
// in recipes/workflows.json (generated from the published list) and writes nothing.
//
//   node tools/workflows/do-work/tool-gaps.mjs TOOLS_FOLDER
//     -> { missing: { "tool:x": ["workflow:a", ...] }, by_recipe: { "workflow:a": ["tool:x"] } }
//
// TOOLS_FOLDER is the Workshop's tools folder (the one holding every tools/<name>/tool-rows.json).

import { readFileSync } from 'node:fs';
import { recipeToolGaps } from '../read-data/recipe-problems.mjs';
import { workshopToolIds } from '../read-data/workshop-tool-ids.mjs';

// The gaps of every recipe in a `{ records: [{ payload }] }` file, against the tool rows under `tools`.
export function toolGaps(recipesFile, tools) {
  const known = workshopToolIds(tools);
  const byRecipe = {};
  const missing = {};
  for (const { payload } of JSON.parse(readFileSync(recipesFile, 'utf8')).records) {
    const gaps = recipeToolGaps(payload, { known });
    if (gaps.length) byRecipe[payload.id] = gaps;
    for (const id of gaps) (missing[id] ??= []).push(payload.id);
  }
  return { missing: Object.fromEntries(Object.entries(missing).sort()), by_recipe: byRecipe };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2]) { console.error('Give the Workshop tools folder: node tool-gaps.mjs TOOLS_FOLDER'); process.exit(2); }
  console.log(JSON.stringify(toolGaps(new URL('../recipes/workflows.json', import.meta.url), process.argv[2]), null, 2));
}
