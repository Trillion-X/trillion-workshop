# path-rail/

A winding learning-path rail (Duolingo-style) — resolved coin nodes stacked on an oscillating vertical centerline, with status-driven appearance (colour / ring / complete / dimmed / bubble) resolved from DATA, no status enum in code.

## Files

| File | Purpose |
|------|---------|
| `PathRail.tsx` | The rail: stacks `PathNode`s on a winding centerline (`windingOffsets`), optional sticky header + empty state; owns the shared keyframes once; motion off under `prefers-reduced-motion`. |
| `PathNode.tsx` | One circular coin node + `PathNodeView` type: raised circle, optional pulsing ring (active), floating bubble, dimmed/locked look, check overlay, caption. Pure presentation — never decides status. |
| `PathConnector.tsx` | One connector rule threading two adjacent nodes across the gap (the dashed-line-between-milestones anatomy). Paints a resolved segment (geometry) with a resolved look (color + dashed); decides no status — traversed (solid, toned) vs upcoming (dashed, muted) is chosen upstream from node status (L090). |
| `path-rail-geometry.ts` | `windingOffsets(count, config?)` — per-node horizontal offsets that oscillate the centerline; `connectorSegments(offsets, gap)` — one `{fromX,toX,length,angleDeg}` per adjacent pair (N nodes → N-1). Both pure + total. |
| `decode-path-nodes.ts` | Generic decoder: raw node rows + a DATA `statusOverrides` map → resolved `PathNodeView[]`. Status is an open string key resolved via DATA (L090). |
| `index.ts` | Barrel — `PathRail`, `PathNode`, `PathConnector`, `windingOffsets`, `connectorSegments`, `decodePathNodes` + types. |
| `PathRail.test.tsx` | Rail tests: one button per node, active bubble, activate-on-click (locked excluded), empty state, header, N-1 connectors, single-node → no connector, traversed/solid vs upcoming/dashed segment tone. |
| `PathNode.tsx` tests / `decode-path-nodes.test.ts` / `path-rail-geometry.test.ts` | Decoder (DATA-driven status, new status = new row, unknown → default, icon resolver, wrapper/junk) + geometry tests. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `PathNodeView` | `{ id, label, icon?, toneColor, ring?, bubble?, dimmed?, complete?, caption? }` | An already-resolved node (colour + flags decoded upstream). |
| `RawPathNode` | `{ id, label, status?, iconName?, bubble? }` | A raw node row before decode. |
| `PathStatusOverride` | `{ toneColor, ring?, dimmed?, complete?, bubble? }` | DATA map value: a status key → coin appearance. |
| `decodePathNodes` | `(raw, { statusOverrides, iconResolver?, defaultTone? }) → PathNodeView[]` | Resolves raw rows against the DATA overrides. Pure. |
| `PathRail` | `({ nodes, header?, gap?, nodeSize?, winding?, onActivate?, emptyState?, className? }) → JSX` | The winding rail; interleaves a `PathConnector` between each adjacent node pair. |
| `PathConnector` | `({ segment, gap, thickness?, color, dashed? }) → JSX` | One rotated rule threading two nodes across the gap. |
| `ConnectorSegment` | `{ fromX, toX, length, angleDeg }` | Geometry of one connector (from `connectorSegments`). |
| `windingOffsets` | `(count, config?) → number[]` | Per-node centerline offsets. |
| `connectorSegments` | `(offsets, gap) → ConnectorSegment[]` | One segment per adjacent node pair. Pure. |

## Dependencies

**Depends on:** `@/packages/ui/show/cn`, `lucide-react` (`Check`, `Lock`).
**Depended on by:** path/progression feature surfaces and the `ui` barrel (`packages/ui/index.ts`).

## Why This Design?

Status is an open DATA key resolved via `statusOverrides` — no closed enum, no `if (status===)` (L090/L063). Adding a new status (e.g. `bonus`) is one override row, zero code. The node layer paints a pre-resolved view, so the rail carries no domain vocabulary — any sequential journey (course path, onboarding, challenge) is the same rail from data.
