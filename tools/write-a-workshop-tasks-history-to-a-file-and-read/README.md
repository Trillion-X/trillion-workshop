# tools/write-a-workshop-tasks-history-to-a-file-and-read/

Write a Workshop task's history to a file and read it back whole, even a row too big for the file limit, in exact byte pieces.

This folder has no row yet. Its old Trillion files are in `from-an-older-version/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## State in this checkout (held, not wired)

- `from-an-older-version/` is not in this checkout. Commit `332230b33` parked it in the private repository `trillion-workshop-was-ported-to-workshop-lazily-placed-need-to-detmeine-if-tehse-are-better-and-if-what-superceded-them-lost-anything` (read only). The parked copies match the source identities in `moved-from.json`: `src/workshop-history-serialization.mjs` (identity `1f:cc6ecc786b…`) loads as-is, and `src/workshop-task-history.mjs.held` and `test/workshop-history-serialization.test.mjs.held` stay held. The piece generator imports `./record-history.mjs` (526 lines at the pinned commit `b6ae0ebf815f`), which this checkout does not hold as a module, so it waits for that owner.
- `do-work/write-history-file.mjs` is a new port, not a copy of old bytes. It writes the pieces of one task's history into files in the legacy line shape (whole rows as their own lines; larger rows as `workshop_history_part` continuation lines in exact hex, each file under its ceiling) and reads the files back whole. It has no dependency and touches no device: the caller passes the piece iterable and a sink. Checked: the pinned `parts()` reader from `src/workshop-task-history.mjs` reads its output back to the exact row bytes.
- `test/write-history-file.test.mjs` runs with `env -u GIT_INDEX_FILE node --test test/*.test.mjs`.
- No row names this tool and nothing is wired into `tool-rows.json`. Writing the files to a person's device is a sharing-like path: it waits for the owner's word.
