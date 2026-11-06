# Decouple sweep: trillion-workshop

Swept 2026-11-03 for "decouple literally everything from this Mac" (the owner, 2026-11-02). Every tie below binds a tool to one machine, one person's computer or one account's device. Each is described by the job the code does, then the shape it takes once a place is known only by what it reports.

The primitive is placement stage 1 on trillion-rust main (`src/account/places.rs`, `create.rs`, `door.rs`): place rows per account and per pursuit, a place described only by what it reports, a router that stores nothing and chooses from signed rows. In this repository a tool cannot see those rows. It sees only the computer it runs on. So the shape here is always the same: the tool asks the computer it runs on for the thing it needs (a lock, a reader, a program, a key store), and when the computer has none, it refuses in words that say what to give it. The tool never asks what kind of machine it is on. A row's `placements` and `invoke.capabilities` already say what a place must report before the router may choose it, so no new row or capability was needed.

Branch: `claude/task-9zielx`, PR #16. Every fix is its own commit on that branch, and all of them are in that one pull request (the session may push only to that branch). Tests: `npm test` on Linux (this cloud box). Line numbers are on the branch.

## Ties removed

| Tie | File:line | Decoupled shape | Commit | Status |
|-----|-----------|-----------------|--------|--------|
| Kept judge calibration refused every place but macOS: the writer lock used the macOS-only `O_EXLOCK` flag behind a `process.platform !== 'darwin'` check, so `remember_file` failed on Linux and 5 tests failed there (6 more were skipped) | `tools/ask-a-small-model-for-a-verdict/do-work/ask-for-a-verdict.mjs:707`, `holdCacheLock` | The folder is asked whether `open(2)` takes a kernel open lock: open a probe file twice and see whether the second open is refused. If it is, the kernel way is used, unchanged. If not, the lock is held by its name: the file is linked into place whole with its holder (`pid`, `started`, `place`), removed by its holder, and taken only from a process that has ended on the same place. A lock held from another place, or a lock of the other way, is never taken. Checked with 8 processes racing 300 writes each: no write was lost. | `055fc8c` | done; tests run on Linux |
| Running programs could be listed only through `/usr/bin/osascript` and libproc | `tools/running-programs/read-data/running-programs.mjs:49` | The readers are rows in `running-programs.json`, tried in order: a process-table folder (`<pid>/comm`, `<pid>/status`, read directly, starting no program), then libproc through osascript (moved unchanged). The place is known only by which reader's `at` it has. | `4b8a388` | done; the real reader now runs in the Linux test |
| A door's key could be read only from the macOS keychain (`security find-generic-password`) | `tools/read-a-list-view/read-data/door.mjs:37`, `tools/export-records-as-list-rows/read-data/record_write_send.py:84` | A credential handle names one key store: `{ keychain_item }` (moved unchanged) or `{ key_file }`, a file the person names, which works on any place. This is the same way `ask-a-hosted-classifier` already reads its key. A handle that names no store, two stores, or a key itself is refused. | `f34b818` | done |
| Finding Premiere projects refused every computer but a Mac (`process.platform !== 'darwin'`) | `tools/media-composition/do-work/relink-editor-projects.mjs:104` | The computer is asked whether it has the Spotlight name index (`/usr/bin/mdfind`). Anywhere else the person names the project files, which already worked on any place. | `c05983c` | done |
| Narration with no producer named fell back to macOS `say` | `tools/media-composition/do-work/tts-narrate.mjs:51`, `video-compose.mjs:2104` | With no producer named, the first producer whose program is on this computer is used. A computer with none is told what to install. | `58cf50b` | done |
| Ending a browser assumed it stops writing its profile once its main process is killed. On Linux its helper processes keep writing, so removing the profile failed with ENOTEMPTY and the run ended in that error. That made 3 tests flaky. | `tools/headless-browser/devtools.mjs:26`, `tools/walk-through-an-app-like-its-users/do-work/browser.mjs:22` | Where the place has process groups (it reports POSIX user ids), the browser leads its own group and the whole group is ended. Elsewhere the browser alone is ended, as before. | `30da9ef` | done; walk-through, record-a-web-page and headless-browser tests passed 3 of 3 runs |
| Connected drives were read only from `/Volumes`, with `mount`, `diskutil` and `osascript` (Finder icons) | `tools/connected-drives/read-data/drives.mjs`, `drive-mount-table.mjs` | Drive readers are rows in `read-data/drives.json`, tried in order, each chosen by whether its `at` path exists: `finder-volumes` (unchanged) and `mount-table` (block-device mounts inside `/media`, `/run/media`, `/mnt` from `/proc/self/mountinfo`). The mount-table reader answers "no icon" and never offers an eject. | PR #167 | done; tested against a pretend mount table on Linux |
| `tool:build-records-to-write` and its sender started `/usr/bin/python3` on macOS and `python3` elsewhere | `tools/export-records-as-list-rows/do-work/build_record_write.mjs`, `send_built_record_write.mjs` | `python3` from the computer's own path everywhere; a computer without one is told to give the run Python 3.10 or newer. The fixed macOS path started the system Python 3.9, older than the 3.10 the tool's README requires. | PR #167 | done |
| The hosted-provider cost observer picked credentials by vendor name prefixes (`cloudflare-`, `backblaze-b2-`) and fixed holder names | `tools/keep-measurements-current/do-work/observe-hosted-provider.mjs` | The person's `hosted-provider-credentials/1` rows name each provider's holders (`--credentials FILE`); no holder name or prefix is in code or packaged data, unnamed vault names are never read, and a provider with no row is reported in `unconfigured_providers` | PR #167 | done; which providers to keep observing is now the person's rows |

