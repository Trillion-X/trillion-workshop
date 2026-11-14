# converge-installed-apps-to-their-current-handle

Make one running app match its own current open handle. An advance APPENDS a handle and changes nothing already running, so a corrected binary reaches the handle and stops there until something does this.

## Files

| File | Purpose |
|---|---|
| `do-work/converge-installed-apps-to-their-current-handle.mjs` | The owner. Observes, closes if alive, confirms the close, opens, re-observes. |
| `do-work/run-converge-installed-apps-to-their-current-handle.mjs` | CLI front door. Exit code follows the predicate, not the commands. |
| `tests/converge-installed-apps-to-their-current-handle.test.mjs` | Every behaviour below has a case here, including the regression for the defect that took the live app down, the regression for the app with no HTTP shell, the close-only writer-release boundary, and the status read carrying the opener's own diagnosis. (This said "20 tests" and was wrong the next time anyone added one. A count in prose cannot be corrected by the commit that invalidates it, and the run prints the real number.) |
| `things-to-store-and-run.json` | Contract record and the two stored sources. |

## Key functions

| Function | Shape | Role |
|---|---|---|
| `convergeOneInstalledAppToItsCurrentHandle` | `({opener?, appId, closeAttempts?, openAttempts?, intervalMs?, spawnTimeoutMs?, execFileAsync?, exists?, probe?, status?, sleep?, home?}) → report` | The whole capability. Everything after `appId` is injectable for tests. Report carries `transport_before`, `transport_after` and `attachments_after`. |
| `closeOneInstalledAppToReleaseItsWriter` | `({opener?, appId, closeAttempts?, intervalMs?, spawnTimeoutMs?, execFileAsync?, exists?, status?, sleep?, home?}) → report` | Releases one app owner without opening anything. Used when a replacement bundle must be installed while the exclusive envelope writer is absent. |
| `isServing` | `({ready, transport}, {probe}) → Promise<boolean>` | Liveness. The opener says the resident owner is ready AND, if a transport is published, it answers `/boot`. A RESPONSE, never a file. |
| `readOneInstalledAppsStatus` | `({opener?, appId, spawnTimeoutMs?, execFileAsync?, exists?, status?, home?}) → report` | Reads one app's resident-owner status. NO open, NO close, NO effect. Adds `published_transport` beside `alive`, because that pair is the finding. |
| `statusReportReader` | `(run, openerPath, appId, timeoutMs?) → () => Promise<{alive, ready, attachments, decision, restart_required, last_boot_phase}>` | The opener's `--status-report-only --same-app-id` report, computed by it at call time from the lock owner's pid. A failed or unparsable report is no evidence and says why in `no_report_because`. |
| `publishedTransport` | `(attachments) → {socketPath} \| {url} \| null` | The transport the opener's status report publishes. A local app publishes `forwarding_socket` (a Unix-domain socket path, since 2026-09-09 no customer machine binds a port); a hosted deployment that declared a TCP listen address publishes `http_url`; an app with no shell publishes neither. |
| `installedOpenerPath` | `(home?) → string` | The installed runtime kit opener. |

## Run it

```sh
node <pkg>/do-work/run-converge-installed-apps-to-their-current-handle.mjs \
  --app-id <id> [--app-id <id> ...] [--opener <abs path>] [--timeout-ms <n>]
```

Add `--close-only` when an installer needs the old envelope writer released before it can admit a
new current handle. Close-only never opens an app; it reports `released` only after the opener's
pid-probed status report says the process graph is no longer alive. A dead starting state is
already released.

Add `--status-only` to ASK instead of act. It performs no open and no close, and it is the mode to
reach for first when something will not come up. **Its predicate is `answered`, not `converged`:** an
app being down is a perfectly good answer, so a status run exits non-zero only when it could not ask
(the opener threw, or the report came back missing and said why in `no_report_because`).
`--status-only` and `--close-only` together are refused rather than ranked, because a caller who
typed both wants two different things.

This mode exists because the package could be TOLD two things and asked nothing, while
`statusReportReader` sat here exported and unreachable from the front door. The only way to learn
why an app would not open was to converge it, which closes a running app to answer a question about
it, so the cheapest question was the most expensive act.

**Read `published_transport` next to `alive`, because that pair is the whole finding.** A published
transport outlives the process that published it, so a dead app keeps advertising one. Measured
2026-09-09 (when the transport was still a port): all three installed apps reported `alive: false`
with `decision: "stale-active-owner-status"` and `restart_required: true`, and all three still
published an address. Anything that resolves an app's transport and then dials it without asking
`alive` first will read that as a network problem. Later the same day the port was deleted from the
runtime: a local app now publishes the shell's Unix-domain socket path in the status attachments
(`forwarding_socket`), `presentation-target.txt` is gone, and this package reads the transport off
the same status report it reads `ready` from.

**`--app-id` repeats**, and the answer is fleet-shaped:

```json
{ "asked": 2, "converged": 0, "not_converged": ["alpha", "beta"], "each": [ ... ] }
```

Failures are NAMED rather than counted, because a fleet answer whose failures are a number sends
the reader back through every entry to find out which ones, which is the work a fleet command
exists to save.

