# tools/review-what-a-list-says/

Keeps what a list says true, and notices what nobody uses.

- **Review is ordinary fields and views.** A list set up for review gives each row an owner, a review state (Verified, Outdated, Verification requested) and a date by which it must be checked again, plus saved views that decide, with the formula engine's rules (`tools/formulas`), which rows need review and why: never checked or flagged, past their date, empty. A person or their AI marks rows checked, outdated or asking to be checked, or names their owner. Nothing new keeps truth: the review is written as the row's own fields through the person's records door.
- **A verification expires.** Verify sets a check-again date `expires_days` ahead (the list's own, or 90 as shipped); a row past its date needs review again though its state still says Verified. Flagging clears the date.
- **Use heat decays.** Every use adds to a row's heat, which halves every 30 days; a row is touched at most once per 360 minutes. A row whose heat is below 0.5 is cold, a candidate for cleanup, unless its review is current (verified and not past its date).
- **Every role, state, action, view, reason, limit and decay constant is data** (`read-data/lists.json` `review`, `use_heat`); nothing here names a list or a state. Reads are bounded and say `complete: false` with a cursor when they stop early.

## Files

| Path | What it is |
|---|---|
| `read-data/list-review.mjs` | `reviewWrites` (values in, values out: what a set up saves and what each row takes), `rowsNeedingReview`, `coldRows`, `heatNow`, `usedHeat`: from the old tree `src/list-review.mjs`. |
| `read-data/lists.json` | The slices of old trillion `src/lists.json` it reads (`review`, `use_heat`, two `limits`, the refusal `words`), under the same names. |
| `read-data/list-refusals.mjs` | `listSay`, moved from the old tree `src/list-refusals.mjs`, without the old app's configuration-error branch. |
| `do-work/review-a-list.mjs` | The rows' seams (the review writes are the store half, below): `findColdRows` over rows and heat records handed in, `findRowsNeedingReview` over the list and rows handed in, `heatOfARow`. |
| `test/list-review-and-heat.test.mjs` | The heat test unchanged; `reviewWrites` values (set up, a row action, refusals) and cold rows over rows handed in. |
| `test/rows-needing-review.test.mjs` | `findRowsNeedingReview` over a list `set_up` left: each reason, one owner, a later `now`, and the refusals. |

## The rows

Setting a list up for review and verifying, flagging, asking to check or assigning its rows is the store half: `workflow:keep-what-a-list-says-true` (recipe and kit in tools/workflows). It reads the list, calls `reviewWrites` here, and keeps what it answers. The old `tool:review-rows-of-a-list` (which read and wrote through the records door) is removed. Proof: lane prove.mjs, the old `reviewRows` as oracle against PostgreSQL (PGlite) and a JSON folder: the writes, the answers, the refusals and the final rows are equal.

| Row | Does |
|---|---|
| `tool:find-cold-rows` | The rows nobody uses, leaving out rows whose review is current |
| `tool:find-rows-needing-review` | Each owner's rows that need review, with why: not verified, past their check-again date, or empty |
| `tool:heat-of-a-row` | A row's heat as of a moment, and the record one more use leaves |

`rowsNeedingReview` (REA finding F-0066) reads each review view through a reader it is given (`readView`). `findRowsNeedingReview` gives it one over the rows handed in, like `findColdRows`: a view's rules go to the rule filter of the Rust formula engine (`tools/formula-engine`), and the expired view keeps the rows whose check-again date is before its `before` binding, evaluated with `{ now }` by the same engine. The caller reads the list and its rows (through the records door, or `tools/read-a-list-view`) and hands them in.
