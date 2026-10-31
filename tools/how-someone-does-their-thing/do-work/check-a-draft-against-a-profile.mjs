// tools/how-someone-does-their-thing/do-work/check-a-draft-against-a-profile.mjs
//
// tool:check-a-draft-against-a-profile: one JSON request on standard input and { result } as JSON on the last line. A request it cannot
// judge is refused with { error } saying what to fix.
import { text } from 'node:stream/consumers';
import { checkDraft } from '../read-data/profile.mjs';

try {
  console.log(JSON.stringify({ result: checkDraft(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
