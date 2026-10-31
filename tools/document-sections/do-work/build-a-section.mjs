// tools/document-sections/do-work/build-a-section.mjs
//
// The command of tool:build-a-quoted-section-from-entries. One JSON request on standard input:
//   { heading, preamble?, sources: [{ path?: "a name for the source", document: { the list of entries under entries_at, ... } }],
//     entries_at?: "messages", text_field?: "content", label_field?: "ordinal", stamp_field?: "timestamp",
//     group_field?: "session_id" }
// and one JSON line out: { result: { text, entries, sources } }, or { error } and a non-zero exit when a source names no
// entries, an entry lacks its text field, or every source is empty. The writing is renderSection in
// build-entries-section.mjs, unchanged: every line of an entry is quoted and nothing else about it is touched.
import { text as readStdin } from 'node:stream/consumers';
import { renderSection } from './build-entries-section.mjs';

const word = (value, fallback) => (typeof value === 'string' && value ? value : fallback);

export function buildFromInput(input) {
  if (typeof input?.heading !== 'string' || !input.heading) throw new Error('heading must be the section heading, as text.');
  if (!Array.isArray(input.sources) || input.sources.length === 0) throw new Error('sources must list at least one { document }.');
  const sources = input.sources.map((source, index) => {
    if (source === null || typeof source !== 'object' || source.document === null || typeof source.document !== 'object') {
      throw new Error(`sources[${index}] must hold a document object.`);
    }
    return { path: word(source.path, `source-${index + 1}`), document: source.document };
  });
  const { bytes, total } = renderSection({
    heading: input.heading,
    preamble: typeof input.preamble === 'string' && input.preamble ? input.preamble : null,
    sources,
    fields: {
      at: word(input.entries_at, 'messages'),
      text: word(input.text_field, 'content'),
      label: word(input.label_field, 'ordinal'),
      stamp: word(input.stamp_field, 'timestamp'),
      group: word(input.group_field, 'session_id'),
    },
  });
  return { text: bytes, entries: total, sources: sources.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify({ result: buildFromInput(JSON.parse((await readStdin(process.stdin)) || '{}')) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
