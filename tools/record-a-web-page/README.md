# tools/record-a-web-page

Records a web page as a demo for an article or post: a headless Chromium plays a list of steps the way a person would, and the real frames come back with a large drawn pointer, a ripple at every click, the view easing in toward each step, and one marked picture per step.

## Files

| File | Purpose |
|------|---------|
| `part.json` | The files other parts may name. |
| `tool-rows.json` | The Workshop row Trillion reads for this folder: `tool:record-a-web-demo`. |
| `test/` | The recorder run on `test/menu-page.html` (Playwright's Chromium, `test-helpers/chromium.mjs`), in real-time and deterministic modes. |
| `do-work/record-a-web-demo.mjs` | Opens the page in Chromium over the DevTools protocol (Node's own WebSocket, no browser library), plays the steps, keeps every painted frame with its time, a picture after each step that has a target or caption, and one timed list (`events.json`); then runs the drawing script and prints its result line. Chromium starts with `tools/headless-browser/quiet-switches.json` first (the tool row places it at `/opt/headless-browser`), a DevTools call that gets no answer in 60 s ends the run, and the browser is killed however the run ends. |
| `do-work/capture-settings.json` | DATA: the frames a second a deterministic recording takes unless `--capture-fps` says otherwise. |
| `do-work/draw-the-demo.py` | Reads the timed list and draws the demo: `demo.mp4`, `demo.gif`, `step-pictures/cover.png` (the frame at the first click) and `step-pictures/step-NN.png` (target ringed, an arrow to it, the caption on a card). Shortens still stretches to `max_idle` seconds. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| step | `{ do, target: { text } \| { selector }, caption, text, key, by, seconds, url, pause, timeout, optional }` | One action. `do` is a key of `ACTIONS` in the recorder: click, hover, type, press, scroll, wait, go. A new action is one entry there. `optional: true` leaves the step out when its target does not show within `timeout` (default 2 s), for a banner or notice that may not appear. |
| `FIND_TARGET` | page function `(target) => box \| null` | Finds a target by selector, or by its visible words (what is on screen first, then the smallest pressable match), scrolling it into view. |
| `ACTIONS` | `{ [do]: async (step, index) => box \| null }` | What each step does to the page, returning the box it acted on. |
| events.json | `{ started_at, ended_at, frames[{t,file}], pointer[{t,x,y}], clicks[{t,x,y}], steps[{index,do,caption,began,acted,ended,target,still}], view, render }` | The one timeline both scripts read; times are seconds since 1970. |
| `Demo` (python) | `Demo(recording, out)` then `encode()`, `mark_steps()` | Camera plan from the steps, frame drawing (`draw_frame`), idle shortening (`plan_idle_cuts`, `real_time`, `video_time`), GIF, marked pictures. |
| `make_pointer` | `(height_px, ink, edge) -> (image, hotspot)` | The arrow pointer drawn as a shape at four times its size and reduced, with an edge and a soft shadow. |
| result line | `{ seconds, frames, width, height, fps, video_bytes, gif_bytes, steps[{index, do, caption, found, at_seconds, picture}] }` | What the Workshop returns at `$.result`. |

With `--deterministic true` the page's own clock is moved one frame at a time (`tools/headless-browser/virtual-clock.mjs`, started with `deterministic-switches.json`) instead of being watched live, so the same steps give the same frames whatever load the machine is under (`test/record-a-web-page-deterministic.test.mjs`).

For source animation frames, `--capture-only true --duration <seconds> --capture-fps <fps>` keeps a PNG grid and `source-frames.json` without drawing a pointer, zooming, cutting idle time or encoding a second movie. Optional `--ready-function <dotted page function>` and `--seek-function <dotted page function>` await the page's declared readiness and seek each frame at exact `index / fps` seconds. Expressions and prototype traversal are refused. Page exceptions and a missing declared function fail the capture. The existing virtual clock still owns page timers.

`source-frames.json` records the requested length, actual frame-grid length, frame paths/times and an image pattern. A fractional final frame rounds the capture length up to the next complete frame. Feed that pattern to the existing media-composition compositor as a `clip` with `source_frame_rate` equal to the captured `fps`, and explicit `in: 0` / `out: duration`. The compositor remains the video/audio/export owner. Source capture is available in the local source CLI; this does not claim the hosted tool row exposes these new arguments.

Command line: `node do-work/record-a-web-demo.mjs --url <address> --steps '<json>' --out <folder> [--width 1280] [--height 720] [--scale 2] [--output-width 1920] [--fps 60] [--cursor-size 72] [--zoom 1.6] [--gif-width 800] [--gif-fps 12] [--max-idle 0.9] [--look '{"accent","ink","paper","pointer_edge","font_file"}'] [--cookies '[{"name","value","url"}]'] (set before the first page opens, for a signed-in page) [--browser <chromium>]` (or `BROWSER_EXECUTABLE`).

## Dependencies

**Depends on:** `tools/headless-browser/quiet-switches.json`, Chromium, Node 24, Python 3 with Pillow, ffmpeg; the computer that runs the tool supplies them (`placement:deployed-container`).

**Depended on by:** `tool:record-a-web-demo` (`tool-rows.json`, which packs `do-work` and `tools/headless-browser`'s `devtools.mjs`, `quiet-switches.json`, `virtual-clock.mjs` and `deterministic-switches.json`); tested by `test/record-a-web-page.test.mjs` and `test/deterministic.test.mjs`.

## Invariants

- Names no site, product or brand: pages, steps, sizes, colours and the caption font are input.
- A step that cannot find its target stops the run with one message naming the step and what to change.
- The drawn pointer, ripples and camera are functions of the timed list, never typed by hand.

## Why This Design?

Trillion's tools run on deployed compute, never on a person's desktop, so desktop recorders (Recordly, OpenScreen, Cap, Screenity) cannot be run by an AI. A scripted browser records the real page, and drawing the pointer afterwards makes it large, smooth and on brand every time. The easing, click dip and tilt are carried from the `browser-video-recording` skill's renderer.
