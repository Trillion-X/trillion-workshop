// tools/leave-a-shared-pursuit/do-work/leave-a-shared-pursuit-run.mjs
//
// The command the tool row runs: one JSON request on standard input, and { result } (or { error }) as JSON on the last line.
// Nothing here reaches a store: the rows the request needs are in the request, handed in by the caller who reads them.
import { text } from 'node:stream/consumers';
import { leaveASharedPursuit } from './leave-a-shared-pursuit.mjs';

const FUNCTIONS = { leaveASharedPursuit };

try {
  const run = FUNCTIONS[process.argv[2]];
  if (!run) throw new Error(`Say which: ${Object.keys(FUNCTIONS).join(', ')}.`);
  console.log(JSON.stringify({ result: run(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message }));
  process.exitCode = 1;
}
