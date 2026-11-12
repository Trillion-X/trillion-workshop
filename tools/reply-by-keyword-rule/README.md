# tools/reply-by-keyword-rule/

Automatic replies to the person's Instagram direct messages and comments, by keyword rule, ManyChat-style, on the
person's own connected account. Two tools: one decides which reply to send now, the other sends one chosen reply once.

The rules are the person's own `reply-rule` records (a list of rows, read in their `order`): `{ id, enabled: 'on' | 'off', words, mode:
'any' | 'all', reply, order }`. `reply` is a template filled by `tools/reply-templates`. Nothing in this folder names a
keyword, a customer or an account.

## Why not an open-source ManyChat clone

The open-source ManyChat alternatives found (diwenne/openreply under MIT, demogar/conversa, the insta-p8 forks,
ilramdhan/auto-dm, lakpriya1s/hushreply under AGPL-3.0) are each a self-hosted web server. It receives Meta's webhooks,
keeps its own database and holds the Meta token itself. A GitHub tool row runs on the person's computer for one command
and cannot host a public webhook or keep a token outside the vault, so none is adopted. The decision is recorded in the
Workshop decision engine (candidate:1: a generic rule tool on the existing Meta connection).

## Meta windows (enforced in `read-data/reply-rules.mjs`)

| Reply | Allowed while | Recipient |
|-------|---------------|-----------|
| Direct message | less than 24 hours since the other person's last message | `recipient.id` (the person's account id) |
| Private reply to a comment | less than 7 days since the comment, once per comment | `recipient.comment_id` |

Only the latest message of a thread is answered, and only when the other person wrote it. The window is checked when
a reply is chosen and again when it is sent.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:decide-the-instagram-replies` | Chooses the reply to send now for each latest direct message and each pulled comment, with the reason for each skip (window closed, already sent, no rule matches, latest message or comment is the person's own). Sends nothing | read and list `reply-rule`, `account-snapshot-part` (the pulled `instagram-messages` and `instagram-comments` threads), `instagram-reply` |
| `tool:pull-my-instagram-comments` (in `tools/pull-from-connected-accounts`) | Pulls the comments on each post of the Instagram account into the `instagram-comments` snapshot, one thread per post | the held token; `account-snapshot-part` |
| `tool:send-an-instagram-reply` | Sends one chosen reply (a decision whose action is send) to graph.instagram.com, the window checked again first. The reply is kept before it leaves; a reply with no answer is kept `not-known` and never retried | read and write `instagram-reply`; the held access token on descriptor 4 |

`instagram-reply` records are keyed by reply key (`<message id>:<rule id>`), one per reply, with `state`: `sending`,
`sent`, `failed` or `not-known`.

## Files

| File | Purpose |
|------|---------|
| `read-data/reply-rules.mjs` | Pure: `normalise`, `ruleMatches`, `dmWindowOpen`, `privateReplyOpen`, `chooseReplies`, `checkSend`. |
| `do-work/decide-the-replies.mjs` | `decideTheReplies`, the decide row's export (reads the records door). |
| `do-work/send-an-instagram-reply.mjs` | `sendAnInstagramReply`, the send row's export. |
| `tool-rows.json` | The two rows. |
| `test/reply-rules.test.mjs` | The rules and both windows, against made-up messages. |
| `test/decide-and-send.test.mjs` | Decide and send against a fake records door and a fake Meta answer; a closed window sends nothing; a key is sent once; an unknown outcome is not retried; a private reply goes to the comment id. |

## Gaps

- The `reply-rule` and `instagram-reply` record kinds need their list definitions in the person's Trillion lists before
  a live rule can be written.

## Dependencies

**Depends on:** `tools/reply-templates` (the reply text), `tools/pull-from-connected-accounts` (the pulled threads and
the snapshot key segments), `tools/records-door` (the run's records), the Meta connection (`instagram` vendor, held
access token on descriptor 4). Node 24 only.
