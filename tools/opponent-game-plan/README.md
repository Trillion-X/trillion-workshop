# tools/opponent-game-plan/

Pulls together what a person has on file about an opponent, says which notes are trusted enough to plan from, prepares the brief a match plan is written from, and records the plan once it has the shape asked for. The Workshop tools `tool:scout-an-opponent` and `tool:prepare-a-match-plan`, run in the tool container. Ported from the `opponent-game-plan` package: the profile join, the search list, the confidence split and the match-plan request context. It calls no model: the AI that reads the brief writes the plan. Nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `read-data/scouting.mjs` | The records read and joined into a profile (one place makes a profile, whether from all reports or the usable ones), the search rows, the confidence split, the plan-shape check, the brief's text, and the record builders (subject, report, profile projection, tactic result) and the latest plan. |
| `read-data/run-as-main.mjs` | How a command runs: one JSON request on standard input, one JSON line out. |
| `do-work/scout-an-opponent.mjs` | The command of `tool:scout-an-opponent`: `search` and `profile`, and `record-report` (a subject and a private-by-default report) and `record-profile` (a profile projection; ratings outside 0 to 100 refused). |
| `do-work/prepare-a-match-plan.mjs` | The command of `tool:prepare-a-match-plan`: `context` (the plan-request record with its brief), `record-plan` (the match-plan record, shape checked), `record-result` (a tactic worked, failed or mixed) and `latest-plan` (the latest plan between two subjects, or null). |
| `what-this-tool-does-and-how-to-run-it.json` | The two tool rows. |
| `part.json` | No module here is offered to other tools. |
| `test/scouting.test.mjs` | The join, ratings, search, the policy (fail closed), the brief with low-confidence evidence left out, the plan shape. An invented game and made-up players. |
| `test/opponent-game-plan-rows.test.mjs` | Each row run from a folder holding only the files it packs, against its sample, and its refusal. |

## Key Types / Functions

| Function | Signature | Role |
|---|---|---|
| `profileView` | `({ player, reports, profiles, plans, tacticResults }) => view` | Strengths, weaknesses, strategies worked and failed, style, ratings, public and private reports, tactic outcomes, joined without repeats. |
| `splitEvidenceByConfidence` | `(reports, policy) => { usable, needsReview }` | The person's policy decides; with none, nothing is usable. |
| `buildPlanPrompt` | `(selfView, opponentView, shape) => text` | One line per fact the evidence holds; missing facts are left out. |
| `assertPlanShape` | `(plan, shape) => plan` | Exactly the strategies and tactics asked for. |

## Invariants

- Nothing names a sport. How many strategies and tactics a plan has is `plan_shape`, required on every call; what a rating, a style or a fact is called is the words in the person's records. A rating outside 0 to 100 is left out, never guessed.
- The confidence policy (`minimumConfidence`, `missingConfidenceIsUsable`) is the person's, given in the request or as an `evidence-confidence-policy` record. No policy: no report is usable, and every report is listed for review.
- The brief holds only usable evidence and never writes a missing fact as unknown.
- A tool keeps nothing between runs: records come back for the caller to write.
- Nothing here is about a person: subjects, notes and plans arrive as records.

## Dependencies

**Depends on:** Node 24 in the tool container.

**Not carried:** the submission of the four write actions (`action:opponent-game-plan.add-report`, `add-court-zone-profile`, `request-plan`, `record-result`) to the retired Bitfield workflow slot: the records they built now come back from the commands above for the caller to write. The record builders themselves are ported (`record-report`, `record-profile`, `record-result`, `latest-plan`), without the old closed list of court zones A to D; the profile builder's closed lists of shot names and playing styles (the person's words now); the live-engine proof test (it read a running engine); and the screens. The record fields for a profile are neutral (`strongest`, `weakest`, `style`, `ratings`), so records written for the old package need those four renamed.

**Depended on by:** Trillion, which reads `what-this-tool-does-and-how-to-run-it.json` when it deploys.

## Moved from bitfield-packages (byte for byte, not yet wired to a tool row)

The original `opponent-game-plan` package: the plan screen, the request builders for a court-zone profile, a player report, a tactic result and a match plan, the read of the plan, its types and tests.

`from-bitfield-packages/moved-from.json` names each moved file, its source path, the full source commit and both identities; every file is the package's own bytes except where its entry names `calls` (a real person's name, address or home path made generic) or an adaptation (`identity_at_move`: relative imports name their file extension, `vitest` reads the shim, a package's own files import each other at their new place). 11 files moved. Files that import the shared ui parts, the screen runtime or `useBitfieldData` run in the app, not in this tree's test command; their data layer is held until it is swapped to the records door.

Tests that do not run in this tree are renamed `.held` (1); the receipt's `held` key says why for each. Every moved feature file has a port contract in `ports/from-bitfield-packages-*.json`.
