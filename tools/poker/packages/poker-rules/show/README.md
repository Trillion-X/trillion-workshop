# Poker Rules Show

Browser surface for inspecting Texas Hold'em rule state.

## Files

| File | Purpose |
| --- | --- |
| `mount-poker-rules.tsx` | Package entry mount that reads the package surface state and renders a derived example hand state. |
| `PokerRuleSummary.tsx` | Rule summary UI styled to match the poker table casino visual language. |

## Rules

- This folder renders rule state only; it does not own room writes, transport, or table layout.
- The surface is scoped to `placeable-surface-list::poker-workspace`, not the main workspace.