This signature is what the package's old name was hiding. It was
`converge-one-installed-app-to-its-current-handle` until 2026-09-05, and nobody had decided the
capability was singular: they decided the NAME once and every layer down to this file grew to
agree. Converging a fleet meant N invocations and N outputs, with no fleet-wide answer possible
because no signature could express one.

Two decisions inside the loop are deliberate. Apps run **sequentially**, because each convergence
closes and reopens an app and the close must land before the open or the reopen no-ops as
already-open, keeping the stale bundle resident while reporting success; two openers against one
machine's pointer state buy nothing a waiting person would notice. And each app has **its own
try**, so one failure isolates instead of abandoning the rest, since a run that stops at the first
problem makes a caller discover their problems one per run.

A repeated app id is **refused**, not de-duplicated: the same app listed twice means the caller's
list is wrong, and silently collapsing it hides which of their two sources was the bad one.

## The predicate IS the capability

This is not "restart the app". A restart reports success when two commands exit 0. This reports `converged: false` when nothing serves afterwards **even though both commands succeeded**, a state a restart-shaped implementation cannot represent. Process start is never readiness.

The CLI's exit code follows `converged` for **every** app in the list, so a caller that only checks
the exit code cannot mistake a started process for a serving one, and cannot mistake a
partly-converged fleet for a converged one either.

## ⚠️ Two things a live run taught, that the unit tests had asserted wrongly

**1. The published address SURVIVES a close.** The first version treated the presence of `presentation-target.txt` (the file that carried the address until 2026-09-09) as liveness. A real run then closed Trillion successfully, saw the file still sitting there, scored the close as unconfirmed, refused to open, and **left the app down**. A published fact is a claim about the past; only a response is evidence about the present. Liveness is now a `/boot` probe over the published transport, and the regression is pinned by `a published transport that outlives the closed process is NOT treated as running`.

**3. (2026-09-05) An HTTP probe cannot see an app with no HTTP shell.** The launcher's surface is a menu-bar item; it publishes no address. The second version asked only the address and reported `was_running: false, converged: false` while the opener reported the owner `running` with its status item visible. Liveness is now asked of the opener's `--status-report-only` report (a pid-probed response, never a file), and a published address must ALSO answer when one exists. Pinned by `an app with NO HTTP shell converges on the opener's status report alone`.

**4. (2026-09-05) SERVING and PRESENT are different facts, and the close must be driven by the second.** Trillion sat at `live: true, ready: false, target_count: 0`, holding the one-running-copy lock and never finishing boot. The close was gated on `isServing`, which is FALSE when `ready` is false, so this owner scored `was_running: false`, **skipped the close**, and opened; the new authority then found a lock owner it could not prove and exited CLEANLY with status 0 (`unproven-live-lock-owner`), so the app could neither finish booting nor be replaced, and nothing printed an error. A process that is alive and not ready is the case that MOST needs closing: a serving app is at least usable, a hung one is a deadlock against its own replacement. **Gating recovery on readiness lets the runtime recover only the apps that did not need recovering.** The close now gates on `wasRunning || lastStatus.alive`, and the confirmation is measured against the SAME fact, because waiting only for `!serving()` confirms instantly for a hung owner and reports `close_confirmed: true` while the lock holder is untouched, which is a durable lie rather than a visible failure. Note this file already said "closes if alive" on the files table while the code did not: the documentation was correct and the behaviour had drifted from it. Pinned by `an app that is ALIVE but NOT READY is closed, because it holds the lock against its own replacement` and `a close is NOT confirmed while the lock owner is still alive, however unready it is`. ⚠️ Underneath it sits a second defect this does NOT fix: the shell restarts itself when it exits, so each close spawns a fresh shell that hangs the same way. Recovery loops need `--do-not-restart-shell-when-it-exits` or they chase their own tail.

**2. A close request is QUEUED, not immediate.** After that failure the boot receipts showed `runner-started`, then `owner-close-request-before-ready` 70 seconds later: the earlier close request was still on disk and the NEXT boot's runner consumed it and shut itself down. So a close and a later open can race through a file that outlives both. If an open appears to succeed and the app dies before ready, look for a stale `runtime-app-authority-close-request.json`.

The opener has its own protection worth knowing about: a second open while one is folding returns `activation-in-progress: another launcher is already folding the app-state log`, which is a backoff rather than an error. Do not answer it by firing more opens.

## Invariants

1. The argv is fixed in source; callers supply a validated app id, never arguments.
2. The close is CONFIRMED before the open. A reopen issued too early no-ops as already-open and keeps the stale bundle resident while everything reports success. A fixed delay is the same bug with better odds.
3. No retry loop and no watcher. A loop here is a second scheduler, the shape that already made the engine a second owner of scheduling once. One act, one report, the caller decides.
4. The published transport is read off the opener's status report, never remembered and never from a file of its own. A local app publishes a socket path; no port exists on a customer machine.
5. Not running is a legal starting state.

## What it does NOT do

It does not prove that whatever changed in the handle behaves correctly; that belongs to the changed component's tests. It only reopens the current signed handle and reports what the app actually serves.

## Dependencies

**Depends on:** `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:util`, `fetch`, and the installed runtime kit opener at run time.

**Depended on by:** nothing yet. Pairs with `replace-process-files-in-installed-apps`, which appends the handle this owner converges onto.
