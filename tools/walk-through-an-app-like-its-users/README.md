# walk-through-an-app-like-its-users

Checks that people can still do what they come to an app for. It walks journeys written as DATA in a real browser on the person's own computer, keeps the evidence (a picture per step with the touched control boxed and numbered, a log, a video per journey), and answers a report a coding agent can fix from. Run it again with the earlier report and it says which failures are fixed, which still fail and which are new.

The open-source counterpart of hosted "continual agent verification" services: the app is reached from the person's own computer, so local, VPN and Tailscale addresses need no tunnel, and the deciding agent is the AI that calls the tool, so the tool needs no model key.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The rows Trillion reads: `tool:walk-through-an-app-like-its-users` (walk journeys, report), `tool:map-an-apps-screens-and-controls` (find screens and controls to write journeys from) and `tool:read-what-a-running-app-shows` (do steps, then report what is on the screen after each). All run `do-work/walk-through-an-app.mjs` on `placement:your-computer` or `placement:caller-sandbox`. |
| `do-work/walk-through-an-app.mjs` | The command: `node walk-through-an-app.mjs walk`, `... map` or `... observe`, one JSON request on standard input, one JSON line out (`{ "result" }` or `{ "error" }`). |
| `do-work/walk.mjs` | `walkApp(request, conventions)` and `mapApp(request, conventions)`: the browser half. One browser context per journey, actions as real mouse and keyboard input, settling on network quiet, polled expectations, pictures, screencast frames and a video (ffmpeg, when present). |
| `do-work/observe.mjs` | `observeApp(request, conventions)`: the observe job. Does each step's action with the same `act` as a walk, then takes the readings the step asks for, and never fails: a step that cannot complete is recorded and the run goes on. |
| `do-work/judge.mjs` | The pure half: `matchTarget`, `judgeExpectation` (every expectation kind), `offeredActions`, `verdictOf`, `learnedFrom`, `fixesFrom`, `decisionsFrom`, `compareWith`. |
| `do-work/in-page.mjs` | What runs inside the page: `readControls` (role, accessible name, value, box of every visible control), `centreOf`, `prepareFill`, `controlAt`, `markBox`, `readScreen`. The observe readings: `readElements`, `readCount`, `readAttributes`, `readText`, `readGlobalPath`, `readMediaReady`. Reads and acts; never judges. |
| `do-work/browser.mjs` | `findBrowser` and `openBrowser`: a headless Chromium started with no browser library (Node's own WebSocket), or one already listening (`browser.devtools_address`). |
| `do-work/walk-conventions.json` | DATA: where browsers usually are, switches, window, timings, which elements are controls, implicit roles, which actions each role offers, key codes, noise patterns, map limits, screencast settings. |
| `test/observe-an-app.test.mjs` | The observe job on made-up pages at data: addresses: a covered control reported as covered, a blocked step reported while the run goes on, every kind of reading, page errors, refusals. |
| `test/walk-through-an-app.test.mjs` | Pure rule tests, the rows, refusals, and an end-to-end run on a local fixture shop: broken (fails with a fix handoff), fixed (reported `fixed`), broken again (reported `newly_failing`), plus the map. |
| `test/fixture-shop.mjs` | The local fixture app the tests walk: a cart whose total ignores the quantity and whose save answers 500 while broken. |
| `test/fixtures/receipt.txt` | The upload fixture. |
| `part.json` | Nothing here is imported from outside this folder. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| journey | `{ id, goal?, expect_every_step?: Expect[], steps: [{ id, intent, do?: Do, expect?: Expect[] }] }` | One thing a person comes to the app for, step by step. |
| `Do` | `{ action: 'goto', url } \| { action: 'click', target } \| { action: 'fill', target, value } \| { action: 'press', key } \| { action: 'upload', target, files } \| { action: 'wait', ms }` | One action a person takes. Keys are the names in `walk-conventions.json` `keys`. |
| target | `{ role, name } \| { role, name_contains }`, optional `nth` | A control as a person sees it. No match, or several without `nth`, is refused, never guessed. |
| `Expect` | `{ kind: 'text_visible' \| 'text_absent' \| 'url_contains' \| 'title_contains', text }`, `{ kind: 'control_present' \| 'control_absent', target }`, `{ kind: 'field_value', target, equals }`, `{ kind: 'checked', target, equals }`, `{ kind: 'no_console_errors' }`, `{ kind: 'no_failed_requests' }` | What must be true after the step; polled until it holds or `expect_most_ms` passes. |
| report | `{ kind: 'app-walk-report', run, verdict, counts, fixes, decisions_needed, learned, compared_with_previous, journeys, report_file }` | Also saved as `report.json` in the evidence folder. |
| fix | `{ journey, goal, step, intent, what_failed, expected, observed, url, app_url, version, reproduce: [{ step, intent, do }], console_errors, failed_requests, evidence: { screenshot, log, video }, recheck }` | Everything a coding agent needs to reproduce and fix one failed step. |
| decision needed | `{ journey, step, intent, why, url, screenshot, offered: Do[] }` | A step with only words, or whose learned control has gone: the caller picks one offered `Do`, adds the fields its `needs` lists (`value` for fill, `files` for upload) and runs again with it in `learned`. |
| learned | `[{ journey, step, do }]` | Actions that passed; given back (or through `previous_report`) they replay next time. A journey's own `do` always wins. |
| comparison | `[{ journey, step, before, now, state }]`, state one of `fixed`, `still_failing`, `newly_failing`, `still_passing`, `now_passing`, `not_walked`, `new` | How a re-run stands against `previous_report`. |

## How a run goes

1. Map the app (`map`) to see its screens and the `do` objects each offers, or write journeys directly.
2. Walk (`walk`). A step without `do` comes back in `decisions_needed`; choose an offered action and run again with it in `learned` (or write it into the journey).
3. Hand `fixes` to the coding agent. After its change, run again with `previous_report` set to the last report: each fixed step reads `fixed`, and a step that broke reads `newly_failing`.

## Reading what the screen shows (observe)

When a walk fails and the reason is not in its expectations, `observe` looks without judging. Give it `app_url` and `steps`: each step may have a `do` (the same actions as a walk) and an `observe` of named readings taken afterwards.

| Reading | Needs | Answers |
|---------|-------|---------|
| `elements` | `selector`, optional `limit` | For each match: tag, label, visible, disabled, cursor, pointer events, z-index, position, opacity, rect, `pointer_would_hit` (what a pointer aimed at its own centre lands on) and `pointer_is_self`. |
| `count` | `selector` | How many nodes match. |
| `attributes` | `selector`, `names` | The named attributes, the form value and the child count of each match. |
| `text` | `selector` | The words in the first match, or null. |
| `global_path` | `path` | `{ found, walked, type }` for a dotted name on the page; a walk along names, never an evaluation. |
| `media_ready` | `selector`, optional `timeout_ms` | Milliseconds until a video or audio element can play. |

The answer is `{ kind: 'app-observation', run, page_errors, failed_requests, steps: [{ id, intent, do?, completed, blocked_by?, ms, observed, console_errors?, failed_requests?, screenshot? }] }`. A step that cannot complete has `completed: false` and `blocked_by`; its readings are still taken and the run goes on. Nothing is asserted, and the page is never intercepted or stubbed, because a check that replaces its subject observes nothing. This is the job of the old web-surface-observation package, merged here so one folder owns driving a running app.

## Rules it keeps

- Every run walks every step; nothing passes because it passed before.
- Adapting the route (a learned control that has gone) stops as a decision; it never changes what a step expects.
- A failed or undecided step stops its journey; the steps after it are `skipped`.
- Each journey has its own browser context, so no journey inherits another's sign-in.
- It reaches whatever the computer it runs on reaches. It is for the person's own apps; it does not refuse local addresses, because local and private apps are what it checks.

## Browsers

It starts the first Chromium-family browser it finds (`WALK_BROWSER`, `CHROME_PATH`, the usual install places, Playwright's cache), or attaches to `browser.devtools_address`. Obscura's `obscura serve` answers the protocol but lays nothing out (every element has a zero box, 2026-10-30), so controls read as not visible there; use a Chromium for walks.

## Dependencies

**Depends on:** Node 22 or later (its own `WebSocket` and `fetch`), a Chromium-family browser, ffmpeg for journey videos (without it the screencast frames stay as the evidence).

**Depended on by:** Trillion, through `tool-rows.json`.
