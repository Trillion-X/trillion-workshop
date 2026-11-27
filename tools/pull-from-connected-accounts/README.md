# tools/pull-from-connected-accounts/

Pulls a person's messages and saved items from the services they use and answers them, so their AI can read them in one place and put them wherever the person keeps such things. The tool keeps nothing. One mechanism runs every service; what differs between services is one JSON description each in `read-data/sources/`: where the service is, how a token is presented, which requests list the conversations and fetch their messages, how a list is paged, which field is an item's identity and which stamp says an edit is newer. Adding a service is one description and one row, never new code.

| Service (`source`) | What is pulled | Held token name |
|---|---|---|
| `discord` | the text and announcement channels a bot can read, in every server it is in | `discord-bot-token` |
| `signal` | the conversations a Signal client on the person's computer printed, handed in whole | none: its input is a handed-in client output (`self_id`, `conversations`) |
| `slack` | the public channels a bot is a member of | `slack-bot-token` |
| `telegram` | the messages a bot was sent, by chat | `telegram-bot-token` |
| `instagram-messages` | the direct-message conversations of an Instagram professional account (messaging API) | `instagram-access-token` |
| `instagram-comments` | the comments on each post of an Instagram professional account (Graph API), one thread per post, each comment kept as the service sent it | `instagram-access-token` |
| `messenger-messages` | the Messenger conversations of a Facebook Page | `messenger-page-access-token` |
| `x-bookmarks` | the posts the person bookmarked on X | `x-access-token` |
| `pinterest-pins` | the pins and boards of a Pinterest account | `pinterest-access-token` |

The token arrives on a private pipe (descriptor 4) from the person's held values and is only ever in the request; it is scrubbed from every sentence the tool prints and is never kept. Signal has no token and no public interface: its login lives in the client on the person's computer, and the pull is handed what that client printed (`handed_in` in its description, below). Chats that need a logged-in session or a local daemon and have no such seam (WhatsApp Web, Instagram by login) are not here: see "What is not here".

## What a pull answers, and what it is handed

Nothing is kept by the tool. A pull answers what it read as the service sent it, folded into what the caller hands back as `held`:

| Answer field | Meaning |
|---|---|
| `threads` | `[{ id, title, messages: [...], source? }]`: the conversations that are new or changed, each whole (its messages merged with the held ones, in order). A conversation with nothing new is not answered. |
| `collections` | `{ <name>: [item] }`: the saved items that are new or changed, exactly as the service sent them. |
| `cursor` | Where the next pull starts (Slack `oldest`, Telegram `offset`); hand it back as `held.cursor`. It moves only when no request failed. |
| `self_id`, `pulled_at`, `new_messages`, `new_items`, `status`, `errors`, `skipped`, `said` | As below. |

`held` is the input a caller keeps from earlier answers, in the same shape: `{ cursor?, threads: [{ id, title, messages, source? }], collections: { name: [item] } }`. The caller replaces a held conversation by `id` and an item by its identity, and keeps the cursor. With `held` left out everything the walk reaches is new. `held` is what lets a pull fold edits, keep a message once, stop paging at the first page already held (`stop_when_known`) and ask only what is newer than the cursor; the tool reads no records to learn it. An id segment, a `seq` or any record id is the caller's own concern. `account` is a name the person gives (default `default`) that the answer carries back, so the caller keeps accounts apart. `read-data/snapshot.mjs` (public, `part.json`) names the snapshot shape other tools read, `{ source, account, self_id, cursor, threads, collections }`.

## Files

