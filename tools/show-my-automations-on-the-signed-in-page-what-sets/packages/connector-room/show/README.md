# Connector Room Show

Browser material for the `Connections` workspace and the internal `Connected workflows` pane.

## Files

| File | Purpose |
| --- | --- |
| `mount-connector-room.tsx` | Mounts either the workspace host or the internal pane from package-owned `surface_input`. |
| `ConnectorRoomPanel.tsx` | Human-facing connected-workflow context panel. |

## Rules

- Use `EmbeddedScreenArrangement` and `placeable-surface-list::connections-workspace`; do not add connection-specific branches to screen arrangement.
- Do not render package contracts, record names, or blocker codes as product copy.
