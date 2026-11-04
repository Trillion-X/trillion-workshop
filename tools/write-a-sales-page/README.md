# parts/public-sales-page/

Sales and landing pages as one row of DATA each, written as a whole HTML page by the shared page writer in the sales look, as the Workshop tool `tool:write-a-sales-page`, whose page is kept in the person's files. The port of bitfield-packages `packages/public-sales-page` and `packages/adaptive-program-landing`: their hero, story, method steps, offers with checkout links, proof, closing call and fine print are sections of the writer's one section shape named by an emphasis word, so no page kind is code.

## Files

| File | Purpose |
|------|---------|
| `read-data/sales-page.mjs` | `pageProblems` (every problem with a row, in words), `salesPageHtml` (the row as a document through `parts/ui/show/server-rendered-page`, with its palette). |
| `do-work/write-a-sales-page.mjs` | The tool's command: row JSON in argv[2], the page written at argv[3], one JSON line out (title, sections, bytes, BLAKE3 identity, the page's words). |
| `records.json` | The tool row: input and output shapes, the container bundle (this part, the page writer, `parts/screen-look/show/sales-page.css`, @noble/hashes), the page kept in files, a sample. |
| `part.json` | No public files: only the container runs this code. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| page row | `{ title, description?, brand?, language?, palette?: { ground, text, accent }, share?, sections: [{ emphasis?, heading?, body?, image?, items?, cards?, actions? }] }` | One page. |
| `salesPageHtml` | `(row, look) => string` | The page. |
| `writeASalesPage` | `(row, out?) => { title, sections, bytes, identity, words }` | The tool's work. |

## Dependencies

**Depends on:** `parts/ui/show/server-rendered-page/page-sections-html.mjs`, `parts/screen-look/show/sales-page.css`, `@noble/hashes`, Node in the tool container.

**Depended on by:** `records/workshop-page-tool-records.json`, `scripts/tool-bundles.mjs` at deploy, `test/workflow-funnel-page-screens.test.mjs`.
