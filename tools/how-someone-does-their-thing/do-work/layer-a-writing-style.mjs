// tools/how-someone-does-their-thing/do-work/layer-a-writing-style.mjs
//
// tool:layer-a-writing-style: one JSON request on standard input and { result } as JSON on the last line. A request it cannot
// judge is refused with { error } saying what to fix.
import { text } from 'node:stream/consumers';
import { layerAWritingStyle } from '../read-data/layers.mjs';

try {
  console.log(JSON.stringify({ result: layerAWritingStyle(JSON.parse((await text(process.stdin)) || '{}')) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
