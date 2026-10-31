# tools/headless-browser/

A library the browser tools pack: a headless Chromium started with the switches that keep macOS from asking for the
login keychain, spoken to over the DevTools protocol through a pipe (`--remote-debugging-pipe`: no TCP port, so a sandbox that lets a browser listen on nothing can run it) and no browser library, and a page clock
that moves only when told. It offers no tool of its own; `tools/page-critic`, `tools/record-a-web-page` and `tools/copy-a-site` pack
its files beside theirs at `/opt/headless-browser`.

## Files

| File | Purpose |
|------|---------|
| `quiet-switches.json` | The switch list every Chromium starts with: `--use-mock-keychain` (no keychain prompt for "Chromium Safe Storage") and `--password-store=basic`. Adding a switch is one row here. |
| `devtools.mjs` | `openBrowser(executable, { width, height, switches? })`, `attachPageTarget(send)` and `BrowserProblem`: a headless Chromium started with the quiet switches and spoken to over DevTools through the pipe (descriptor 3 in, 4 out, one JSON message ended by a NUL byte each). A browser that does not answer its first call in 30 s, one that exits at start, or a call with no answer in 60 s ends with a `BrowserProblem`; the browser and its throwaway profile end with the run. |
| `deterministic-switches.json` | DATA: the Chromium switches a virtual-clock recording starts with (`openBrowser(path, { switches })`), so a picture taken while the page's time is paused is not left waiting for a frame. |
| `virtual-clock.mjs` | `createVirtualClock({ browser, fps, capture })`: the page's own clock moved only when told, one frame at a time, so a recording is the same every time. Used by `tools/record-a-web-page` with `--deterministic true`. |
| `part.json` | The files code outside this folder may import. |
| `test/devtools-target.test.mjs` | A browser with no startup page gets one made and attached; an existing page is attached without making another. |
| `test/devtools-pipe.test.mjs`, `test/stand-in/pipe-browser.mjs` | The browser is started with the pipe and no port; messages split across writes are framed by the NUL byte; one that exits at start is a `BrowserProblem` with its own words. The stand-in browser speaks only the pipe. |
| `test/proxy.test.mjs` | A browser told a proxy loads a page through it, and loopback, private and metadata addresses go to the proxy too (where the engine refuses them), never around it. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `openBrowser` | `(executable: string, { width, height, switches? }) => Promise<{ send(method, params), on(listener), close() }>` | A page attached over DevTools. |
| `attachPageTarget` | `(send) => Promise<{ targetId, sessionId }>` | Attach to the browser's page, making one when there is none. |
| `BrowserProblem` | `class extends Error` | A problem whose message is shown to the person as it is. |
| `createVirtualClock` | `({ browser, fps, capture }) => clock` | The page's time moved one frame at a time. |

## Dependencies

**Depends on:** a Chromium-family browser on the computer, Node 24. A tool is told one with `--browser` or `BROWSER_EXECUTABLE` (a path is used as given); a bare name such as `chromium`, or none, is looked for in `browser-places.json` (Chrome, Chromium, Edge, Brave and a Playwright cache, in that order) by `browserExecutable`, which every `openBrowser` call uses. No browser found ends with a BrowserProblem that says what to install.

**Depended on by:** `tools/page-critic`, `tools/record-a-web-page` and `tools/copy-a-site` (their rows pack these files), `test-helpers/chromium.mjs` (`quiet-switches.json`).

## Invariants

- Every Chromium starts with the quiet switches first.
- However the calling run ends, the browser process ends with it and its throwaway profile folder is removed.
- How many browsers run at once on one computer is the runner's decision; this library opens one browser per call
  and keeps no lock or queue of its own.
- A run told a proxy (`HTTPS_PROXY`, as the engine tells every internet:true run) starts its browser with
  `--proxy-server` set to it and loopback addresses sent there too (`--proxy-bypass-list=<-loopback>`; Chromium
  would otherwise go to them directly). Chromium does not read that setting itself, and the engine's sandbox lets the
  run reach nothing but that proxy. Which addresses are public is the engine's to judge, never this library's.
