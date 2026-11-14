// tools/workflows/read-data/public-recipes.mjs
//
// The recipes the Workshop ships beside this tool (recipes/*.json, each { records: [{ payload }] }), read from those files
// in name order: every recipe, one by its id, and the one that claims a purpose by its `default_for` (old trillion's
// defaultWorkflowFor: a screen that needs "the setup workflow" asks for the recipe whose default_for names setup, never
// a recipe id it knows). Nothing is written and no recipe is known to the code.
import { readdirSync, readFileSync } from 'node:fs';

const RECIPES = new URL('../recipes/', import.meta.url);

/** Every shipped recipe's payload, file by file in name order. */
export function publicRecipes() {
  return readdirSync(RECIPES).filter(file => file.endsWith('.json')).sort()
    .flatMap(name => (JSON.parse(readFileSync(new URL(name, RECIPES), 'utf8')).records ?? []).map(record => record.payload).filter(Boolean));
}

/** The shipped recipe with this id, or a refusal naming it. */
export function publicRecipe(id) {
  const found = publicRecipes().find(payload => payload.id === id);
  if (!found) throw new Error(`No recipe ${id} is in the person's workflows or the recipes folder.`);
  return found;
}

/** The id of the shipped recipe whose `default_for` names `purpose`, or null when none does. */
export function defaultRecipeFor(purpose) {
  return publicRecipes().find(payload => [payload.default_for].flat().includes(purpose))?.id ?? null;
}
