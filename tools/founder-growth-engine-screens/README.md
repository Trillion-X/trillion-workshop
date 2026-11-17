# tools/founder-growth-engine-screens/

The founder growth workspace: one top-level surface and six child views (what to do next, what the operator is doing, content results, write a post, distribution, connected services), each a view over the person's own rows. Adding a child is one more surface record carrying the workspace's placement label; no source entry is added. Every data-heavy child gets a bounded owner address, so the workspace never falls back to a catalogue of every row.

Moved byte for byte from the old `founder-growth-engine-screens` package of `bitfield-packages` (`moved-from.json` is the receipt). The data layer of the screen and both tests are held (below).

## Files

| File | Purpose |
|------|---------|
| `read-data/visual-database-projection.ts` | `buildFounderGrowthVisualDatabaseProjection` and `readFounderGrowthFeedInputName`: build the visual-database model, its evaluator descriptors, its first view and the row-open actions from a surface's input and its feed. |
| `show/mount-visual-database-surface.tsx` | The screen mount: reads the feed, builds the projection, draws the visual-database surface and its record actions. |
| `things-to-store-and-run.json` | The package's own boundary file: the workspace surface, its six child surface records, the retired Saved links marker and the four input descriptors. |
| `__tests__/*.test.ts.held` | The two package tests, held. |
| `moved-from.json`, `ports/` | The receipt and the port contracts of the move. |

## Held

- `show/mount-visual-database-surface.tsx` reads its feed with `useBitfieldData` and asks other owners with `sendRequestToBitfieldTarget`, both of the retired package runtime; they become records-door reads before a tool row can open the screen.
- `tools/keep-lists-of-rows/...` (the visual database's model, derived-field resolver and surface) and `tools/ui/show/placeable-surface-intent/...` are not in this repository's tree; the imports stay as written until those groups are moved.
- `__tests__/workspace-surface.contract.test.ts.held` needs `visual-database-projection.ts` to load; `__tests__/capture-summarize-chain.conformance.test.ts.held` reads the boundary file of a different package (`founder-growth-engine`). The receipt key `held` names each reason.

## Dependencies

**Depends on:** the visual database and the shared UI parts, neither in this tree yet.

**Depended on by:** nothing in this repository yet.
