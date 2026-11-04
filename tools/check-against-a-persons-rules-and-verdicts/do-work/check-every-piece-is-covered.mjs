// tools/check-against-a-persons-rules-and-verdicts/do-work/check-every-piece-is-covered.mjs
//
// tool:check-every-piece-is-covered, run in the tool container with the records door on descriptor 3:
//
//   node do-work/check-every-piece-is-covered.mjs < {}
//
// prints { result: { status, files, missing_checks, missing_covered_by, lines } } on its last line
// (do-work/piece-sweep.mjs coverageInRecords): per source file, its pieces, those with a check, those with a recorded
// reason and the uncovered ones by name; status failed when any piece is uncovered. Reads only; writes nothing.
import { text } from 'node:stream/consumers';
import { coverageInRecords } from './piece-sweep.mjs';

try {
  JSON.parse((await text(process.stdin)) || '{}');
  const { openRecordsDoor } = await import('../../records-door/read-data/records-door.mjs');
  console.log(JSON.stringify({ result: await coverageInRecords(openRecordsDoor()) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
