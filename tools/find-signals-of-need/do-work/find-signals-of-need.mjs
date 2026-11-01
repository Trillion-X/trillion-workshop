// tools/find-signals-of-need/do-work/find-signals-of-need.mjs
//
// tool:find-signals-of-need: one JSON request on standard input and { result } as JSON on the last line. A request it
// cannot judge is refused with { error } saying what to fix. It sends nothing and keeps nothing.
import { text } from 'node:stream/consumers';
import { findSignals } from '../read-data/signals.mjs';

try {
  console.log(JSON.stringify({ result: await findSignals(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