| File | Purpose |
|------|---------|
| `do-work/pull.mjs` | `pullFromAnAccount(source, input, context)` and one export per service (`pullDiscord`, `pullSlack`, ...). Reads the token, asks who it belongs to, walks the description's requests, folds into the `held` it was handed and answers the new or changed conversations and items. |
| `read-data/sources/*.json` | One service each: `base`, `auth` (`header` with a name and prefix, or `path` with a template), `headers`, `identity`, `failure`, `rate_limit`, `cursor`, `walks` (each walk is a list of request levels and a `fold`). `messenger-messages.json` extends `instagram-messages.json`. `signal.json` has `handed_in` instead of `base`, `auth` and `identity`. |
| `read-data/sources.mjs` | `loadSource(id)` (resolves `extends`, refuses a description that cannot be pulled) and `sourceIds()`. |
| `read-data/fold.mjs` | The one pure fold: dedup by identity, order, and the three conflict policies (`keep`, `newer`, `merge`). |
| `read-data/pointer.mjs` | JSON-pointer reads and the small value expressions a description uses. |
| `read-data/snapshot.mjs` | Record ids, `readParts` and `assemble` for the parts earlier pulls kept. Public (`part.json`); no pull writes them now. |
| `do-work/signal-client.mjs` | The Signal client rows: `readSignalOnThisComputer` (receive, fold, hand to the `signal` pull) and `linkSignalOnThisComputer` (link and its QR code). |
| `read-data/signal-envelopes.mjs` | `readEnvelopeLines` and `envelopesToConversations`: what `signal-cli -o json receive` prints, in the `signal` pull's contract. |
| `do-work/connect-instagram*.py`, `do-work/graph_instagram_client.py`, `do-work/ig_snapshot_store.py` | The Instagram and Messenger Python producers moved from the package; see "What is not here". |
| `what-this-tool-does-and-how-to-run-it.json` | Nine pull rows (none declares a records door) and the two Signal client rows. Reading back what a pull kept is the recipe `workflow:read-what-i-pulled-from-an-account` (`tools/workflows/recipes/`, kit `tools/workflows/kits/read-what-i-pulled-from-an-account.json`): the person's own store is read directly. |
| `test/` | Fold, pointer, source and row tests, and every service pulled against a stand-in in the shape the service documents. `test/fixtures/signal-client-output.json` is the Signal client's contract as a made-up output. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `pullFromAnAccount` | `(source, { account?, limit?, most_pages?, most_threads?, held?, self_id?, <handed_in.document>? }) -> { status, threads, collections, new_messages, new_items, cursor, errors, skipped, said, ... }` | One pull. `status` is `pulled`, `partial` (some requests failed, named in `errors`), `needs_login` (no token, or the service refused it) or `unreachable`. |
| `foldItems` | `(held, arriving, policy) -> { items, added, changed }` | Held and arriving copies, once per identity, in order; nothing passed in is changed. |
| source description | `{ id, base, auth, identity, walks: [{ levels: [{ path, query, items, keep, bind, page }], fold }] }` | Everything that differs between services. A level's `bind` names values later paths use (`{channel}`), `page` is `{ param, next }` or `{ param, from_last }`, `fold` is `{ layout: threads \| items, key, signature, order, conflict, stop_when_known }`. A level with `from: "parent"` asks nothing: its `items` are read inside the entry the level above gave (a conversation that carries its messages). |
| `handed_in` | `{ document }` | A service with nothing to ask. In place of `base`, `auth` and `identity`: the input `<document>` (a JSON list, here `conversations`) is the one answer every request of the walk reads, and the input `self_id` says whose account it is. The pull has no token, no network and no `needs_login`. |
| `cursor` | `{ start, advance: { over: raw \| records, by, plus } }` | Where the next pull starts (Slack `oldest`, Telegram `offset`), answered and handed back as `held.cursor`. |

## Rules it keeps

- With no token it asks nothing of the service and answers `needs_login`.
- A pull never asks for more than `most_pages` pages of one conversation and `most_threads` conversations; a page that holds only what is already in `held` ends the paging (`stop_when_known`), so a pull after the first reads what is new.
- The cursor moves only when no request failed, so a conversation that failed is read again; re-reading is safe because the fold dedups by identity against `held`. A failed request is named in `errors` and never stops the others.
- Nothing is dropped without being said. A message or item with none of the fields that identify it, and a message whose conversation has no id, are left out and named in the answer's `skipped`: `[{ conversation, reason }]`, one entry for each conversation and reason, with the count in the reason (`conversation` is the conversation's id, or its name or position when it has no id, or `null`). The others are kept and the status stays `pulled`; `said` ends with how many entries were left out. Messages are kept as printed; the account's own are told by `from` equal to `self_id`, which `tools/conversations` reads.
- A message pulled twice is kept once. An edited message replaces the older copy only when its edit stamp is later (Discord: strictly later; Slack, Telegram and Signal: later or equal); a renamed conversation takes its new title; held history is never lost.
- A refused token (HTTP 401 or 403, or the service's own `ok: false`) is `needs_login`; a service that did not answer, after three more tries for a dropped connection, is `unreachable`. One 429 is waited out for the time the service names (never more than the description's limit) and tried again once.

## What is not here

