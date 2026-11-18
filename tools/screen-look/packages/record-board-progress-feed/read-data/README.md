# read-data

Pure projection code for `record-board-progress-feed`.

This folder folds configured source refs and producer events into source-keyed
progress rows. It has no React, DOM, owner-action execution, Runtime Kit write
calls, or package-set folder assumptions.

## Owned Files

- `tools/see-what-is-being-worked-on/packages/record-board-progress-feed/read-data/source-correlated-records.ts`: generic event, row, diagnostic, descriptor,
  and action helpers.
- `process-session-source-events.ts`: adapter from existing process-session
  snapshots/activity events into the generic event shape.

## Invariants

- Source address is the first grouping key.
- State, producer, action, and diagnostic codes are open strings.
- Unknown values survive as data.
- Malformed producer input creates diagnostics while preserving valid rows.
- Replay order and live append order produce the same row set.
