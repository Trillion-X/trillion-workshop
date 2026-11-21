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
| `admission.mjs` | `acquireBrowserAdmission`, `withBrowserAdmission`: the one queue every local browser waits in (one at a time per computer). It blocks while a headless Chromium it did not start is running, except one that has been running past `outside_browser_wait_minutes` (`admission.json`): that browser is logged once (`outside browser pid X since T`) and stops blocking. A young one, or one whose start time cannot be read, still blocks; a process list the sandbox denies (EPERM, EACCES) is not waited on: admission is granted and logged once; any other unreadable list holds admission for 60 s, then grants with the reason logged. A wait that runs out is thrown as `browser_held`, naming the outside browsers' pid, start time and command (`namedHolderError`). |
| `admission.json` | DATA: `outside_browser_wait_minutes` (10): how long a headless browser this admission does not manage may hold local browser work before it stops holding it. |
| `part.json` | The files code outside this folder may import. |
| `test/devtools-target.test.mjs` | A browser with no startup page gets one made and attached; an existing page is attached without making another. |
| `test/devtools-pipe.test.mjs`, `test/stand-in/pipe-browser.mjs` | The browser is started with the pipe and no port; messages split across writes are framed by the NUL byte; one that exits at start is a `BrowserProblem` with its own words. The stand-in browser speaks only the pipe. |
| `test/headless-browser-admission.test.mjs` | The queue and the outside-browser rule, with a fake process list: an old outside headless browser (an agent-browser daemon's, 53 minutes up) does not block a queued browser and is logged once; a young or unreadable one still does; a process list the sandbox denies (EPERM, EACCES) is not waited on: admission is granted and logged once; any other unreadable list holds admission for 60 s, then grants with the reason logged. |
| `test/proxy.test.mjs` | A browser told a proxy loads a page through it, and loopback, private and metadata addresses go to the proxy too (where the engine refuses them), never around it. |
| `test/workshop-browser-for-tests.mjs` | The browser launcher and Screen Look stylesheet path a test of another repository imports, with the selected-checkout provenance line. One call row applied (`lock-of-the-consumer`). Moved from trillion-apps `web/test/`. |
| `test/byte-identity-for-tests.mjs` | The `1f:` identity of bytes a test made itself, from the compiled hasher, checked once against the JavaScript BLAKE3. Moved byte for byte. |
| `test/workshop-custody-for-tests.mjs` | Shared test-only custody comparison: complete assertion token streams retain literal contents, arguments, nested calls and callbacks. Two call rows applied (`control-plane-default`, `control-plane-pins-path`: a private folder named as a default becomes a made-up one). |

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
