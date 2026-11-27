# tools/reply-by-keyword-rule/

Automatic replies to what people send or comment on the person's connected places, by keyword rule, ManyChat-style, on
the person's own connected account. One tool decides which reply to send now; each place has a send row that sends one
chosen reply once. A place is a row of `read-data/reply-places.json` (where its items are pulled from, whose words are
the person's own, how long a reply is allowed, who it goes to, and the request that sends it); Instagram and YouTube
are two such rows, and a place the code has never heard of is one more row and one send row that holds its connection.
Nothing in `do-work/` or `read-data/*.mjs` names a place (a test reads every file to prove it).

The rules are the person's own `reply-rule` records (a list of rows, handed in as `rules` and applied in their `order`): `{ id, enabled: 'on' | 'off', words, mode:
'any' | 'all', reply, order }`. `reply` is a template filled by `tools/reply-templates`. Nothing in this folder names a
keyword, a customer or an account.

## Why not an open-source ManyChat clone

The open-source ManyChat alternatives found (diwenne/openreply under MIT, demogar/conversa, the insta-p8 forks,
ilramdhan/auto-dm, lakpriya1s/hushreply under AGPL-3.0) are each a self-hosted web server. It receives Meta's webhooks,
keeps its own database and holds the Meta token itself. A GitHub tool row runs on the person's computer for one command
and cannot host a public webhook or keep a token outside the vault, so none is adopted. The decision is recorded in the
Workshop decision engine (candidate:1: a generic rule tool on the existing Meta connection).

## Windows and places (the place rows, enforced in `read-data/reply-rules.mjs`)

| Place, channel | Reply allowed while | Recipient |
|----------------|---------------------|-----------|
| Instagram, `dm` | less than 24 hours since the other person's last message (only the latest message of a thread is answered) | `recipient.id` (the person's account id) |
| Instagram, `private-reply` | less than 7 days since the comment, once per comment | `recipient.comment_id` |
| YouTube, `comment` | no window (`window_ms: null`); once per comment through the reply key | the comment's thread id, as the request's `parentId` |

The window is checked when a reply is chosen and again when it is sent. Every place's items are handed to the decide row by channel id in `pulled`: Instagram's are the threads the person's pulls
kept (read by their AI), YouTube's are the answers of `tool:read-youtube-comments` as `pulled.comment`. The person's own id at
the place (their pulled account id, or YouTube's channel id from their connection) is handed in as `self_id`.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:decide-the-replies` | For one place (`place`, a row id) chooses the reply to send now for each item, with the reason for each skip (window closed, already sent, no rule matches, the item is the person's own, no recipient). Takes `rules`, `pulled`, `self_id` and `kept` in the request; reads, sends and keeps nothing | none |
| `tool:pull-my-instagram-comments` (in `tools/pull-from-connected-accounts`) | Pulls the comments on each post of the Instagram account into the `instagram-comments` snapshot | the held token; `account-snapshot-part` |
| `tool:send-a-reply-on-instagram`, `tool:send-a-reply-on-youtube` | Send one chosen reply (a decision whose action is send) as its place row's request says, to the place row's hosts only, the window checked again first. A key among the `kept` rows given is never sent; the answer holds the `reply-kept` row (`sent`, `failed` or `not-known`) for the person's AI to keep, and a reply with no answer is `not-known` and never retried | the held access token on descriptor 4 |

`reply-kept` rows are keyed by place and reply key (`<message id>:<rule id>`), one per reply, with `state`: `sent`, `failed`
or `not-known`. The send row answers it as `keep`; the person's AI keeps it and hands the rows it holds back in `kept`.

## Files

| File | Purpose |
|------|---------|
| `read-data/reply-places.json` | One row per place: connection vendor, send row, own-id rule, hosts, and each channel's pull, field paths, window, recipient and request. |
| `read-data/reply-rules.mjs` | Pure: `normalise`, `ruleMatches`, `pick`, `fill`, `windowOpen`, `itemsOf`, `chooseReplies`, `checkSend`. |
| `do-work/decide-the-replies.mjs` | `decideTheReplies`, the decide row's export (reads nothing: its request holds everything). |
| `do-work/send-a-reply.mjs` | `sendAReply`, every send row's export. |
| `what-this-tool-does-and-how-to-run-it.json` | The three rows. |
| `test/reply-rules.test.mjs` | The rules, the windows, the template and a place made up in the test, against made-up messages. |
| `test/decide-and-send.test.mjs` | Decide and send with no records door and a fake answer; a closed window sends nothing; a key among the kept rows is sent once; an unknown outcome is not retried; a place the code has never heard of is one row; no code file names a place. |

## Gaps

- The `reply-rule` and `reply-kept` record kinds need their list definitions in the person's Trillion lists before
  a live rule can be written.

## Dependencies

**Depends on:** `tools/reply-templates` (the reply text), `tools/pull-from-connected-accounts` (the pulled threads and
the snapshot key segments), `tools/records-door` (the export command that runs each row), each place's connection (held access token on descriptor 4). Node 24 only.

YouTube's reply request (`comments.insert`) has not been run against the live service; its row is proved against a made-up answer only.
