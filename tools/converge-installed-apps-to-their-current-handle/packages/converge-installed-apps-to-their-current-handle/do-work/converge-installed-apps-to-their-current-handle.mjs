// packages/converge-installed-apps-to-their-current-handle/do-work/converge-installed-apps-to-their-current-handle.mjs
//
// PURPOSE
//   Make a running app match its own current open handle. An advance APPENDS a
//   handle and changes nothing that is already running, so a corrected binary
//   reaches the handle and stops there until something does this.
//
// THE PREDICATE IS THE CAPABILITY
//   This is NOT "restart the app". A restart reports success when two commands
//   exit 0. This reports `converged: false` when no address is published after
//   the open, EVEN THOUGH BOTH COMMANDS SUCCEEDED. Process start is never
//   readiness; a re-observed serving address is. If you are tempted to simplify
//   this by trusting the exit codes, you have deleted the only thing here that
//   distinguishes it from a button.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The argv is FIXED IN THIS SOURCE. Callers supply a validated app id, never
//      arguments. Third package to draw this line; an `extraArgs` passthrough is
//      how each of them would become a general exec channel.
//   2. THE CLOSE IS CONFIRMED BEFORE THE OPEN. This is recorded behaviour, not
//      caution: "a raced reopen no-ops as already-open and keeps the resident
//      stale bundle". Everything then reports success while the old binary keeps
//      running, which is indistinguishable from the fix not working. A fixed
//      delay is the same bug with better odds.
//   3. NO RETRY LOOP, NO WATCHER. A loop here is a second scheduler, which is the
//      shape that already made the engine a second owner of scheduling once. One
//      act, one honest report, the caller decides.
//   4. The published transport is READ from the opener's status report, never
//      remembered. A local app publishes a Unix-domain socket path; there is no
//      port anywhere on a customer machine, so nothing here can cache one.
//   5. Not running is a LEGAL starting state, not an error.
//   6. Liveness is asked of the OPENER's status report (a pid-probed response),
//      and the transport it publishes, when one is published, must ALSO answer.
//      An app with no shell at all is not invisible (2026-09-05).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsyncDefault = promisify(execFile);

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The installed runtime kit's opener, NOT a build directory. */
export function installedOpenerPath(home = homedir()) {
  return join(home, ".bitfield", "runtime-kit", "apps-this-computer-can-open", "bin", "open-bitfield-app");
}

/**
 * The transport one app publishes, read off the opener's status report attachments.
 *
 * A local app publishes `forwarding_socket`, the Unix-domain socket its shell serves over. A
 * deployment that declared a TCP listen address publishes `http_url`. An app with no shell (the
 * launcher's surface is a menu-bar item) publishes neither, and that is `null`, not an error.
 */
