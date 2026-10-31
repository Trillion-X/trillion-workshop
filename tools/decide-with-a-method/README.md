# tools/decide-with-a-method/

Decisions a person's AI makes with a method, kept as the person's own `decision` records: start one, answer the method's questions one at a time (every check answered, the calling AI's own judge's verdicts beside each answer), make the decision, say what was done, and report how it turned out. At the moment of choice the person's earlier similar decisions come back with how each turned out. A decided decision can be made safe to show strangers (`tool:share-a-decision`): the calling AI rewrites its redacted facts in general terms, the plain privacy pass finds nothing in the rewrite with the person's own private terms, and a second model's re-identification verdict is accepted for exactly those words. Ported from the old app's `src/engine.mjs` (DecisionEngine), `src/private-method.mjs`, `src/check-uses.mjs`, `src/check-judge.mjs` (the caller's verdicts) and the record layout of `src/decision-store.mjs`, so the Decisions screen reads what these tools write. The method is the person's own rows, which they see and edit: one row per method in their Methods list (`list:methods`, row type `method`) and one row per check in their Method checks list (`list:method-checks`, row type `method-check`, naming its step and method), never this folder's; Trillion asks no model. A call reads every method row (a few) but only the check rows of the step it asks or judges, through the records door's `where` (`{ step }`, and `{ id }` for each check a step names by id), so a step's few checks never cost the whole list. A question sends each check as its id and question; `tool:next-decision-question` with `explain: [ids]` sends the whole words of those checks (what a good answer does, what it refuses). An answered step keeps each check it asked as its id, question and the content identity of its row as asked; a decision's root keeps its method's id (`method_id`) beside the snapshot, so similar decisions are weighed without reading snapshots; and a change too large for one door message is written in parts (`writeBatches` of `tools/records-door`), its root last.

## Files

