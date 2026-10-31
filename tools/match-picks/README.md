# tools/match-picks/

Shows how a community picked the winner of each match, the result, and how one person's own picks turned out. The Workshop tools `tool:tally-match-picks` and `tool:check-pick-copy`, run in the tool container. Ported from the `match-picks` package's read side: the pick split, the result and the personal history. Nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `read-data/match-picks.mjs` | The records read and joined: each match's split by choice, its winner, one picker's own pick and history. |
| `read-data/run-as-main.mjs` | How a command runs: one JSON request on standard input, one JSON line out. |
| `read-data/pick-copy.mjs` | Finds the person's banned terms in texts; the list arrives with the request. |
| `do-work/check-pick-copy.mjs` | The command of `tool:check-pick-copy`: `{ texts, banned_terms }` in, `{ passed, findings }` out. |
| `do-work/tally-match-picks.mjs` | The command of `tool:tally-match-picks`: `{ rows, picker_id? }` in, `{ matches, history? }` out. |
| `tool-rows.json` | The tool row. |
| `part.json` | No module here is offered to other tools. |
| `test/pick-copy.test.mjs` | The banned terms: letter case, phrases across white space, punctuation, refusals. Made-up terms. |
| `test/match-picks.test.mjs` | The split and rounding, an empty match, results (the latest counts), right and wrong in the history, a changed pick, ordering, records of other kinds ignored, the command. Made-up matches and pickers. |
| `test/match-picks-rows.test.mjs` | The row run from a folder holding only the files it packs, against its sample, and its refusal. |

## Key Types / Functions

| Function | Signature | Role |
|---|---|---|
| `matchPickViews` | `(state, pickerId?) => views` | Each match by start time with every choice's count and whole percent, the winner, and the picker's own choice. |
| `matchPickPersonalHistory` | `(state, pickerId) => entries` | One picker's picks newest first, with right or wrong once the match has a result. |

## Invariants

- A picker who changes a pick counts once, for the latest. (The package this came from counted every pick, so a changed pick counted twice.) The earlier pick stays in the history, marked `superseded`.
- Percents are rounded per choice and may not add to 100.
- Free picks only: the tool reads records and moves no money. Wording the person does not want (for example talk of money) is checked by `tool:check-pick-copy` against a list the person gives with each request; no word list is shipped. The old guard matched inside words and so does this check.
- Nothing here is about a person: matches, picks and results arrive as records.

## Dependencies

**Depends on:** Node 24 in the tool container.

**Not carried:** the builders for a prompt, a pick and a result (each wrapped one record and submitted it to the old workflow slot; engine plumbing) and the screens; the copy guard's word list is not carried, it is the request's `banned_terms`.

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.
