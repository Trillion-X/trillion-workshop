// tools/walk-a-new-person-through-first-setup/do-work/walk-a-new-person-through-first-setup.mjs
//
// tool:walk-a-new-person-through-first-setup, run as a function in the tool container:
//
//   node do-work/walk-a-new-person-through-first-setup.mjs < <the input as JSON>
//
// and prints the setup plan as JSON on its last line. It is a projection: the caller reads the saved setup run, the
// account's access prerequisites, its known facts, its computer inventory and the pursuit lens from its own records
// and hands them over. Nothing here reads storage or the clock except `now`, and nothing is written.
//
// Input (every field but origin is optional; a field left out is unknown, never empty):
//   { view?: 'state' | 'full', origin, runtime?, prerequisites?, known?, native?, lens?, entry?, came_from? }
//   runtime        the saved run (workflow) and its next calls
//   prerequisites  the account's current access prerequisites
//   known          pursuits, connections, profile and devices already on the account
//   native         { computers, cards, truncated? } the account's computer inventory and their tool cards
//   lens           the person's pursuit lens ({ opening, parts, closing, rows }) read from their lists
//   entry          the entry point id the person started from; came_from is the page recorded when they joined
//   toolkits, toolkit_swaps   the toolkit and swap rows the person keeps ({ id, type, value }); the starters this tool ships
//                  are offered with them
//   toolkit_choice { toolkit?, drop?, add?, swap? }: swap is { slot: [pointer] } or a swap row's id; no toolkit is the default
//   row            set when this runs as a listed starter row: that row's id is the pick
import { readFileSync } from 'node:fs';
import { setupPlan } from './setup-plan.mjs';
import { entryPointForSetup } from '../../start-from-any-landing-page/src/entry-points.mjs';

// The plan for one request; it throws when the request is not one this tool can answer.
export function walkAPersonThroughFirstSetup(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Send one JSON object: { origin, view?, runtime?, prerequisites?, known?, native?, lens?, entry?, came_from? }.');
  if (typeof input.origin !== 'string' || !input.origin) throw new Error('origin is the service address the setup files are served from.');
  const { entry, came_from: cameFrom, row, ...facts } = input;
  // Run as a listed starter row (its row source's invoke_with), the row's id is the pick: a toolkit, or a swap into the default.
  if (row !== undefined && facts.toolkit_choice === undefined) {
    if (typeof row !== 'string') throw new Error('row is the id of a toolkit or swap row.');
    facts.toolkit_choice = row.startsWith('toolkit-swap:') ? { swap: row } : { toolkit: row };
  }
  const plan = setupPlan(facts);
  const entryPoint = entryPointForSetup(entry, cameFrom ?? null);
  return entryPoint ? { ...plan, entry_point: entryPoint } : plan;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  try {
    process.stdout.write(JSON.stringify({ result: walkAPersonThroughFirstSetup(JSON.parse(readFileSync(0, 'utf8') || '{}')) }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
