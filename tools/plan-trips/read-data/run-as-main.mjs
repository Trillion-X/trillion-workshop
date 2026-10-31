// tools/plan-trips/read-data/run-as-main.mjs
//
// How every plan-trips command runs: one JSON request on standard input, one JSON line out, { result } or { error } with a
// non-zero exit. A command file calls runAsMain(import.meta.url, handle) and stays importable for tests.
import { text as readStdin } from 'node:stream/consumers';

export async function runAsMain(moduleUrl, handle) {
  if (moduleUrl !== `file://${process.argv[1]}`) return;
  try {
    console.log(JSON.stringify({ result: handle(JSON.parse((await readStdin(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
