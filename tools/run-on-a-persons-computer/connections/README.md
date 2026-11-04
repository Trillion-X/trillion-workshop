# Connections a computer carries

The message modules `computer/carry-connections.mjs` loads on a person's own computer, one per service only that computer can reach. Each is named by a row in `computer/carry-connections.json` (`module`, `export`, its own settings and words) and never by the program.

## Files

| File | Purpose |
|------|---------|
| `imessage.mjs` | iMessage through Messages on a Mac: sends with AppleScript (recipient and words passed as argv items, never inside the script) and reads recent messages from `~/Library/Messages/chat.db` opened read-only, recovering the words from `attributedBody` when the text column is empty. Ported from bitfield-packages `imessage-messages-sender` and `imessage-chatdb-decoder`. |
| `whatsapp.mjs` | WhatsApp as a linked device held open with Baileys (`@whiskeysockets/baileys`, installed in `computer/`): links once with the 8-character phone code (asked again every pairing window), reconnects on the restart codes, stops on logged out (401), sends from the person's own number and keeps the newest `keep` messages in `recent.json` beside the session. Incoming voice notes are downloaded on this computer and their original audio is kept in the person's Files; each recent-message row carries the file identity so any AI can open it. If the namespace is unavailable, a private local copy stays retryable until Trillion confirms the saved file. A half-linked session is moved aside, never deleted. Ported from bitfield-packages `whatsapp-web-connector` and `whatsapp-web-decoder`. |

## Key types / functions

| Name | Shape | Role |
|------|-------|------|
| module contract | `start() → { carried, account?, why? }`, optional `connect({ phone }) → { state, code?, expires_after_seconds?, error? }`, `send({ to, text, link }) → { sent, to, at } \| { sent: false, error }`, `read({ with, limit }) → { messages: [{ from, chat, at, text, audio? }], error? }`, optional `carried()` | What the helper calls; any other export is never run from a job. `connect` starts setup on an uncarried service; a pairing code is transient and expires. `audio` can carry `{ kind, duration_seconds?, media_type?, file_identity?, file_name?, import_error? }`; a voice note is complete when its original audio has a `file_identity`. `to: "me"` is the person's own account. |
| `imessage(settings, { run, open })` | `run(script, argv) → { code, out, err }`, `open(path) → db` | Made with osascript and `node:sqlite` by default, fakes in tests. |
| `textFromAttributedBody(blob)` / `appleTime(value)` | → string \| null / ISO \| null | The typedstream words (length byte, `0x81` two-byte, `0x82` four-byte) and a Messages date (ns since 2001). |
| `whatsapp(settings, { load, log, changed, keepFile, folder, now })` | adds `connect({ phone })`, `link({ phone, onCode })`, `adopt(folder)`, `stop()` | `connect` starts phone pairing and refreshes an expired one-time code on the next request. `keepFile({ name, bytes, media_type })` stores original voice-note audio; its `readCached(name)` reads the private local retry copy. The optional `folder` keeps tests and disposable proofs isolated. `changed()` tells the helper to publish its card again when WhatsApp opens or drops. |
| `audioOf(message)` / `voiceNoteName(item)` / `importVoiceNote(item, { download, keepFile, readCached })` | → audio facts / filename / saved-file reference | The source adapter's generic message shape; failed uploads remain retryable from their local audio until the saved-file identity is confirmed. |
| `jidFor(to, self)` / `wordsOf(message)` | → jid \| null / string \| null | A WhatsApp address from "me", a phone number or a jid; the words of any message kind that carries them. |

## Dependencies

**Depends on:** `osascript` and `node:sqlite` (iMessage), `@whiskeysockets/baileys` from `computer/package.json` (WhatsApp).
**Depended on by:** `computer/carry-connections.mjs`, `test/carry-connections-modules.test.mjs`.
