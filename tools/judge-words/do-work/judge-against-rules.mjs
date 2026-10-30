// tools/judge-words/do-work/judge-against-rules.mjs
//
// Words and any JSON judged against the caller's rule rows (do-work/judge-words.mjs `judge`). Run by the Workshop tool
// `tool:judge-against-rules` in the tool container:
//
//   node do-work/judge-against-rules.mjs < <the input as JSON>
//
// and prints { result: { passed, status, coverage, findings, lines, said } } as JSON on its last line. A rule row that
// cannot be compiled (no selector, a test of the wrong kind, an empty path) is refused with { error } and why.
import { text } from 'node:stream/consumers';
import { judge } from './judge-words.mjs';

const input = JSON.parse((await text(process.stdin)) || '{}');
try {
  console.log(JSON.stringify({ result: judge(input) }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
