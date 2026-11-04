# tools/read-what-is-on-screen/

Reads what the person is doing on their Mac, as text, from the front window's accessibility tree (never a screenshot), for a short watch: the app, the window title, the page address and the visible words, when they switch apps or windows and again every tick, so their AIs keep continuity across the day. Passwords, keys and card numbers are removed on the Mac before anything leaves it. Learned from a screen-reading continuity app (reverse engineered 2026-10-14 and 2026-10-15).

## Files

| File | Purpose |
|------|---------|
| `do-work/read.swift` | The reader. Watches the front window for `--watch-seconds`, reads on an app or title change and every `--tick-seconds`, prints `{ captures }`, `{ needs_access, said }` or `{ error }`. `--scrub` reads text on standard input and prints it scrubbed, without reading any window. |
| `do-work/read-what-is-on-screen.mjs` | `readWhatIsOnScreen` (run as a function by `tools/records-door`) and `read`: checks the watch bounds, runs the reader with the rules file, and returns its last line or an error in words. |
| `read-data/rules.json` | All rules as DATA: never-read apps, title words and address words, secret patterns, which accessibility roles and attributes are words, where a browser keeps its address, the wake attributes for Electron and Chromium apps, the read limits and the access words. |
| `tool-rows.json` | The row `tool:read-what-is-on-screen`: a `computer` row with the `read-the-screen-text` capability and a run ceiling of 300 seconds; and `tool:parse-snapshot`, a `computer` row with no capability (it reads only the elements it is given). |
| `test/read-what-is-on-screen.test.mjs` | The command on a stand-in reader; the rules' contents; and the real reader's scrubbing, run for real with the real rules on text typed in the test (keys, tokens, card numbers, `password:` values, a private key), its refusal of a pattern that does not compile and of a missing rules file, and a Swift type-check. |
| `read-data/snapshot-triggers.mjs` | The policy half of the Mac app's accessibility snapshot reader: `createGovernor` (which events take a snapshot, debounce, global and per-app spacing with backoff, locked screen, memory pressure, every ask counted), `parseSnapshot` (declarative per-app parser rows), `redact`, and `parse`, the function of the row `tool:parse-snapshot`. |
| `read-data/snapshot-triggers.json` | The triggers, throttle, skip facts, parser rows, redaction patterns and outcome names. |
| `test/snapshot-triggers.test.mjs` | The original Trillion tests for the governor, the backoff, the parser rows and the redaction. |
| `part.json` | Nothing here is imported by other code. |

## How a run goes

- A watch is 5 to 240 seconds (default 50) and a tick 10 to 600 seconds (default 60); a request outside these is refused with the bounds. The 240 leaves the row's 300 second ceiling room for the compiler to start.
- A window's first capture in a run carries its whole `text`; later captures of the same window carry only the lines `added` and `removed`, so a long watch costs what changed. The same text of the same window is kept once.
- An app in `never_read_bundles`, a window whose title holds a `never_read_title_words` entry, and a page whose address holds a `never_read_url_words` entry are skipped before any text is read. A secret pattern that does not compile stops the run, because it would let that kind of secret through.
- Reading is bounded by `limits` (depth, nodes, characters), so a huge window cannot stall the Mac.
- Accessibility off is `needs_access: "accessibility"` with `rules.words.needs_access`.

## Moved from Trillion

`computer/snapshot-triggers.mjs` and `computer/snapshot-triggers.json` (deleted in Trillion-X/trillion dc79bb0a87), with `test/snapshot-triggers.test.mjs`, the same code. Its Swift half, the event watching that asks the governor, stays in the Mac app (`macos/App/ComputerReader.swift`, which moved from Trillion-X/trillion to Trillion-X/trillion-apps on 2026-11-03), which keeps it; `read.swift` here is a separate reader and does not use the governor yet.

## Not yet

- The `read-the-screen-text` capability is not in the engine's `product/computer-capabilities.json`, so a run is refused until the engine's owner adds it (its sandbox rules for the accessibility services and for starting `/usr/bin/swift`, and the macOS Accessibility permission, are measured there, not here).
- Reading a live window is not covered by a test: it needs the Accessibility grant and the person's own windows. On 2026-10-15 the reader read 2,290 text items from one browser window and 1,598 from a notes window by hand; that is not repeated here.
- Swift compiles the reader on every run (a few seconds) because the row starts `swift read.swift`; a compiled reader would need a signing owner.

## Dependencies

**Depends on:** `tools/records-door` (the command that runs a function), `tools/content-identity`; `/usr/bin/swift` (Xcode command line tools) on the Mac.

**Depended on by:** nothing is imported from here.
