// tools/who-does-each-step/do-work/list-who-can-do.mjs
//
// tool:what-can-trillion-do: one JSON request on standard input, { doers, only_a_person? }, and
// { result: { doers, only_a_person } } as JSON on the last line: what can do steps, and the reasons a step may stay the person's.
import { text } from 'node:stream/consumers';
import { whoCanDo } from '../read-data/who-does.mjs';

try {
  console.log(JSON.stringify({ result: whoCanDo(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message }));
  process.exitCode = 1;
}
