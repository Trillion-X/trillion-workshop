# tools/social-posts/

The person's posts, read from their own `post` records through the run's records door (`tools/records-door`).

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:read-post-calendar` | The posts between two times, earliest first, each with whether it can still move, and the drafts and approved posts with no time yet | list `post` |
| `tool:see-how-each-post-did` | How each place a post was published to did: that place's own counts (handed in), the visitors its link brought and what they bought (handed in, in tool:break-down-visits-and-sales' shape), joined by exact identity only | list `post` |

## Files

| File | Purpose |
|------|---------|
| `read-data/post-calendar.mjs` | `readPostCalendar`, run by `tools/records-door/do-work/run-an-export.mjs`, and the shape every reader sees a post in. |
| `read-data/post-calendar.json` | The longest span one read covers (400 days) and how many unscheduled posts are shown (50). |
| `read-data/post-results.mjs` | `seeHowEachPostDid`, run by the records door's export command: each delivery a post record says was posted (with the place's own post id) becomes one published row; observations, visits and conversions become the join's rows. |
| `read-data/post-performance-attribution.ts` | `readPostPerformanceAttributionRows`, ported from bitfield-packages `packages/content-analytics`: the latest place count linked by the place row or the place's own post id, visits whose `utm_content` is exactly the post id, the place's post id or `post_id::account_id` and names one place only, and conversions of those visitors in the same project. Nothing missing becomes a zero. |
| `tool-rows.json` | The rows. |
| `test/post-calendar.test.mjs` | The calendar row against the fake records door: the span, the order, what can move, the refusals. |
| `test/post-results.test.mjs` | The results row against the fake records door: per-place counts, visits and sales, the shared-token refusal, post_ids, refusals. |
| `test/post-performance-attribution.test.ts` | The join's own tests, carried from content-analytics. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| Observation | `{ post_id, account_id, metrics: { name: number }, observed_at? }` or `{ platform_post_id, account_id?, metrics }` | One place's own counts for one post, read with that place's tools. |
| Result row | `{ post_id, account_id, title, platform_post_id, url, metrics, observed_at, brought?: { visits?, conversions?, value? }, evidence }` | What one published place did; `brought` holds only what was counted. |

## Dependencies

**Depends on:** `tools/records-door`.
