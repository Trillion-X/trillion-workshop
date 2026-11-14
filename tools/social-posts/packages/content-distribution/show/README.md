# content-distribution / show

The blind, descriptor-driven Distribution surface: it paints owner-produced copy, columns, stats, channels, and a post queue with a master-detail pane, choosing none of those words itself.

## Files

| File | Purpose |
|------|---------|
| `ContentDistributionPanel.tsx` | The React surface. Reads the evidence feed via `useBitfieldData`, resolves it through `readDistributionView`, and renders the heading, blocker cards, stat band, channel grid, post queue (wide table / narrow cards), and the selected-post detail pane — entirely from resolved descriptor cells. |
| `mount-content-distribution.tsx` | Bootstrap shell that mounts the panel into the runtime surface frame (error boundary + floating material frame + react surface mount). Follows the universal package mount convention. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `ContentDistributionPanel` | `() => JSX.Element` | Top-level surface export. Holds only ephemeral UI state (`selectedIntentId`); all domain truth comes from the resolved `view`. |
| `QueueCellView` | `({ cell: QueueCell, column: QueueColumn, liveLinkLabel: string }) => JSX.Element \| null` | Paints one already-humanized cell by its generic `render` kind (`status` → Badge, `link` → external-link Icon, else → Text). Never branches on a platform or status name. |
| `DestinationCard` | `({ destination: PublishDestination, connectedLabel, disconnectedLabel }) => JSX.Element` | One channel card: display label, optional account label, connection StatusDot + label. Connection is the generic boolean `connection_enabled`. |
| `PostDetail` | `({ detail: DistributionDetail, view: DistributionView }) => JSX.Element` | The detail pane: title + status Badge, sanitized error + remediation lines, labeled field list (`OutputFieldList`), optional live link, and the activity timeline. |
| `badgeVariant` | `(tone: string) => 'neutral'\|'info'\|'success'\|'warning'\|'error'` | Maps a generic semantic tone to a Badge variant, defaulting unknown tones to `neutral`. |
| `toneDot` | `(tone: string) => 'success'\|'warning'\|'error'\|'info'\|'idle'` | Maps a generic tone to a StatusDot status token, defaulting unknown tones to `idle`. |

## Dependencies

**Depends on:**
- `@/packages/ui` (barrel only) — `Badge`, `Card`, `Container`, `Icon`, `OutputFieldList`, `ResponsiveSwitch`, `SafeErrorCard`, `ScrollableSurface`, `StatStrip`, `StatusDot`, `Table*`, `Text`, `sanitizeErrorText`.
- `@/packages/content-distribution/read-data/read-content-distribution` — `readDistributionView`, `destinationDisplayLabel`, and the view types.
- `@bitfield/runtime-kit/react` — `useBitfieldData` (the only data source).
- `lucide-react` — `ExternalLink` icon.

**Depended on by:**
- The package mount/runtime surface registration (via `mount-content-distribution.tsx`).

## Invariants

1. Zero imports from `slot::workflow` / `slot::eeaf` — data arrives only through `useBitfieldData`.
2. Components only from the `@/packages/ui` barrel; zero inline `className`, zero raw `<div>/<span>/<p>`. The lone `<a>` wrapper is the platform's only native link affordance.
3. Platforms are destination **records** and statuses are domain **options** — the panel never names a platform or a status (L090). It renders resolved cells.
4. No copy/column/stat literal in code: every visible string comes from `view.copy`, `view.queueColumns`, or `view.statBand`.
5. The panel logs `[ui:content-distribution] mounted input=<n> records` on mount (observability).
