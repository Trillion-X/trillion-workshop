# tools/export-documents-to-files/

Saves a document as a file and writes a web page from a record. Two tools that run on the person's own computer: `tool:export-a-document-to-a-file` and `tool:write-a-web-page-from-a-record`. Ported from bitfield-packages `packages/structured-file-output` and `packages/public-document-renderer`; nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `do-work/render-structured-file-export.py` | Reads a job (title, a tree of text blocks, a descriptor) and a rules file, walks the tree once into sections, and writes a Word, PDF, Markdown or text file; reads the file back and compares it before it reports. `python3 render-structured-file-export.py --job-file JOB --rules-rows-file RULES [--project-only] [--result-path FILE]`. Word uses the standard library only; PDF needs reportlab and the font file the rules name. Changed from the package: the content hash is no longer printed (hash the file with `tools/content-identity`), the result file is written only when `--result-path` is given, and a `file_stem` that names a folder is refused. |
| `do-work/public-page-projection.mjs` | Pure, Worker-compatible export of `renderRecordPublicationProjection` from the existing safe structured page renderer. No Node file or URL modules are loaded by this module. |
| `do-work/render-public-page.mjs` | Pure implementation: projects an envelope (descriptor, record, optional values) into a page model with title, sharing tags, structured data, sections, address and proof. |
| `do-work/render-public-page-cli.mjs` | Node-only file wrapper: `node render-public-page-cli.mjs ENVELOPE.json [OUTPUT.html]`. Writes the pure projection to a file and reports its proof. |
| `read-data/starter-projection-rules.json` | A neutral starting rules file: which props carry text, the table shape, and the Markdown, text, Word and PDF formats. A person's own rules replace it. |
| `test/test-structured-file-export-docx.py` | The package's Word test over made-up trees (needs python-docx, otherwise it prints `skipped`). Changed: the paths, and the checks of the old engine's action manifest and of the content hash are gone. |
| `test/test-structured-file-export-pdf.py` | The package's PDF test (needs reportlab, pypdf and the Arial.ttf font, otherwise it prints `skipped`). Changed: the paths, the hash check and the picture-review branch are gone. |
| `test/read-structured-docx.py` | Reads a Word file back to ordered text and structure, used by the Word test. |
| `test/export-documents-to-files.test.mjs` | Runs the two Python tests, then both commands over a made-up bakery: Markdown with a table, Word with no library, a refused file name, a refused format, a page from two differently shaped records, escaping, structured data with empty fills dropped. |
| `tool-rows.json` | The two tool rows. |
| `part.json` | No public files. |

## Not carried

The package also held a browser-download builder (`make-structured-file-output.ts`) that wrote csv, markdown, text, a plain docx and a simple pdf bytes in the browser and handed them to a download or a save-to-path step of the old engine. The rules-driven program above produces the same Markdown, text, Word and PDF files from data and supersedes it; the browser hand-off is old-engine plumbing and is not carried. A spreadsheet (xlsx) writer existed only there.

## Rules file shape

A JSON list of rows `{ "kind": "structured-file-projection-rules", "id", "text_properties", "heading_level_path", "table": { "min_cells", "min_rows" }, "formats": { "<format_id>": { "extension", ... } } }`. A format with `"renderer": "docx"` or `"pdf"` is drawn by the program (styles are fields of the format); any other format is built from `title_template`, `heading_template`, `line_template`, `row_template`, `cell_separator`, `document_template` and the other template fields. See the starter file.
