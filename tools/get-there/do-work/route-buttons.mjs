// tools/get-there/do-work/route-buttons.mjs
//
// tool:route-buttons: one JSON request on standard input, { destination, origin?, stops?, mode? }, and
// { result: { buttons, said? } } as JSON on the last line.
import { text } from 'node:stream/consumers';
import { routeButtons } from '../read-data/get-there.mjs';

try {
  console.log(JSON.stringify({ result: routeButtons(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message }));
  process.exitCode = 1;
}
