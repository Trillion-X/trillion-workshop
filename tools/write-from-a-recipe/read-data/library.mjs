// tools/write-from-a-recipe/read-data/library.mjs
//
// The writing recipes and instruction blocks this folder keeps (writing-recipes.json, instruction-blocks.json), and
// the one way a request names a recipe and fills its work item. A request either hands its own recipe or names one
// here by recipe_id; a person's own blocks replace a block here with the same id.
import recipeRows from './writing-recipes.json' with { type: 'json' };
import blockRows from './instruction-blocks.json' with { type: 'json' };

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const RECIPES = recipeRows.records.map(record => record.payload);
export const BLOCKS = blockRows.records.map(record => record.payload);

/** The recipe a request means: its own `recipe`, else the kept recipe named by `recipe_id`. */
export function recipeOf(input) {
  if (plainObject(input.recipe)) return input.recipe;
  if (typeof input.recipe_id === 'string') {
    const found = RECIPES.find(recipe => recipe.id === input.recipe_id);
    if (!found) throw new Error(`No writing recipe is named ${input.recipe_id}; tool:list-writing-recipes lists them, or hand your own recipe.`);
    return found;
  }
  throw new Error('Give recipe (a writing recipe: instruction_plan, and optionally gate_policy and delivery_target) or recipe_id (from tool:list-writing-recipes).');
}

/** The work item with each declared field's default filled in where the request left it out; refuses a missing required field by name. */
export function workItemOf(recipe, given) {
  const workItem = plainObject(given) ? { ...given } : {};
  const declared = plainObject(recipe.work_item) ? recipe.work_item : {};
  for (const field of Array.isArray(declared.fields) ? declared.fields : []) {
    if (plainObject(field) && typeof field.id === 'string' && workItem[field.id] === undefined && field.default !== undefined) workItem[field.id] = field.default;
  }
  const missing = (Array.isArray(declared.required) ? declared.required : []).filter(key => workItem[key] === undefined || workItem[key] === '');
  if (missing.length) throw new Error(`work_item needs ${missing.join(', ')} for ${recipe.id ?? 'this recipe'}.`);
  return workItem;
}

/** The blocks a recipe may name: the kept ones, with the request's own blocks of the same id in their place. */
export function blocksWith(own) {
  const mine = (Array.isArray(own) ? own : []).filter(block => plainObject(block) && typeof block.id === 'string')
    .map(block => ({ kind: 'ai-instruction-block', ...block }));
  const ids = new Set(mine.map(block => block.id));
  return [...BLOCKS.filter(block => !ids.has(block.id)), ...mine];
}
