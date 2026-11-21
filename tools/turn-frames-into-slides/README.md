# tools/turn-frames-into-slides/

Each presentation frame on a board becomes one slide, in story order, drawn by the board's own SVG exporter. The slides print as pages of the frame's size into one PDF, with a picture of every page. A deck, a brand book or a one-page summary is the same thing here: a board with frames. Colours and fonts are the person's look (named by variable, read from `tools/screen-looks`), logos are their brand's files (picked by `tools/brand-kit`), and per-reader wording is a filled word template (`tools/fill-a-template-without-changing-its-words`). Ported from the group board's deck export with its whole import closure; the only changes are local import paths and the additions listed under Invariants.

## Files

| File | Purpose |
|------|---------|
| `read-data/group-graph.ts`, `node-ref.ts`, `visual-layer-types.ts` | The graph the board is kept in, which other tools import from here (part.json). |
| `do-work/make-slides.mjs` | `node do-work/make-slides.mjs <request.json> --out <folder> [--browser <chromium>] [--pdf] [--pictures]`: look values, assets and filled words into the board, then the slides, the document, the PDF and the pictures. |
| `read-data/words-a-reader-sees.json` | DATA: the rule rows (tools/judge-words rows) every line on a slide is judged by before anything is drawn: no long dash, no small-print hedging, no small label above the title. A request's `words_rules` (the person's own rows) are judged with them. |
| `tool-rows.json` | `tool:turn-frames-into-slides`, an `on-your-computer` row. |
| `part.json` | The graph files other tools may import. |
| `test/board-deck.test.ts` | The deck export's own tests, carried with it. |
| `test/words-a-reader-sees.test.mjs` | A long dash, an en dash, small-print hedging, a label above the title (whatever it is named) and a person's own rule row each stop the deck; plain words, a hyphen, a caption under a picture and a subtitle below the title are drawn. |
| `test/make-slides.test.mjs` | A made-up board: story order, frame size, look values, an asset, filled words, stops on a missing value, and (with a Chromium) the PDF and pictures. |

## How to run it

```
node tools/turn-frames-into-slides/do-work/make-slides.mjs request.json --out deck --pdf --pictures
```

`request.json` (paths relative to it):

```json
{
  "board": "board.json",
  "title": "Example deck",
  "look_values": "look.json",
  "look_css": "look.css",
  "assets": { "wordmark": "brand/wordmark-black.svg" },
  "frames": ["s1", "s3"],
  "words_from": "filled.piece.json"
}
```

`frames` names the slides to make and their order, so one board can hold the pages of several decks and each deck request picks its own. Pictures and hand-drawn marks are board items too: `extra.crop` ({ x, y, w, h } as parts of the picture) shows one window of a screenshot, `extra.rotation` tilts a note, `extra.borderStrokeStyle` (`marker`, `pencil`, `sketch`) draws a frame by hand, and a connector (`extra.fromMemberId`, `extra.toMemberId`, `extra.strokeStyle`) draws a line between two items.

A board item: `{ "memberId": "s1-title", "x": 80, "y": 80, "w": 1000, "h": 200, "text": "Made for Example Co", "extra": { "fontSize": 56, "fontWeight": 600, "fontFamily": "--font-display", "style": { "fill": "none", "stroke": "none", "textColor": "--text-primary" } } }`. A frame: `{ "memberId": "s1", "x": 0, "y": 0, "w": 1280, "h": 720, "extra": { "presentationFrame": { "order": 1 }, "style": { "fill": "--black-pure", "stroke": "--black-pure" } } }`.

Per-reader wording: make a word template from the printed `deck.html` (`html_json_records` with `script_id: "slide-words"`, medium `carousel`), mark the reader's specifics as slots, fill them from sourced facts, check the fill with `drift.py --check`, and pass the filled piece as `words_from`.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `BoardItem` | `{ memberId, x, y, w, h, text?, src?, extra }` | One thing on the board; a frame carries `extra.presentationFrame.order`. |
| `boardToDeck` | `(items, BoardDeckOptions) => { slides: DeckSlide[] }` | Frames to slides. |
| `deckToHtml` | `(deck, { title?, page?, css?, words? }) => string` | The document the PDF is printed from. |
| `prepareItems` | `(rawItems, { values, assets, texts, base }) => BoardItem[]` | Look values, assets and filled words into the board. |
| `chooseFrames` | `(items, ids?) => BoardItem[]` | Only the named frames stay slides, in the named order; absent ids keep every frame. |

## Dependencies

**Depends on:** Node's standard library; `tools/judge-words` (`judge`, for the words every slide is judged by); `tools/organize-the-sidebar` (the board model, frames, exporter and deck); `tools/headless-browser` (`devtools.mjs`, loaded only for `--pdf` and `--pictures`) and a Chromium.

**Depended on by:** `tools/workflows/recipes/make-a-brand-book-and-decks.json`.

## Invariants

- Every line on every chosen slide is judged (`wordFindings`, with `tools/judge-words`) before any slide is drawn; one broken row stops the run with each finding and its slide, so a deck drawn by a workflow and a deck drawn by a lane's own script meet the same rules. A short line set at most 0.8 of the slide's largest words and wholly above them is judged as a label above the title (`slideLines`), by where it sits, not by its name.

- One slide per frame, in the frames' story order; every frame is the same size, and that size is the page.
- A colour or font written as a variable name is the look's own value, and text shows a look value as `{{--name}}` (a swatch label) so the value is never copied; a name the look lacks stops the run. Nothing here names a colour, a font or a brand.
- The board model, frames, exporter and deck are tools/organize-the-sidebar's (`read-data/group-board-model.ts`, `do-work/board-frames.ts`, `do-work/board-svg.ts`, `do-work/board-deck.ts`), imported, never copied. Their additions this tool needs, each absent → byte-identical output: per-item `extra.fontSize`, `fontWeight`, `lineHeight`, `textInset`, `charWidth`, and `extra.imageFit: "contain"`; `deckToHtml`'s `page`, `css` and `words`.
- Text that does not fit its item ends in an ellipsis rather than overflowing; look at the pictures.
- The slide words in the document are inert JSON (never run), with `<` escaped.
