// tools/check-against-a-persons-rules-and-verdicts/do-work/split-a-document-into-pieces.mjs
//
// tool:split-a-document-into-pieces, run in the tool container:
//
//   node do-work/split-a-document-into-pieces.mjs < { text, file?, file_identity? }
//
// prints { result: { pieces } } on its last line: every piece of the text as the row a person keeps
// (do-work/pieces.mjs pieceRows). A request with no text is refused with { error }. Reads and writes no records.
import { text as readAll } from 'node:stream/consumers';
import { pieceRows } from './pieces.mjs';
import SETTINGS from '../read-data/pieces.json' with { type: 'json' };

try {
  const input = JSON.parse((await readAll(process.stdin)) || '{}');
  if (typeof input.text !== 'string') throw new Error(SETTINGS.words.text);
  if (input.file !== undefined && typeof input.file !== 'string') throw new Error(SETTINGS.words.file_name);
  console.log(JSON.stringify({ result: { pieces: pieceRows([{ text: input.text, file: input.file, file_identity: input.file_identity }]) } }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
