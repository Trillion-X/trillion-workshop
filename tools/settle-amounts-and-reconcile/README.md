# tools/settle-amounts-and-reconcile/

Two things any list of amounts needs, over the person's own lists, with no business named. **Settlement** applies an amount held by one row (a payment, a credit, a grant) across other rows (invoices, bills, budgets) as allocation rows between them. **Reconciliation** closes a set of cleared lines against a statement with an explained residual, a receipt per close and a record of any later edit to a closed line. Beside them: entries of signed lines that post only when they add to zero, the lines of a quote totalled with each percent naming its base, and accrual and cash read from the same rows.

- **An allocation is its own row** linking a source row to a target row with an amount. Nothing is kept on the two rows: what is applied and open is always worked out from the allocation rows, so removing one reopens that target and frees the source and changes nothing else.
- **What is left of a source is a credit** (unapplied). It is never forced onto a row.
- **Empty is not zero.** A row with no amount has nothing to settle and is refused with the field named.
- **Many items, each answered.** Applying or removing many items answers each one (done, already_done or refused, with why) and an outcome of all, some or none. One refused item never hides or undoes the others.
- **Once per key.** An allocation row's id is made from the request key, the source and the target; a close with the same key returns the same receipt. After the writes the totals are read again, and an allocation that left a row over-applied is removed and answered refused.
- **A close adds up or says why.** The cleared lines must add up to the statement, or the residual is explained in words. A receipt is kept forever (an undone close gets undone_at); a line changed or removed after its close is found by check and may be kept as a discrepancy row beside the receipts.
- **Entries add to zero.** An entry posts only when its signed lines add to zero, in one write; it is never edited and is undone by a new entry with every line negated. A balance check lists every entry that does not add to zero and every line with no amount or no entry (unplaced, never counted as zero).
- **Percents name their base** (the line above, since the last subtotal, all above), and the answer shows the base used. **Accrual and cash** are two reads of the same rows and allocations, each figure naming its basis and the rows behind it.
- **Every order, field name, limit and word is a row** in `read-data/list-settlements.json`, never a branch in code.

The person's lists are their records: a list is `list:<id>` of type `list` and its rows are `record:<row_type>:<row id>` of type `record:<row_type>` (the shape of `tools/records-door/read-data/lists-door.mjs`). Each row names the record kinds of the lists it reads or writes (`source_kind`, `target_kind`, `lines_kind`) so its run is granted exactly those.

## Files

| Path | What it is |
|---|---|
| `read-data/list-settlements.mjs` | `makeSettlements` and `handleSettlementRequest`, moved unchanged from old trillion `src/list-settlements.mjs`. |
| `read-data/list-settlements.json` | Its orders, fields, limits, outcomes, words, bases and line kinds, moved unchanged from old trillion `src/list-settlements.json`. |
| `do-work/settle-over-records.mjs` | `settle({ action, list_id, ... }, { door })`: the module over the person's lists through their records door, for every row. |
| `tool-rows.json` | `tool:settle-amounts-between-lists`, `tool:reconcile-lines-against-a-statement`, `tool:post-balanced-entries`, `tool:total-quote-lines`, `tool:report-on-accrual-or-cash`. |
| `test/list-settlements.test.mjs` | Old trillion `test/list-settlements.test.mjs`, every settlement assertion as it was, over records in a door kept in memory. |
| `test/settle-over-records.test.mjs` | The seam: conditional row writes, removal, and refusals answered as errors. |
