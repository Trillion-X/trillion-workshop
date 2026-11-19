// tools/how-someone-does-their-thing/do-work/keep-a-voice-edit.mjs
//
// tool:keep-a-voice-edit: one JSON request on standard input and { result } as JSON on the last line. A request it cannot
// judge is refused with { error } saying what to fix.
import { text } from 'node:stream/consumers';
import { keepAVoiceEdit } from '../read-data/voice.mjs';

try {
  console.log(JSON.stringify({ result: keepAVoiceEdit(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
