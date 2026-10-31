// tools/write-from-a-recipe/do-work/list-writing-recipes.mjs
//
// tool:list-writing-recipes. One JSON request on standard input: { words?, section? }. Prints
// { result: { recipes: [{ id, label, section, needs, fields }], blocks: [{ id, label, body }], sections } } on its last
// line: the kept recipes (each one instruction over the person's text, with the answers it asks for) and the
// instruction blocks a recipe may name. `words` keeps the recipes and blocks whose label or id holds every word.
import { text } from 'node:stream/consumers';
import { BLOCKS, RECIPES } from '../read-data/library.mjs';

export function listWritingRecipes(input = {}) {
  const words = typeof input.words === 'string' ? input.words.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const holds = row => words.every(word => `${row.id} ${row.label ?? ''}`.toLowerCase().includes(word));
  const recipes = RECIPES.filter(holds).filter(recipe => typeof input.section !== 'string' || recipe.section === input.section);
  return {
    recipes: recipes.map(recipe => ({ id: recipe.id, label: recipe.label, section: recipe.section ?? null, needs: recipe.work_item?.required ?? [], fields: recipe.work_item?.fields ?? [] })),
    blocks: BLOCKS.filter(holds).map(block => ({ id: block.id, label: block.label, body: block.body })),
    sections: [...new Set(RECIPES.map(recipe => recipe.section).filter(Boolean))],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify({ result: listWritingRecipes(JSON.parse((await text(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
