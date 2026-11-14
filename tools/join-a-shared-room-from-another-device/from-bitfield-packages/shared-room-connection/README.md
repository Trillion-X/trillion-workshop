# Shared Room Connection

Package-owned shared-room connection records and helpers.

## Rules

- `read-data` is a public source root for packages that consume shared-room connection records.
- Public source does not make this folder runtime authority. Runtime consumers read admitted records from the log projection.
- The visible `Connect devices` surface remains generic shared-room connection UI, but Bitfield Studio currently places it inside `placeable-surface-list::poker-workspace` instead of the main workspace because poker is the active room consumer.
