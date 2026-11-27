# tools/recently-deleted/

Recently Deleted and Archived: how long each keeps the person's files before its time ends. Each state has a DATA
default, and the person's own choice replaces it. That choice is their setting record `setting:keep_for`, which their AI reads
and gives as `keep_for`; the tool reads and keeps nothing.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:read-deleted-files-keep-for` | Each state's days (null: until put back), its default, what happens when its time ends, and the usual choices | none (takes `keep_for` as input) |

Setting the days, deleting, archiving and putting back also arm the account's alarm, so they move once wake is mounted.

## Files

| File | Purpose |
|------|---------|
| `read-data/keep-for.mjs` | `readKeepFor` (takes `keep_for` as input), run by `tools/records-door/do-work/run-an-export.mjs`. |
| `read-data/set-aside.json` | The two states and the usual numbers of days. |
| `what-this-tool-does-and-how-to-run-it.json` | The row. |
| `test/keep-for.test.mjs` | Defaults, a person's own choice, and a right on one record. |

## Dependencies

**Depends on:** `tools/records-door`.
