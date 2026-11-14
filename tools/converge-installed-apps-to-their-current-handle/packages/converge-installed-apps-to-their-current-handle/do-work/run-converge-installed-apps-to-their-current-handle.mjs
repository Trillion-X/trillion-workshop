#!/usr/bin/env node
// The front door. It takes a LIST of apps, because the worker beside it converges one and how
// many is the caller's business rather than this package's.
//
// It used to take a single `--app-id`, and not because anyone decided the capability was
// singular. The package was called `converge-ONE-installed-app-...`, and every layer down to this
// file grew to agree with a word. Converging a fleet meant running the tool N times and reading N
// outputs, and no fleet-wide answer existed because no signature could express one. The name came
// off on 2026-09-05; this is the signature that was underneath it.

import {
  closeOneInstalledAppToReleaseItsWriter,
  convergeOneInstalledAppToItsCurrentHandle,
  readOneInstalledAppsStatus,
} from "./converge-installed-apps-to-their-current-handle.mjs";

/** Every value given to a repeatable flag, in the order given. */
function every(name) {
  const values = [];
  process.argv.forEach((token, at) => {
    if (token !== name) return;
    const value = process.argv[at + 1];
    if (value == null || value.trim().length === 0) throw new Error(`${name} requires a value`);
    values.push(value.trim());
  });
  return values;
}

/** Optional single flag. Absent means absent, never a substituted default. */
function optional(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (value == null || value.trim().length === 0) throw new Error(`${name} requires a value`);
  return value;
}

try {
  const appIds = every("--app-id");
  if (appIds.length === 0) throw new Error("at least one --app-id is required");
  const duplicated = appIds.filter((id, at) => appIds.indexOf(id) !== at);
  if (duplicated.length > 0) {
    // Refused rather than de-duplicated. Converging the same app twice in one run means the
    // caller's list is wrong, and silently collapsing it hides which of their two sources of
    // truth was the bad one.
    throw new Error(`the same app is listed twice: ${[...new Set(duplicated)].join(", ")}`);
  }

  const opener = optional("--opener");
  const spawnTimeoutMs = optional("--timeout-ms");
  const closeOnly = process.argv.includes("--close-only");
  // The third mode, and the only one that causes NOTHING. Asking used to require converging, which
  // closes a running app to answer a question about it, so the cheapest question was the most
  // expensive act. Refused together rather than silently ranked, because a caller who typed both
  // wants two different things and picking one for them is how a report ends up describing an act
  // nobody asked for.
  const statusOnly = process.argv.includes("--status-only");
  if (statusOnly && closeOnly) throw new Error("--status-only and --close-only ask for different things; choose one");

  const each = [];
  for (const appId of appIds) {
    // Sequentially, and that is a decision rather than an oversight. Each convergence CLOSES and
    // REOPENS an app, and the close must land before the open or the reopen no-ops as already-open
    // and keeps the stale bundle resident while reporting success. Running two of those at once
    // puts two openers against one machine's pointer state for no gain a person waiting on a fleet
    // would notice.
    try {
      // One try per app, so a failure isolates to its own app instead of abandoning the rest of
      // the list. A run that stops at the first failure makes a caller discover their problems one
      // per run, which for a fleet is the same as not having a fleet command.
      const forOneApp = {
        appId,
        ...(opener == null ? {} : { opener }),
        ...(spawnTimeoutMs == null ? {} : { spawnTimeoutMs }),
      };
      let report;
      if (statusOnly) report = await readOneInstalledAppsStatus(forOneApp);
      else if (closeOnly) report = await closeOneInstalledAppToReleaseItsWriter(forOneApp);
      else report = await convergeOneInstalledAppToItsCurrentHandle(forOneApp);
      each.push({ appId, ...report });
    } catch (error) {
      each.push({ appId, converged: false, error: error.message });
    }
  }

  // WHAT COUNTS AS SUCCESS DEPENDS ON WHAT WAS ASKED FOR, and for the read it is NOT that the app
  // is up. An app being down is a perfectly good ANSWER, and failing the run on it would make the
  // one mode that causes nothing report a problem with the world rather than with the question. The
  // read fails only when it could not ASK: the opener threw, or the status reader came back with no
  // report and said why. Same shape as the other two, different predicate, which is why the word is
  // computed rather than assumed.
  const predicate = statusOnly ? "answered" : closeOnly ? "released" : "converged";
  const succeeded = (one) => (statusOnly
    ? one.error === undefined && one.no_report_because === undefined
    : one[predicate] === true);
  const notConverged = each.filter((one) => !succeeded(one)).map((one) => one.appId);
  process.stdout.write(`${JSON.stringify({
    asked: appIds.length,
    [predicate]: appIds.length - notConverged.length,
    // Named, not counted. A fleet answer whose failures are a number sends the reader back to
    // read every entry to find out which ones, which is the work the fleet command exists to save.
    [statusOnly ? "not_answered" : "not_converged"]: notConverged,
    each,
  }, null, 2)}\n`);

  // The EXIT CODE follows the predicate, not the commands, and for a list it follows EVERY
  // predicate. A caller who only checks the exit code cannot mistake a started process for a
  // serving one, and now cannot mistake a partly-converged fleet for a converged one either.
  if (notConverged.length > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
}
