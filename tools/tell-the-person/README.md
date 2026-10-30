# tools/tell-the-person/

What Trillion told the person, read from their own `told-the-person` records through the run's records door
(`tools/records-door`). The told list is one head record `told-the-person` naming the kept notices in order, and one
record `told-the-person:<seq>` per notice.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:my-notices` | The newest notices (of one kind if asked), where the person saw each, how far each way got and why a way did not carry it | list `told-the-person` |

## Files

| File | Purpose |
|------|---------|
| `read-data/told.mjs` | `myNotices`, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `tool-rows.json` | The row. |
| `test/told.test.mjs` | The row against the fake records door: order, kind filter, seen count, an earlier whole head. |

## Dependencies

**Depends on:** `tools/records-door`.
