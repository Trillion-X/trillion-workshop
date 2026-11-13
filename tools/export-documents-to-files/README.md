# tools/export-documents-to-files/

The one export. Any selection (a list, table, record, document, board, words, calendar, graph or picture) is read as one document of typed blocks and written as a file in any format; each format is a row of data. Four Workshop tools: `tool:export-a-document-to-a-file` and `tool:list-the-file-formats-an-export-can-make` (Node, run in the tool container, so a page and an AI call them the same way), `tool:export-a-markdown-book-to-word` and `tool:write-a-web-page-from-a-record` (run on the person's own computer). The Markdown book exporter moved from Trillion-X/source-repo-a `tools/private-book-reader` (at 5a9ba3988a4d); the page writer was ported from bitfield-packages `public-document-renderer`; nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `do-work/export-to-file.mjs` | The command of the two export tools: `export` (`{ document, format, file_stem?, format_row?, now? }` to `{ format_id, filename, extension, mime, byte_length, base64, text?, finish? }`) and `formats`. One JSON request on standard input, `{ result }` or `{ error }` as the last line. |
| `do-work/document.mjs` | The one document every export starts from (`{ title?, blocks }`, block kinds heading, paragraph, list, table, graph, events, picture and ink), its checks (the error names the block that is wrong), and the lowerings: a graph as two tables, events as one table, a document as an outline, ink marks as a picture through `tools/draw-ink-marks`. |
| `do-work/format-takes.mjs` | Pure: whether a format takes a document, from its block kinds, so a screen offers only formats that will work. |
| `do-work/render-template.mjs` | The program that writes every text format (Markdown, text, CSV, TSV, HTML, slides, calendar, Mermaid, DOT, GraphML, OPML, FreeMind) from the format row's templates and escapes; its header lists the options. |
| `do-work/layout.mjs` | Measures, wraps and pages a document with the Helvetica advance widths; one place for PDF and SVG. A PDF refuses a character the font cannot draw and names it. |
| `do-work/render-pdf.mjs`, `do-work/render-svg.mjs` | Turn the laid-out pages into a PDF 1.4 file (base-14 fonts, deflated streams, document title) or one SVG (a document that is one picture comes out as that picture). |
| `do-work/render-docx.mjs`, `do-work/render-xlsx.mjs`, `do-work/zip.mjs` | Word (Title and Heading styles, Word lists, a table with a repeating header) and Excel (a sheet per table, numbers and true/false kept as such, frozen header) from the standard library only, in a deflated ZIP. |
| `read-data/export-formats.json` | The format rows: id, label, extension, mime, renderer, the block kinds it draws, and its options. A person adds a format by adding a row. |
| `read-data/page-layouts.json`, `read-data/paper-sizes.json`, `read-data/helvetica-widths.json` | The page layout (margins, spacing, table and list style), the paper sizes (a request names one, or its locale's region picks it; US Letter is the default; orientation is a request field) and the font advance widths the layout reads. |
| `do-work/public-page-projection.mjs` | Pure, Worker-compatible export of `renderRecordPublicationProjection` from the existing safe structured page renderer. No Node file or URL modules are loaded by this module. |
| `do-work/render-public-page.mjs` | Pure implementation: projects an envelope (descriptor, record, optional values) into a page model with title, sharing tags, structured data, sections, address and proof. |
| `do-work/render-public-page-cli.mjs` | Node-only file wrapper: `node render-public-page-cli.mjs ENVELOPE.json [OUTPUT.html]`. Writes the pure projection to a file and reports its proof. |
| `test/write-a-web-page.test.mjs` | The page writer: a page from two differently shaped records, escaping, structured data with empty fills dropped, the command. |
| `test/export-to-file.test.mjs` | The file exporter as the container runs it: every format row writes every kind it takes; CSV quoting, Markdown escapes, HTML, calendar folding, Mermaid, DOT, GraphML, OPML, FreeMind, ink marks as a picture; PDF, Word and Excel files opened again with `pdftotext` and `unzip` (skipped without them); a person's own format row; refusals by name. |
| `do-work/export-a-book.mjs` | `tool:export-a-markdown-book-to-word`, the entry with the person's records door (`exportABook(input, { door })`, run with `tools/records-door/do-work/run-with-stdio-mcp.mjs`): reads the book's settings row through `tools/settings`, runs the book's checks branch of `list:checks` on the exact manuscript bytes (`bookChecks`, through `tools/check-against-a-persons-rules-and-verdicts` branch mode), and only when they pass runs the Word exporter with the settings and that receipt. New in the move: the launch-video exporter had no checks branch. |
| `do-work/export_markdown_book_to_word.py` | Moved from launch-video `private_book_reader.py`: parses the Markdown subset of a book (headings, GFM tables, nested lists, quotes, inline bold, italic and code) and builds the Word file from a retained template (title, clickable contents with page fields, heading bookmarks, footer page numbers), only after the writing gate admits the exact source bytes, then reads the saved file back and compares it to the source. `--check` parses and reports without writing. Changed: the manuscript, template and output come from arguments or the settings row (`--settings-record` + `--book-id`, or `--settings` with the object already read), the checks receipt is `--checks-receipt`, and the last line is one JSON answer. |
| `do-work/writing_gate.py` | Moved from launch-video `writing_gate.py`: binds the settings to the source BLAKE3 and role; for current prose requires the checks receipt for these bytes, runs `tools/pin-files-by-content/do-work/verify-writing-profile.mjs` (writing profile, reviews, component spans through `verify-source-spans.mjs`), and validates the captured Decider2B (book-voice classifier) execution on every paragraph and its hash-pinned qualification benchmark, with policy-bound reader context (v1 earlier blocks, v2 heading previews). Changed: settings instead of a `.writing-policy.json` found beside the manuscript (the evidence folder is the settings' `evidence_folder`), BLAKE3 from `tools/content-identity` instead of `b3sum`, the checker found beside this tool instead of through `TRILLION_WORKSHOP`, and the capture validator is the classifier's own module. |
| `do-work/check-a-voice-capture.mjs` | The gate's call into the classifier's `validateInput` and `validateReport` (the launch-video gate's inline `node -e` script). |
| `do-work/verify_book_against_its_source.py` | Moved from launch-video `verify_pdf_source.py`: checks the Word file and a rendered PDF against the source (outline order and depth, contents links, pre-body blank pages, page map, ordered prose and table inventories with pypdf and PDFium, arrows), and can repair confirmed ToUnicode ligature mappings with a pixel-identical check. Changed: BLAKE3 from `tools/content-identity`, the summary is one JSON line. |
| `test/test_export_markdown_book_to_word.py`, `test/test_verify_book_against_its_source.py`, `test/test_writing_gate.py` | The launch-video tests, all kept (73 methods), plus 6 for the settings row and the checks branch; when `tools/train-and-evaluate-a-writing-voice-classifier` is in the checkout, every gate test runs a second time against its own capture validator (`RealVoiceClassifierGateTests`). `CachedPageFieldTests` had gone stale there (it rendered without a source snapshot) and runs again. |
| `test/voice-classifier-stand-in.mjs` | A stand-in for the classifier's capture validator, so the gate's tests run without the classifier or a model. |
| `test/reader-context-scope-repro.json` | The launch-video reproduction that showed why reader context had to be policy-bound: the two-block context cannot tell apart an older definition. |
| `test/export-a-book.test.mjs` | Runs the three Python suites (skipped without python-docx, pypdf and pypdfium2), then the door entry over a made-up book and checks branch in an in-memory door: a passing and two failing branches, a blocked export that writes nothing, a comparison copy exported and refused once its bytes change, the settings row read through `tools/settings`. |
| `tool-rows.json` | The three tool rows. |
| `part.json` | The files other code may import: the page projection, `format-takes.mjs` and `read-data/export-formats.json` (the apps list and filter formats from them). |

## How a format is a row

```
{ "id": "csv", "label": "CSV", "extension": "csv", "mime": "text/csv", "renderer": "template",
  "draws": ["heading", "paragraph", "list", "table"], "options": { ... } }
```

`renderer` is one of `template`, `pdf`, `docx`, `xlsx`, `svg`, `document-json`; `options` are what that renderer reads (the template options are in `do-work/render-template.mjs`). A graph or events block the format does not draw is written as tables; a picture it does not draw is refused by name. `finished_by: page` (PNG) means the last step needs a browser page: the tool returns the SVG and `finish: raster-png`. A table column may declare a currency (`currencies`): formats that write words show money as money in the request's locale, and a format row with `options.cells: "numbers"` (CSV, TSV, Excel, JSON) keeps numbers (Excel adds a money format). A person's own format goes to the tool whole as `format_row`, so keeping formats in a list of one's own needs no code.

The app does not know a format: it lists `read-data/export-formats.json`, asks `format-takes.mjs` which formats take what it holds, builds a document from what the person selected (the reader lives with the screen that owns the selection), and runs the tool.

## Not carried from the old writers

The old Python writer (`render-structured-file-export.py`, its rules file and tests) and the package's browser-download builder are gone: the program above writes the same Markdown, text, Word and PDF files, and the formats the apps' own exporters wrote, from data. A character a PDF font cannot draw is refused, not replaced by a question mark as the app's old PDF writer did.

## The book's settings row

`record:setting:export-documents-to-files~piece~<book-id>` in `list:settings` (read with `tools/settings`), its `settings`:

| Key | Holds |
|---|---|
| `role` | `current_prose`, `comparison` or `historical_reference`. A comparison or historical reference is exported as bound input with no current-prose approval. |
| `source_blake3` | The BLAKE3 the manuscript's bytes must have; any change blocks until the evidence is renewed. |
| `manuscript`, `template`, `output_folder` | Where the book, the retained Word template and the exports are (arguments win). |
| `checks_branch` | Current prose: the book's branch of `list:checks`; its rows and those of every branch above it are judged on the exact bytes. `checks_reading` passes options to the Markdown reader. |
| `evidence_folder` | Current prose: the absolute folder the evidence below is read from; no path may leave it. |
| `profile`, `reviews` | The writing profile and review manifest `verify-writing-profile.mjs` reads. |
| `decider_requirements`, `decider_evidence`, `decider_qualification` | The policy-owned criteria and model, the captured run on every paragraph, and the hash-pinned qualification benchmark (as the launch-video README described them; `reader_context_binding` binds literal reader context). |

## How old Trillion did it

Old Trillion had no Markdown-to-Word book exporter and never used pandoc: it only named Word files for preview and download (`src/file-words.json:69`, `src/repo-explorer.mjs:626`, `src/workspace/file-previews.json:12` at 4ffa1dc4a2^) and saved an exported artifact through the process file-save envelope of the structured-file-output engine (`parts/group/do-work/request-board-output.ts:13` at cc1ece55), whose Word writer was a Python program, now replaced by `do-work/render-docx.mjs`. The book exporter is a different job (a retained template, contents with page fields, a writing gate, PDF verification), so it was moved one to one, not merged into the document writer.

## Not carried from the book exporter

- The `.writing-policy.json` discovered beside the manuscript (and its `documents` map and `unknown_documents: deny`): the settings row replaces it, and a book with no row is refused the same way.
- `b3sum` and `TRILLION_WORKSHOP`: the Workshop's own BLAKE3 owner and checker paths are used.

## Dependencies

**Depends on:** Node (the file exporter: the standard library only; ink marks through `tools/draw-ink-marks`). The book exporter, on the person's computer: Python 3, python-docx, and pypdf, pypdfium2 and Pillow for its verifier, LibreOffice to render a PDF; Node with `tools/content-identity` (BLAKE3), `tools/pin-files-by-content` (writing profile, source spans), `tools/check-against-a-persons-rules-and-verdicts` (the checks branch, `read-words.mjs`), `tools/records-door` (the door on the person's computer), `tools/settings` (the settings row) and `tools/train-and-evaluate-a-writing-voice-classifier` (`read-data/evaluation-integrity.mjs`, the voice capture validator).

**Depended on by:** the four tool rows; `tools/publish-content-for-discovery` (the page projection).
