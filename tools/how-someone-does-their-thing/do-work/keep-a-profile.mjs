// tools/how-someone-does-their-thing/do-work/keep-a-profile.mjs
//
// tool:keep-a-profile: one JSON request on standard input and { result } as JSON on the last line. A request it cannot
// judge is refused with { error } saying what to fix.
import { text } from 'node:stream/consumers';
import { keepProfile } from '../read-data/profile.mjs';

try {
  console.log(JSON.stringify({ result: { profile: keepProfile(JSON.parse((await text(process.stdin)) || '{}')) } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
