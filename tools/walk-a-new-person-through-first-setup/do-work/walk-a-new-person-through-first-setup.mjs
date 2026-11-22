import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
// tools/walk-a-new-person-through-first-setup/do-work/walk-a-new-person-through-first-setup.mjs
//
// tool:walk-a-new-person-through-first-setup, run as a function in the tool container:
//
//   node do-work/walk-a-new-person-through-first-setup.mjs < <the input as JSON>
//
// and prints the setup plan as JSON on its last line. It is a projection: the caller reads the saved setup run, the
// account's access prerequisites, its known facts, its computer inventory and the pursuit lens from its own records
// and hands them over. The one read here is the toolkit rows, from the database that keeps them; nothing is written.
//
// Input (every field but origin is optional; a field left out is unknown, never empty):
//   { view?: 'state' | 'full', origin, runtime?, prerequisites?, known?, native?, lens?, entry?, came_from? }
//   runtime        the saved run (workflow) and its next calls
//   prerequisites  the account's current access prerequisites
//   known          pursuits, connections, profile and devices already on the account
//   native         { computers, cards, truncated? } the account's computer inventory and their tool cards
//   lens           the person's pursuit lens ({ opening, parts, closing, rows }) read from their lists
//   entry          the entry point id the person started from; came_from is the page recorded when they joined
//   database       the database that keeps the toolkits and toolkit_swaps tables, as this computer names it (or
//                  credential_name, the held name of its connection): the engine hands its connection on descriptor 3 and the
//                  rows are read there (choose-toolkit.mjs readToolkitRows), never handed in
//   toolkit_choice { toolkit?, drop?, add?, swap? }: swap is { slot: [pointer] } or a swap row's id; no toolkit is the default
//   row            the id of a toolkits or toolkit_swaps row to pick
import { readFileSync } from 'node:fs';
import { setupPlan } from './setup-plan.mjs';
import { readToolkitRows } from './choose-toolkit.mjs';
import { throughProxy } from '../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs';
import { entryPointForSetup } from '../../start-from-any-landing-page/src/entry-points.mjs';

// The plan for one request; it throws when the request is not one this tool can answer.
export function walkAPersonThroughFirstSetup(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Send one JSON object: { origin, view?, runtime?, prerequisites?, known?, native?, lens?, entry?, came_from? }.');
  if (typeof input.origin !== 'string' || !input.origin) throw new Error('origin is the service address the setup files are served from.');
  const { entry, came_from: cameFrom, row, ...facts } = input;
  // A row's id is the pick: a toolkit, or a swap into the default.
  if (row !== undefined && facts.toolkit_choice === undefined) {
    if (typeof row !== 'string') throw new Error('row is the id of a toolkit or swap row.');
    facts.toolkit_choice = row.startsWith('toolkit-swap:') ? { swap: row } : { toolkit: row };
  }
  const plan = setupPlan(facts);
  const entryPoint = entryPointForSetup(entry, cameFrom ?? null);
  return entryPoint ? { ...plan, entry_point: entryPoint } : plan;
}

// The toolkit rows from the held connection (descriptor 3), through the run's own proxy when the engine names one. pg is
// loaded only here, so a caller of the plan alone needs no database module.
async function toolkitRowsAt(connection) {
  const { default: pg } = await import('pg');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const client = new pg.Client({ connectionString: connection, ...(proxy ? { stream: throughProxy(proxy) } : {}) });
  await client.connect();
  try {
    return await readToolkitRows(async text => (await client.query(text)).rows);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  let connection = '';
  try { connection = readFileSync(3, 'utf8').trim(); } catch { /* nothing held */ }
  try {
    const { toolkits: _toolkits, toolkit_swaps: _swaps, database, credential_name: held, ...input } = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if ((database !== undefined || held !== undefined) && !connection) throw new Error('No connection to the toolkits database was handed to this run: give database, or credential_name under which it is held.');
    const rows = connection ? await toolkitRowsAt(connection) : {};
    process.stdout.write(JSON.stringify({ result: walkAPersonThroughFirstSetup({ ...input, ...rows }) }) + '\n');
  } catch (error) {
    let said = String(error?.message ?? error);
    if (connection) {
      for (const part of [connection, (() => { try { return decodeURIComponent(new URL(connection).password); } catch { return ''; } })()]) if (part) said = said.split(part).join('[held]');
    }
    process.stdout.write(JSON.stringify({ error: said }) + '\n');
    process.exitCode = 1;
  }
}
