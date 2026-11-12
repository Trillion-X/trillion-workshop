# tools/name-my-next-commitment/

Say what is happening now or next on the person's calendar, with a countdown ("Design review · in 12 min"): the one line the Mac menu bar item shows when nothing is running. The caller reads the timed calendar items from the person's records and hands them over. Nothing here reads storage, and nothing is written.

Ported from old trillion `src/workspace/next-commitment.ts` and `src/workspace/next-commitment.json` at commit `cdb3894b25`. Both files are copied byte for byte into `read-data/`; the do-work entry only adds the input checks and the JSON answer.

## What the old menu bar item did, and what is here

| Old part | Decision | What happened |
|---|---|---|
| The countdown line (`nextCommitment`, `countdown`, `reach`) | Ported | `read-data/next-commitment.ts`, unchanged. |
| The words and look-ahead limits (`next-commitment.json`) | Ported | `read-data/next-commitment.json`, unchanged. |
| The menu bar item's mark: the running count, the newest running title, the unread chip (`macos/App/menu-bar-panel.json` `mark`) | Not ported | Still in the old tree and in the app's Swift code. The mark's content is a separate owner's data and is not part of this tool. |
| The menu bar settings rows (`src/workspace/panel-settings.mjs`) | Not ported | A message contract between the page and the Swift host, so it belongs to the app, not to a Workshop tool. |
| Refresh cadence (`refresh_seconds`) | Ported | Returned in the answer so the host knows when to ask again. |

## Files

| File | Purpose |
|------|---------|
| `do-work/name-my-next-commitment.mjs` | `tool:name-my-next-commitment`: one JSON input on standard input, `{ result }` or `{ error }` on the last line. |
| `read-data/next-commitment.ts` | The countdown line, from the old tree. |
| `read-data/next-commitment.json` | Its words and limits, from the old tree. |
| `test/name-my-next-commitment.test.mjs` | Tests for the line, the reach, the calendar counting rules and the refusals; the local-midnight case is written in local clock times so it holds in any time zone. |
| `tool-rows.json` | The Workshop row Trillion reads for this folder. |
| `part.json` | The entry the row runs is public. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `nameMyNextCommitment` | `(input) -> { line, within_hours, reach_ends_at, refresh_seconds }` | Refuses a request whose items, times, reach or counting are not of the right shape. |
| `nextCommitment` (read-data) | `(items, nowMs, withinHours, counting) -> string or null` | The line for the commitment now or next inside the reach. |

## Dependencies

**Depends on:** nothing outside this folder (Node 24 type stripping runs `read-data/next-commitment.ts`).

**Depended on by:** `tool-rows.json` (the row packs these files), `test/name-my-next-commitment.test.mjs`.
