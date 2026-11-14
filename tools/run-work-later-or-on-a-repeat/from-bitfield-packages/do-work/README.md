# Do Work Boundary

The do-work modules build data. They return write intents, receipt previews, and
opaque owner-action dispatch requests.

`materialize-recurring-windows.ts` is the recurrence owner. It receives only
schedule DATA and occurrence state, derives a stable local-time/DST-aware window
identity, and returns idempotent materialization intents plus the same unresolved
occurrence for retry. It advances only from a complete owner-proven outcome
record. It never polls, dispatches, or treats an acknowledgement as evidence.

They do not call network APIs, read secret material, spawn OS work, import owner
source modules, or execute the owner action. The workflow slot and the target
owner package do execution after receiving the descriptor-backed request.
