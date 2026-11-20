// tools/network-people/do-work/network-people-run.mjs
//
// The command the Network rows run: one JSON request on standard input, and { result } (or { error }) as JSON on the last line.
// The first argument names the function (do-work/network-people.mjs): networkProfile, findNetworkPeople or onMyPath. Nothing here
// reaches a store: the records the request needs are in the request, handed in by the caller who reads them from the person's store.
import { text } from 'node:stream/consumers';
import { findNetworkPeople, networkProfile, onMyPath } from './network-people.mjs';

const FUNCTIONS = { networkProfile, findNetworkPeople, onMyPath };

try {
  const run = FUNCTIONS[process.argv[2]];
  if (!run) throw new Error(`Say which: ${Object.keys(FUNCTIONS).join(', ')}.`);
  console.log(JSON.stringify({ result: run(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message }));
  process.exitCode = 1;
}
