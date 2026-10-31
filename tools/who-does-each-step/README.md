# tools/who-does-each-step/

For every step of a plan, protocol, checklist or workflow, says who should do it, so no step silently lands on the person. `tool:who-does-each-step` weighs each step against the doers the caller names and answers `trillion` (a tool, a workflow or the person's AIs does it), `one-tap` (it spends money or reaches someone outside the account, so it waits for one yes with the price shown), `you` (only for a reason in the caller's own list of reasons only a person can meet, with every helping doer attached) or `nobody-yet` (no doer covers a need: a doer to build, never a to-do). `tool:what-can-trillion-do` lists the doers and the reasons back. Ported from the app's `src/who-does-it.mjs`.

The tool knows no doer, need, reason or vendor. The doers (`{ id, label, does: [words], tool_id?, cost?, spends?, reaches_others?, hand_off?, how? }`) and the reasons only a person can meet (`{ id, words, given_once?, first_try? }`) come with each request, from the caller's own records; the sentences an answer says and the ranking of past outcomes have neutral defaults in `read-data/words.json` that a request may override. Nothing is spent or sent: the answer only says who and what would run.

Rules it keeps: a need is matched to the doer whose phrase covers the most of its words (stems, so `printing` covers `print`); a reason the person meets once (`given_once`) is not asked again when the step names the message that gave it (`given_in`); a reason with a `first_try` doer reaches the person only after that doer failed on the step (`past`); a doer the person already said yes to (`approved`) needs no tap; past outcomes (`met`, `failed`) move a doer up or down among those covering the same need, so equal inputs give equal answers.

## Files

| File | Purpose |
|------|---------|
| `read-data/who-does.mjs` | `whoDoesEachStep`, `whoCanDo` and `covers`. The header lists the invariants and the shapes. |
| `read-data/words.json` | The default sentences and the ranking. |
| `do-work/who-does-each-step.mjs` | The command of `tool:who-does-each-step`. |
| `do-work/list-who-can-do.mjs` | The command of `tool:what-can-trillion-do`. |
| `tool-rows.json` | The two rows, with sample runs. |
| `test/who-does.test.mjs` | The old module's cases on a made-up bakery plan and made-up doers: no step lands on the person, taps and prices, the person's own part, nobody-yet, approved doers and ranking, the most specific phrase, consent given once, sign-in first try, refused input, and the rows. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| step | `{ id?, words, needs?, only_a_person_because?, given_in?, past?, input? }` or words | One thing the plan asks for. |
| `whoDoesEachStep` | `({ steps, doers, only_a_person?, approved?, past?, words?, ranking? }) -> { steps, counts, said }` | The one gate. |
| `whoCanDo` | `({ doers, only_a_person? }) -> { doers, only_a_person }` | What can do steps, and why a step may stay the person's. |

## Dependencies

**Depends on:** Node 24 only.

**Depended on by:** `tool-rows.json`; the workflows that name `tool:who-does-each-step`.
