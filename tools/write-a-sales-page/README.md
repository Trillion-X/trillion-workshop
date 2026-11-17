# tools/write-a-sales-page/

Sales and landing pages as one row of DATA each, written as a whole static HTML page by the shared page writer in the sales look, as the Workshop tool `tool:write-a-sales-page`, whose page is kept in the person's files. This follows bitfield-packages `packages/public-sales-page`'s static row-to-page shape and reuses section content concepts from `packages/adaptive-program-landing`. It does not port the latter's interactive checkout, enrollment consent, email course or article behavior; cards and actions here are static page content and links. A hero, story, method steps, offer, proof, closing call and fine print use the same section shape named by an emphasis word, so no static page kind is code.

## Files

| File | Purpose |
|------|---------|
| `read-data/sales-page.mjs` | `pageProblems` (every problem with a row, in words), `salesPageHtml` (the row as a document through `tools/ui/show/server-rendered-page`, with its palette). |
| `do-work/write-a-sales-page.mjs` | The tool's command: row JSON in argv[2], the page written at argv[3], one JSON line out (title, sections, bytes, BLAKE3 identity, the page's words). |
| `records.json` | The tool row: input and output shapes, the container bundle (this part, the page writer, `tools/screen-look/show/sales-page.css`, @noble/hashes), the page kept in files, a sample. |
| `part.json` | No public files: only the container runs this code. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| page row | `{ title, description?, brand?, language?, palette?: { ground, text, accent }, share?, sections: [{ emphasis?, heading?, body?, image?, items?, cards?, actions? }] }` | One page. |
| `salesPageHtml` | `(row, look) => string` | The page. |
| `writeASalesPage` | `(row, out?) => { title, sections, bytes, identity, words }` | The tool's work. |

## Dependencies

**Depends on:** `tools/ui/show/server-rendered-page/page-sections-html.mjs`, the mounted `tools/screen-look/show/sales-page.css` DATA file, `@noble/hashes`, Node in the tool container. The static CLI reads that stylesheet from the path in its row; direct library calls retain the package-resolved default.

**Scope:** this writes section content and links into static HTML. It does not provide the interactive checkout, enrollment consent, email course or article behavior from `packages/adaptive-program-landing`.

**Depended on by:** `records/workshop-page-tool-records.json`, `scripts/tool-bundles.mjs` at deploy, `test/workflow-funnel-page-screens.test.mjs`.
