// tools/how-someone-does-their-thing/do-work/find-repeated-voice-edits.mjs
//
// tool:find-repeated-voice-edits: one JSON request on standard input and { result } as JSON on the last line. A request it
// cannot judge is refused with { error } saying what to fix.
import { text } from 'node:stream/consumers';
import { repeatedVoiceEdits } from '../read-data/voice.mjs';

try {
  console.log(JSON.stringify({ result: repeatedVoiceEdits(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
