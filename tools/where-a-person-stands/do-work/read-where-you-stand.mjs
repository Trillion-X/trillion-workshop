// tools/where-a-person-stands/do-work/read-where-you-stand.mjs
//
// Where the person stands on one thing, with their own words and every earlier stand, from its stance record's history.
// The caller (the AI that holds the person's key) pages records:history at @own-records for stance:<kind>:<identity>
// and passes { versions, next }; this tool reads nothing itself. Run by the Workshop tool `tool:read-where-you-stand`
// in the tool container:
//
//   node do-work/read-where-you-stand.mjs < <the input as JSON>
//
// and prints { result: { stand, choices } } as JSON on its last line. A thing with no stand reads stance null.
import { text } from 'node:stream/consumers';
import { stanceChoices, standFrom } from './where-a-person-stands.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
try {
  console.log(JSON.stringify({ result: { stand: standFrom(input), choices: stanceChoices() } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