## Ties still open

| Tie | File:line | Decoupled shape | Commit | Status |
|-----|-----------|-----------------|--------|--------|
| iMessage history is read from macOS `chat.db` | `tools/conversations/read-data/sources.json:335` | Already a source row. A computer reports whether it holds that store. No change needed beyond the router choosing only places that report the source. | none | kept: the data exists only where Messages keeps it |
| Messages are sent through AppleScript on the person's Mac | `tools/send-messages/read-data/message-providers.json:53` | Already one provider row among others (email and the rest). A computer reports which providers it can run. | none | kept: already data, not code |
| The device-notification route `live` is labelled "A Mac" | `tools/notifications/read-data/device-notifications.mjs:48` | Label it by what it reaches ("A computer"), in the module's words | none | open: a one-word change, left out because the label may be matched elsewhere |
| The copied transcribe script falls back to a model under `~/.bitfield/runtime-kit` | `tools/audio-transcription/do-work/process-scripts/transcribe-audio.py:220` | No home-folder fallback; the run names the model file | none | kept: the row says the script is copied unchanged, and the seam (`do-work/audio_transcription.py:42`) always passes `--model-path`, so the fallback never runs |
| The legacy-lock check and the open-project check ask `lsof` | `ask-for-a-verdict.mjs:878`, `relink-editor-projects.mjs:112` | Already a question to the place. A place without `lsof` keeps the lock busy (fail closed) or treats the project as closed. | none | kept |
| The test-only hint `taskpolicy -b` in a comment | `tools/media-composition/do-work/measure-loudness.mjs:48` | Already a caller-given argument | none | kept |

## Looked for and not found

- The owner's account id or name in code or rows: none.
- The Mac-only state on the 5:30 PM list (LaunchAgents, `local-runtime.json`, the `~/.bitfield/credentials` files, the local listeners on 8788, 8092, 8099, 18092, 11434/11435, 8795, 8700, 3001-3003, 8081, 9100, 8317): no code here reads any of it. Ollama's usual address `localhost:11434` appears only as a default a request can replace (`tools/meaning-search/do-work/process-scripts/embed-text-ollama.mjs:139`, `tools/file-spoken-moments-into-topic-buckets/do-work/bucket_moments.py:160`). Every other `127.0.0.1` is a test server on port 0, or the FTP receiver's default listen address, which its settings file can change.
- Browser lookup (`headless-browser/browser-places.json`, `walk-conventions.json`, `saved-posts-conventions.json`): already lists Linux places and the Playwright cache under the person's home folder, so it is not a tie.
- Storage in one local folder: every store found is a path the request names. The one exception is the model-identity cache under the person's home `.cache` (`who-can-be-asked.mjs:86`), which every computer has.

## Needs the owner

- `docs/` is not a place in `capabilities.json`. Rule 7 forbids adding a row there, so this file has no place row. If the gate refuses it, either the owner adds `docs` to `places`, or this report moves to wherever he wants sweep reports kept.
- Pushing to main and releases.

## Test run on Linux

Before this branch: 3455 tests, 17 failing, 26 skipped. Five of the failures were the calibration lock above.

After this branch (with Python's blake3, numpy, scipy and soundfile installed, which un-skipped some tests): 3465 tests, 11 failing, 17 skipped, plus 3 browser tests that fail only now and then. None of the 11 is a tie to one machine:

- `media-composition` image-sequence duration (3 tests): this box's ffmpeg (6.1) is too old, and a current ffmpeg passes them.
- `assemble-a-plan-into-a-cut` (1 test): ffmpeg fails while rendering a clip. It fails the same way with `video-compose.mjs` as it is on main. Before this branch it was skipped, because the Python modules it needs were missing. It has not been checked against a newer ffmpeg.
- `page-critic` (3 tests) and `record-a-web-page` (3 tests): this box's agent proxy listens on loopback. `headless-browser/devtools.mjs` sends even loopback pages through `HTTPS_PROXY`, so the tests' local pages never load. They pass with the proxy unset.
- `walk-through-an-app-like-its-users`, "a broken shop" (1 test): it fails for the same proxy reason.
