# Open Surface Action

Generic browser-local action for opening another placeable surface through the existing placeable-surface intent.

The component only emits an opaque payload. It does not import screen arrangement, mutate tabs, invoke workflows, know package data, or call another package directly.

Visible detail and unavailable messages use the shared `Text` body variant so callers do not invent local text styles while composing handoff buttons.
