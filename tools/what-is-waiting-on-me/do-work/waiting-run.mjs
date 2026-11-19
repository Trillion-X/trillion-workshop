// tools/what-is-waiting-on-me/do-work/waiting-run.mjs
//
// The command the three record-reading tools run: one JSON request on standard input, and { result } (or { error }) as
// JSON on the last line. The first argument names the function: read (tool:read-what-is-waiting-on-me), finish
// (tool:finish-what-is-waiting-on-me) or verify (tool:verify-waiting-on-me-completion). Nothing here reaches a store:
// the records the request needs are in the request, handed in by the caller who reads them from the person's own store.
import { text } from 'node:stream/consumers';
import { readWaitingOnMe, finishWaitingOnMe, verifyWaitingCompletion } from '../read-data/waiting-records.mjs';

const FUNCTIONS = { read: readWaitingOnMe, finish: finishWaitingOnMe, verify: verifyWaitingCompletion };

try {
  const run = FUNCTIONS[process.argv[2]];
  if (!run) throw new Error('Say which: read, finish or verify.');
  console.log(JSON.stringify({ result: run(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message, ...(error.code ? { code: error.code } : {}) }));
  process.exitCode = 1;
}
