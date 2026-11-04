# tools/send-messages/

The person's AI sends a message to one person or a list: an email (Amazon SES or Resend), a text (Twilio) or a Messages message from the person's own Mac, through the provider the person chooses. An email can be written from a template, and a document the person wrote can first be turned into the message body. Each recipient is sent to on their own and answered on their own, so one bad address never hides the others. And it keeps who agreed to get which emails: a signed-up email course (consent, queued lessons, unsubscribe), a one-update interest list, and a read-back of every consent.

Six packages did this one job and are merged here, ported from bitfield-packages: `broadcast-delivery` (Amazon SES, Resend and Twilio, to a list), `resend-email-sender` (one templated email, thread headers, retry key), `imessage-messages-sender` (Messages on the Mac), `composition-mail-serializer` (a document into a body) and `myletter-newsletter` (consent for email courses and update lists). The consent half sends its lessons through the sending half, which is why they share a folder.

The provider's key arrives on a private pipe (the row's `credential_mounts`, one descriptor per key) and goes to the one adapter process in its environment. It is never in the request, an argument, a file, a record or the answer. No sender is assumed: an email row's email comes from the account's own mail row, which ships with none, so an account sends nothing until it names its sender; a lesson has its course's `from`, and a template used with none is refused. Nothing is sent to a person without a recorded consent where a consent applies: a lesson is sent only while the subscription is active, and once.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:send-an-email-with-amazon-ses` | An email to a list through the person's SES account, under the account's mail rules (`do-work/mail-sender.mjs`) | container, internet, records door (`mail-settings`, `mail-sent`, `mail-day`), keys `amazon-ses-access-key-id` and `amazon-ses-secret-access-key` |
| `tool:send-an-email-with-resend` | An email to a list through the person's Resend account, from words, markdown (a written email) or a template, with thread headers and a retry key, under the account's mail rules (`do-work/mail-sender.mjs`) | container, internet, records door (`mail-settings`, `mail-sent`, `mail-day`), key `resend-api-key` |
| `tool:send-a-text-with-twilio` | A text message to a list of numbers through the person's Twilio account | container, internet, key `twilio-auth-token` |
| `tool:send-a-message-on-this-mac` | A Messages message from the person's own Mac, failing closed with what to allow when macOS refuses | `computer` row holding `use-the-messages-app` |
| `tool:write-a-message-body-from-a-document` | A document's nodes into `{ body_html, body_text, inline_refs, degraded }` | on the person's computer, Python |
| `tool:sign-someone-up-for-an-email-course-with-resend` / `-with-amazon-ses` | Records a person's consent to an email course, queues the later lessons, sends lesson 1; signing up again sends nothing twice | container, records door, the provider's keys on descriptors 4 and up |
| `tool:send-due-email-lessons-with-resend` / `-with-amazon-ses` | Sends each queued lesson whose time has come to the people still signed up, once each; a failed send queues its own retry (up to three) | container, records door, keys as above |
| `tool:save-interest-in-an-email-update` | Keeps a person's consent to one email if a course becomes available; sends nothing | container, records door, no key |
| `tool:stop-an-email-course` | Ends a subscription from the token in the unsubscribe link | container, records door, no key |
| `tool:pace-sends-from-an-inbox` | When each address may be emailed from one sending inbox: a ramp of sends a day, the least gap, the weekdays and local hours, how long to leave an address, and a pause when the last sends bounce or draw a complaint; answers due now, a schedule and who is held and why | container, no internet, no key |
| `tool:sort-bounces-and-replies` | What each bounce, complaint, unsubscribe, auto-reply and reply that came back means, by outcome rows over a provider's events or the mailbox's messages: which addresses to suppress, which to retry, who wrote back | container, no internet, no key |
| `tool:who-agreed-to-get-which-emails` | Everyone with a consent: who, which list, when, in what words, whether they still agree, and the addresses that can be sent to now | container, records door (read only), no key |

