# tools/social-posts/

The person's posts, kept in their own `post` records and read and written through the run's records door
(`tools/records-door`): drafted, checked for each place they are going, approved exactly as reviewed, and set to go at
their time. The places are rows (`read-data/post-places.json`); the person's accounts are their own `connection`
records, each naming its connection id, the handle the engine reads that account's held values by. No value a place
signs a request with is ever in a record, a row or this code.

Approval is owned by `tool:approve-a-post` in this package's rows. It requires the complete reviewed snapshot and the
row's read and write rights for the post record. `approved_by` is attribution supplied by the caller; it does not claim
that a person saw or pressed a page. The old native adapter and its historical page-only test are held under
`held-source/`: they wrapped the retired EEAF/HTTP lifecycle, whose imports are absent here, and their page-only
approval rule was rejected. The historical test path remains runnable and imports the current common-owner regression.
The existing keeper receipt in `tools/keep-and-wake-ai-sessions-on-this-computer/moved-from.json` records the exact
Trillion source and held bytes at the original bulk-move commit. The live Trillion owner has since changed; this held
adapter is historical evidence, not a second implementation of the current owner.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:list-post-destinations` | The person's accounts a post can go to, each ready or not and why, and each place they have no account for yet | list `connection` |
| `tool:draft-a-post` | Keeps a draft: words, file, destinations, link, time; changing an approved or scheduled post makes it a draft again. Nothing is posted | read and write `post`, list `connection` |
| `tool:check-a-post` | Whether the post is ready for each place: what each will refuse, and what could not be checked here | read `post`, list `connection` |
| `tool:approve-a-post` | Approves only with the complete `approval_values` snapshot from review; changed values are refused. Approval uses the row's granted read and write `post` rights. | read and write `post` |
| `tool:publish-a-post-now` | Queues an approved post for the current time through the existing post wake and each destination's send row. It returns `scheduled` until those rows record their outcomes; an unknown outcome is not retried automatically. | read and write `post`, list `connection` |
| `tool:set-a-post-to-go-at-its-time` | An approved post with a time still ahead, ready for every place, becomes `scheduled`. Nothing is sent now | read and write `post`, list `connection` |
| `tool:take-back-a-post` | A scheduled post nothing was sent for becomes a draft again, so its time sends nothing | read and write `post` |
| `tool:check-the-instagram-connection` | Asks Instagram which account one of the person's Instagram connections (`account_id`) signs in as, with its held value placed only as the request leaves. Posts nothing | none (http) |
| `tool:check-the-threads-connection` | Asks Threads which account one of the person's Threads connections (`account_id`) signs in as (id and username), with its held value placed only as the request leaves and renewed before its 60 days lapse. Posts nothing | none (http) |
| `tool:check-the-facebook-page-connection` | Asks Facebook which Page one of the person's Facebook Page connections (`account_id`) signs in as, the same way. Posts nothing | none (http) |
| `tool:check-the-youtube-connection` | Asks YouTube which channel one of the person's YouTube connections (`account_id`) signs in as, with its held value placed only as the request leaves. Returns the channel id, title and uploads playlist id. Posts nothing | none (http) |
| `tool:list-my-youtube-videos` | Lists the videos of the channel a YouTube connection signs in as, from its uploads playlist (`playlist_id` from the check), with each video's privacy status, unlisted and private included when the sign-in can read the channel. Posts nothing | none (http) |
| `tool:read-youtube-comments` | Reads the top-level comment threads of one video (`video_id`, run once per video) through a YouTube connection (`account_id`), 100 to a page: text, like count, publish time, reply count and the commenter's channel id only (no display name). Posts, rates and moderates nothing | none (http) |
| `tool:read-post-calendar` | The posts between two times, earliest first, each with whether it can still move, and the drafts and approved posts with no time yet | list `post` |
| `tool:see-how-each-post-did` | How each place a post was published to did: that place's own counts (handed in), the visitors its link brought and what they bought (handed in, in tool:break-down-visits-and-sales' shape), joined by exact identity only | list `post` |
| `tool:send-a-post-to-<place>` (one per place row: youtube, tiktok, instagram, facebook, instagram-facebook, threads, linkedin, substack, x, beehiiv, ghost) | Sends an approved post whose time has come to one destination (`account_id`, an account of that place's connection kind) and keeps where it went. The engine hands the run only that account's held values; each reaches only the place's hosts as the request leaves. Marked not known before sending, never sent twice. A post with a file hands the place that file from the person's files (media_from in its place row): a share it streams (address), the bytes streamed to it (stream), or the bytes as one piece (whole); a file no longer in their files is refused before anything leaves. Run at a post's time by `tool:send-each-post-at-its-time`, it is told the post's `armed_at` and sends nothing once the post no longer carries it. It posts publicly: run it only with the person's yes for that post | read and write `post`, read `connection`, share_file and read_file on the person's files |
| `tool:send-each-post-at-its-time` | Runs on its own once the person switches on its wake (`at-its-time`, on their `post` records). For each changed post set to go at its time, it sets one run of the place's send row (the place row's `send_tool`) per destination still to be sent, at the post's `scheduled_for`, told its `armed_at`. A post taken back, changed or set again sends nothing at the old time. It sends nothing itself and nothing polls | read `post` and `connection`; it also holds the rights its sends need, because each send reaches only what the wake was granted |
| `tool:save-a-snippet` | Keeps words the person sends again and again as a snippet (title, words with `{name}` blanks, tags), or changes one; `expected_set_at` refuses a change to a snippet saved since it was read. Sends nothing | read, list and write `snippet` |
| `tool:find-snippets` | The person's snippets, newest used first, by the words in them or a tag, each with its blanks | read and list `snippet` |
| `tool:use-a-snippet` | A snippet's words with the blanks given filled; each blank given no value is left as written and named back in `left_blank`. Counts the use; never rewrites the words | read, list and write `snippet` |
| `tool:remove-a-snippet` | Removes one snippet | read, list and write `snippet` |
| `tool:keep-a-thread-summary` | Keeps an AI's summary of one conversation, covering through `latest` (the newest message's id and time, handed in from the messages owner); keeping again replaces it | read, list and write `thread-summary` |
| `tool:read-a-thread-summary` | The summary kept of one conversation, and how many of `message_times` (the conversation's newest message times, handed in) come after what it covers: `newer_messages`, `stale` | read and list `thread-summary` |
| `tool:remove-a-thread-summary` | Removes the summary of one conversation; the messages are not touched | read, list and write `thread-summary` |

## Files

| File | Purpose |
|------|---------|
| `read-data/post-shape.mjs` | The one shape of a post: the approval fields, whether it can still change, and the post as every reader sees it. |
| `read-data/posts.mjs` | `listPostDestinations`, `draftAPost`, `checkAPost`, `approveAPost`, `setAPostToGoAtItsTime`, `takeBackAPost`, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `read-data/posts.json` | The record kinds, link tags, limits, ready-check limits and words, the first-contact rule, how a file reaches a place (`media`), the markups a place may take words in (`markup`) and how a post goes at its time (`at_its_time`: each timed send's budget, the most one firing sets, the states it still sends in, its words). |
| `read-data/post-places.json` | One row per place: the connection vendor that reaches it, how its publisher is filled (held and readable fields), its hosts, its default settings, what it takes (`format`) and the row that sends to it (`send_tool`). |
| `read-data/send-a-post.mjs` | `sendAPost` and `sendEachPostAtItsTime` (run by the records door's export command), `publisherFor` and `heldFetch`: one post to one destination through its place's publisher, the held values read from descriptors 4, 5, ... in the order the place's options name them, placed only as a request to the place's own hosts leaves. |
| `read-data/publisher-facebook-page.mjs`, `read-data/publisher-substack.mjs` | Publishers shaped like @opencoredev/social-sdk's for the two places it does not reach (the adapters `facebook-page` and `substack`). |
| `read-data/publisher-requests.mjs` | `requests`: the publisher for a place whose requests are written in its place row (beehiiv and Ghost): each step's address, headers and body as templates of the post's words (as written or in a markup of posts.json), its settings and earlier replies, with what each reply must hold and a read back that must name the post that was made. Nothing in it names a place. |
| `read-data/post-ready.mjs` | `readyFor` and `readyOverall`: one place's ready check and the post's, from the place's `format`. |
| `read-data/post-calendar.mjs` | `readPostCalendar`. |
| `read-data/post-calendar.json` | The longest span one read covers (400 days) and how many unscheduled posts are shown (50). |
| `read-data/post-results.mjs` | `seeHowEachPostDid`, run by the records door's export command: each delivery a post record says was posted (with the place's own post id) becomes one published row; observations, visits and conversions become the join's rows. |
| `read-data/post-performance-attribution.ts` | `readPostPerformanceAttributionRows`, ported from bitfield-packages `packages/content-analytics`: the latest place count linked by the place row or the place's own post id, visits whose `utm_content` is exactly the post id, the place's post id or `post_id::account_id` and names one place only, and conversions of those visitors in the same project. Nothing missing becomes a zero. |
| `read-data/snippets.mjs`, `read-data/snippets.json` | `makeSnippets`: save, list, use and remove a snippet over an `eeaf`, its record type, blank pattern, sizes and words as data. Moved byte for byte from trillion `src/snippets.mjs` and `src/snippets.json`. |
| `read-data/thread-summaries.mjs`, `read-data/thread-summaries.json` | `makeThreadSummaries`: save, read and remove one conversation's summary over an `eeaf`, given the thread's `latest` and `newer`. Moved byte for byte from trillion `src/thread-summaries.mjs` and `src/thread-summaries.json`. |
| `read-data/drafts-over-door.mjs` | The snippet and thread-summary rows: `heldEeafOver` (the `eeaf` both moved files call, `read`, `ids`, `write`, over records held in memory) and `passesOverDoor` (runs the moved code in passes, fetching through the records door each record or kind a pass missed, then sends the last pass's writes as one door write, each record that was read `expected` as read); `saveASnippet`, `findSnippets`, `useASnippet`, `removeASnippet`, `keepAThreadSummary`, `readAThreadSummary`, `removeAThreadSummary`. |
| `test/native-post-approval.mjs` | The common-owner approval regression: a named post is accepted with the exact reviewed snapshot and row grant; a changed snapshot is refused; a read-only grant leaves the post a draft. |
| `held-source/` | Byte-preserved evidence for the unsupported native adapter and historical page-only test. The keeper's existing `moved-from.json` records their source and held identities. |
| `tool-rows.json` | The rows. |
| `test/send-a-post.test.mjs` | The sender against the fake records door and a stand-in place: sent once, the held value only in the place's own request and in no record, nothing before its time, not-known kept until resend, a file refused before anything leaves, the host guard, each send row's mounts in the order the sender reads them, a place that signs two requests in one run sending the held key on both (each descriptor read once), and a post going at its time: one timed send per destination at its time, none for a post not set, removed or already sent, nothing sent by a timed send the post was taken back, changed or set again since, and the wake's rights equal to its sends'. |
| `test/posts.test.mjs` | The posting rows against the fake records door: destinations, draft, check, approve as reviewed, set for its time with nothing sent, take back, the refusals; and each connection check asks with the value its place signs with, on one of that place's hosts. |
| `test/post-calendar.test.mjs` | The calendar row against the fake records door: the span, the order, what can move, the refusals. |
| `test/post-results.test.mjs` | The results row against the fake records door: per-place counts, visits and sales, the shared-token refusal, post_ids, refusals. |
| `test/snippets.test.mjs`, `test/thread-summaries.test.mjs` | Trillion's tests of the two moved files, assertions unchanged, over `test/drafts-for-tests.mjs` (an in-memory `eeaf` standing in for trillion's `test/social-posts-for-tests.mjs`). Trillion's second test in each (the posts tools and page road, and the person store's thread ends from its messages owner) runs callers that stay in trillion and is not moved. |
| `test/drafts-over-door.test.mjs` | The seven rows against the fake records door: save, find, use with a blank left, change, stale and empty refusals, remove; a summary kept through the latest message, fresh then stale by the message times, replaced, removed; and a write carrying each read record as `expected`. |
| `test/post-performance-attribution.test.ts` | The join's own tests, carried from content-analytics. |
| `web/src/workspace/posts-screen-mount.tsx` | The Posts screen's module entry (`tool:check-a-post`): `mount` is `mountPostsScreen`. |
| `web/src/workspace/calendar-screen-mount.tsx` | The posting calendar's module entry (`tool:read-post-calendar`): `mount` is `mountCalendarScreen`. |
| `web/src/workspace/calendar-screen.tsx` | Posting calendar, the planning view of Posts (entry `calendar`, the screen of the Workshop tool `tool:read-post-calendar`): the person's posts on a month board or week and day hour lanes (shared `ScheduleCalendar`, its header choosing month, week or day, drawn as one record views' `render` view whose id `calendar` takes the place of the Calendar every list is offered, since this screen reads only the span on screen and asks for approval again after a move; with search, a status filter and a List), each at the time it goes out, drafts with no time in the tray. Dragging a post that can still change to a day, an hour or the tray gives it that time or takes it away (`/work/api/posts/draft`); a moved approved or scheduled post is a draft again and a notification offers Approve again (approve, and set again while its time is ahead). Opening a post shows a time field, Move, Take its time away and Approve. Reads only the span on screen (`/work/api/posts/calendar`). Words, views, statuses and tones are `calendar.json`. |
| `web/src/workspace/calendar.json` | DATA for the posting calendar: its bar views (`calendar` and the List) and the month, week and day its calendar header offers (`ScheduleCalendar` views), each post status's words and tone, the hour window, snap and post length, and every sentence it says. |
| `web/src/workspace/posts-screen.tsx` | Posts (entry `posts`, the screen of the Workshop tool `tool:check-a-post`, `records/workshop-publishing-tool-records.json`): every post the person or their AI drafted in the shared record views, in sections by status; each row shows the post's video, picture or sound as its picture (`file-picture.ts`) with a Cards view; opening one shows it beside the list with its words, its file playing in the shared `FilePreview`, link and time, and each place it is going with that place's own words and settings, where its copy is, and that place's ready check in plain words (`src/post-ready.mjs`). Approve and Publish on the post and on each row's menu; a post not ready for every place can be handed to the person's AI (queued job `fix-post`); with no post, the AI is asked to draft one (`draft-post`). Under an opened post is Say about this (`say-about-this.tsx`) about the post (`record` its post_id): a note on its video is kept at the moment playing and reaches every AI as a revision of that draft. The list and an opened post are the person's `post` records read through the records door (`records-door.ts`) and shaped by `src/post-shape.mjs`, as the posts store shapes them; the ready check shows only where an owner answers it. Pressed through `/work/api/posts` (`src/work-posts.mjs`), the routes the AI's post tools call. |
| `web/src/workspace/post-looks.json` | DATA for the Posts screen: each post status's section name and tone in list order, each place's state tone, the presses a post offers (`id` = the verb, `when` = the statuses) and the jobs handed to the AI. |
| `web/src/workspace/new-post.tsx` | Writing a post and choosing where it goes, shared by Posts and the posting calendar. |
| `web/src/workspace/pending-changes.ts`, `web/src/workspace/pending-layers.json` | Changes the store has not yet acknowledged, laid over what a screen reads until it has, so a moved post is not snapped back; the layers are the DATA file. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| Post record | `{ post_id, status, caption, media?, caption_by_platform, settings_by_platform, destinations: [connection id], link?, scheduled_for?, time_zone?, source?, format_id?, reaches?, deliveries?, created_at, updated_at, approved_at?, armed_at? }` | One post; status is draft, approved, scheduled, posted, failed or partial. |
| Connection record | id `connection:<connection id, URL-encoded>`, value `{ connection_id, vendor, service?, account_label?, plain: { field: text }, held: [field], can_send? }` | One of the person's accounts: its readable fields, and the names (never the values) of the fields its vault holds. |
| Place row | `{ id, send_tool, platform, label, adapter, connection_vendor, options, account, hosts, media_from, default_settings, format }` | Where a post can go and what it takes. |
| Observation | `{ post_id, account_id, metrics: { name: number }, observed_at? }` or `{ platform_post_id, account_id?, metrics }` | One place's own counts for one post, read with that place's tools. |
| Result row | `{ post_id, account_id, title, platform_post_id, url, metrics, observed_at, brought?: { visits?, conversions?, value? }, evidence }` | What one published place did; `brought` holds only what was counted. |
| Snippet record | id `snippet:<saved at>:<10 hex>`, type `snippet`, value `{ snippet_id, title, text, tags, set_at, uses, used_at? }` | Words the person sends again and again; `{name}` in `text` is a blank. |
| Thread summary record | id `thread-summary:<app or ->:<conversation_id>`, type `thread-summary`, value `{ summary_id, app, conversation_id, summary, through_message_id, through_at, set_at }` | An AI's summary of one conversation and the message it covers through. |

## Dependencies

**Depends on:** `tools/records-door`; `@opencoredev/social-sdk` 0.5.0 (MIT, locked in the Workshop's package-lock.json), packed by the send rows.

## Moved from Trillion

- `src/snippets.mjs`, `src/snippets.json` -> `read-data/snippets.mjs`, `read-data/snippets.json` (byte for byte); `test/snippets.test.mjs` -> `test/snippets.test.mjs`.
- `src/thread-summaries.mjs`, `src/thread-summaries.json` -> `read-data/thread-summaries.mjs`, `read-data/thread-summaries.json` (byte for byte); `test/thread-summaries.test.mjs` -> `test/thread-summaries.test.mjs`.
- Their words still name trillion's AI tools (`list_snippets`, `read_messages`, `save_thread_summary`); here those are `tool:find-snippets`, the messages owner's read, and `tool:keep-a-thread-summary`.
- Trillion's `src/social-posts.mjs` (with `src/social-post-tools.mjs`, `src/work-posts.mjs` and the thread ends wired in `src/person-store.mjs`) still imports its own copies of both until it moves.
