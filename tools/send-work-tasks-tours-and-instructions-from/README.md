# tools/send-work-tasks-tours-and-instructions-from/

Send work, tasks, tours and instructions from Trillion to customers' AIs, to one person, a group, a test group or everyone, in a time window.

This folder has no tool row yet.

- `do-work/work-for-ais-rules.mjs`: the row rules, ported from the old owner's `src/work-for-ais.mjs` at commit b6ae0ebf81 (the tag named in `moved-from.json`): `checkedRow`, `rowsInForce`, `inWindow`, `triggersFor`, `handoffFor`, `rowsFor`. The settings come from the caller (the rows and limits live in `tools/decide-when-things-show/read-data/work-for-ais.json`, which this file's test reads). Audiences are matched by the caller's `matches`, not here.
- `test/work-for-ais-rules.test.mjs`: 8 tests run with `node --test`, from the old held test's cases.
- Not ported yet (task rows in verify-every-port): the delivery when an account's AI connects (old `makeWorkDelivery`, `handoffFor` into the task engine), the operator's row store and tools (old `workRowsOf`, `read_work_for_ais`, `send_work_to_ais`), and the formula-engine audience match.
- `from-an-older-version/` is no longer in this checkout: commit 332230b33 (Nov 19 2026) moved the folder, with the `.held` copies of the old `src/work-for-ais.mjs` and its two tests, to a parked copy outside this checkout. `moved-from.json` names each file's source path and commit.
