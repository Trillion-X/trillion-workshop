// tools/document-sections/do-work/place-a-section.mjs
//
// The command of tool:place-a-section-in-a-markdown-document. One JSON request on standard input:
//   { document_text: "<the whole markdown document>", section_text: "<the section, starting with its own heading>" }
// and one JSON line out: { result: { text, placement: "appended" | "replaced", heading } }, or { error } and a non-zero
// exit when the section has no heading. The placing is placeSection in append-section.mjs, unchanged; this file only
// hands it text, because a tool container has no access to the person's files.
import { text as readStdin } from 'node:stream/consumers';
import { placeSection } from './append-section.mjs';

export function placeInText(input) {
  if (typeof input?.document_text !== 'string') throw new Error('document_text must be the markdown document, as text.');
  if (typeof input?.section_text !== 'string') throw new Error('section_text must be the section to place, as text.');
  return placeSection(input.document_text, input.section_text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify({ result: placeInText(JSON.parse((await readStdin(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
