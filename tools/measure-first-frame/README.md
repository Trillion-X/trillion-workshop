# tools/measure-first-frame/

Measure what a person sees when a video served by byte ranges starts: the first presented frame, the time from Play to a moving frame, the time to a frame after a seek, and the bytes the browser asked for, in a real Chromium, fresh and returning. Give it the address of any video a browser can play by Range (a share link, a file's byte route, a loopback server); it answers the numbers and judges each median against the bar the Oct 2026 files path set.

The page is one blank page with one `<video muted playsinline preload=auto src=URL>`: the same decoder and the same Range requests any player makes. Nothing of a share page, a poster or a player's own markup is read, so the same run measures every host that serves bytes. The blank page is answered by the browser itself at the video's own origin (it never reaches the server).

## Run

    echo '{"url":"https://HOST/share/LABEL/KEY","samples":3}' | node tools/measure-first-frame/do-work/measure-first-frame.mjs

Input: `url` (https, or http on this computer's loopback), `samples` (default 3, 1 to 20), `seek_fraction` (default 0.6, 0.05 to 0.95), `timeout_ms` (default 30000), `browser_path` (else `BROWSER_EXECUTABLE`, else Playwright's Chromium if installed, else a place in DATA). Playwright's own Chromium has no H.264 decoder in some builds: give `browser_path` a Chrome for an MP4 that needs it (the answer names the browser).

Answer `{ result: { host, browser, samples: [{ fresh, returning }], medians, against_bar } }`. Each visit: `first_frame_seconds`, `play_to_moving_seconds` (Play to a frame past 0.1 s of media), `seek_seconds` (to a frame within 0.3 s of the target), `bytes` and `responses` (what the browser's responses for the address delivered, by `content-length`), `statuses`, `content_ranges`, `duration_seconds`, `error` (null, or why a number is null: never zero). `against_bar` judges `fresh` against the cold bar and `returning` against the warm bar; `within` is null when a number was not measured.

The address is never answered (a share's key is in it); the answer names its host.

## The bar

`read-data/measure-first-frame.json` holds the defaults and the bar, each number with its source line in lane streaming-bar's `streaming-bar.md` section 1.1: warm first frame at most 2.9 s, cold at most 5.9 s, 17 MB fetched to the first frame, seek at most 204 ms, Play to moving frame at most 0.973 s. The bar is the Oct 5 2026 measurement of the old path; it changes only when a newer measurement of a working path replaces it.

## Files

| File | Purpose |
|------|---------|
| `do-work/measure-first-frame.mjs` | `measureFirstFrame(input, { launch? })`, `checkInput`, `findBrowser`, and the command (stdin JSON in, `{ result }` out) |
| `do-work/shape-the-result.mjs` | `median`, `deliveredBytes`, `mediansOf`, `againstBar`, `shapeResult`: pure, no browser |
| `read-data/measure-first-frame.json` | DATA: defaults, bounds, browser places, the bar and where each number comes from |
| `what-this-tool-does-and-how-to-run-it.json` | The row `tool:measure-first-frame`, run on the person's own computer |
| `test/measure-first-frame.test.mjs` | The shaping on made-up numbers; the input checks; a real Chromium measuring a generated video served by Range from a loopback server (skipped, with its reason, where Chromium or ffmpeg is missing) |

## Dependencies

**Depends on:** `playwright-core`, `tools/headless-browser/quiet-switches.json` (the switches every Chromium starts with), a Chromium or Chrome on the computer. No download at run time.

**Not here:** the byte route a share is read from (tools/live-namespace `serve-shares`), the Finder-folder first-frame timing (the files core), and a run against the person's real store, which needs a shared file and a computer that serves it.
