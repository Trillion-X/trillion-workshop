# tools/recently-deleted/

Recently Deleted and Archived: how long each keeps the person's files before its time ends. Each state has a DATA
default, and the person's own choice replaces it. That choice is their setting record `setting:keep_for`, read through
the run's records door (`tools/records-door`) with a right on that one record only.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:read-deleted-files-keep-for` | Each state's days (null: until put back), its default, what happens when its time ends, and the usual choices | read `setting:keep_for` only |

Setting the days, deleting, archiving and putting back also arm the account's alarm, so they move once wake is mounted.

## Files

| File | Purpose |
|------|---------|
| `read-data/keep-for.mjs` | `readKeepFor`, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `read-data/set-aside.json` | The two states and the usual numbers of days. |
| `tool-rows.json` | The row. |
| `test/keep-for.test.mjs` | Defaults, a person's own choice, and a right on one record. |

## Dependencies

**Depends on:** `tools/records-door`.
