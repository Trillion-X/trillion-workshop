// A stand-in for a source's landing owner (land_paths.py) in the sync tests: argv[2] is a log file; it keeps the words it
// was started with and the text of each --edit file there, one JSON line, and answers with a landed commit as land_paths does.
import { appendFileSync, readFileSync } from 'node:fs';
const [log, ...words] = process.argv.slice(2);
const edited = words.flatMap((word, i) => (words[i - 1] === '--edit' ? [word] : [])).map(edit => {
  const at = edit.indexOf('=');
  return { path: edit.slice(0, at), text: readFileSync(edit.slice(at + 1).replace(/^cat '(.*)'$/, '$1'), 'utf8') };
});
appendFileSync(log, `${JSON.stringify({ words, edited })}\n`);
console.log(`land_paths: landed ${'a'.repeat(40)} on ${'b'.repeat(12)} (try 1)`);
