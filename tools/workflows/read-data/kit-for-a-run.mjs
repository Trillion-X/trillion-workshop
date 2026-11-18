// tools/workflows/read-data/kit-for-a-run.mjs
//
// The kit a workflow runs with, chosen before the engine is called (the engine runner stays definitions, input and
// answers in, the run out): the shipped kits/<slug>.json, else a `kit` the person's own recipe row holds, else one drafted
// from the recipe's own steps, marked draft with what it still owes. So no workflow runs without a kit.
import { existsSync, readFileSync } from 'node:fs';
import { draftKit } from './draft-a-kit.mjs';

const KITS = new URL('../kits/', import.meta.url);

/** The kit this run carries: the shipped kit file, the kit on the person's own row, or one drafted from the recipe's own steps. */
export function kitFor(recipe) {
  const file = new URL(`${recipe.id.slice(recipe.id.indexOf(':') + 1)}.json`, KITS);
  if (existsSync(file)) return { from: 'shipped', kit: JSON.parse(readFileSync(file, 'utf8')) };
  if (recipe.kit && typeof recipe.kit === 'object') return { from: 'own-row', kit: recipe.kit };
  const { kit, problems } = draftKit({ recipe });
  return { from: 'drafted', kit: { ...kit, draft: true, owes: problems } };
}
