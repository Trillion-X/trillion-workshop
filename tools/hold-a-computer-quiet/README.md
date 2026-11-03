# tools/hold-a-computer-quiet/

Keeps the apps a hold names closed whenever they open, and Focus on, until the hold's own end time, on the person's own Mac. A hold may instead name `only`: every app but those (and the always-open ones) is closed while it lasts. A hold always ends by itself, at most `longest_hours` away, so it can never keep the person out of their own computer. Nothing here knows what a session is; a protocol step (a lock-in session, a bedtime schedule, the one thing waiting on the person) runs these tools by id.

Moved here from `Trillion-X/trillion` `computer/hold-this-mac.mjs` (2026-11-02).

## Files

| File | Purpose |
|------|---------|
| `read-data/hold-this-mac.mjs` | `holdADeviceQuiet`, `releaseADevice`, `deviceHolds`, `focus` (one per row) and `resumeHolds` (the tool host calls it once when it starts), over `makeHolds`, plus the pure helpers: the end of a hold, the identities no hold closes, which open apps a hold closes, which apps hold the microphone. |
| `read-data/hold-this-mac.json` | Where holds are kept, how often to look, the longest hold, the apps never closed, which of the computer's places are kept open, the resources an app is spared while using, the default apps, the Focus shortcuts as DATA, and every word said. |
| `tool-rows.json` | `tool:hold-a-device-quiet`, `tool:release-a-device`, `tool:device-holds`, `tool:focus`: `computer` rows with `capabilities: ["close-apps-and-switch-focus"]`. |
| `part.json` | Nothing here is imported by other code. |
| `test/hold-this-mac.test.mjs` | A pretend Mac: holds close apps politely, never close kept apps, end by themselves, resume after a restart; the rows. |
| `test/fixtures/keep-open-rows.json` | A computer's places as its tool host hands them in. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `makeHolds` | `({ settings?, rows?, home?, facts?, exec?, now?, timers? }) => { hold, release, holds, focus, resume, look }` | The tools over a home folder and a command runner, so tests hold a pretend Mac. |
| `placeRows` | `(context) => rows` | The computer's places the run was handed as `context.keep_open_rows`; none when it was handed none (then only `always_open` is kept). |
| `keptIdentities` | `(settings, rows, home, facts) => Set` | Every name an app kept open goes by: shown name, bundle file name, executable, bundle id, bundle path. |
| `closedBy` | `(holds, settings, kept) => app => boolean` | Whether the lasting holds close a running app. |

## How a run goes

- Holds live in one file under the person's home (`folder`/holds.json). A missing or unreadable file means nothing is held: it fails open.
- While a hold lasts, one watcher per computer looks every `watch_seconds`: holds that ended are dropped (Focus off when no lasting hold wants it), and every app the holds close is asked to quit politely; only a refusal ends it. An app using the microphone (a live recording or call) is left for a later look.
- The first call makes the watcher with the places that call carried; later calls share it.

## Not yet

- The watcher lives in the process that ran the first call. The Trillion Mac app's tool host runs these functions in its own long-lived process and calls `resumeHolds` when it starts, so holds outlive one run. Run once per call by `run-an-export.mjs`, a hold is written and its first look runs, but nothing watches after the run ends.
- `context.keep_open_rows` is handed in by the Trillion Mac app's tool host from its own list of places. `run-an-export.mjs` hands only `door`, so a run started that way keeps only `always_open`.

## Dependencies

**Depends on:** Node's standard library and the Mac's `lsappinfo`, `osascript`, `kill`, `pmset`, `ps`, `plutil`, `shortcuts` and `open`; `tools/records-door` (`run-an-export.mjs`) for a `computer` run.

**Depended on by:** `tool-rows.json`; the Trillion Mac app's tool host (`computer/mac-tools.json` in Trillion-X/trillion), which runs these functions on placement:your-computer.
