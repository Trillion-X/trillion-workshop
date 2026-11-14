# Connector Room

Package-owned connection workspace and connected-workflow context records.

## Files

| File | Purpose |
| --- | --- |
| `things-to-store-and-run.json` | Publishes the top-level `Connections` workspace, the internal `Connected workflows` pane, workspace inputs, and default workspace layout state. |
| `read-data/` | Package-local display data and the default connections workspace layout. |
| `show/` | Browser material for the workspace host and connected-workflow pane. |

## Rules

- The main workspace exposes `Connections`, not package vocabulary like connector room.
- Internal panes are selected by package-owned `surface_input`; screen arrangement stays generic.
- This package does not execute connectors. It only presents the connection context that owner packages publish.
