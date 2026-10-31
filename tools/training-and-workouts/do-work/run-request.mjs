// tools/training-and-workouts/do-work/run-request.mjs
//
// Run by the Workshop rows in the tool container:  node do-work/run-request.mjs <function in requests.mjs> < <the request as JSON>
// Prints { result } as JSON on its last line. A request that is not JSON, or that requests.mjs refuses, prints { error } and why.
import { text } from 'node:stream/consumers';
import * as requests from './requests.mjs';

try {
  const run = requests[process.argv[2]];
  if (typeof run !== 'function') throw new Error(`Unknown request: ${process.argv[2]}.`);
  console.log(JSON.stringify({ result: run(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
