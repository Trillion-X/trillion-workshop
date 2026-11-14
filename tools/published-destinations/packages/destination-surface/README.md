# destination-surface

Generic read-only surface for owner-published destination descriptors.

## Boundary

- Descriptor DATA owns labels, layout, subject scope, and accepted-effect row selection.
- Documents selects owner-published destination projections; the browser never reads or aggregates accepted effects.
- The surface renders honest empty state until the declared owner returns accepted rows.
- The browser never resolves identity, writes effects, executes scoring, or persists progress.
- Rank, history, pulse, and progress rows are empty or derived from canonical owner output.

## Source

| File | Job |
|---|---|
| `read-data/read-destination.ts` | Decode and project generic descriptor physics. |
| `do-work/read-activity-effects.ts` | Decode the composition-provided accepted-effect input. |
| `show/DestinationView.tsx` | Render descriptor sections and visual-only celebrations. |
| `do-work/migrate-honest-destination-state.ts` | Guarded successor-first migration and exact legacy-row retraction. |
| `things-to-store-and-run.json` | Renderer entry, descriptor contract, migration target, and zero product instances. |

## Honest-state migration

`destination-surface.migrate-honest-destination-state` is owner-to-owner only.
It accepts exact current payloads, honest successors, and exact retraction rows
within the `destination::` namespace. It performs this fixed sequence:

1. Read every current mutation basis.
2. Write honest empty/derived successors with atomic guards.
3. Read back every successor exactly.
4. Retract only exact declared legacy rows under declared bases.
5. Read back final absence.

Lost replies are classified by the independent readback. Changed bases fail
closed. Replays converge without additional writes.

Production activation and live migration are intentionally outside this source
package change.
