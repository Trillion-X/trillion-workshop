# Connector Room Read Data

Package-local display records and layout state for the `Connections` workspace.

## Files

| File | Purpose |
| --- | --- |
| `connector-room-surface.ts` | Human-facing copy for the `Connected workflows` pane. |
| `read-connections-workspace-layout-state.ts` | Default embedded screen-arrangement state for `placeable-surface-list::connections-workspace`. |

## Rules

- Visible strings must use plain product language: Connections, Connected workflows, Outside accounts and keys, Recent activity, Activity groups.
- Backend/package terms stay out of display data.