- WhatsApp Web (Baileys) is not pulled: it needs a session or a local daemon, not a token for a public interface.
- Instagram by logging in as the person (instagrapi) is not a tool row yet. Its original, `do-work/connect-instagram.py` (session from held blobs, login, pull, fold, gated `direct_send` reply), is carried here byte for byte from bitfield-packages `packages/instagram-dm-connector` with the Graph producer it shares its pull with (`do-work/connect-instagram-graph.py`, `do-work/graph_instagram_client.py`: the Facebook-Login surface by `ig_user_id`, the transport retry and the page-to-fill walk) and the pure `do-work/ig_snapshot_store.py`; receipt `from-bitfield-packages-instagram-dm-connector/moved-from.json`, tests in `do-work/__tests__/` (`test_messenger_reuse.py.held` needs the package's own decoder). The instagrapi library the login needs was vendored in the package (untracked) and is not carried.

## The Signal client on this computer

Two computer-kind rows run Signal's own client, `signal-cli`, on the person's computer, and need no grant: the only person step is scanning a code once.

| Row | What it does |
|---|---|
| `tool:link-signal-on-this-computer` | A session: runs `signal-cli link` and, as soon as the address arrives, prints `{ state: "scan", link, qr_text, qr_svg }` (the QR code as text and as SVG) in the session's output; the person scans it in Signal on the phone (Settings, Linked devices, Link new device). Answers `linked` with `self_id`, or `not_linked` with why. |
| `tool:read-my-signal-messages-on-this-computer` | Runs `signal-cli -o json receive`, folds the envelopes into the contract below (`read-data/signal-envelopes.mjs`) and hands them to the `signal` pull in the same run (`input.held` is passed on). Answers the pull's answer plus `received` and `left_out`; `needs_link` (starting nothing) until the link row has run. |

Both rows declare their programs themselves in `invoke.programs`: `signal-cli` 0.14.9, the publisher's archive (pinned BLAKE3, checked against its GPG signature), and Java, the Temurin 25.0.5+8 JRE every system's pin of which is copied unchanged from old trillion's java row (trillion-rust 62d1aa7b). The engine fetches both the first time, puts their folders on the run's PATH (signal-cli's launcher finds `java` there) and lets the contained run start them. Both declare `invoke.kept_folder`, a folder the engine keeps for this tool between runs and hands in as `client_folder`: signal-cli keeps the linked account (its keys and store) there. Signal gives a linked device each message once, so what `receive` printed is written to `trillion-pending.jsonl` in that folder before it is kept, and handed in again by the next run if keeping it failed. Java reaches the internet through the run's proxy (`JAVA_TOOL_OPTIONS`, set from the run's `HTTPS_PROXY`).

How envelopes become conversations: a group is `group:<groupId>`, titled by the group name an envelope carries; a person is their service id (never a phone number), titled by the name their messages came with. A message is `<author service id>:<sent time>`, as Signal identifies it, so an edit (`editMessage.targetSentTimestamp`) lands on its message with `editedTimestamp`. The account's own messages sent from the phone arrive as sync messages and are `from` `self_id` (the account's service id, read from signal-cli's `data/accounts.json`). An offered call is a `call_started` message; receipts, typing, stories, reactions and data messages that say nothing (group or timer changes) are counted in `left_out`. `test/fixtures/signal-cli-receive.jsonl` is a made-up `receive` output and `test/signal-client.test.mjs` folds and keeps it.

## What the Signal client must hand in

The input `conversations` is a JSON list, one entry for each conversation, exactly the fields below and no others; `self_id` is the identity the account is known by. `test/fixtures/signal-client-output.json` is a made-up output in this shape, and `test/pull.test.mjs` pulls it whole and checks it holds only these fields.

| Field | Where | Meaning |
|---|---|---|
| `id` | conversation, required | the conversation's identity; a conversation without one is left out and named in `skipped` |
| `name` | conversation | its title; the id is the title when there is none |
| `type` | conversation | `group` or `individual`; kept for the client's use, not read here |
| `messages` | conversation, required | the list of messages, any order (they are kept in time order) |
| `id` | message | the message's identity; its `timestamp` stands in when there is none |
| `timestamp` | message, required without an `id` | epoch milliseconds; a message with neither is left out and named in `skipped` |
| `from` | message | who sent it: the same identity as `self_id` for the account's own messages |
| `body` | message | the text; a message without one (a call, a sticker) is kept and has no transcript text |
| `editedTimestamp` | message | epoch milliseconds of the latest edit; a later one replaces an earlier copy |
| `type` | message | `normal` or the client's own kind (`call_started`); kept as printed |

The cursor is the greatest message `timestamp` seen, in the answer; the caller hands it back as `held.cursor`. Nothing in the input is a phone number, a token or a login: the client holds its own.
- A pull is not a conversation surface; drawing the messages is a screen's job.

## Dependencies

**Depends on:** Node's standard library, `uqr` (the link row's QR code), and `tools/records-door` (packed beside this folder's files by every row: the door client and `run-an-export.mjs`). Tests need no door; `tools/records-door/test/` serves only the read row's test.

**Depended on by:** any tool that reads a pulled account through `read-data/snapshot.mjs`.
