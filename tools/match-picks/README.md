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
| `read-data/pick-records.mjs` | The three records a pick is made of (`pick-match`, `match-pick`, `match-pick-result`) built from a request: trimmed, required fields checked, at least two choices with their own ids, a new id and the time, and the person's banned words refused. The old package's three builders, with the person's list in place of the shipped one. |
| `do-work/prepare-match-pick-record.mjs` | The command of `tool:prepare-a-match-pick-record`: `{ what: prompt \| pick \| result, ...fields, banned_terms?, now? }` in, `{ id, record }` out. Writes nothing; the caller keeps the record in the person's store. |
| `tool-rows.json` | The tool row. |
| `part.json` | No module here is offered to other tools. |
| `test/pick-records.test.mjs` | The three records built and trimmed, refusals (missing field, one choice, a choice id twice, banned wording, bad `what` or `now`), records read back by the tally, and the command. |
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

**Carried unwired, in the last section:** the package's own builders for a prompt, a pick and a result (each wraps one record and submits it to the old workflow slot) and the screens. The builders' job is done by `tool:prepare-a-match-pick-record`, which does not submit anything. **Not carried:** the copy guard's word list; `tool:check-pick-copy` takes it as the request's `banned_terms`, and the package's guard (`do-work/regulated-money-copy-guard.ts`) is carried as written.

**Depended on by:** Trillion, which reads `tool-rows.json` when it deploys.

## Files moved from bitfield-packages (packages/match-picks)

Each file below is the package's own, byte for byte; `from-bitfield-packages/moved-from.json` names each source path and commit, the identity of its source bytes and of its bytes here, and the `calls` that made a real name or id made up. After the first commit only import paths changed. A file named `.held` is the same bytes with its test name taken off so the repository test does not run it; the reason is under `held` in the receipt. Most files import `@/packages/ui` and the retired package runtime (`@bitfield/runtime-kit`); the shared ui parts live in apps `tools/ui`, so the screens and targets here are prepared, not wired to a tool row.

| File | What it is |
|---|---|
| `do-work/create-pick-prompt.ts` | builds and submits free pick prompt inputs. |
| `do-work/regulated-money-copy-guard.ts` | rejects wagering and payment copy in prompt/result text. |
| `do-work/resolve-match-pick.ts` | builds and submits result inputs. |
| `do-work/submit-match-pick.ts` | builds and submits pick inputs. |
| `read-data/match-picks-types.ts` | defines match, pick, result, choice view, and personal history records. |
| `read-data/read-match-picks.ts` | turns match, pick, and result rows into match views and personal history. |
| `show/MatchPicksSurface.tsx` | renders match selection, choice controls, community pick split, result, and personal history. |
| `show/match-picks-scoped-feed.test.ts.held` | A test of the package, held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried |
| `show/mount-match-picks.tsx` | A file of the package. |
| `test/match-picks.test.ts.held` | proves prompt creation, split math, result resolution, action wiring, history, and the copy guard. (held: imports react or shared ui parts (tools/ui) that live in apps tools/ui, not in the Workshop) |

### Not carried

- 13 files: proof evidence of the package (screenshots, proof scripts and notes); not carried
- 5 files: package README, package.json or ignore file; this folder has its own README
- 3 files: generated build output of the retired package runtime (entry scope, built entry bytes); not carried
- 1 file: maps package entries to the retired package runtime's entry scope; not carried
- 1 file: the package's screen reference contract; not carried
- 1 file: the package boundary file: record contracts, actions and surfaces for the retired package runtime (slot workflows, owner targets); not carried

The receipt's `not_carried` names each path.
