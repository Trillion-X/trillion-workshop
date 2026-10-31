# tools/take-requests/

Requests that arrive from people or from checks: each is kept as a record with how it was decided, handed to the owner who
can act on it, and closed by the receipt that owner gives back. It all lives in the person's own records and is reached
through the run's records door (`tools/records-door`). Nothing here names an owner, an action, an origin or a disposition.
Which origins count as someone asking, who the owners are, what an owner is asked to run and how a request was decided are
the person's records and the caller's words. Deciding is the calling AI's job; these tools check the decision is whole
and carry it out.

Ported from bitfield-packages `packages/request-intake`: its intake decision, its owner-action request builder and its
owner receipt link. Forms and their answers are not a second job here: `tools/ask-questions-sort-answers-follow-up` keeps
a form, checks and records its answers, and writes the same `owner-action-request` record when an answer hands work to an
owner, so a form submission uses that tool. Not carried: the document-to-form publisher (documents' own job), the trigger
rule that fires on a submission (the engine's wake), the structured session-selection submission (it depends on the
session catalog), the reopen planner for a failed outcome (it plans work in the old engine's task and process-session
records), the request projection and the iOS surface (screens).

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:take-a-request` | Keeps one request that arrived, as the caller decided it, and asks the owner when the decision hands it over; the same request again changes nothing; a request that cannot be acted on yet (owner not on file, text too long to hand over) keeps nothing | reads `intake-origins`, `intake-owner`; reads and writes `intake-request`, `owner-action-request` |
| `tool:hand-a-request-to-its-owner` | Asks an owner to run an action with what a form, a check or a person supplied, once per operation | reads and writes `owner-action-request` |
| `tool:record-the-owners-receipt` | Links an owner's receipt to the request it answers | reads and writes `intake-request`, `intake-receipt` |
| `tool:my-requests` | The requests taken, newest first, each with its receipts and whether an owner still owes an answer | lists `intake-request`, `intake-receipt` |

## Records

| Type | Id | Value |
|------|----|-------|
| `intake-origins` | `intake-origins:accepted` | `{ origins: [ref] }`, written by the person: the origins that count as someone asking |
| `intake-owner` | `intake-owner:<owner_ref>` | `{ owner_ref, active }`, written by the person |
| `intake-request` | `intake-request:<request_id>` | the request (`request_id`, `source_ref`, `message_ref`, `atom_ref`, `content_revision`, `at`, `text`), its `disposition` and `reason`, `owner_ref`, `status` (`recorded` or `handed`), `owner_request` and `receipt_refs` |
| `intake-receipt` | `intake-receipt:<ref>` | `{ ref, request_id, owner_ref, title, summary, process_ref, observed_at, raw }` |
| `owner-action-request` | `owner-action-request:<operation_id>:<n>` | `{ kind, owner, actionRef, input, status, requested_at }`, read and updated by the owner it names |

A request that waits keeps nothing: when the decision hands it to an owner who is not on file, or hands over a text longer
than `max_text_chars` (default 65536), the answer is `deferred` and no record is written, so taking it again once the
owner is on file is a first take and `tool:my-requests` has nothing to show for it. A text longer than the bound that is
not being handed over is kept cut to it. A decision with `existing_task_ref` is refused (`current_task_executor_not_verified`):
a task reference says nothing about who is running it now. A request taken again is the same one only if its `source_ref`,
`message_ref`, `atom_ref` and `content_revision` all match; any other difference is `source_identity_conflict`. When the
decision gives no `acceptance_criteria`, the owner is told success is "The requested outcome is verified."

An owner request already kept is never rewritten: what the owner has done to it stays. Records have no compare-and-swap,
so two simultaneous takes of one request both write the same deterministic records.

## Field names

The old decision took a candidate and a decision with other names; the ones here are plain words the caller gives.

| Old | Here |
|-----|------|
| `candidate.record_ref` (always `request:<source>:<message>`) | `request.request_id`, any non-empty id the caller chooses |
| `candidate.native_message_ref` | `request.message_ref` |
| `candidate.origin_ref` equal to one fixed origin | `request.origin_ref`, one of the origins in the person's `intake-origins:accepted` record |
| `decision.disposition_ref`, `decision.create_task` | `decision.disposition` (any words), `decision.hand_to_owner` |
| `decision.owner_ref`, `decision.existing_task_ref`, `decision.acceptance_criteria` | the same names |
| the owner list passed in | the person's `intake-owner:<owner_ref>` records |
| `process_session_ref` on a receipt | `process_ref` |
| the action descriptor (`id`, `definition_ids`, `input`, `copy`) | `hand_off` (`id`, `action_ref` or `action_refs`, `input`, `copy`); `hand_off` is required when `hand_to_owner` is true |

## Not carried

The old decision also fixed one task shape (title, priority, assignee, execution claim and work source) and drove a
model's confidence threshold and a worker profile; those belong to the tools that run work and decide, not to keeping a
request. The compare-and-set write the old decision asked its caller to do is replaced by the records door's
deterministic keys.

## Files

| File | Purpose |
|------|---------|
| `read-data/requests.mjs` | `takeARequest`, `handARequestToItsOwner`, `recordTheOwnersReceipt`, `myRequests` and the pure `ownerActionRequests`, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `tool-rows.json` | The four rows. |
| `part.json` | The folder's public files. |
| `test/requests.test.mjs` | The rows against the fake records door with exactly their rights, carrying the package's cases with made-up data: hand-off, deferred owner, replay, source clash, refused origin, copy rows and two action refs, receipts and the list. |

## Dependencies

**Depends on:** `tools/records-door`.
