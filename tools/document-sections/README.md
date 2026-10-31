# tools/document-sections/

Puts one named section into a markdown document without repeating it, and writes a section out of a list of entries without changing their words: the Workshop tools `tool:place-a-section-in-a-markdown-document` and `tool:build-a-quoted-section-from-entries`, run in the tool container. Ported from bitfield-packages `packages/document-sections`; nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `do-work/append-section.mjs` | The placing: `headingDepth`, `firstHeading`, `locateSection`, `placeSection` (pure), and `run` (reads a document and a section file, writes by atomic same-folder rename; for use from a person's own computer). Carried unchanged from the package. |
| `do-work/build-entries-section.mjs` | The writing: `entriesOf`, `renderEntry`, `renderSection` (pure), and `run` (files in, file out). Carried unchanged from the package. |
| `do-work/place-a-section.mjs` | The command of the placing tool: `{ document_text, section_text }` on standard input, `{ result: { text, placement, heading } }` on the last line. |
| `do-work/build-a-section.mjs` | The command of the writing tool: `{ heading, preamble?, sources, entries_at?, text_field?, label_field?, stamp_field?, group_field? }` in, `{ result: { text, entries, sources } }` out. |
| `tool-rows.json` | The two tool rows. |
| `part.json` | The two pure modules other tools may import. |
| `test/place-named-section.test.mjs` | The package's placing tests (append, replace, nested subsections, fenced headings, idempotence, missing heading, prefix collision). |
| `test/build-entries-section.test.mjs` | The package's writing tests (every line survives, markdown stays quoted, refusals, order across sources, field names as inputs). |
| `test/section-commands.test.mjs` | Both commands run over standard input, over synthetic text. |

## Key Types / Functions

| Function | Signature | Role |
|---|---|---|
| `placeSection` | `(documentText, sectionText) => { text, placement: 'appended' \| 'replaced', heading }` | Pure. A section runs from its heading to the next heading of the same or a higher level; headings inside fenced blocks never end it. |
| `locateSection` | `(lines, heading, depth) => { start, end } \| null` | Half-open line range of the existing section. |
| `renderSection` | `({ heading, preamble, sources, fields }) => { bytes, total }` | Quotes every line of every entry; refuses a source without its list, an entry without its text and sources that hold nothing. |
| `placeInText` / `buildFromInput` | `(input) => result` | The commands' work, exported for tests. |

## Invariants

- A section file supplies its own heading; the tool never invents, renames or reformats one. A section without a heading is refused.
- Placing the same section twice gives the same bytes.
- An entry's text is emitted behind a quote marker and otherwise unchanged. An empty result is refused, never written.
- Nothing here knows what a document or an entry is about: headings, field names and sources are inputs.

## Dependencies

**Depends on:** Node 24 in the tool container (`node:stream/consumers`); `append-section.mjs` and `build-entries-section.mjs` also use `node:fs/promises` and `node:path` for their file-based `run`.

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
