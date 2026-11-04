# tools/review-what-a-list-says/

Keeps what a list says true, and notices what nobody uses.

- **Review is ordinary fields and views.** A list set up for review gives each row an owner, a review state (Verified, Outdated, Verification requested) and a date by which it must be checked again, plus saved views that decide, with the formula engine's rules (`tools/formulas`), which rows need review and why: never checked or flagged, past their date, empty. A person or their AI marks rows checked, outdated or asking to be checked, or names their owner. Nothing new keeps truth: the review is written as the row's own fields through the person's records door.
- **A verification expires.** Verify sets a check-again date `expires_days` ahead (the list's own, or 90 as shipped); a row past its date needs review again though its state still says Verified. Flagging clears the date.
- **Use heat decays.** Every use adds to a row's heat, which halves every 30 days; a row is touched at most once per 360 minutes. A row whose heat is below 0.5 is cold, a candidate for cleanup, unless its review is current (verified and not past its date).
- **Every role, state, action, view, reason, limit and decay constant is data** (`read-data/lists.json` `review`, `use_heat`); nothing here names a list or a state. Reads are bounded and say `complete: false` with a cursor when they stop early.

## Files

| Path | What it is |
|---|---|
| `read-data/list-review.mjs` | `reviewRows`, `rowsNeedingReview`, `coldRows`, `heatNow`, `usedHeat`: moved unchanged from old trillion `src/list-review.mjs`. |
| `read-data/lists.json` | The slices of old trillion `src/lists.json` it reads (`review`, `use_heat`, two `limits`, the refusal `words`), under the same names. |
| `read-data/list-refusals.mjs` | `listSay`, moved from old trillion `src/list-refusals.mjs`, without the old app's configuration-error branch. |
| `do-work/review-a-list.mjs` | The rows' seams: `reviewListRows` over the person's lists through `tools/records-door/read-data/lists-door.mjs`, `findColdRows` over rows and heat records handed in, `heatOfARow`. |
| `test/list-review-and-heat.test.mjs` | Old trillion `test/list-review-and-heat.test.mjs`: the heat test unchanged; review and cold rows over an in-memory records door. |

## The rows

| Row | Does |
|---|---|
| `tool:review-rows-of-a-list` | Sets a list up for review, or verifies, flags, asks to check or assigns its rows |
| `tool:find-cold-rows` | The rows nobody uses, leaving out rows whose review is current |
| `tool:heat-of-a-row` | A row's heat as of a moment, and the record one more use leaves |

`rowsNeedingReview` (each owner's rows to look at, with why) needs a saved-view reader (`readView`); it moves here with no row until the lists' saved views are read through the records door.
