// tools/who-does-each-step/do-work/who-does-each-step.mjs
//
// tool:who-does-each-step: one JSON request on standard input, { steps, doers, only_a_person?, approved?, past?, words?, ranking? },
// and { result: { steps, counts, said } } as JSON on the last line. A request it cannot read is refused with { error }.
import { text } from 'node:stream/consumers';
import { whoDoesEachStep } from '../read-data/who-does.mjs';

try {
  console.log(JSON.stringify({ result: whoDoesEachStep(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message }));
  process.exitCode = 1;
}
