# tools/social-posts/

The person's posts, read from their own `post` records through the run's records door (`tools/records-door`).

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:read-post-calendar` | The posts between two times, earliest first, each with whether it can still move, and the drafts and approved posts with no time yet | list `post` |

## Files

| File | Purpose |
|------|---------|
| `read-data/post-calendar.mjs` | `readPostCalendar`, run by `tools/records-door/do-work/run-an-export.mjs`, and the shape every reader sees a post in. |
| `read-data/post-calendar.json` | The longest span one read covers (400 days) and how many unscheduled posts are shown (50). |
| `tool-rows.json` | The row. |
| `test/post-calendar.test.mjs` | The row against the fake records door: the span, the order, what can move, the refusals. |

## Dependencies

**Depends on:** `tools/records-door`.
