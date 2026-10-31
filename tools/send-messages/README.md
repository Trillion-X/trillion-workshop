# tools/send-messages/

The person's AI sends a message to one person or a list: an email (Amazon SES or Resend), a text (Twilio) or a Messages message from the person's own Mac, through the provider the person chooses. An email can be written from a template, and a document the person wrote can first be turned into the message body. Each recipient is sent to on their own and answered on their own, so one bad address never hides the others. And it keeps who agreed to get which emails: a signed-up email course (consent, queued lessons, unsubscribe), a one-update interest list, and a read-back of every consent.

Six packages did this one job and are merged here, ported from bitfield-packages: `broadcast-delivery` (Amazon SES, Resend and Twilio, to a list), `resend-email-sender` (one templated email, thread headers, retry key), `imessage-messages-sender` (Messages on the Mac), `composition-mail-serializer` (a document into a body) and `myletter-newsletter` (consent for email courses and update lists). The consent half sends its lessons through the sending half, which is why they share a folder.

The provider's key arrives on a private pipe (the row's `credential_mounts`, one descriptor per key) and goes to the one adapter process in its environment. It is never in the request, an argument, a file, a record or the answer. No sender is assumed: an email has the `from` the person gives, and a template used with none is refused. Nothing is sent to a person without a recorded consent where a consent applies: a lesson is sent only while the subscription is active, and once.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:send-an-email-with-amazon-ses` | An email to a list through the person's SES account | container, internet, keys `amazon-ses-access-key-id` and `amazon-ses-secret-access-key` |
| `tool:send-an-email-with-resend` | An email to a list through the person's Resend account, from words or a template, with thread headers and a retry key | container, internet, key `resend-api-key` |
| `tool:send-a-text-with-twilio` | A text message to a list of numbers through the person's Twilio account | container, internet, key `twilio-auth-token` |
| `tool:send-a-message-on-this-mac` | A Messages message from the person's own Mac, failing closed with what to allow when macOS refuses | `computer` row holding `use-the-messages-app` |
| `tool:write-a-message-body-from-a-document` | A document's nodes into `{ body_html, body_text, inline_refs, degraded }` | on the person's computer, Python |
| `tool:sign-someone-up-for-an-email-course-with-resend` / `-with-amazon-ses` | Records a person's consent to an email course, queues the later lessons, sends lesson 1; signing up again sends nothing twice | container, records door, the provider's keys on descriptors 4 and up |
| `tool:send-due-email-lessons-with-resend` / `-with-amazon-ses` | Sends each queued lesson whose time has come to the people still signed up, once each; a failed send queues its own retry (up to three) | container, records door, keys as above |
| `tool:save-interest-in-an-email-update` | Keeps a person's consent to one email if a course becomes available; sends nothing | container, records door, no key |
| `tool:stop-an-email-course` | Ends a subscription from the token in the unsubscribe link | container, records door, no key |
| `tool:who-agreed-to-get-which-emails` | Everyone with a consent: who, which list, when, in what words, whether they still agree, and the addresses that can be sent to now | container, records door (read only), no key |

A new provider is one row in `read-data/message-providers.json` (its settings, its keys, and either an adapter script or a command) and one row in `tool-rows.json`.

The consent records (`email-course-subscription`, `email-course-token`, `email-course-interest`, `contact-point`, `email-lesson-due`) are kept in the person's own records. A subscription holds the contact's id, not the address. Nothing wakes the lesson runner yet: the person's AI (or a wake the engine declares for `tool:send-due-email-lessons-*`) runs it.

## Files

| File | Purpose |
|------|---------|
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
| `read-data/message-providers.json` | The providers: settings from the request, keys by secret name and descriptor, adapter or command. |
| `read-data/message-templates.json` | Two sample templates (a sign-in link, a welcome). They carry no sender. |
| `tool-rows.json` | The twelve rows. |
| `part.json` | Nothing here is imported by other code. |
| `test/` | `render-a-message.test.mjs` (the email sender's render and template cases), `send-a-message.test.mjs` (the adapters with a stand-in fetch, the Messages cases, the keys), `composition-mail-serializer.test.mjs` with `test_composition_mail_serializer.py`, `email-course.test.mjs` (the consent package's own cases), `keep-who-agreed.test.mjs` (the consent logic through the records door with each row's rights), `stub-fetch.mjs` (the stand-in fetch). |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `sendMessage` | `(request, { providerId, credentials }) -> { provider, sent: [{ recipient, messageId? , error? }], said }` | Sends to each recipient and answers each. |
| `MessageBlockedError` | `code: 'blocked_needs_grant'` | The Mac refused the Automation event; the message says what to allow. |
| `buildEmailMessage` | `(template, variables, override?) -> { from, subject, html, text }` | An override merges over the template field by field; no `from` is a refusal. |
| `buildSendInvocation` | `(provider, { recipient, body }) -> { argv, timeout_ms, success_stdout_marker, ... }` | The command for a program on the computer. |
| `readCustomHeaders` | `(object) -> object` | Refuses a bad name, a line break or a value over 4 KiB. |
| `createPublicEmailCourse` | `({ readCurrent, writeBatch, invokeTarget, now, mintToken }) -> { enroll, captureInterest, deliver, unsubscribe }` | The consent logic; every outside need is handed in. |
| `makeCourse` | `({ door, send }) -> the same` | The logic wired to the person's records and a sender. |

## Dependencies

**Depends on:** Node's standard library, `@noble/hashes` (BLAKE3, packed at `/opt/node_modules/@noble/hashes` by the consent rows), Python 3 for the serializer, and for the computer row and the consent rows `tools/records-door` (`run-an-export.mjs` and the door client). The Mac row needs the Mac's `osascript`.

**Depended on by:** nothing.

## Limits

The records door has no compare-and-swap. The consent logic expects one on a write; `keep-who-agreed.mjs` reads the record just before writing and refuses a write whose expected state changed, which closes the race to the width of one read-then-write. Two sign-ups of the same person at the same instant can still both pass that read; the second then replaces the first's token, and the first's unsubscribe link stops working. A compare-and-swap on `records:write` in the engine would close it.
