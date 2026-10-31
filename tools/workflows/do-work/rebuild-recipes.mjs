// tools/workflows/do-work/rebuild-recipes.mjs
//
// recipes/workflows.json is generated, never edited by hand. The workflows are rows in a list (the public view of it is
// published into published/workflows.json and published/workflow-steps.json by tool:publish-a-list-view-as-a-file);
// this makes the recipe rows the validator and the engine's recipe row source read from those two files.
//
//   node tools/workflows/do-work/rebuild-recipes.mjs           writes recipes/workflows.json
//   node tools/workflows/do-work/rebuild-recipes.mjs --check   exit 1 when the file on disk is not what the two published files make

import { readFileSync, writeFileSync } from 'node:fs';
import { recipesFromViews } from '../read-data/recipe-rows.mjs';

const PUBLISHED = new URL('../published/', import.meta.url);
const TARGET = new URL('../recipes/workflows.json', import.meta.url);

// The text of recipes/workflows.json that the two published view files make.
export function rebuiltRecipesText(published = PUBLISHED) {
  const view = name => JSON.parse(readFileSync(new URL(name, published), 'utf8'));
  const recipes = recipesFromViews(view('workflows.json'), view('workflow-steps.json'));
  const about = 'Generated from published/workflows.json and published/workflow-steps.json by do-work/rebuild-recipes.mjs; edit the list those files publish, never this file.';
  return `${JSON.stringify({ about, records: recipes.map(payload => ({ payload })) }, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = rebuiltRecipesText();
  if (process.argv.includes('--check')) {
    if (readFileSync(TARGET, 'utf8') !== text) { console.error('recipes/workflows.json is not what the published files make: run rebuild-recipes.mjs.'); process.exit(1); }
  } else writeFileSync(TARGET, text);
}
