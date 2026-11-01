# tools/tell-the-person/

What Trillion told the person, read from their own `told-the-person` records through the run's records door
(`tools/records-door`). The told list is one head record `told-the-person` naming the kept notices in order, and one
record `told-the-person:<seq>` per notice.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:my-notices` | The newest notices (of one kind if asked), including their body and offered actions, where the person saw each, how far each way got and why a way did not carry it | list `told-the-person` |
| `tool:my-device-notices` | Reads notices queued or positively delivered to one registered device, oldest first after its cursor | reads `notification-device`; lists `told-the-person` |
| `tool:mark-my-notices-read` | Records read/unread state and the first surface and device where a notice was read; repeats do not move that surface | reads and writes `told-the-person` with compare-and-swap |
| `tool:act-on-my-notice` | Completes an explicitly offered local open action; effectful source actions are refused unless their owner is available | reads `told-the-person` |

## Files

| File | Purpose |
|------|---------|
| `read-data/told.mjs` | `myNotices`, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `tool-rows.json` | The four rows. |
| `test/told.test.mjs` | The rows against the fake records door: order, kind filter, notice content/actions, device scoping and cursor, action offer validation, first-surface preservation, unread and an earlier whole head. |

## Dependencies

**Depends on:** `tools/records-door`.
