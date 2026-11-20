# tools/send-work-tasks-tours-and-instructions-from/

Send work, tasks, tours and instructions from Trillion to customers' AIs, to one person, a group, a test group or everyone, in a time window.

This folder has no tool row yet.

- `do-work/work-for-ais-rules.mjs`: the row rules, ported from the old owner's `src/work-for-ais.mjs` at commit b6ae0ebf81 (the tag named in `moved-from.json`): `checkedRow`, `rowsInForce`, `inWindow`, `triggersFor`, `handoffFor`, `rowsFor`. The settings come from the caller (the rows and limits live in `tools/decide-when-things-show/read-data/work-for-ais.json`, which this file's test reads). Audiences are matched by the caller's `matches`, not here.
- `test/work-for-ais-rules.test.mjs`: 8 tests run with `node --test`, from the old held test's cases.
- `do-work/work-for-ais-delivery.mjs`: the delivery when an account's AI connects, ported from old `makeWorkDelivery` (src/work-for-ais.mjs lines 149-198): per-account cache (cache_seconds), rows cache (rows_cache_seconds), one run per account, once per handed row, a live handoff not remembered, and the 5000-account cap (`ACCOUNTS_KEPT`). Built and tested, not wired, waits for the owner's word.
- `test/work-for-ais-delivery.test.mjs`: 15 tests, from the old test's delivery cases.
- `do-work/work-for-ais-book.mjs`: the operator's per-row book, ported from old `makeWorkRow`, `readWorkRows`, `workRowsOf` (lines 200-268): save, end and list, each row in its own book; the 200-row limit (from DATA) and expired-row let-go on save (old lines 249-258, `planWorkRowSave`). Built and tested, not wired, waits for the owner's word.
- `test/work-for-ais-book.test.mjs`: 9 tests, from the old test's book cases.
- `test/work-for-ais-fakes.mjs`: shared fakes for the tests (the DATA settings, an edge store with pages, a small audience matcher, account facts).
- Not built (the operator's route and tools, old `answerWorkRequest`, `handleWorkForAisRequest`, `workForAisTools`): they are route and tool rows, and wait for the owner's word. The formula-engine audience match stays the caller's `matches`.
- `from-an-older-version/` is no longer in this checkout: commit 332230b33 (Nov 19 2026) moved the folder, with the `.held` copies of the old `src/work-for-ais.mjs` and its two tests, to a parked copy outside this checkout. `moved-from.json` names each file's source path and commit.