| File | Purpose |
|------|---------|
| `read-data/decisions.mjs` | Six decision tools as functions over the records door: `startADecision`, `nextDecisionQuestion`, `answerADecisionQuestion`, `makeTheDecision`, `reportADecisionResult`, `sayWhatWasDone` (and the helpers `share-a-decision.mjs` keeps a share with). Reads and writes the old store's layout: a root `decision` with `answered_steps`, each answered step a `decision-step:<id>:<nnn>` record; a decision kept whole is laid apart at its next change (its calls become `decision-call` records), written in parts with its root last when one write cannot carry it. |
| `read-data/method.mjs` | `methodCatalogue(methods, checks)`: every method function over the person's method rows and check rows (resolving `extends`, the stage backbone, steps by switch, checklists, coverage, the current question and its answer schema, answer validation, decision fields). |
| `read-data/verdicts.mjs` | `takeCallerVerdicts`: the calling AI's verdicts, taken only where they rest on the answer or an evidence ref and a refusal names words of its check. |
| `read-data/decision-outcome.mjs` | How a decision turned out: `currentDecisionOutcome`, `decisionStatus`, `decisionResult`, `outcomeIsCurrent`, `personReportVerified`. Pure; who wins when the person and a check disagree is passed in. |
| `read-data/share-a-decision.mjs` | `shareADecision`: a decided decision made safe to show strangers; apart so only the share's row loads the plain privacy pass and the review identity. |
| `read-data/similar-decisions.mjs` | `similarDecisions`: the newest decisions' goals and methods, weighed, the closest read whole and brought back. |
| `read-data/public-address.mjs` | Whether an address an answer names (a `url` field) is a public https address. Unchanged from the old app's judging part. |
| `read-data/public-address.json` | DATA: the blocked ranges and names. |
| `read-data/decide-with-a-method.json` | DATA: where the records are (`records`), `precedence`, `similar`, which questions carry pursuits, the cited-refs bound, the grader and its words, the records per write, how a decision is shared (`share`: the never-publish rows, the shared entry's fields, the rewrite words, the re-identification rubric with synthetic cases, the check and pool tools), and every word a tool says or refuses with. |
| `tool-rows.json` | The Workshop rows: `tool:start-a-decision`, `tool:next-decision-question`, `tool:answer-a-decision-question`, `tool:make-the-decision`, `tool:report-a-decision-result`, `tool:say-what-was-done`, `tool:bring-back-similar-decisions`, `tool:share-a-decision`. |
| `part.json` | `decision-outcome.mjs` is public. |
| `test/fixtures.mjs` | A made-up method and an in-memory records door. |
| `test/decisions.test.mjs` | The tools end to end over the made-up method: one source one decision, turns and replays, checks and grounded refusals, citations, the decision and its fields, results, what was done, laying a whole decision apart, sharing only after the plain pass and a re-identification verdict bound to the exact words, the rows' rights. |
| `test/method.test.mjs` | The old app's method tests over the made-up method: the backbone, templates and defaults, switch reasons and their exact shape, checklists and the answer schema. |
| `test/decision-outcome.test.mjs` | The old app's outcome tests, ported. |
| `test/similar-decisions.test.mjs` | The old app's similar-decisions tests, ported. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `startADecision` | `({ source_id, goal, evidence, options, method? }, { door }) -> reply` | One source opens one decision under the method's snapshot. |
| `answerADecisionQuestion` | `({ decision_id, step_id, answer, verdicts?, usage? }, { door }) -> reply` | Validates the answer against the method, takes grounded refusals, keeps the step. |
| `makeTheDecision` | `({ decision_id, decision, verdicts?, usage?, expected_generation? }, { door }) -> reply` | The choice, its fields and evidence; a new one only after a failed result. |
| `reportADecisionResult` | `({ decision_id, result, summary, answered_by: "person", ... }, { door }) -> reply` | The person's result; a failed one opens the decision again. |
| `methodCatalogue` | `(methods, checks, { grader }) -> functions` | Every method function over the person's method rows and check rows. |
| `similarDecisions` | `({ decision_id, limit? }, { door }) -> { similar_decisions }` | Earlier decisions like this one, each with its choice and how it turned out. |
| `shareADecision` | `({ decision_id, rewrite?, reidentification? }, { door }) -> { next: "rewrite" | "check" } or { shared, send }` | The redacted facts to rewrite; then the plain pass on the rewrite; then the review identity a verdict must carry; then the entry kept and the pool tool to send it to. |

## Not here yet

- A workflow run named by `run_id` cannot be read by these tools, so it is refused, and a plan whose decision needs a finished decision-phase run waits (`words.decision_phase_runs`).
- A report from a trusted person source (the signed-in host's basis) cannot be marked here: every report is kept as the caller's claim.
- The pool account's door admits other people through a share's act grant (trillion-rust `src/account_rights/share_grant.rs`). Sending a shared decision there is the calling AI's own call with the pool's share bearer: `tool:add-a-shared-situation` with `send.entry` and the meaning of its situation (the embedding the pool names), then `tool:add-a-pooled-result` with the bit `tool:randomize-a-result` drew. No tool here reaches another account's door.
- The re-identification verdict comes from `tool:ask-a-small-model-for-a-verdict`, whose rows run on the person's computer, not at the engine yet; this tool only checks that the verdict was accepted for exactly the rubric and words it names (`contentReviewIdentity`). A result's own words are not shared: the pool takes only its randomized bit.

## Dependencies

**Depends on:** `tools/records-door` (the door client, `run-an-export.mjs` and `writeBatches`), `tools/content-identity` (the identity of each kept check), and, loaded only for a share, `tools/learn-from-everyones-results` (the plain privacy pass, public) and `tools/ask-a-small-model-for-a-verdict` (`contentReviewIdentity`, public); Node 24 in the tool container. Every row packs records-door, content-identity and `@noble/hashes`.

**Depended on by:** `tool-rows.json`, the tests here.
