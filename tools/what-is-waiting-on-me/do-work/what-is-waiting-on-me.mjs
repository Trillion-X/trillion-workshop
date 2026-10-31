// tools/what-is-waiting-on-me/do-work/what-is-waiting-on-me.mjs
//
// tool:what-is-waiting-on-me: one JSON request on standard input, { sources, found, words? }, and
// { result: { cards, sources, count, said } } as JSON on the last line. A request it cannot read is refused with { error }.
import { text } from 'node:stream/consumers';
import { whatIsWaitingOnMe } from '../read-data/waiting.mjs';

try {
  console.log(JSON.stringify({ result: whatIsWaitingOnMe(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message }));
  process.exitCode = 1;
}
