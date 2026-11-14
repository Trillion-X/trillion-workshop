# subject-participant/

Generic package for subject_participant_request, subject_participant_projection, and subject_participant_action_request.

This package is dumb and blind. It reads only package-declared inputs, emits
owner-action requests, and never imports source-system clients, slot internals,
sibling package internals, provider clients, or product-specific code. Its
workflow definition records generic pending subject-participant requests as EEAF-shaped
facts; package-set binding data chooses when that effect path runs.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Package boundary records for owned facts, inputs, owner-action contracts, the generic subject-participant request workflow, and surfaces |
| `read-data/README.md` | Reader contract |
| `do-work/README.md` | Owner-action request contract |
| `show/README.md` | Surface rendering contract |
| `read-data/subject-participant-surface.js` | Package-owned generic surface descriptor |
| `show/mount-subject-participant.js` | Browser-local package boundary surface entry source |
| `generated/subject-participant.js` | Package-owned generated entry bytes admitted by Runtime Kit |
| `tests/subject-participant-surface.test.mjs` | Package-local entry and genericness proof |
| `claim.md` | Package UI claim remediation record |
| `reference-grounded-screen-contract.md` | Reference-grounded design contract |
| `visual-proof.md` | State proof matrix and screenshot matrix |

## Key Types

| Type / Function | Signature | Role |
|---|---|---|
| `JoinSubjectRequest` | `{ subjectRef, actorRef?, roleRef?, stateRef, requestedAt? }` | Input to `joinSubject` do-work |
| `joinSubject(request)` | `Promise<unknown>` | FLOW B caller writing participant facts via `action:subject-participant.record-subject-participant-request` |

## Depends On

- `@bitfield/runtime-kit` — `sendRequestToBitfieldTarget` FLOW B transport

## Depended On By

- `packages/group-list` — calls `action:subject-participant.record-subject-participant-request` by action-id string (BRTK5016-safe) via `ask-to-join-group.ts`; reads `subject-participants` published input

## Effect Records

`things-to-store-and-run.json` includes `record-subject-participant-request`, a package-owned workflow definition that records EEAF-shaped membership facts under `prop:subject_participant:*` (subject_ref, actor_ref, role_ref, state_ref, created_at) then republishes them as a `cell_table` at the `subject-participants` published address. `record-subject-participant-action-request` records opaque owner-action requests; package-set binding data chooses when each definition runs.

## UI Claim Package Files

`subject-participant` now has a completed claim artifact set under the package root:

| File | Purpose |
|---|---|
| `claim.md` | Claim status, package truth, state/proof matrix, translation boundary |
| `reference-grounded-screen-contract.md` | Reference and contract grounding before visual implementation |
| `visual-proof.md` | Exact render-state matrix and screenshot matrix |

## State / Proof

| State | Proof |
|---|---|
| Empty | Render path exists in `show/mount-subject-participant.js` with fallback summary copy |
| Sparse | Chips render for single ownership/action records |
| Dense | Chips wrap and remain readable |
| Loading | N/A in show path (no async fetch) |
| Error | N/A in show path (no async write/read branch) |
| Offline | Static boundary surface is renderable without network |
| Mobile | Wrapped action sections and flexible spacing |
| Desktop | Expanded content width and larger card shell |

## Translation Boundary

Banned source terms: `subject_participant_request`, `subject_participants`, owner-action IDs.
Human surface terms: participation request, member role, membership status, invite flow.

## Implementation Implications

The package is intentionally generic and blind. Any richer participant record presentation must be added through existing shared UI primitives or downstream package screens, not direct source-system logic.
