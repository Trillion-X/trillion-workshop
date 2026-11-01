// tools/how-someone-does-their-thing/do-work/find-repeated-edits.mjs
//
// tool:find-repeated-edits: one JSON request on standard input and { result } as JSON on the last line. A request it cannot
// judge is refused with { error } saying what to fix.
import { text } from 'node:stream/consumers';
import { findRepeatedEdits } from '../read-data/edits.mjs';

try {
  console.log(JSON.stringify({ result: findRepeatedEdits(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
