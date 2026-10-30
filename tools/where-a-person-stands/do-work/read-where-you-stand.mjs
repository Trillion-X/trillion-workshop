// tools/where-a-person-stands/do-work/read-where-you-stand.mjs
//
// Where the person stands on each thing, with their own words and every earlier stand, from the versions of their
// stance records. Run by the Workshop tool `tool:read-where-you-stand` in the tool container:
//
//   node do-work/read-where-you-stand.mjs < <the input as JSON>
//
// and prints { result: { stances, choices } } as JSON on its last line. A thing with no stand reads stance null.
import { text } from 'node:stream/consumers';
import { stanceChoices, standsFrom } from './where-a-person-stands.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
try {
  console.log(JSON.stringify({ result: { stances: standsFrom(input.records ?? [], input.artifact_ref), choices: stanceChoices() } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
