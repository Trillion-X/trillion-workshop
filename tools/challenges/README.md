# tools/challenges/

Time-boxed challenges people enroll in, as DATA: checks that a challenge definition is complete, and decides which challenges one person joins from their scores, building the enrollment records. Two Workshop tools run in the deployed tool container: `tool:check-challenge-definitions` and `tool:enroll-an-observer-in-challenges`. Ported from bitfield-packages `packages/challenge`; nothing here is imported by the Worker.

A person's AI composes this with other tools: it scores the observer for each challenge with the tool that scores candidates for an observer (`tools/run-experiments`), gives those scores here, and stores each returned record at its `address` through the person's records door. Which challenges exist, their windows, who they fit and the status words are the person's own records; the tool ships none.

## Files

| File | Purpose |
|------|---------|
| `read-data/challenges.mjs` | `validateChallengeDefinition`, `enrollmentAddress`, `buildEnrollment`, `decideEnrollments`: pure, no clock, no I/O, no scoring. |
| `do-work/requests.mjs` | `checkChallengeDefinitions`, `enrollInChallenges`: the two functions the rows run; a request that cannot run throws a sentence saying what to fix. |
| `do-work/run-request.mjs` | The command the rows run: `node do-work/run-request.mjs <function>`, the request as JSON on standard input, `{ result }` or `{ error }` on the last line. |
| `tool-rows.json` | The two rows. |
| `part.json` | No public files: only the container runs this code. |
| `test/` | `challenges.test.mjs` (the logic), `rows.test.mjs` (each row's sample run as the container runs it, and the refusals). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| definition | `{ kind: 'challenge-definition', id, label, engagement_window: { unit, length }, audience_decider_ref, feed_ref, enrollment_policy: { min_score }, objective_ref? }` | One challenge. `unit` is any word, `length` any positive number. |
| enrollment | `{ kind: 'challenge-enrollment', challenge_id, observer_id, started_at, engagement_window, status_key }` | One membership; the window is copied from the definition at enrollment. |
| `validateChallengeDefinition` | `(raw) => { valid, errors }` | Structure only; it does not follow the references. |
| `enrollmentAddress` | `(challengeId, observerId) => string` | `challenge::<id>::enrollment::<observer>`: the same pair is the same address, so storing twice keeps one record. |
| `decideEnrollments` | `({ definitions, scores, observerId, startedAt, statusKey }) => { enrollments, skipped }` | A challenge joins when valid and the score reaches its own `min_score`; every other is listed with the reason. A missing score is never read as a low one. |

## Invariants

- The window is an overlay on engagement, never an access input: nothing here decides who may see content.
- The tool holds no clock and no status words: `started_at` and `status_key` are required inputs.
- The tool scores nobody. The score for each challenge arrives as a number.

## What was not carried

- The one product's challenge and feed records and the tests built on them (cohort selection, feed decode, path render): the records are one product's data and the path rail is a screen drawn by the screens owner.
- `enrollment-live.test.ts`: a live-engine round trip over the old runtime.
- `do-work/enroll-observer.ts` scoring through the old selection module: scoring is `tools/run-experiments`; here the scores are input.
- `do-work/process-scripts/enroll-observer-cli*`: the old engine's process wrapper, replaced by `do-work/run-request.mjs`.

## Dependencies

**Depends on:** Node 24 in the tool container; nothing else.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names).
