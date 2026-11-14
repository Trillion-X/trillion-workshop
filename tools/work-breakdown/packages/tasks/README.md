# tasks

`tasks` publishes task records and task action descriptors for the Bitfield Studio package set.

## Contract

- Task assignment is ordinary record data: `assigned_to`, `claimed_by`, due date, priority, order, attachments, and proof are generic record fields consumed through Record Board descriptors.
- An agent is an assignee or claimant, not a separate task type.
- This package does not define `tasks.execute-task` or `tasks.stop-task` workflow actions. Agent execution is owned by the generic assignment/claim runner path and surfaced to Agent Activity as a projection.
- This package does not publish `agent-tasks` or `prop:agent_task:*` records. Those retired records stay only as `remove: true` tombstones.
- `package::tasks::value::task-action-targets` lists only advertised task actions that this package intentionally exposes.
- Retired execute/stop task records stay in the contract as `remove: true` tombstones so live package writes retract old current-state records.
