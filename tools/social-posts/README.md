# tools/social-posts/

The person's posts, kept in their own `post` records and read and written through the run's records door
(`tools/records-door`): drafted, checked for each place they are going, approved exactly as reviewed, and set to go at
their time. The places are rows (`read-data/post-places.json`); the person's accounts are their own `connection`
records, each naming its connection id, the handle the engine reads that account's held values by. No value a place
signs a request with is ever in a record, a row or this code.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:list-post-destinations` | The person's accounts a post can go to, each ready or not and why, and each place they have no account for yet | list `connection` |
| `tool:draft-a-post` | Keeps a draft: words, file, destinations, link, time; changing an approved or scheduled post makes it a draft again. Nothing is posted | read and write `post`, list `connection` |
| `tool:check-a-post` | Whether the post is ready for each place: what each will refuse, and what could not be checked here | read `post`, list `connection` |
| `tool:approve-a-post` | Approves the post exactly as it was reviewed (`expected_values`); a post that reaches someone is approved only by the person | read and write `post` |
| `tool:set-a-post-to-go-at-its-time` | An approved post with a time still ahead, ready for every place, becomes `scheduled`. Nothing is sent now | read and write `post`, list `connection` |
| `tool:take-back-a-post` | A scheduled post nothing was sent for becomes a draft again, so its time sends nothing | read and write `post` |
| `tool:check-the-instagram-connection` | Asks Instagram which account one of the person's Instagram connections (`account_id`) signs in as, with its held value placed only as the request leaves. Posts nothing | none (http) |
| `tool:check-the-facebook-page-connection` | Asks Facebook which Page one of the person's Facebook Page connections (`account_id`) signs in as, the same way. Posts nothing | none (http) |
| `tool:read-post-calendar` | The posts between two times, earliest first, each with whether it can still move, and the drafts and approved posts with no time yet | list `post` |
| `tool:see-how-each-post-did` | How each place a post was published to did: that place's own counts (handed in), the visitors its link brought and what they bought (handed in, in tool:break-down-visits-and-sales' shape), joined by exact identity only | list `post` |
| `tool:send-a-post-to-<place>` (one per place row: youtube, tiktok, instagram, facebook, instagram-facebook, threads, linkedin, substack, x) | Sends an approved post whose time has come to one destination (`account_id`, an account of that place's connection kind) and keeps where it went. The engine hands the run only that account's held values; each reaches only the place's hosts as the request leaves. Marked not known before sending, never sent twice. A post with a file is refused until a run can be handed the file. It posts publicly: run it only with the person's yes for that post | read and write `post`, read `connection` |

What starts a send at a post's time is the person's own wake (switched on by them), not these rows.

## Files

| File | Purpose |
|------|---------|
| `read-data/post-shape.mjs` | The one shape of a post: the approval fields, whether it can still change, and the post as every reader sees it. |
| `read-data/posts.mjs` | `listPostDestinations`, `draftAPost`, `checkAPost`, `approveAPost`, `setAPostToGoAtItsTime`, `takeBackAPost`, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `read-data/posts.json` | The record kinds, link tags, limits, ready-check limits and words, and the first-contact rule. |
| `read-data/post-places.json` | One row per place: the connection vendor that reaches it, how its publisher is filled (held and readable fields), its hosts, its default settings and what it takes (`format`). |
| `read-data/send-a-post.mjs` | `sendAPost` (run by the records door's export command), `publisherFor` and `heldFetch`: one post to one destination through its place's publisher, the held values read from descriptors 4, 5, ... in the order the place's options name them, placed only as a request to the place's own hosts leaves. |
| `read-data/publisher-facebook-page.mjs`, `read-data/publisher-substack.mjs` | Publishers shaped like @opencoredev/social-sdk's for the two places it does not reach (the adapters `facebook-page` and `substack`). |
| `read-data/post-ready.mjs` | `readyFor` and `readyOverall`: one place's ready check and the post's, from the place's `format`. |
| `read-data/post-calendar.mjs` | `readPostCalendar`. |
| `read-data/post-calendar.json` | The longest span one read covers (400 days) and how many unscheduled posts are shown (50). |
| `read-data/post-results.mjs` | `seeHowEachPostDid`, run by the records door's export command: each delivery a post record says was posted (with the place's own post id) becomes one published row; observations, visits and conversions become the join's rows. |
| `read-data/post-performance-attribution.ts` | `readPostPerformanceAttributionRows`, ported from bitfield-packages `packages/content-analytics`: the latest place count linked by the place row or the place's own post id, visits whose `utm_content` is exactly the post id, the place's post id or `post_id::account_id` and names one place only, and conversions of those visitors in the same project. Nothing missing becomes a zero. |
| `tool-rows.json` | The rows. |
| `test/send-a-post.test.mjs` | The sender against the fake records door and a stand-in place: sent once, the held value only in the place's own request and in no record, nothing before its time, not-known kept until resend, a file refused before anything leaves, the host guard, and each send row's mounts in the order the sender reads them. |
| `test/posts.test.mjs` | The posting rows against the fake records door: destinations, draft, check, approve as reviewed, set for its time with nothing sent, take back, the refusals; and each connection check asks with the value its place signs with, on one of that place's hosts. |
| `test/post-calendar.test.mjs` | The calendar row against the fake records door: the span, the order, what can move, the refusals. |
| `test/post-results.test.mjs` | The results row against the fake records door: per-place counts, visits and sales, the shared-token refusal, post_ids, refusals. |
| `test/post-performance-attribution.test.ts` | The join's own tests, carried from content-analytics. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| Post record | `{ post_id, status, caption, media?, caption_by_platform, settings_by_platform, destinations: [connection id], link?, scheduled_for?, time_zone?, source?, format_id?, reaches?, deliveries?, created_at, updated_at, approved_at?, armed_at? }` | One post; status is draft, approved, scheduled, posted, failed or partial. |
| Connection record | id `connection:<connection id, URL-encoded>`, value `{ connection_id, vendor, service?, account_label?, plain: { field: text }, held: [field], can_send? }` | One of the person's accounts: its readable fields, and the names (never the values) of the fields its vault holds. |
| Place row | `{ id, platform, label, adapter, connection_vendor, options, account, hosts, media_from, default_settings, format }` | Where a post can go and what it takes. |
| Observation | `{ post_id, account_id, metrics: { name: number }, observed_at? }` or `{ platform_post_id, account_id?, metrics }` | One place's own counts for one post, read with that place's tools. |
| Result row | `{ post_id, account_id, title, platform_post_id, url, metrics, observed_at, brought?: { visits?, conversions?, value? }, evidence }` | What one published place did; `brought` holds only what was counted. |

## Dependencies

**Depends on:** `tools/records-door`; `@opencoredev/social-sdk` 0.5.0 (MIT, locked in the Workshop's package-lock.json), packed by the send rows.
