// tools/check-against-a-persons-rules-and-verdicts/do-work/check-copy-words.mjs
//
// Words, pages, decks and picture readings checked as a set (do-work/check-copy.mjs `checkCopy`). Run by the Workshop tool
// `tool:check-copy` in the tool container:
//
//   node do-work/check-copy-words.mjs < <the input as JSON>
//
// and prints { result: { status, passed, exit, units, failing, held, advisory, problems, results, questions, lines } } as JSON
// on its last line. A request it cannot check (no words, rules the checker cannot compile) is refused with { error }.
import { text } from 'node:stream/consumers';
import { checkCopy } from './check-copy.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
try {
  console.log(JSON.stringify({ result: checkCopy(input) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
