# tools/opponent-game-plan/

Pulls together what a person has on file about an opponent, says which notes are trusted enough to plan from, prepares the brief a match plan is written from, and records the plan once it has the shape asked for. The Workshop tools `tool:scout-an-opponent` and `tool:prepare-a-match-plan`, run in the tool container. Ported from the `opponent-game-plan` package: the profile join, the search list, the confidence split and the match-plan request context. It calls no model: the AI that reads the brief writes the plan. Nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `read-data/scouting.mjs` | The records read and joined into a profile (one place makes a profile, whether from all reports or the usable ones), the search rows, the confidence split, the plan-shape check and the brief's text. |
| `read-data/run-as-main.mjs` | How a command runs: one JSON request on standard input, one JSON line out. |
| `do-work/scout-an-opponent.mjs` | The command of `tool:scout-an-opponent`: `search` and `profile`. |
| `do-work/prepare-a-match-plan.mjs` | The command of `tool:prepare-a-match-plan`: `context` (the plan-request record with its brief) and `record-plan` (the match-plan record, shape checked). |
| `tool-rows.json` | The two tool rows. |
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

**Not carried:** the builders that wrapped a player report, a court-zone profile and a tactic result into a record and submitted it to the old workflow slot (engine plumbing); the profile builder's closed lists of court zones, shot names and playing styles (the person's words now); the live-engine proof test (it read a running engine); and the screens. The record fields for a profile are neutral (`strongest`, `weakest`, `style`, `ratings`), so records written for the old package need those four renamed.

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
