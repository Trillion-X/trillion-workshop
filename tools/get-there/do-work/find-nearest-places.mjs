// tools/get-there/do-work/find-nearest-places.mjs
//
// tool:find-nearest-places: one JSON request on standard input, { name, near, radius_km?, most?, mode? }, and
// { result: { places, start, said } } as JSON on the last line. A service that does not answer is an { error } in words.
import { text } from 'node:stream/consumers';
import { findNearestPlaces } from '../read-data/get-there.mjs';

try {
  console.log(JSON.stringify({ result: await findNearestPlaces(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof SyntaxError ? `the request is not JSON: ${error.message}` : error.message }));
  process.exitCode = 1;
}
