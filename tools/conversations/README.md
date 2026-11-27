# tools/conversations/

Turning a person's exported messages into their own records. A chat app's saved messages, a mailbox page or an email
file, the Messages database, an AI assistant's logs and a captured web chat all come out the same way: **threads**
and **atoms**, the canonical contract, plus **conversations** in the shape the owner that keeps messages takes. One
canonical mapper gives every message a stable identity that does not change when its words are edited; the many
kinds of export are rows of data (`read-data/sources.json`) read by a few readers, so a new app is a new row, not
new code. It runs on the person's computer over the folder they granted, reads only inside it, reaches no internet
and keeps nothing. Pulling messages from a service with a token is a connector's job; a snapshot file is the seam it
calls.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:read-an-export-of-my-conversations` | Reads an export from a chosen folder: all of it a page of atoms at a time, the list of threads, or one thread's newest messages first | on the person's computer, read-a-folder |
| `tool:list-the-kinds-of-conversation-export-i-can-read` | Lists the kinds of export that can be read, what each one's files look like and what the run must say for it | in a container |
| `tool:list-the-conversation-sources-on-this-computer` | Finds every app's conversations in the granted home folder: ChatGPT, Claude.ai and Grok exports, Google Takeout activity (Gemini Apps, Assistant, AI Mode), and the sessions of Claude Code, Codex, Gemini CLI and Hermes | on the person's computer, read-a-folder |
| `tool:import-my-conversations-from-a-source` | Keeps one source's conversations as the person's records (handed back to keep), from each file's cursor row | on the person's computer, read-a-folder, values in and keep out |
| `tool:import-conversation-exports-from-my-files` | Keeps exports already in the account's files through the same canonical message owner, with immutable identity checks, exact message readback and paged source provenance | values in (the export's file, its rows), keep out; no host-folder grant |
| `tool:resume-importing-my-conversations` | The same for every source found, each from where it stopped, until `more` is false | on the person's computer, read-a-folder, values in and keep out |
| `tool:show-how-far-my-conversation-import-is` | Per source: files seen and done, conversations and messages kept, its state | values in (cursor rows only) |
| `tool:count-my-ai-conversations-per-app` | The AI conversations list read back: conversations and messages per app | values in (list rows only) |

## How a run reaches the person's records

A run holds no store and reaches none. The person's rows are handed in as `input.stored` (`records`, `queries`, `files`),
read by the caller from the store the person keeps them in (`read-data/rows-in-hand.mjs`, `rowsInHand`). What the run writes
comes back as `keep`: each record `{ id, type, value, expected }` (value null removes it) and each file `{ file, identity,
base64, expected }`, where `expected` is the record or file identity as the run saw it before that write, so a store refuses
a keep whose record has moved. A run that is not handed something it needs keeps nothing and answers `needs` (`complete: false`):
the record ids it reads (`records`), the lists it asks for (`lists`), and the files it looks for by name (`files`). The caller
reads those from its own store, hands them in and runs again until `needs` is empty. A list answer is the caller's answer for
that query (greatest id first unless `reverse` is false) plus the run's own writes of that kind, so a write is seen by the run's
later reads. The rows run `workflows/do-work/run-a-function.mjs` on the export's name: its input is the row's stdin, with the
values in `input.stored`.

## Bringing every conversation in

Moved from Trillion-X/trillion at the tag `old-trillion-before-worker-retire` (`moved-from.json` names each file, its
source and both identities; `ports/` holds the contracts). What is kept is what old Trillion kept:

- **Messages**: each message through the moved message owner (`tools/keep-and-wake-ai-sessions-on-this-computer/src/messages.mjs`
  `record()`, unchanged), so each is a `message` record with its `message-source-key`, its original time and
  `captured_road: chat_import`; bringing the same export in again adds nothing twice. The owner reads and writes
  synchronously over the rows in hand (`ownerRecords(hand)`): a read it makes that was not handed in is a need (see above),
  and its writes are kept in the order it made them, a message always before its source key.
- **One row per conversation** in the list `ai-conversations` (`record:ai-conversation`, `read-data/ai-conversations-list.json`):
  title, app, conversation_id, started, last, messages, models, original_file. Labels, people, pursuits and follow-ups
  are never written, so what the person set stays.
- **A cursor row per file and per source** (`conversation-import-cursor:<source>[:<file key>]`): where the file's read
  is (a conversation's place, a decoder page, or a transcript's byte offset with the recorder's context), what it kept,
  and whether it is done. A rerun skips a done, unchanged file and reads a grown session on from its offset.
- **Only what changed lately**: `changed_within_days` (import and resume) reads only the files changed within that many
  days. Run every 180 s with 7 over the four AI apps' sessions, it is old Trillion's recorder sweep
  (`record-every-message.mjs --sweep`, `sweep.every_seconds` and `sweep.changed_within_days`): each new turn is kept
  within minutes with no hook, and a turn a hook missed heals on the next run. The clock is an engine wake the person
  declares as a `wake-declaration` record and switches on; without a window every file is read, as before.
- **A run stops at its time box**: `time_box_seconds` ends a run, which answers `more: true` with what it kept and its cursor
  rows where they are; the next run resumes from them. A run that needs a record, list or file it was not handed keeps
  nothing and answers `needs` (see above), so a stop never leaves a message without its source key.
- **Where each source is** is DATA: `read-data/conversation-sources-on-this-computer.json` (export file names, the
  Takeout folder a file sits in, words its head holds; the local apps' session folders are their rows'
  `transcript_roots` in the harness rules). The granted folder is read as the person's home.
- **How each is read**: ChatGPT's conversation trees by `read-data/chat-archives.mjs`; Claude.ai, Grok and Google
  Takeout activity by rows of `read-data/sources.json` (`claude-ai-export`, `grok-export`, `google-activity`) through
  `decode_source.py`; the local AI apps' sessions by the harness rules old Trillion recorded every message by
  (`harness/record-every-message.mjs` `rowsFrom` and `messagesOf`, its bounded older-transcript reader), so only the
  rows those rules call the person's, the AI's, a peer's or generated context are kept, under `<app id>:<session id>`.
- **A ChatGPT individual-chat Markdown export** is also read by `read-data/markdown-chat-export.mjs`: its title, `/c/<UUID>` identity, and each `## Prompt:` / `## Response:` occurrence are retained in order. Adjacent same-speaker messages remain separate, fenced code is not parsed as headings, and unzoned date/model text is preserved as `source_at` with no invented UTC time.
- **Long messages** are kept in ordered parts of at most `most_text` characters, so one part fits one write.
- **Files a message carried** are handed back as `keep` entries (`{ file, base64 }`) for the caller to write into the
  person's files; the run finds an existing file by the files it is handed (`find_file`, `read_file`), and each piece of a
  written file fits one message (`writeWholeFile`), and
  the message names each by its identity (`attachments`, `about`), the way old Trillion linked them:
  - an export's file is looked for beside the export (`attachment_depth` folders down): ChatGPT's `file-XXXX-photo.png`
    by the id its name starts with (never as the start of a longer id), Grok's `prod-mc-asset-server/<id>/content` by
    the folder it sits in (kept as `<id>.<extension its bytes say>`), or at the path the run names for that id
    (`attachments: { id: path }`); it is kept at `/messages/<app>/<its name>`;
  - an image pasted into a Claude Code or Codex session is kept at `/messages/<conversation>/<message>-<n><extension>`,
    old Trillion's recorder's own name for it;
  - a file already there with the same identity is not written again, and a write sent again resumes under the same
    upload id, so a rerun copies nothing twice; a message of only files is kept once its file is;
  - a file not found, refused or over `most_attachment_bytes` is counted (`attachments_not_kept`,
    `attachments_refused`, `attachments_too_large`), never an error;
  - a zipped ChatGPT export (named in the run's `files`) has its files found inside the zip the same way
    (`exportFilesInZip`: by the id an entry's last name starts with, or the folder it sits in; an entry's name is never
    read as a path, and archive litter and entries that expand too far are left out), each inflated only when a message
    names it. A zip is read whole into memory and its conversations*.json are bounded by the archive reader's
    `chat_export` profile (80 MB each): a larger export is unzipped first, and its conversations.json is then streamed;
  - a message of only files (Grok's image sent without words) is kept with empty text: the canonical mapper keeps a
    no-text utterance that names its `attachments`, and such an utterance never converges with another.
- **A ChatGPT conversations.json of any size** is read one conversation at a time (`read-data/json-array-stream.mjs`),
  never parsed whole (a JavaScript string stops at about 500 MB; a 700 MB made-up export streams in about 7 s in 60 MB).
  Its cursor's `next` is `{ at, byte, bytes, changed_ms }`: a stopped run starts again at that byte when the file is
  unchanged, and otherwise passes `at` conversations without parsing them.

## Files

| File | Purpose |
|------|---------|
| `read-data/decode_source.py` | The command: `decode_source.py <granted folder> [--sources table.json]`, request on standard input; modes `all`, `threads`, `page`; `--list`. |
| `read-data/read_source.py` | The readers driven by a row's `shape`: fields (JSON and JSON lines, with the getter vocabulary documented in the file), SQLite rows, summaries and windows. |
| `read-data/read_mail.py` | Mail: an `.eml` file (RFC 5322) or a page of message resources with their part trees. |
| `read-data/read_session_events.py` | An AI coding assistant's JSON-lines event streams, including a byte-tail window for a very large log. |
| `read-data/read_web_capture.py` | A captured web chat page, validated against the provider the run expects. |
| `read-data/transcript_mapper.py` | The canonical mapper: thread specs to threads, atoms and rejections; atom identity; ranked convergence of two sightings; page windows. |
| `read-data/content_identity.py` | The BLAKE3 identity of bytes (`1f:` + 64 hex): the `blake3` module when present, else a pure implementation checked against published answers on first use. The same identity as `tools/content-identity`, for Python. |
| `read-data/choose_source.py` | Matches a file to its row by what it looks like (`input_shape`) and refuses a file two rows could read. |
| `read-data/for_recording.py` | Turns decoded threads and atoms into `{ conversation_id, title, app, messages: [{ id, speaker, text, at }] }`. |
| `read-data/snapshot_fold.py` | For connectors: folds a new snapshot into a thread and merges edited messages, keeping the newer by edit time. |
| `read-data/sources.json` | One row for each kind of export: Discord, Slack, Telegram, Signal, Instagram, WhatsApp, the Messages database, mail, Gmail pages, assistant logs, captured web chats, Claude.ai and Grok account exports, Google Takeout activity. |
| `read-data/chat-archives.mjs` | Moved from trillion `src/chat-archives.mjs`: a ChatGPT export's conversation tree, or a conversation read off its page, as messages; a long message in ordered parts (`most_text`). |
| `read-data/markdown-chat-export.mjs` | Reads a single ChatGPT Markdown chat export; no earlier parser owner (`ports/markdown-chat-export.json`). |
| `read-data/json-array-stream.mjs` | The elements of a file's top-level JSON array, read a piece at a time, each with the byte offset just past it (`jsonArrayElements`, `firstByteOf`). No prior owner (`ports/json-array-stream.json`). |
| `read-data/chat-import.mjs` | Moved from trillion `src/chat-import.mjs`: `importConversation` and `keepConversationRow`; `ownerRecords` (the message owner's reads and writes over the rows in hand); the import tools' functions. |
| `read-data/rows-in-hand.mjs` | The rows a run is handed (`records`, `queries`, `files`) read in memory; what it keeps comes back as `keep` with the value it expected; `answering` answers `keep` when complete, `needs` when not. |
| `read-data/ai-conversations-list.json` | Moved from trillion `src/ai-conversations-list.json`: the list every imported AI conversation gets one row in. |
| `read-data/conversation-sources-on-this-computer.json` | Where each app's conversations are, and the import's pacing (`write_rows`, `write_bytes`, `most_text`, `time_box_seconds`). |
| `read-data/acquire-and-import-ai-chat-history.json` | Moved from trillion `docs/notes/chat-history-marketplace-workflow.json`: the workflow `workflow:acquire-and-import-ai-chat-history` these tools serve (inventory, acquire, reconcile). |
| `moved-from.json`, `ports/` | Each moved file's source and identities; the port contracts of `chat-archives.mjs` and `chat-import.mjs`. |
| `what-this-tool-does-and-how-to-run-it.json` | The nine rows. |
| `test/python/` | The Python tests, with made-up exports (a bakery's orders); `test/python.test.mjs` runs each as a node test. |
| `test/rows.test.mjs` | Each row's command run the way the engine runs it. |
| `test/import-conversations.test.mjs` | The import over the held store (`test/support/held-store.mjs`), with a synthetic export or session folder for each source: what each keeps, a second run adding nothing, a grown session read on, a run not handed what it needs writing nothing and answering `needs`. |
| `test/import-rows.test.mjs` | The import rows run as the engine runs them (argv, stdin with `{ input: { ..., stored }, folder }`), each answered from the held store. |
| `test/import-attachments.test.mjs` | The files messages carried, handed back as keep: where each source's file is found and kept, a rerun writing no file again, a run not handed a file it looks for asking for it. |
| `test/large-and-zipped-exports.test.mjs` | The JSON array reader at every piece size and resumed at an end; a ChatGPT export kept a conversation at a time, a 503 spell midway then a resume from the cursor's byte with nothing kept twice; a zipped export's files copied from inside it; a Grok image sent without words kept with its file. |
| `test/chat-archive-parts.test.mjs`, `chat-export-zip.test.mjs`, `chat-history-identity.test.mjs`, `chat-source-time.test.mjs` | Moved from trillion `test/`, over the held store where they used the Worker's store. |
| `test/chat-attachments.test.mjs`, `native-chat-import.test.mjs` | Moved from trillion `test/`: the same made-up chat and assertions, over the namespace finder and the on-computer import instead of the Worker's PersonStore and Namespace routes. The two space tests of `chat-attachments` (a file item members of a space read from the importer's store) stay behind with the Worker's space owner. |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| Thread spec | `{ session_id, title, messages: [{ index, speaker, text, at, native_ref, kind, ... }] }` | What a reader gives the mapper. |
| Atom | `{ atom_ref, thread_ref, kind, speaker_ref, at, content, relations, ... }` | One message, reaction or event; `atom_ref` is the BLAKE3 identity of its place in its source. |
| Source row | `{ id, label, reader, input_shape, shape, recording, needs, ... }` | How one kind of export is read; `needs` lists the choices the run must make (`mailbox_address`, `expected_provider`). |
| Rejection | `{ code, ... }` | One structured entry for each thing an export could not give. |

## Names that changed from the decoders this replaces

| Old | New | Where |
|-----|-----|-------|
| `capture_binding.task_ref` | `capture_binding.captured_by` | captured web chat page |
| `capture_binding.surface_ref` | `capture_binding.surface` | captured web chat page |
| `capture_binding.authorization_ref` | `capture_binding.authorization` | captured web chat page |
| `capture_binding.isolation_observation_ref` | (not asked for) | captured web chat page |
| the person's own Gmail messages named by their mailbox address | named `me` | Gmail pages |
| SHA-256 digests of message ids and attachments | BLAKE3 (`content_hash`, `1f:` + 64 hex) | all sources |

The same-behaviour test is `test/python/test_same_as_old.py`; its fixtures (`test/python/fixtures/old_outputs.json`) were made once from the old decoders, and the header of the test says how to make them again.

## Dependencies

**Depends on:** for the read rows, nothing in this repository. The import rows reach no store and no door; they pack
`tools/workflows` for its `do-work/run-a-function.mjs` runner, and read `tools/content-identity`, and
`tools/content-identity`, the message owner and harness rules of `tools/keep-and-wake-ai-sessions-on-this-computer`
(`src/messages.mjs` and what it imports, `harness/record-every-message.mjs`), `tools/decide-with-a-method`
(`decision-records.mjs`, for `canonical`), `tools/set-up-my-account` (`harnesses.json`) and
`tools/take-pictures-out-of-a-zip-archive` (the archive reader, for an export zip), with `@noble/hashes` and `fflate`. `tools/save-what-you-watch-and-read` packs this folder's `read-data` to
read bookmark and pin exports with its own rows.

## Files moved from bitfield-packages (packages/gmail-mailbox-decoder)

Each file below is the package's own, byte for byte; `from-bitfield-packages/moved-from.json` names each source path and commit, the identity of its source bytes and of its bytes here, and the `calls` that made a real name or id made up. After the first commit only import paths changed. A file named `.held` is the same bytes with its test name taken off so the repository test does not run it; the reason is under `held` in the receipt. Most files import `@/packages/ui` and the retired package runtime (`@bitfield/runtime-kit`); the shared ui parts live in apps `tools/ui`, so the screens and targets here are prepared, not wired to a tool row.

| File | What it is |
|---|---|
| `do-work/__tests__/test_gmail_snapshot_store.py.held` | Characterization tests for the fold policy, written before it adopted the shared fold so they prove nothing observable changed. Run by `npm run test:snapshot-folds`. (held: imports conversation_snapshot_fold, the co-mounted fold; the Workshop's fold is convers |
| `do-work/gmail_snapshot_store.py` | Mail-specific fold policy only: which field is the identity, how entries are ordered, that the copy already held wins a collision, and how the position cursor advances. The merging itself belongs to `conversation-snapshot-fold`, delivered here as a co-mounted  |

### Not carried

- 2 files: package README, package.json or ignore file; this folder has its own README
- 1 file: the package boundary file: record contracts, actions and surfaces for the retired package runtime (slot workflows, owner targets); not carried
- 1 file: reads an OAuth credential blob from a file and calls the Gmail API with it: a provider call with a credential; the door hands credentials by handle through a row's invoke.connection, so it needs that swap first
- 1 file: tests connect-gmail.py
- 1 file: rewritten in the Workshop as the data row gmail-page in read-data/sources.json read by read_mail.py, with test_source_gmail_page.py; behaviour kept; flagged for the lead
- 1 file: tests the decoder that the data row replaced

The receipt's `not_carried` names each path.