Pacing and what comes back are DATA in `read-data/inbox-pacing.json`: a pacing row (`new-inbox-warmup`, `saturday-local`, or the person's own) is a ramp, a gap, weekdays, local hours, days to leave an address and a pause rule; an event-source row says where the recipient, type, status, subject, text and time sit in one provider's event (Resend, Amazon SES, a mailbox message, or plain); an outcome row says when it applies (every condition on a field: `equals`, `matching` or `pattern`) and what it means (a kind) and asks (an action: suppress, stop-sequence, retry-later, hand-to-person, none). The first outcome row that applies wins. When one address has several outcomes, the strongest action holds (the actions are listed strongest first), so an out-of-office after a reply, or a delay notice after a hard bounce, never puts the address back; a retry-later outcome holds the address until its `retry_at` and is then sent again once. Local dates, weekdays and hours are read through `tools/wall-time`, the one wall-clock reader. A new provider, rule or pace is a row, never code. Neither tool sends: the planner's `due_now` goes to a send tool, and the sorter's `outcomes` go back to the planner, which then holds the bounced, unsubscribed and replied.

A new provider is one row in `read-data/message-providers.json` (its settings, its keys, and either an adapter script or a command) and one row in `tool-rows.json`.

The consent records (`email-course-subscription`, `email-course-token`, `email-course-interest`, `contact-point`, `email-lesson-due`) are kept in the person's own records. A subscription holds the contact's id, not the address. Nothing wakes the lesson runner yet: the person's AI (or a wake the engine declares for `tool:send-due-email-lessons-*`) runs it.

## Files

| File | Purpose |
|------|---------|
| `do-work/mail-sender.mjs` | The mail rules every email row runs under, moved from the older owner's mail sender: the sender only from the account's mail row (`mail-settings` record `settings:mail`, copied from `read-data/mail-settings.json` the first time), every email written down under its address (`mail-sent` records) and limited per person and kind, a proof address never handed to a provider, the day's allowance (`mail-day` records) with room kept for sign-in codes, a refusal before dispatch giving its allowance back and any other failure kept as unknown and never sent again blindly, a written email's BCC copy to the account's own address and its sent copy, and subscription headers. The allowance is taken before the provider is asked, in one records write conditioned on what was read. `mailSender`, `bindingFor`, `sendAnEmail`, `mailSettings`, and the command the email rows run. |
| `do-work/send-a-message.mjs` | The sending seam. Picks the provider's row, checks the request, hands the adapter its keys, answers per recipient. `sendMessage`, `sendOnThisMac` (the computer row's export), and the command that reads the request on standard input and each key from its descriptor. |
| `do-work/keep-who-agreed.mjs` | The consent seam: gives the course logic its reads, batch writes, contact points and queued lessons from the person's records, and sends through the sending seam. Exports for each consent tool. |
| `do-work/send-via-resend.cjs` | Resend adapter (from `broadcast-delivery`), with the custom headers and retry key the single-email sender had. |
| `do-work/send-via-twilio-sms.cjs` | Twilio text adapter (from `broadcast-delivery`), unchanged. |
| `do-work/send-via-amazon-ses.cjs` | Amazon SES adapter: the same SendEmail call over HTTPS signed with Signature Version 4, in place of the package's 1.2 MB bundled SDK. |
| `do-work/composition_mail_serializer.py` | Document nodes into a message body (from `composition-mail-serializer`), unchanged. |
| `read-data/email-course.mjs` | Consent for email courses and update lists (from `myletter-newsletter`'s `email-course.mjs`): validates the agreement, keeps pending interest or active course state, schedules and delivers lessons through targets it is handed. |
| `read-data/render-a-message.ts` | Picks a template by name and fills its `{{key}}` words, escaping HTML (from the email sender's `render-email.ts`). |
| `read-data/render-a-send.ts` | Builds the command for a program on the person's computer from DATA, with the body as its own argument (from `render-send.ts`). |
| `read-data/check-message-headers.ts` | Bounded custom headers: names limited, no line breaks, 4 KiB (from the email sender's request checks). |
| `read-data/message-providers.json` | The providers: settings from the request, keys by secret name and descriptor (an email provider's keys come after the records door's descriptor 3), adapter or command. |
| `read-data/draw-an-email.mjs` | Draws one email in a look, moved from the older owner's markdown reader and email part (`document-page-html.mjs` `markdownBlocks`, `markdownText`, `emailMessageHtml`) and its mail sender's palette (`solidColour`, `emailPalette`, `currentPalette`, `drawEmail`): the words as html and as text, the action in the look's button, see-through colours laid over the paper, the account's mark and made-with line. A look that cannot be read sends nothing (`BRAND_UNREAD`); before any look is published the shipped look is worn. |
| `read-data/email-look.json` | Which look variable each part of an email wears (ink, accent, paper, faces, corners, button depth), the shipped look's values for them, and the words for a look that cannot be read. |
| `read-data/mail-settings.json` | The mail row an account starts with (no sender, no postal address: the account names its own): per-person limits by kind, the sent log, proof addresses, the day's allowance and keep-back, and how each email provider's refusals read (`providers`: its error code, the codes refused before dispatch, the code saying its day is full). |
| `read-data/inbox-pacing.json` | The pacing rows, event-source rows, outcome rows, and the closed lists of kinds and actions they may name. |
| `read-data/inbox-pacing.mjs` | `planSends`, `sortOutcomes`, `eventFields` and the row checks `pacingProblems`, `outcomeRowProblems`, `eventSourceProblems`. |
| `do-work/pace-an-inbox.mjs` | The command of both pacing rows: `plan` or `sort` in argv, JSON in, `{ result }` or `{ error }` out. |
| `read-data/message-templates.json` | Two sample templates (a sign-in link, a welcome). They carry no sender. |
| `tool-rows.json` | The fourteen rows. |
| `part.json` | Nothing here is imported by other code. |
| `test/` | `render-a-message.test.mjs` (the email sender's render and template cases), `send-a-message.test.mjs` (the adapters with a stand-in fetch, the Messages cases, the keys), `composition-mail-serializer.test.mjs` with `test_composition_mail_serializer.py`, `email-course.test.mjs` (the consent package's own cases), `keep-who-agreed.test.mjs` (the consent logic through the records door with each row's rights), `mail-sender.test.mjs` (the older owner's mail sender, per-person limit and admission cases through the records door: limits, codes without subjects, proofs, the day, refused against unknown, two sends racing, the sender from the row, written email and its BCC, subscription headers, the email rows; every email drawn in the worn look, a look that cannot be read sending nothing and the shipped look before any is published, every markdown block drawn, a sign-in code's plain words drawn, a caller's own html kept), `inbox-pacing.test.mjs` (the ramp, gap, days and hours in a time zone, held addresses, the pause, each event source and outcome row, rows added only as DATA, both commands), `stub-fetch.mjs` (the stand-in fetch). |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `sendMessage` | `(request, { providerId, credentials }) -> { provider, sent: [{ recipient, messageId? , error? }], said }` | Sends to each recipient and answers each. |
| `MessageBlockedError` | `code: 'blocked_needs_grant'` | The Mac refused the Automation event; the message says what to allow. |
| `planSends` | `({ pacing \| pacing_row, time_zone, recipients, now?, first_send_at?, history?, outcomes?, suppressed? }) -> { pacing, time_zone, paused, due_now, schedule: [{ recipient, at, local, day }], held: [{ recipient, why }], said }` | When each address may be sent to from one inbox. |
| `sortOutcomes` | `({ events, event_source? \| event_source_row, outcome_rows?, now? }) -> { event_source, outcomes: [{ recipient, rule, kind, action, says, at?, retry_at? }], suppress, stop, retry, replies, unmatched, said }` | What each event that came back means. |
| `buildEmailMessage` | `(template, variables, override?) -> { from, subject, html, text }` | An override merges over the template field by field; no `from` is a refusal. |
| `buildSendInvocation` | `(provider, { recipient, body }) -> { argv, timeout_ms, success_stdout_marker, ... }` | The command for a program on the computer. |
| `readCustomHeaders` | `(object) -> object` | Refuses a bad name, a line break or a value over 4 KiB. |
| `createPublicEmailCourse` | `({ readCurrent, writeBatch, invokeTarget, now, mintToken }) -> { enroll, captureInterest, deliver, unsubscribe }` | The consent logic; every outside need is handed in. |
| `makeCourse` | `({ door, send }) -> the same` | The logic wired to the person's records and a sender. |

## Dependencies

**Depends on:** Node's standard library, `@noble/hashes` (BLAKE3, packed at `/opt/node_modules/@noble/hashes` by the consent rows), Python 3 for the serializer, and for the computer row and the consent rows `tools/records-door` (`run-an-export.mjs` and the door client). The pacing planner reads local time through `tools/wall-time/read-data/wall-time.mjs`. The Mac row needs the Mac's `osascript`.

**Depended on by:** the outreach recipes in `tools/workflows/recipes/workflows.json`, whose pace, send and outcome steps name these rows.

## Limits

The email rows draw in the shipped look (`read-data/email-look.json` `shipped_palette`). The account's worn look is read by `tools/screen-looks` from the app owner's look DATA, which a sending row is not given, so the rows pass no `readLook`; `mailSender` takes one for a caller that holds it.

The records door has no compare-and-swap. The consent logic expects one on a write; `keep-who-agreed.mjs` reads the record just before writing and refuses a write whose expected state changed, which closes the race to the width of one read-then-write. Two sign-ups of the same person at the same instant can still both pass that read; the second then replaces the first's token, and the first's unsubscribe link stops working. A compare-and-swap on `records:write` in the engine would close it.
