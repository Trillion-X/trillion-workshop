# tools/pull-from-connected-accounts/

Pulls a person's messages and saved items from the services they use into their own records, so their AI can read them in one place. One mechanism runs every service; what differs between services is one JSON description each in `read-data/sources/`: where the service is, how a token is presented, which requests list the conversations and fetch their messages, how a list is paged, which field is an item's identity and which stamp says an edit is newer. Adding a service is one description and one row, never new code.

| Service (`source`) | What is pulled | Held token name |
|---|---|---|
| `discord` | the text and announcement channels a bot can read, in every server it is in | `discord-bot-token` |
| `slack` | the public channels a bot is a member of | `slack-bot-token` |
| `telegram` | the messages a bot was sent, by chat | `telegram-bot-token` |
| `instagram-messages` | the direct-message conversations of an Instagram professional account (messaging API) | `instagram-access-token` |
| `messenger-messages` | the Messenger conversations of a Facebook Page | `messenger-page-access-token` |
| `x-bookmarks` | the posts the person bookmarked on X | `x-access-token` |
| `pinterest-pins` | the pins and boards of a Pinterest account | `pinterest-access-token` |

The token arrives on a private pipe (descriptor 4) from the person's held values and is only ever in the request; it is scrubbed from every sentence the tool prints and is never written to the records. A person's own mail, texts and chats that need a logged-in session or a local daemon (WhatsApp Web, Signal, Instagram by login) are not here: see "What is not here".

## Where the pull is kept

Everything is kept in the person's own records through the records door, one record of kind `account-snapshot-part` per part, so a re-pull reads only the parts it needs and rewrites only the parts that changed. Messages and items are kept exactly as the service sent them.

| Record id | Value |
|---|---|
| `account-snapshot:<source>:<account>:state` | `{ kind: "state", self_id, cursor, pulled_at }` |
| `account-snapshot:<source>:<account>:thread:<thread id>` | `{ kind: "thread", seq, thread: { id, title, messages: [...], source? } }` |
| `account-snapshot:<source>:<account>:item:<collection>:<item id>` | `{ kind: "item", seq, collection, identity, item }` |

A conversation is one record, so one with a very large number of messages is one large record; `most_pages` and `limit` bound what a single pull adds. `account` is a name the person gives (default `default`); an id segment keeps letters, digits and `. _ @ -` and writes every other byte as `~` and two hex digits. `seq` is the order a part was first seen in. `read-data/snapshot.mjs` is this folder's public part: `readParts(door, source, account)` and `assemble(source, account, parts)` give any other tool the account as one snapshot, `{ source, account, self_id, cursor, threads: [{ id, title, messages, source? }], collections: { <name>: [...] } }`, the same shape for every service. A conversation that has a description of its own at the service (an Instagram or Messenger conversation's participants) keeps it in `source`.

## Files

| File | Purpose |
|------|---------|
| `do-work/pull.mjs` | `pullFromAnAccount(source, input, context)` and one export per service (`pullDiscord`, `pullSlack`, ...). Reads the token, asks who it belongs to, walks the description's requests, folds, writes changed parts and the state. |
| `do-work/read.mjs` | `readPulledSnapshot`: the conversations and collections held for an account, or one conversation's messages. Changes nothing. |
| `read-data/sources/*.json` | One service each: `base`, `auth` (`header` with a name and prefix, or `path` with a template), `headers`, `identity`, `failure`, `rate_limit`, `cursor`, `walks` (each walk is a list of request levels and a `fold`). `messenger-messages.json` extends `instagram-messages.json`. |
| `read-data/sources.mjs` | `loadSource(id)` (resolves `extends`, refuses a description that cannot be pulled) and `sourceIds()`. |
| `read-data/fold.mjs` | The one pure fold: dedup by identity, order, and the three conflict policies (`keep`, `newer`, `merge`). |
| `read-data/pointer.mjs` | JSON-pointer reads and the small value expressions a description uses. |
| `read-data/snapshot.mjs` | Record ids, `readParts` and `assemble`. Public (`part.json`). |
| `tool-rows.json` | Seven pull rows and `tool:read-what-i-pulled-from-an-account`. |
| `test/` | Fold, pointer, source and row tests, and every service pulled against a stand-in in the shape the service documents. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `pullFromAnAccount` | `(source, { account?, limit?, most_pages?, most_threads? }) -> { status, new_messages, new_items, cursor, errors, said, ... }` | One pull. `status` is `pulled`, `partial` (some requests failed, named in `errors`), `needs_login` (no token, or the service refused it) or `unreachable`. |
| `foldItems` | `(held, arriving, policy) -> { items, added, changed }` | Held and arriving copies, once per identity, in order; nothing passed in is changed. |
| source description | `{ id, base, auth, identity, walks: [{ levels: [{ path, query, items, keep, bind, page }], fold }] }` | Everything that differs between services. A level's `bind` names values later paths use (`{channel}`), `page` is `{ param, next }` or `{ param, from_last }`, `fold` is `{ layout: threads \| items, key, signature, order, conflict, stop_when_known }`. |
| `cursor` | `{ start, advance: { over: raw \| records, by, plus } }` | Where the next pull starts (Slack `oldest`, Telegram `offset`), kept in the state record. |

## Rules it keeps

- With no token it asks nothing of the service and reads and writes no record.
- A pull never asks for more than `most_pages` pages of one conversation and `most_threads` conversations; a page that holds only what is already held ends the paging (`stop_when_known`), so a pull after the first reads what is new.
- The cursor moves only when no request failed, so a conversation that failed is read again; re-reading is safe because the fold dedups by identity. A failed request is named in `errors` and never stops the others.
- A message pulled twice is kept once. An edited message replaces the older copy only when its edit stamp is later (Discord: strictly later; Slack and Telegram: later or equal); a renamed conversation takes its new title; an earlier pull's history is never lost.
- A refused token (HTTP 401 or 403, or the service's own `ok: false`) is `needs_login`; a service that did not answer, after three more tries for a dropped connection, is `unreachable`. One 429 is waited out for the time the service names (never more than the description's limit) and tried again once.

## What is not here

- WhatsApp Web (Baileys), Signal (signal-cli) and Instagram by logging in as the person (instagrapi) are not pulled: each needs a session or a local daemon, not a token for a public interface. Signal's connector asked `signal-cli` for a `listConversations` command that does not exist.
- A pull is not a conversation surface; drawing the messages is a screen's job.

## Dependencies

**Depends on:** Node's standard library and `tools/records-door` (packed beside this folder's files by every row: the door client and `run-an-export.mjs`). Tests import `tools/records-door/test/` for the stand-in door.

**Depended on by:** any tool that reads a pulled account through `read-data/snapshot.mjs`.
