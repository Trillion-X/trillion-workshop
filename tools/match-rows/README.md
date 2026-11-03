# tools/match-rows/

Pairs rows from two places that describe the same thing: a card line and its receipt, both sides of a transfer, a payment and the invoices it paid, a calendar event and a timesheet entry. The caller names the fields to compare, how close counts and how much each matters. It returns confident matches, suggestions with their alternatives and reasons, and what is left on each side. It never confirms when two candidates are nearly as good, and it changes no row; the caller writes the pairs it accepts. Learned from transaction matching in two finance apps (reverse engineered 2026-10-15).

## Files

| File | Purpose |
|------|---------|
| `do-work/match-rows.mjs` | `matchRows(request)`: pure and deterministic. Scores every left row against every right row field by field, rules out pairs a required field disagrees on, then confirms, suggests and leaves over. |
| `read-data/rules.json` | The defaults as DATA: the fields compared when a request names none (amount ignoring sign, date within 5 days, description words), `confirm_at`, `suggest_at`, `clear_lead`, the number of alternatives, the words that never count as shared, the id field and the mode. A request overrides any of it. |
| `tool-rows.json` | The row `tool:match-rows`, run in the small container. |
| `test/match-rows.test.mjs` | The pairing's behaviour on invented card lines, receipts, transfers and calendar rows, and the row's own sample run through the command the row runs. |
| `part.json` | Nothing here is imported by other code. |

## How rows are paired

- **Scoring:** a number agrees by being the same (as it is, ignoring sign, or as a mirror image) within its tolerance, a date by being within its tolerance in days, words by the share of the smaller side's words they have in common, `same` by equal text. A pair's confidence is the weighted share of its fields' scores, and every field's reason is returned.
- **Required fields:** a field marked `required` that disagrees, or is missing on either side, rules the pair out.
- **Confirming:** a pair at or above `confirm_at` is matched only when no other unused row is within `clear_lead` of it for either side (in `one_to_one` mode); otherwise it is suggested with up to `alternatives` other candidates. Nothing below `suggest_at` is offered.
- **Modes:** `one_to_one` uses each row once, best first; `many_to_one` sends each right row to its best left row, so one payment can collect many bills.
- **Already paired:** pairs in `already` are returned as `kept` and their rows are not offered again.
- **Refusals:** no fields, a side that is not a list, a row without an id and two rows on one side with the same id are refused in words.

## Dependencies

**Depends on:** `tools/records-door` (the command that runs a function), `tools/content-identity`; Node 22.

**Depended on by:** nothing is imported from here.
