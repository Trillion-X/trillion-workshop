# tools/export-documents-to-files/

Saves a document as a file, exports a Markdown book to Word through its writing checks, and writes a web page from a record. Three tools that run on the person's own computer: `tool:export-a-document-to-a-file`, `tool:export-a-markdown-book-to-word` and `tool:write-a-web-page-from-a-record`. Ported from bitfield-packages `packages/structured-file-output` and `packages/public-document-renderer`, and moved from Trillion-X/trillion-launch-video `tools/private-book-reader` (at 5a9ba3988a4d); nothing here is imported by the Worker.

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
| `do-work/export-a-book.mjs` | `tool:export-a-markdown-book-to-word`, the entry with the person's records door (`exportABook(input, { door })`, run with `tools/records-door/do-work/run-with-stdio-mcp.mjs`): reads the book's settings row through `tools/settings`, runs the book's checks branch of `list:checks` on the exact manuscript bytes (`bookChecks`, through `tools/check-against-a-persons-rules-and-verdicts` branch mode), and only when they pass runs the Word exporter with the settings and that receipt. New in the move: the launch-video exporter had no checks branch. |
| `do-work/private-layout-proof.py` | Source-baselined restoration of the explicitly admitted private-layout purpose. The existing book entry delegates to this core; it pins the original policy/source/projection/scoped gate/rules, holds private snapshots, invokes the current structured renderer and reads back a private unfinished artifact with a non-delivery receipt. `ports/private-layout-proof.json` records the real byte-copy baseline and the live-caller retirement boundary. |
| `do-work/project-markdown-source.py` | Projects an exact current Markdown snapshot through the existing book parser and independent source checker into the source-bound Documents tree. Literal blocks retain hard lines and whitespace; list items retain original markers and nesting. Synthetic consumer controls are in `test/test_markdown_source_projection.py`. |
| `do-work/export_markdown_book_to_word.py` | Moved from launch-video `private_book_reader.py`: parses the Markdown subset of a book (headings, GFM tables, nested lists, quotes, inline bold, italic and code) and builds the Word file from a retained template (title, clickable contents with page fields, heading bookmarks, footer page numbers), only after the writing gate admits the exact source bytes, then reads the saved file back and compares it to the source. `--check` parses and reports without writing. Changed: the manuscript, template and output come from arguments or the settings row (`--settings-record` + `--book-id`, or `--settings` with the object already read), the checks receipt is `--checks-receipt`, and the last line is one JSON answer. |
| `do-work/writing_gate.py` | Moved from launch-video `writing_gate.py`: binds the settings to the source BLAKE3 and role; for current prose requires the checks receipt for these bytes, runs `tools/pin-files-by-content/do-work/verify-writing-profile.mjs` (writing profile, reviews, component spans through `verify-source-spans.mjs`), and validates the captured Decider2B (book-voice classifier) execution on every paragraph and its hash-pinned qualification benchmark, with policy-bound reader context (v1 earlier blocks, v2 heading previews). Changed: settings instead of a `.writing-policy.json` found beside the manuscript (the evidence folder is the settings' `evidence_folder`), BLAKE3 from `tools/content-identity` instead of `b3sum`, the checker found beside this tool instead of through `TRILLION_WORKSHOP`, and the capture validator is the classifier's own module. |
| `do-work/check-a-voice-capture.mjs` | The gate's call into the classifier's `validateInput` and `validateReport` (the launch-video gate's inline `node -e` script). |
| `do-work/verify_book_against_its_source.py` | Moved from launch-video `verify_pdf_source.py`: checks the Word file and a rendered PDF against the source (outline order and depth, contents links, pre-body blank pages, page map, ordered prose and table inventories with pypdf and PDFium, arrows), and can repair confirmed ToUnicode ligature mappings with a pixel-identical check. Changed: BLAKE3 from `tools/content-identity`, the summary is one JSON line. |
| `test/test_export_markdown_book_to_word.py`, `test/test_verify_book_against_its_source.py`, `test/test_writing_gate.py` | The launch-video tests, all kept (73 methods), plus 6 for the settings row and the checks branch; when `tools/train-and-evaluate-a-writing-voice-classifier` is in the checkout, every gate test runs a second time against its own capture validator (`RealVoiceClassifierGateTests`). `CachedPageFieldTests` had gone stale there (it rendered without a source snapshot) and runs again. |
| `test/voice-classifier-stand-in.mjs` | A stand-in for the classifier's capture validator, so the gate's tests run without the classifier or a model. |
| `test/reader-context-scope-repro.json` | The launch-video reproduction that showed why reader context had to be policy-bound: the two-block context cannot tell apart an older definition. |
| `test/export-a-book.test.mjs` | Runs the three Python suites (skipped without python-docx, pypdf and pypdfium2), then the door entry over a made-up book and checks branch in an in-memory door: a passing and two failing branches, a blocked export that writes nothing, a comparison copy exported and refused once its bytes change, the settings row read through `tools/settings`. |
| `tool-rows.json` | The three tool rows. |
| `part.json` | No public files. |

## Not carried

The package also held a browser-download builder (`make-structured-file-output.ts`) that wrote csv, markdown, text, a plain docx and a simple pdf bytes in the browser and handed them to a download or a save-to-path step of the old engine. The rules-driven program above produces the same Markdown, text, Word and PDF files from data and supersedes it; the browser hand-off is old-engine plumbing and is not carried. A spreadsheet (xlsx) writer existed only there.

## Rules file shape

A JSON list of rows `{ "kind": "structured-file-projection-rules", "id", "text_properties", "heading_level_path", "table": { "min_cells", "min_rows" }, "formats": { "<format_id>": { "extension", ... } } }`. A format with `"renderer": "docx"` or `"pdf"` is drawn by the program (styles are fields of the format); any other format is built from `title_template`, `heading_template`, `line_template`, `row_template`, `cell_separator`, `document_template` and the other template fields. See the starter file.

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
| `export_purposes.private_layout_proof` | Optional explicit admission `{input_root, policy, policy_blake3}`. It pins the original default-deny `book-writing-policy-v1` document/purpose map rather than discovering a policy beside the source. All paths are exact absolute paths; `policy_blake3` is the hexadecimal BLAKE3. |

### Private layout inspection

The normal `exportABook` request accepts `purpose: "private_layout_proof"` and `job_file` only when the settings explicitly admit that purpose. The Python CLI accepts the same `--purpose private_layout_proof --job-file JOB`. This branch preserves the current-prose role. It runs the original private-purpose admission against held private source, policy, job, projection, scoped mechanical gate and rules snapshots, then uses the current structured document renderer. It does not run or satisfy the final-delivery checks branch, writing profile or voice qualification. Omitting `purpose` keeps the existing final-delivery path and every one of its guards.

The pinned policy must retain `schema: "book-writing-policy-v1"`, `unknown_documents: "deny"`, and an exact source entry with `role: "current_prose"`, `source_blake3` and `native_gate_result`. Its `export_purposes.private_layout_proof` requires `delivery_eligible: false`, `requires_voice_qualification: false`, a visible title containing "Private layout proof" and "Unfinished", a relative private `output_root` outside `deliverables`, and an exact admitted document entry with `file_stem`, `projection`, `projection_blake3`, `mechanical_gate_id`, `mechanical_gate_blake3`, `rules` and `rules_blake3`. The scoped gate must actually pass; these pins do not create a gate result or imply a full writing review.

The job's `source.candidate_path` and `source.candidate_content_identity` bind the actual source (`1f:` plus its BLAKE3). Its tree must equal the pinned `documents-structured-file-projection-v1` projection's tree and `source_identity`. Only native Word/PDF formats are admitted. The policy owns the destination and file stem; final-output, template and page-map arguments are refused for this purpose. Input files must be private regular files owned by the current user under `input_root`, with no symlink ancestors. The policy's parent and all proof directories are mode 0700; proof files are mode 0600.

A success has `status: "private_layout_proof"`, `delivery_eligible: false` and a `private-layout-proof-result-v1` gate receipt with `voice_qualification: "not_established"`, exact input/artifact identities and visible unfinished-label readback. It claims neither author approval nor final delivery nor all-page review. Failed runs retain private diagnostics and cannot become final-delivery receipts. Synthetic opposing controls are in `test/test_private_layout_proof.py` and `test/private-layout-proof.test.mjs`.

Projection rules can name a `literal_text` selector and `indent_level_path`; the renderer preserves literal whitespace instead of treating it as wrapped prose. Optional PDF `literal_wrap` DATA describes soft display wraps with original hard-line character offsets and continuation prefixes; it never silently shrinks the source. The renderer returns the resulting `literal_layout` map and source identity inside the artifact receipt for separate page review. `--content-identity` adds the intended rendered bytes' `payload_hash` from the current content-identity owner; private proofs require it and compare saved bytes independently. Generic rendering without these opt-ins keeps its existing behavior.

## How old Trillion did it

Old Trillion had no Markdown-to-Word book exporter and never used pandoc: it only named Word files for preview and download (`src/file-words.json:69`, `src/repo-explorer.mjs:626`, `src/workspace/file-previews.json:12` at 4ffa1dc4a2^) and saved an exported artifact through the process file-save envelope of the structured-file-output engine (`parts/group/do-work/request-board-output.ts:13` at cc1ece55), whose Word writer is `do-work/render-structured-file-export.py` above. The book exporter is a different job (a retained template, contents with page fields, a writing gate, PDF verification), so it was moved one to one, not merged into that writer.

## Not carried

- The `.writing-policy.json` discovered beside the manuscript (and its `documents` map and `unknown_documents: deny`): the settings row replaces it, and a book with no row is refused the same way.
- `b3sum` and `TRILLION_WORKSHOP`: the Workshop's own BLAKE3 owner and checker paths are used.

## Dependencies

**Depends on:** Python 3 (Word export of a structured document: the standard library; PDF: reportlab). The book exporter: python-docx, and pypdf, pypdfium2 and Pillow for its verifier, LibreOffice to render a PDF; Node with `tools/content-identity` (BLAKE3), `tools/pin-files-by-content` (writing profile, source spans), `tools/check-against-a-persons-rules-and-verdicts` (the checks branch, `read-words.mjs`), `tools/records-door` (the door on the person's computer), `tools/settings` (the settings row) and `tools/train-and-evaluate-a-writing-voice-classifier` (`read-data/evaluation-integrity.mjs`, the voice capture validator).

**Depended on by:** the three tool rows.
