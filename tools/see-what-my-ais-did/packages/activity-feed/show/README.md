# Activity Feed Show

Browser material for the `Recent activity` pane and the live activity overlay.

## Files

| File | Purpose |
| --- | --- |
| `ActivityIndicator.tsx` | The generic live-actor badge renderer. Reads `activity-fact` records (via the scoped feed), ranks newest-first by **client-side first-seen** (the DATA path has no wall-clock), and renders a fading badge per actor. |
| `ActivityFeedPanel.tsx` | The `Recent activity` list panel surface. |
| `mount-activity-overlay.tsx` | Self-mounting entry for the floating activity overlay (wraps `ActivityIndicator`). |
| `mount-activity-feed.tsx` | Self-mounting entry for the `Recent activity` panel. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
| --- | --- | --- |
| `ActivityIndicator` | `({ activity?, packageId?, maxVisible?, position?, actorStyles?, onActivityChange? }) → JSX` | Live badges from activity records read by the owning entry at a statically declared input. `actor_type`/`action_type` are OPEN `string` (never a closed union). |
| `actorStyles` (prop) | `Record<string, ActorTypeStyle>` | DATA override for badge styling; wins over `BUILTIN_ACTOR_STYLES`. Adding an actor type = one DATA entry, zero code. |
| `BUILTIN_ACTOR_STYLES` / `DEFAULT_ACTOR_STYLE` | const maps | Maximally-capable defaults (L083); any unknown `actor_type` still renders via `DEFAULT_ACTOR_STYLE` (never dropped). |

## Rules

- Show real activity only after owner packages publish it.
- Input selection belongs to the package read-scope descriptor; UI props cannot name undeclared feeds.
- Do not render fake preview rows or implementation gates.
- `actor_type`/`action_type`/`record_kind`/`source_kind` are OPEN strings resolved DATA-first — never a closed TS union (guarded by `lesson-rules.json` `L090-no-closed-discriminant-union-tsx`).
