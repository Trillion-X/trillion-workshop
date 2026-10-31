# tools/check-documents-agree-with-their-source/

Several documents each claim to reflect one source (summaries, translations, copies for other readers). This reports which have fallen behind it. Which documents, which source, what identifies a unit and which markers each must carry are all DATA the person gives: adding a mirror is a row, adding a set is a record, neither is a source edit. Ported from the package `check-documents-agree-with-their-source`; the engine is unchanged.

## Files

| File | Purpose |
|------|---------|
| `do-work/check-documents-agree-with-their-source.mjs` | The engine: pure functions over a descriptor and a reader. It touches no disk, names no document, pattern or marker, and a test greps it for the words of the domain that motivated it. Copied unchanged. |
| `do-work/check-my-documents.mjs` | `tool:check-documents-agree-with-their-source`: the granted folder in argv, `{ sets }` on standard input, `{ result }` on the last line. The disk half and nothing else: reads the documents the sets name inside the folder, reports a missing document as its own fact, refuses a path that leaves the folder and a run over no set. Replaces the package's runner, which read its sets from its own manifest. |
| `part.json` | The engine is public, so another tool may import it. |
| `tool-rows.json` | The row. It runs on the person's computer after they grant `read-a-folder`. |
| `test/a-document-that-fell-behind-its-source.test.mjs` | The package's test: unit extraction, numeric ordering, every refusal, falling behind, markers with a per-mirror override, and the same engine on a different subject. The sample identifiers are made up. |
| `test/check-my-documents-row.test.mjs` | The row's shape, and the command run the way the engine runs it over a made-up folder. |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `unitsIn` / `newestUnit` | `(text, pattern) -> { raw, order }[]` / `{ raw, order } \| null` | Every unit in a text; the maximum by captured NUMBER (item 99 sorts below item 218), the last match when the pattern captures none. |
| `readMirrorSet` | `(descriptor) -> Set` | Validates and normalises; throws on no source, no mirrors, no unit pattern, or a mirror with no document. |
| `mirrorsBehind` | `(set, textOf) -> { newest, behind[], sourceCarriesNoUnit }` | Which mirrors lack the source's newest unit. A shorter mirror is correct, not a finding. |
| `mirrorsMissingMarkers` | `(set, textOf) -> { document, marker }[]` | Which mirrors lack a literal string required of them. |
| `agreementReport` | `(descriptor, textOf) -> Report` | The whole answer, structured, never a boolean. |

## Dependencies

**Depends on:** nothing (Node 24 in the engine's run).

**Depended on by:** `tool-rows.json`. The local engine runs the row on the person's computer (`computer` kind) after the person grants `read-a-folder`.
