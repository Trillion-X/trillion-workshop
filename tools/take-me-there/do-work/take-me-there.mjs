// tools/take-me-there/do-work/take-me-there.mjs
//
// tool:take-me-there: one JSON request on standard input, { thing, waiting, screens, own_origins?, beside?, name?, category?,
// say?, steps?, key?, fallback_points_at? }, and { result } as JSON on the last line: { taken: false, said } or the screen,
// arrangement, walkthrough and notice to save and send. A request it cannot read is refused with { error }.
import { text } from 'node:stream/consumers';
import { takeMeThere } from '../read-data/take-me-there.mjs';

try {
  console.log(JSON.stringify({ result: takeMeThere(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message }));
  process.exitCode = 1;
}
