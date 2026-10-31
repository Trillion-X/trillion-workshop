# tools/office-files/

Reads a spreadsheet, a Word document or a presentation as data, changes cells or words by rules while keeping every other byte, and edits a presentation's text and slide order and reads it back as proof. Four tools that run on the person's own computer: `tool:read-an-office-file`, `tool:change-cells-or-words-in-an-office-file`, `tool:edit-a-presentations-text` and `tool:describe-a-presentation-runtime`. Ported from bitfield-packages `packages/office-open-xml-decoder` and `packages/apply-declared-presentation-text-edits`; nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `do-work/decode-office-open-xml.py` | Reads an xlsx, docx or pptx into JSON, standard library only. `python3 decode-office-open-xml.py <file> [--sheet NAME] [--max-rows N] [--formulas]`. Carried unchanged except its path line. |
| `do-work/rewrite-office-open-xml-cells.py` | Applies a JSON rule list (`cell`, `shared-string`, `document-text`) and writes a new file; reports matches per rule. `python3 rewrite-office-open-xml-cells.py <in> <rules.json> <out>`. Carried unchanged except its path line. |
| `do-work/apply-declared-presentation-text-edits.mjs` | Applies one request to a presentation through a runtime module the request names, then reads the output back. `node apply-declared-presentation-text-edits.mjs --request <request.json>`. Changed: the typeface comes from the request (`fonts.regular`, `fonts.bold`, or `typeface` on a text item) and is set only when named; the package set one product font pair. |
| `do-work/describe-presentation-runtime-surface.mjs` | Read-only probe: the property names the runtime exposes on a slide, a shape's text and the notes. Carried unchanged except its path line. |
| `test/decode-office-open-xml.test.py` | The package's test: builds a workbook, decodes it, rewrites a formula cell and an inline string, asserts the unmatched rule reports 0, decodes the output again (5 cases). Changed: the paths of the two programs. |
| `test/test_paragraph_locators.py` | The package's paragraph-locator test (3 checks). Changed: the path of the decoder, and it prints its result instead of writing `records.json`. |
| `test/test_presentation_order.py` | New: slides come back in the deck's declared order, not file-name order. |
| `test/apply-presentation-edits.test.mjs` | New: the presentation editor over a stand-in runtime and a made-up deck (the package had no test). |
| `test/office-files.test.mjs` | Runs the Python tests under `python3 -I`. |
| `tool-rows.json` | The four tool rows. |
| `part.json` | No public files. |

## Request shape (presentation edits)

```json
{
  "runtimeModule": "<absolute path to a module exporting FileBlob and PresentationFile>",
  "source": "<in.pptx>", "output": "<out.pptx>",
  "fonts": { "regular": "<typeface>", "bold": "<typeface>" },
  "slides": [
    { "index": 3, "bg": "#171922",
      "text": [{ "s": "...", "pos": {"left":0,"top":0,"width":0,"height":0}, "sz": 32, "b": true, "tc": "#fff", "a": "center", "va": "middle", "typeface": "..." }],
      "rect": [{ "pos": {}, "fill": "#...", "line": "#...", "lineW": 1, "radius": 12 }],
      "replace_text": [{ "contains": "old headline", "with": "new headline" }],
      "notes": "speaker notes" }
  ],
  "delete": [1, 15],
  "slide_order": [2, 3, 1]
}
```

Every edit names an ORIGINAL slide number; `slide_order` is applied last and must be a permutation of the surviving slides.

## Key Types / Functions

| Name | Signature / Shape | Role |
|---|---|---|
| `_decode_sheet` | `(z, part, strings, max_rows, want_formulas) -> rows` | One worksheet part to `[{ row, cells: { A: { value, formula? } } }]`. |
| `_decode_document` | `(z) -> { kind, blocks }` | Paragraphs with `paragraph:N` selectors (empty paragraphs count, table paragraphs do not) and tables. |
| `_presentation_slide_parts` | `(z) -> [part]` | Slide parts in the order the presentation declares. |
| `_matches` / `_apply_set` | `(cell, strings, match) -> bool`, `(cell, setting)` | The whole matcher and setter vocabulary of the rewriter; a new matcher is one branch and one key in the rules file. |
| Presentation request | see above | One numbering, one report, readback as proof. |

## Invariants

- The input file is never modified; the output goes to the path the caller names.
- Every part a rewrite does not touch is copied byte for byte, so styles, charts and formatting survive.
- A rule that matches nothing is reported with 0, never silently accepted; a `slide_order` that drops or doubles a slide refuses the whole request.
- No sheet name, formula, slide content or product is known here: all of it arrives in the rules or the request.

## Dependencies

**Depends on:** Python 3 standard library (`zipfile`, `xml.etree`, `json`, `argparse`) for the two Python programs; Node 24 for the presentation editor, plus a presentation runtime module the request names (any module exporting `FileBlob.load` and `PresentationFile.importPptx` / `exportPptx`).

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
