# tools/pull-a-time-window-from-a-stored-camera-file/

Take the sound of a few seconds, or one still picture, out of a camera video kept in cloud storage, without downloading the video. Camera files run about 13 MB per second of footage; audio is a small part of each second. The tool reads the file's box headers and its index by byte range, builds a sparse local copy with the same layout, asks ffprobe which byte ranges hold the audio packets inside the window (or the one key frame at or before a second), reads only those ranges and decodes them. The wav starts with silence up to the window's start, so second N of the wav is second N of the camera file and a plan can cut it in the camera file's own seconds.

Moved from a film's tools folder (`b2_audio_window.py`). The algorithm is the old one; the reader command, the store and the storage account id are now the person's settings (a `list:settings` row read through `tools/settings`, or keys of the request), and the picture mode's key-frame probe asks ffprobe not to parse (see Invariants).

## Files

| File | Purpose |
|------|---------|
| `do-work/pull_window.py` | The command: the request on standard input (or `--request FILE`); `--base FOLDER` is where a relative `out` is written. Modes `window` and `frame`. Prints a sentence, then `{"result": {...}}` as its last line, or `{"error": ...}`. |
| `tool-rows.json` | `tool:pull-a-time-window-from-a-stored-camera-file`, a `computer` row with `start-a-program` (the reader, ffmpeg, ffprobe) and `change-a-folder` (where `out` goes), run under `tools/settings`' `run-with-settings.mjs`. Its sample runs stand in for the reader, ffprobe and ffmpeg; one reads a settings row through the stand-in records door. |
| `part.json` | Nothing here is imported by other code. |
| `test/test_pull_window.py` | A made-up camera file drawn by ffmpeg and served by a stand-in reader: window length and lead silence, which bytes are read, frame mode reads one video packet, retry and refusal, credentials; storage from settings, a top-level key winning, out in the granted folder. |
| `test/fake_reader.py` | The stand-in reader: serves a byte range of a local file and logs every range it served. |
| `test/pull-a-time-window-from-a-stored-camera-file.test.mjs` | Checks the row and runs those tests (skips without ffmpeg). |

## The request

| Key | What it holds |
|---|---|
| `mode` | `window` (default) or `frame`. |
| `identity` | The stored file's identity as the store names it. |
| `from`, `to` | Window seconds (window mode). `at`: the second to take a frame at (frame mode). |
| `out` | Where the wav or jpg goes. |
| `settings_record`, `settings` | The person's `list:settings` row for this folder (`record:setting:pull-a-time-window-from-a-stored-camera-file~<scope_kind>~<scope_id>`), and settings for this run laid over it. They hold `store`, `account`, `reader`, `credentials` and `gap`; the same key at the top of the request wins. |
| `store`, `account` | The store the reader is pointed at, and the storage account id the file is kept under. |
| `reader` | `{argv, cwd?, env?, ok_marker?, retries?, retry_seconds?}`. `argv` is a template: `{store} {account} {identity} {out} {offset} {length}` are filled in. The command writes the bytes to `{out}` and prints `ok_marker` (default `ok-range`). A failed read is retried (default 20 times, 3 seconds apart). |
| `credentials` | Names of environment variables the reader needs (a storage key's name). Each must be set where this runs; the values go to the reader and are never read, printed or kept here. |
| `gap` | Join audio ranges closer than this many bytes into one read (default 262144). |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `Reader` | `read(offset, length, tmp) => bytes` | Runs the reader command for one range, retries, counts reads and bytes. |
| `walk_boxes` | `(reader, tmp) => [(type, offset, size)]` | Top-level boxes up to and including `moov`. |
| `sparse_copy` | `(reader, tmp) => path` | Every box header and the whole `moov`; media bytes left as holes. |
| `join_ranges` | `(packets, gap) => [[pos, size]]` | The reads: packets joined where closer than `gap`. |
| `pull_window`, `pull_frame` | `(reader, ...) => answer` | The two modes. |

## Dependencies

**Depends on:** Python 3.10 or later, ffmpeg and ffprobe, the person's reader command, and `tools/settings` with `tools/records-door`, which its row packs.

**Depended on by:** `tool-rows.json`.

## Invariants

- No key, account id, store path or reader path is in the code. The store, account and reader are the person's settings row; a key reaches the reader through the environment from the person's vault.
- Only headers, the index and the asked packets are read (plus, when gap joins them, the bytes between audio packets that lie within `gap`; `gap: 0` reads packets alone). Frame mode reads exactly one video packet. Storage reads are capped per day: ask for the shortest window that answers.
- The key-frame probe runs ffprobe with `-fflags +noparse+nofillin`. The sparse copy holds zeros where the video is, and ffmpeg 8's H.264 parser clears every key flag it cannot confirm in them, so the old probe found no key frame. The flags the file's own sample table gives are the ones used.
- A failed range read is refused with the offset and length asked; there is no retry loop beyond `reader.retries`.
