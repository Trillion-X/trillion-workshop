// tools/where-a-person-stands/do-work/keep-where-you-stand.mjs
//
// The person's stand on one thing, as the record to keep. Run by the Workshop tool `tool:keep-where-you-stand` in the
// tool container:
//
//   node do-work/keep-where-you-stand.mjs < <the input as JSON>
//
// and prints { result: { stance_record } } as JSON on its last line. The Workshop keeps the record in the person's own
// records (the row's `keeps_records`); keeping it again with another stand makes a new version of the same record. A
// stand that is not the person's, or names its thing by anything but its identity, is refused with { error }.
import { text } from 'node:stream/consumers';
import { stanceRecord } from './where-a-person-stands.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
try {
  console.log(JSON.stringify({ result: { stance_record: stanceRecord(input) } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
