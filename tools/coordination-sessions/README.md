# tools/coordination-sessions/

A gathering a person organizes: its purpose, the times, places and modes it could have, how many places it has, who may see and join it, and its lifecycle state. Ported from bitfield-packages `packages/coordination-session`: the lifecycle operations, the catalog and the event planner are the package's logic, without the old engine's owner references and target wrapper.

- **Every row takes what it works on and answers the next version.** Nothing is kept, authorized or sent here; the caller keeps the answer as a record.
- **Open descriptors, never lists.** Purpose, mode, lifecycle state, visibility and the policies are words and refs the person names. Nothing here lists modes or visibilities, and a lifecycle state is any `{ key, descriptor_ref }`. To limit which states may follow which, give the person's own stages to `tools/move-records-through-declared-states`.
- **Places are a capacity ledger.** A session's `capacity_plan.seat_ledger_ref` is the id of a ledger in `tools/reservations`; `tool:plan-an-event` answers the input for that tool's `open-a-capacity-ledger`.
- **Lineage and provenance travel.** Reschedule, fork, merge and supersede keep which sessions a session came from and the provenance of who took part and what they preferred.
- **Who may see an entry is the person's rule.** A catalog entry holds a reference to it; deciding is not done here.

## Files

| File | Purpose |
|------|---------|
| `do-work/session-lifecycle.ts` | `createCoordinationSession`, `updateCoordinationSession`, `rescheduleCoordinationSession`, `forkCoordinationSession`, `mergeCoordinationSessions`, `cancel`, `confirm`, `recordCoordinationSessionNoShow`, `close`, `requestCoordinationSessionFeedback`, `supersedeCoordinationSession`, and `runASessionOperation` (one request, one named step). Copied; the owner-reference record, its defaults and the old target comment are gone, and the availability owner is optional. |
| `read-data/session-catalog.ts` | `publishSessionCatalogEntry`, `readSessionCatalog`, `updateSessionCatalogEntry`, `retractSessionCatalogEntry`, `supersedeSessionCatalogEntry`, `crossOfferSessionCatalogEntry`. Copied; the access and recommendation delegates, the owner references and the screen-projection reference are gone, and `readSessionCatalog` takes its options second. |
| `read-data/plan-an-event.ts` | `planAnEvent`: a draft to session, catalog entry, capacity ledger input and addresses. Rewritten from `materializeOrganizerEvent`: mode and visibility are open words, and the branding, access, intake, publication and projection plans (all references to other packages) and the sign-up copy are gone. |
| `do-work/coordination-sessions.mjs` | The tool seam, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `tool-rows.json` | Three rows. |
| `part.json` | No public files. |
| `test/session-lifecycle.test.mjs`, `test/session-catalog.test.mjs`, `test/plan-an-event.test.mjs` | The package's cases (with a made-up bakery club), plus refusals. |
| `test/coordination-sessions-rows.test.mjs` | Every row run as the container runs it. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `CoordinationSession` | `{ session_id, purpose_contract, candidate_occurrences, candidate_places, candidate_modes, capacity_plan: { capacity_policy_ref, seat_ledger_ref }, participation_policy, lifecycle_state, workflow_definition_ref, supersedes_ref?, fork_merge_provenance, participant_provenance, preference_provenance, feedback_request_ref? }` | One gathering. |
| `tool:run-a-session-step` | `{ operation, session \| sessions, ... } -> { session } \| { predecessor, successor }` | create, update, reschedule, fork, merge, cancel, supersede, confirm, record_no_show, close, request_feedback. |
| `tool:work-a-session-catalog` | `{ operation, entry \| entries \| predecessor + successor, ... } -> { entry } \| { entries } \| { predecessor, successor }` | publish, read, update, retract, supersede, cross_offer. |
| `tool:plan-an-event` | `{ idempotency_key, host_group_ref, labels, primary and alternate times, time_zone, mode, visibility, capacity, host_origin, workflow_definition_ref } -> { session, capacity_ledger, catalog_entry, preview_path, live_path, share_url }` | Same draft, same plan. |

## Dependencies

**Depends on:** `tools/records-door` (packed by every row at `/opt/records-door`, for its command only; these rows read no records). Node 24 in the tool container runs the `.ts` files by stripping their types.

**Depended on by:** Trillion's deploy reads `tool-rows.json`.
