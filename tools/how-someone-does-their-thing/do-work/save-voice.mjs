// tools/how-someone-does-their-thing/do-work/save-voice.mjs
//
// tool:save-voice: one JSON request on standard input and { result } as JSON on the last line. A request it cannot
// judge is refused with { error } saying what to fix.
import { text } from 'node:stream/consumers';
import { saveVoice } from '../read-data/voice.mjs';

try {
  console.log(JSON.stringify({ result: saveVoice(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
