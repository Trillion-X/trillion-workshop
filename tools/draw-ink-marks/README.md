# tools/draw-ink-marks/

Ink marks on any addressed space (a page, a picture, a timeline, a board): the Workshop tools `tool:see-the-ink-marks-on-a-space`, `tool:turn-a-drawn-stroke-into-a-mark-shape`, `tool:find-the-ink-mark-to-erase` and `tool:export-ink-marks-as-svg`, run in the tool container. Ported from the addressed-marks package: its ink physics (reading operations, folding them into showing marks, stroke shapes, erase hit-testing, SVG export), as plain data in and data out.

Marks are append-only. A mark is never edited: a later operation hides, restyles, reorders, copies or merges an earlier mark by naming its ref, and what shows is the fold of all operations in the order they were made. Erasing is therefore a new operation, which keeps every earlier state recoverable.

## Files

| File | Purpose |
|------|---------|
| `do-work/ink.mjs` | The mechanism, pure: `readMarkOperationRecords`, `readMarkStyles`, `readMarkTools`, `markTargetKey`, `materializeMarkRecords`, `mapPointsForTool`, `nearestMarkPathRef`, `marksToSvg`. |
| `do-work/marks.mjs` | The command of all four tools: the verb (`see`, `stroke`, `erase`, `svg`) is the first argument, one JSON request is on standard input, `{ result }` or `{ error }` is the last line. |
| `tool-rows.json` | The four tool rows. |
| `part.json` | The pure module other tools may import. |
| `test/ink.test.mjs` | The package's export tests, plus folding, reference effects, stroke shapes and erasing, over made-up pictures. |
| `test/marks-command.test.mjs` | The four commands run as the container runs them. |

## Key Types / Functions

| Function | Signature | Role |
|---|---|---|
| `materializeMarkRecords` | `({ operations, styles?, target?, readerKey? }) => { targetKey, paths, hiddenRefs, operations, unrendered }` | Folds the operations for one space; a mark's own style fields lie over the style it names. |
| `mapPointsForTool` | `(tool, points) => points` | Chooses the figure from the tool row's mapper: passthrough, segment, polygon corners, polygon sides N. Unknown kinds keep the stroke. |
| `nearestMarkPathRef` | `(material, point, radius) => ref \| null` | Nearest showing mark by distance to its segments, closing edge included. |
| `marksToSvg` | `(material, { defaultStroke }) => { svg, bounds }` | One path per mark in the space's own coordinates; refuses a mark with no concrete colour and no default. |

## Invariants

- Nothing here names a tool, a colour or a space: tools, styles and spaces are the person's own rows, read from the request.
- The export has no default colour. The old package fell back to a fixed ink colour; that was somebody's choice, so a caller now supplies `default_stroke` or the export is refused.
- Stroke widths are in the reader's screen units and are exported as `vector-effect: non-scaling-stroke`, as drawn.

## Not here

The drawing surface (pointer capture, the toolbar, the live overlay and its session state), the fill decoration layers drawn through the shared interface layer registry, and the writers that append operations and styles to the old log belong to the screens and to the records door, not to a tool. Appending an operation is a record write the caller makes with the effects these tools return.

## Dependencies

**Depends on:** Node 24 in the tool container (`node:stream/consumers`).

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