export function publishedTransport(attachments) {
  const socketPath = nonEmpty(attachments?.forwarding_socket);
  if (socketPath) return { socketPath };
  const url = nonEmpty(attachments?.http_url);
  if (url) return { url };
  return null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Transport addresses remain inside this host lifecycle owner. */
function publicStatus(value) {
  if (Array.isArray(value)) return value.map(publicStatus);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["socketPath", "forwarding_socket", "shell_socket_path", "carrier_socket_path"].includes(key))
      .map(([key, entry]) => [key, publicStatus(entry)]),
  );
  if (typeof value === "string") {
    try { return JSON.stringify(publicStatus(JSON.parse(value))); } catch {}
    return value.replace(/\/[^\s"']*bf-fwd-[^\s"']*\.sock/g, "[private runtime transport]");
  }
  return value;
}

function publicConnection(app, transport) {
  return transport == null ? null : { app_id: app };
}

/**
 * Whether the app is actually SERVING, which is not the same as whether it left
 * a file behind.
 *
 * ⚠️ CORRECTED BY A LIVE RUN, 2026-09-04. The first version treated the presence
 * of `presentation-target.txt` as liveness. That is wrong: the file SURVIVES a
 * close. The real run closed Trillion successfully, the process graph reported
 * `active_process_graph_alive: false`, the address file was still there, so the
 * close was scored as unconfirmed and the app was left DOWN, refusing to reopen.
 *
 * A file is a claim about the past. Only a response is evidence about the
 * present, which is the same rule this repo already applies to readiness: a
 * process being started is never readiness.
 *
 * ⚠️ CORRECTED AGAIN BY A LIVE RUN, 2026-09-05. The second version asked ONLY
 * the HTTP address. The launcher has no HTTP shell (its surface is a menu-bar
 * item), publishes no address, and so read as never running and never
 * converged while the opener reported it running with its status item visible.
 * Readiness had been defined in one app's vocabulary (a port) instead of the
 * runtime's (a live, current resident owner).
 *
 * Now: the opener's own status report is the primary witness. It is computed
 * at call time from the one-running-copy lock owner's pid, so it is a RESPONSE,
 * not a file that outlives a close. A published transport is a SECOND witness
 * that must also answer whenever it exists.
 *
 * ⚠️ CHANGED 2026-09-09 when the port was deleted. The second witness used to be
 * an HTTP address read from `presentation-target.txt`. No file carries an address
 * now; the transport is read off the same status report as `ready`, and for a
 * local app it is a socket path.
 */
export async function isServing({ ready, transport }, { probe } = {}) {
  if (!ready) return false;
  if (transport == null) return true;
  return probe(transport);
}

/** Default probe: the app answers `/boot` over the transport it published. */
async function defaultProbe(transport) {
  try {
    if (transport.socketPath) return await bootAnswersOverSocket(transport.socketPath);
    const response = await fetch(`${transport.url}/boot`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

function bootAnswersOverSocket(socketPath) {
  return new Promise((resolveProbe) => {
    const request = http.request({ socketPath, method: "GET", path: "/boot" }, (incoming) => {
      incoming.resume();
      resolveProbe((incoming.statusCode ?? 0) >= 200 && (incoming.statusCode ?? 0) < 300);
    });
    request.on("error", () => resolveProbe(false));
    request.setTimeout(5000, () => { request.destroy(); resolveProbe(false); });
    request.end();
  });
}

/**
 * The opener's status report for one app, read as `{ alive, ready, attachments }`.
 * `--status-report-only` performs no open and no close; it reads the resident
 * owner's lock, refuses a dead pid, and reports whether that owner is current.
 */
export function statusReportReader(run, openerPath, app, timeoutMs) {
  return async () => {
    try {
      const result = await run(openerPath, ["--status-report-only", "--same-app-id", app], {
        maxBuffer: 1024 * 1024 * 64,
        ...(timeoutMs == null ? {} : { timeout: Number(timeoutMs), killSignal: "SIGKILL" }),
      });
      const report = JSON.parse(String(result.stdout));
      return {
        alive: report.active_process_graph_alive === true,
        ready: report.active_process_graph_ready === true,
        attachments: report.active_shell_attachments ?? null,
        // THE REPORT'S OWN DIAGNOSIS, CARRIED RATHER THAN DISCARDED. The three booleans above
        // answer "may I reuse this owner", which is all convergence needs, and they cannot answer
        // WHY an open then fails. The opener already decides and names it (`stale-active-owner-status`
        // is its report for a ready-looking status file with no live resident owner proof), and
        // that name plus `restart_required` is the whole difference between "it did not come up"
        // and a next action. Reducing a diagnosis to the bits one caller happens to branch on is
        // how a tool ends up unable to explain its own refusal.
        //
        // Additive on purpose: convergence reads `alive`, `ready` and `attachments` and is
        // untouched by these.
        decision: report.decision ?? null,
        restart_required: report.restart_required ?? null,
        last_boot_phase: report.last_boot_phase ?? null,
      };
    } catch (error) {
      // No report is no evidence of a live owner. Never a throw: the caller's
      // observations must still be reported.
      //
      // The reason is kept for the same argument as the fields above. "No report" has an open set
      // of causes (the opener is absent, it timed out, it printed something that is not JSON, the
      // machine refused to spawn it), and a bare `false` makes every one of them look like a
      // confidently dead app.
      return {
        alive: false,
        ready: false,
        attachments: null,
        decision: null,
        restart_required: null,
        last_boot_phase: null,
        no_report_because: String(error?.message ?? error).slice(0, 200),
      };
    }
  };
}

function requireSafeName(value, errorCode) {
  if (value == null || String(value).trim().length === 0) throw new Error(`${errorCode}:absent`);
  if (!SAFE_NAME.test(value)) throw new Error(`${errorCode}:${value}`);
  return value;
}

function requireOptionalTimeout(timeoutMs, code) {
  if (timeoutMs == null) return;
  const value = Number(timeoutMs);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${code}:${timeoutMs}`);
}

/**
 * Wait until `check()` reports the state we need, or give up.
 *
 * Deliberately NOT a retry of the ACT. It re-observes a state the act already
 * caused. Retrying the act is invariant 3; re-observing it is how the predicate
 * gets answered at all.
 */
async function waitFor(check, { attempts, intervalMs, sleep }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return check();
}

export async function convergeOneInstalledAppToItsCurrentHandle({
  opener,
  appId,
  closeAttempts = 30,
  openAttempts = 60,
  intervalMs = 1000,
  spawnTimeoutMs,
  execFileAsync: run = execFileAsyncDefault,
  exists = existsSync,
  probe = defaultProbe,
  status,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  home = homedir(),
} = {}) {
  const openerPath = resolve(opener ?? installedOpenerPath(home));
  const app = requireSafeName(appId, "APP_ID_INVALID");
  requireOptionalTimeout(spawnTimeoutMs, "CONVERGE_TIMEOUT_MS_INVALID");
  if (!exists(openerPath)) throw new Error(`OPENER_ABSENT:${openerPath}`);

  const readStatus = status ?? statusReportReader(run, openerPath, app, spawnTimeoutMs);
  let lastStatus = { alive: false, ready: false, attachments: null };
  const serving = async () => {
    lastStatus = await readStatus();
    return isServing({ ready: lastStatus.ready, transport: publishedTransport(lastStatus.attachments) }, { probe });
  };

  // Liveness is a RESPONSE, never a file. A status file outlives the process.
  const wasRunning = await serving();
  const transportBefore = publishedTransport(lastStatus.attachments);

  let close = null;
  let closeConfirmed = true;
  // ⚠️ CORRECTED A THIRD TIME BY A LIVE RUN, 2026-09-05, and by the same mistake
  // the two notes on `isServing` describe: liveness asked in the wrong vocabulary.
  //
  // SERVING and PRESENT are different facts, and the close must be driven by the
  // second. Trillion sat at `live: true, ready: false, target_count: 0` holding the
  // one-running-copy lock. `serving()` is false when `ready` is false, so this
  // scored `was_running: false`, SKIPPED the close, and opened. The new authority
  // then found a lock owner it could not prove and exited cleanly with status 0
  // (`last_decision=unproven-live-lock-owner`), so the app could neither finish
  // booting nor be replaced, forever, with no error anyone would see.
  //
  // A process that is ALIVE AND NOT READY is the case that MOST needs closing: a
  // serving app is at least usable, a hung one is a deadlock that holds the lock
  // against its own replacement. Gating recovery on readiness means the runtime can
  // only recover apps that did not need recovering.
  if (wasRunning || lastStatus.alive) {
    close = await invocation(run, openerPath, ["--close-this-bitfield-app", "--same-app-id", app], spawnTimeoutMs);
    // INVARIANT 2. Opening before this is confirmed silently no-ops as
    // already-open and keeps the stale bundle resident.
    // The confirmation is measured against the SAME fact the close was gated on.
    // Waiting only for `!serving()` confirms instantly for a hung owner, which
    // would report `close_confirmed: true` while the lock holder is untouched, and
    // that false receipt is worse than the original skip. `serving()` refreshes
    // `lastStatus`, so alive is read after it, never before.
    closeConfirmed = await waitFor(
      async () => !(await serving()) && lastStatus.alive !== true,
      { attempts: closeAttempts, intervalMs, sleep },
    );
    if (!closeConfirmed) {
      return {
        app_id: app,
        was_running: wasRunning,
        transport_before: publicConnection(app, transportBefore),
        transport_after: publicConnection(app, publishedTransport(lastStatus.attachments)),
        attachments_after: publicStatus(lastStatus.attachments),
        close,
        open: null,
        close_confirmed: false,
        converged: false,
      };
    }
  }

  const open = await invocation(run, openerPath, ["--same-app-id", app], spawnTimeoutMs);
  const convergedNow = await waitFor(serving, { attempts: openAttempts, intervalMs, sleep });

  return {
    app_id: app,
    was_running: wasRunning,
    transport_before: publicConnection(app, transportBefore),
    transport_after: publicConnection(app, publishedTransport(lastStatus.attachments)),
    // The facts the process itself wrote (a menu-bar item's on-screen frame, an
    // openable-thing count): the same facts the ship proof reads. Reported, not scored.
    attachments_after: publicStatus(lastStatus.attachments),
    close,
    open,
    close_confirmed: closeConfirmed,
    // The whole point. Not "both commands exited 0", and not "a status file exists".
    converged: convergedNow,
  };
}

/**
 * Release one live app owner without opening anything.
 *
 * This is the install/write boundary that convergence deliberately cannot express:
 * convergence closes and immediately reopens the CURRENT handle, but a replacement
 * bundle must be installed while the old app's exclusive envelope writer is absent.
 * The close is still confirmed from the opener's pid-probed status response; an
 * exited close command is never enough evidence to hand the writer to another owner.
 */
/**
 * Read one installed app's resident-owner status. NO open, NO close, NO effect.
 *
 * WHY THIS EXISTS. This package could converge an app and could close one, and could not be ASKED
 * anything. `statusReportReader` was here and exported, and the front door had no way to reach it,
 * so the only way to learn why an app would not come up was to converge it again, which closes a
 * running app to ask a question. A question that cannot be asked reads exactly like a question with
 * a clean answer, and this is the second time that shape has been found in this set.
 *
 * Measured 2026-09-09, which is what made it worth adding rather than noting: converging `trillion`
 * reported `was_running: false` and then an open that exited 1 with
 * `last_decision=stale-active-owner-status restart_required=true`. Reading that without performing
 * a close was not possible from any declared front door.
 */
export async function readOneInstalledAppsStatus({
  opener,
  appId,
  spawnTimeoutMs,
  execFileAsync: run = execFileAsyncDefault,
  exists = existsSync,
  status,
  home = homedir(),
} = {}) {
  const openerPath = resolve(opener ?? installedOpenerPath(home));
  const app = requireSafeName(appId, "APP_ID_INVALID");
  requireOptionalTimeout(spawnTimeoutMs, "CONVERGE_TIMEOUT_MS_INVALID");
  if (!exists(openerPath)) throw new Error(`OPENER_ABSENT:${openerPath}`);

  const readStatus = status ?? statusReportReader(run, openerPath, app, spawnTimeoutMs);
  const report = await readStatus();
  return {
    app_id: app,
    ...publicStatus(report),
    // Reported beside `alive` on purpose, because the pair is the finding. A transport present with
    // `alive: false` is exactly the state that makes a dead app look reachable, and it is what sent
    // a session chasing a blocked network for an app that was simply not running.
    published_transport: publicConnection(app, publishedTransport(report.attachments)),
  };
}

export async function closeOneInstalledAppToReleaseItsWriter({
  opener,
  appId,
  closeAttempts = 30,
  intervalMs = 1000,
  spawnTimeoutMs,
  execFileAsync: run = execFileAsyncDefault,
  exists = existsSync,
  status,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  home = homedir(),
} = {}) {
  const openerPath = resolve(opener ?? installedOpenerPath(home));
  const app = requireSafeName(appId, "APP_ID_INVALID");
  requireOptionalTimeout(spawnTimeoutMs, "CONVERGE_TIMEOUT_MS_INVALID");
  if (!exists(openerPath)) throw new Error(`OPENER_ABSENT:${openerPath}`);

  const readStatus = status ?? statusReportReader(run, openerPath, app, spawnTimeoutMs);
  let lastStatus = await readStatus();
  const wasRunning = lastStatus.alive === true;
  let close = null;
  let closeConfirmed = !wasRunning;

  if (wasRunning) {
    close = await invocation(run, openerPath, ["--close-this-bitfield-app", "--same-app-id", app], spawnTimeoutMs);
    closeConfirmed = await waitFor(
      async () => {
        lastStatus = await readStatus();
        return lastStatus.alive !== true;
      },
      { attempts: closeAttempts, intervalMs, sleep },
    );
  }

  return {
    app_id: app,
    was_running: wasRunning,
    close,
    close_confirmed: closeConfirmed,
    released: closeConfirmed,
    final_status: publicStatus(lastStatus),
  };
}

async function invocation(run, command, args, timeoutMs) {
  try {
    const result = await run(command, args, {
      maxBuffer: 1024 * 1024 * 256,
      ...(timeoutMs == null ? {} : { timeout: Number(timeoutMs), killSignal: "SIGKILL" }),
    });
    return { ok: true, command, args, stdout: publicStatus(result.stdout), stderr: publicStatus(result.stderr) };
  } catch (error) {
    // A close or open that FAILS is reported, not thrown, because the caller
    // needs the address observations alongside it to know what actually happened.
    return {
      ok: false,
      command,
      args,
      stdout: publicStatus(String(error.stdout ?? "")),
      stderr: publicStatus(String(error.stderr ?? error.message ?? "")),
    };
  }
}
