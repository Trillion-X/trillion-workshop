# tools/take-requests/

Requests that arrive from people or from checks: each is kept as a record with how it was decided, handed to the owner who
can act on it, and closed by the receipt that owner gives back. It all lives in the person's own records and is reached
in the person's own store: the caller reads the rows these tools need and gives them as `records`, and what they make comes back as `keep` for the caller to write there. Nothing here names an owner, an action, an origin or a disposition.
Which origins count as someone asking, who the owners are, what an owner is asked to run and how a request was decided are
the person's records and the caller's words. Deciding is the calling AI's job; these tools check the decision is whole
and carry it out.

Ported from bitfield-packages `packages/request-intake`: its intake decision, its owner-action request builder and its
owner receipt link. Forms and their answers are not a second job here: `tools/ask-questions-sort-answers-follow-up` keeps
a form, checks and records its answers, and writes the same `owner-action-request` record when an answer hands work to an
owner, so a form submission uses that tool. Not carried: the document-to-form publisher (documents' own job), the trigger
rule that fires on a submission (the engine's wake), the structured session-selection submission (it depends on the
session catalog), the reopen planner for a failed outcome (it plans work in the old engine's task and process-session
records), the original request screen model and the iOS surface. `tool:my-requests` provides the linked-receipt read
projection over the rows the caller hands it (it keeps nothing). Recording an owner's receipt is the recipe `workflow:keep-the-owners-receipt` (`tools/workflows/recipes/keep-the-owners-receipt.json`, kit beside it): a receipt only links a record, so it is the store's own job.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:take-a-request` | Checks one request that arrived, as the caller decided it, and gives back what to keep, with the owner's request when the decision hands it over; the same request again keeps nothing; a request that cannot be acted on yet (owner not on file, text too long to hand over) keeps nothing | takes `intake-origins`, `intake-owner`, `intake-request` and `owner-action-request` rows in `records`; gives back `keep` |
| `tool:hand-a-request-to-its-owner` | Builds the request to an owner to run an action with what a form, a check or a person supplied, once per operation, and gives back the ones not yet kept | takes `owner-action-request` rows in `records`; gives back `keep` |
| `tool:my-requests` | The requests taken, newest first, each with its receipts and whether an owner still owes an answer | takes `intake-request` and `intake-receipt` rows in `records`; keeps nothing |

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

An owner request already kept is never rewritten: what the owner has done to it stays. Two simultaneous takes of one request
both get the same deterministic `keep` rows; the caller's write is the one that decides, by the store's own version check.

## Carried originals

`moved-from.json` names the files moved byte for byte from bitfield-packages `packages/request-intake` (commit d926b7adb8): `do-work/` (`request-intake-actions.ts`, `publish-form.ts`, `record-submission.ts`, `structured-selection-preferences.ts`, `plan-source-message-reopen.mjs`, `process-scripts/decide-source-message.py`), `read-data/request-intake-projection.ts`, `index.ts`, `show/`, `show-ios-jscore/`, `things-to-store-and-run.json` and the tests that run here (`test/*.test.mjs` for the projection, receipts, reopen planner, iOS mount and the workflow reads, and `test/test_decide_source_message.py`). The four tests that read the old package-set layout and the five vitest tests are not carried yet: they need calls rows. The three `tool:` rows above run `read-data/requests.mjs`; the originals are not wired into a row yet.

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
request. The compare-and-set write the old decision asked its caller to do is replaced by a deterministic id and the
store's own version check when the caller writes what `keep` gives back.

## Files

| File | Purpose |
|------|---------|
| `read-data/requests.mjs` | `takeARequest`, `handARequestToItsOwner`, `myRequests` and the pure `ownerActionRequests`, run by the generic function runner `tools/records-door/do-work/run-an-export.mjs` (it holds no records here). |
| `what-this-tool-does-and-how-to-run-it.json` | The three rows. |
| `part.json` | The folder's public files. |
| `test/requests.test.mjs` | The three rows run as the container runs them, with the records each is given as input and the rows it gives back as `keep`, carrying the package's cases with made-up data: hand-off, deferred owner, replay, source clash, refused origin, copy rows and two action refs, and the list.

## Dependencies

**Depends on:** the generic function runner in `tools/records-door` (`do-work/run-an-export.mjs`); no store.
