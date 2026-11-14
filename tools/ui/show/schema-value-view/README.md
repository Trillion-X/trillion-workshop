# schema-value-view

Shows what a tool, a step or an AI handed back as a designed view picked by the value's shape. No raw-JSON toggle; ids, hashes and raw timestamps are not shown.

## Files

| File | Purpose |
|------|---------|
| `result-views.json` | DATA: the shape-to-view rows (first match wins), field roles (title, summary, state, time), machine-field patterns, state words and tones, flag and time phrases, limits and words. Also names, per view, the shared part and the catalogue entry it follows. |
| `result-view.ts` | Pure: a value (and its schema) becomes a `ResultView` by evaluating the rows. Builds the headline sentence of a status from its own data and turns moments into human times. |
| `value-shape.ts` | Pure: the plain field list (`valuePieces`, `plainLabel`), used when `designed={false}` and for a value no row describes. |
| `SchemaValueView.tsx` | Draws a `ResultView` with shared parts: Card, Container, Text, StatusDot, StatStrip, Table, Timeline, SafeErrorCard, EmptyPlaceholder. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `SchemaValueView` | `({ value, schema?, designed?, now? }) => ReactElement` | The view any screen uses for a tool's, step's or AI's output. |
| `resultView` | `(value, { schema?, now?, timeZone? }) => ResultView` | Value to designed view; deterministic. |
| `ResultView` | `status-card \| summary-card \| item-list \| table \| timeline \| metric-tiles \| error-card \| link-card \| text \| bullets \| empty-state \| pieces` | One designed view. |
| `valuePieces` | `(value, schema?, label?) => ValuePiece[]` | Plain field list. |

To map a new shape to a view, add a row to `shapes` in `result-views.json`; the renderer names no tool.

## Dependencies

**Depends on:** `card`, `container`, `empty-placeholder`, `relative-time`, `safe-error-card`, `stat-strip`, `status-dot`, `table`, `text`, `timeline` (all in this part).

**Depended on by:** `src/workspace/tool-screen.tsx`, `src/workspace/workshop-screen.tsx`, `tools/social-posts/web/src/workspace/posts-screen.tsx`, `tools/build-and-send-a-sales-contract/web/src/workspace/sales-contract-builder-surface.tsx`, `parts/ui/show/run-card`, and, with `designed={false}`, `parts/documents/show/DocumentConflictComparison.tsx`, `parts/file-content-renderer/show/FileContentRenderer.tsx`, `trillion-workshop/tools/keep-lists-of-rows/show/descriptor-mutation-recovery.tsx`.
