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
| `read-data/sources.json` | One row for each kind of export: Discord, Slack, Telegram, Signal, Instagram, WhatsApp, the Messages database, mail, Gmail pages, assistant logs, captured web chats. |
| `tool-rows.json` | The two rows. |
| `test/python/` | The Python tests, with made-up exports (a bakery's orders); `test/python.test.mjs` runs each as a node test. |
| `test/rows.test.mjs` | Each row's command run the way the engine runs it. |

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

**Depends on:** nothing in this repository. `tools/save-what-you-watch-and-read` packs this folder's `read-data` to
read bookmark and pin exports with its own rows.
