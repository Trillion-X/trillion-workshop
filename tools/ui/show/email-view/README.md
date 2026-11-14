# ui/email-view

One email drawn the way an email client's reading pane draws it: subject and preview line, sender and date, who it went to, then the body as a formatted document.

## Files

| File | Purpose |
|------|---------|
| `EmailView.tsx` | The reading pane: subject heading with the preview line, sender (initials from `person-tag`) with the date on the right, To / each kind of copy / Reply to rows, the body read by the one markdown renderer (`document-page` `markdownHtml`) and drawn in `markdown-block` MarkdownBlock, the caller's actions beside the subject, and the caller's `footer` row under the body. |
| `EmailThread.tsx` | A conversation in the order it happened: one quiet row per message (sender with initials, date, the line it starts with) and the caller's own node (an `EmailView` card) for the open one. Picking a row asks the caller to open it. |
| `index.ts` | Barrel export. |
| `README.md` | This file. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|------------------|------|
| `EmailView` | `(props: EmailViewProps) => JSX.Element` | Draws one email. |
| `EmailViewProps` | `{ subject; from; to: string[]; replyTo?; copies?: EmailCopy[]; preheader?; sentAt? (ISO); bodyMarkdown?; bodyText?; actions?: ReactNode; footer?: ReactNode; noBody? }` | The email's parts; `bodyMarkdown` wins over `bodyText`; `actions` are the caller's buttons; `footer` is a row of them inside the message under the body (reply, forward, a menu). |
| `EmailThread` | `(props: { entries: EmailThreadEntry[]; onOpen; earlier?; note?; label }) => JSX.Element` | Draws a conversation; the entry with `content` is the open message. |
| `EmailThreadEntry` | `{ id; from; sentAt?; preview?; unread?; content? }` | One message of the conversation. |
| `EmailCopy` | `{ to: string; how: string }` | One copy beyond the To line; `how` names its kind (cc, bcc, or any other). |
| `emailAddressRows` | `(props: { to; replyTo?; copies? }) => { label; values }[]` | The address rows in reading order (To, each copy kind in the order first met, Reply to), empty rows left out. |
| `copyRowLabel` | `(how: string) => string` | A copy row's name from its own `how` ("cc" -> "Cc"). |

## Dependencies

**Depends on:** `../container`, `../text`, `../person-tag`, `../markdown-block/MarkdownBlock`, `../document-page/document-page-html.mjs` (`markdownHtml`); look from `parts/screen-look/show/file-preview.css` (`.file-preview-markdown`, `.file-preview-link`).

**Depended on by:** `tools/calendar/web/src/workspace/email-screen.tsx` (the open Gmail conversation); `../record-views/open-views.tsx` (the `email` open view, used by Sent and any record set whose kind rows name `email`).

## Invariants

1. Shared parts only; no markup written here.
2. A raw HTML body is never framed or run: the body is drawn from markdown or plain words, and raw HTML in them shows as text.
3. Domain-blind: no sender, product or reason is named; copy kinds come from the data.

## References

Plain's thread message, sender line with to/from under the subject and the body in its own panel (mobbin.com/screens/6b03543c-d8bd-403c-a3eb-3c43783a0a23); Calendly's sent email, sender, To row and the date on the right (mobbin.com/screens/e4c1b45c-1f6d-456c-ba0d-ffd1b09fe681). 21st.dev search "email reader pane" had no reading-pane component; original code.
