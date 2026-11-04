// computer/program-host.mjs
//
// PURPOSE
//   Starts and stops the programs this Mac runs for its person's Trillion according to what the account has installed.
//   The Mac helper (harness/wake-sessions.mjs, through computer/mac-tools.mjs) asks the account which Marketplace
//   configurations it follows (GET /mcp/api/marketplace/configurations/installations), takes the tool components of the
//   installation rows whose `follows` starts with "trillion-" (Trillion's own starting set), and runs exactly the
//   programs and publishes exactly the tools those components name. It writes the answer to
//   ~/.trillion/installed-programs.json, which the computer reader reads to start the pieces it hosts itself
//   (read-this-computer.mjs gates), and gives the Mac's card the same set of skills.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Recipes are DATA in computer/mac-tools.json `programs`, shipped inside the signed app, and never come from the
//      server: an installation row can only name a tool id; the program that id starts is the one the app carries. A
//      tool id with no recipe here starts nothing.
//   2. Compatibility: with no installation row whose `follows` starts with the prefix (no starting set installed on this
//      account), with a read that failed, or with the Mac offline, the Mac behaves as it did before this file existed:
//      the legacy programs (settings.program_host.legacy) run, every tool is published, and every piece the reader
//      hosts runs. A failed or offline read uses the last saved file; with none saved, the legacy set.
//   3. A Mac never stops anything because a read failed. Only a read the account answered can remove a program, and a
//      failed read keeps what is running and may only start what the saved or legacy set names.
//   4. Every program it starts is this process's child, gets the account key as the first line of its standard input
//      (never on a command line, in a file or in a log), and ends with this process (computer/end-with-the-app.mjs in
//      the program, plus a stop signal from here), so a replaced helper never leaves its programs beside the new one's.
//   5. Programs are started only by a helper the app started (it was given the key on standard input); a helper run by
//      hand or by launchd records the installed set and publishes by it but starts no program, as it did not before.
//   6. A program that fails to stay up `quick_failures_before_degrade` times in a row (a run shorter than its
//      restart_seconds.steady_seconds; DATA on the program, else on program_host; absent means it is restarted without
//      end) is left stopped and reported degraded (status().degraded, one `program_degraded` log line). The next look at
//      the account that the account answered gives it a fresh start. Bounded restarts, then an honest degraded state,
//      instead of a crash loop that only the backoff slows.
//
// SECURITY
//   The key is written to a child's standard input and sent only to the account's own origin by the caller handed in.
//   The saved file holds tool and program ids only, never the key.
//
import { spawn as spawnProcess } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentToolId } from '../src/renamed-tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SAVED_VERSION = 1;

export const installedProgramsFile = (settings, home = homedir()) => join(home, settings.program_host.file);

const insideIds = settings => Object.entries(settings.programs ?? {}).filter(([, recipe]) => recipe.inside).map(([id]) => id);

/** What a Mac with no starting set installed runs: the legacy programs, every legacy tool, every piece the reader hosts. */
export const legacyDesired = settings => ({ version: SAVED_VERSION, followed: false,
  programs: [...settings.program_host.legacy, ...insideIds(settings)], tools: null });

/** The desired set from the account's installation rows ({ id, context, follows, components, without, removed_at }). */
export function desiredFor(settings, installations) {
  const host = settings.program_host;
  const rows = (Array.isArray(installations) ? installations : []).filter(row => row && !row.removed_at && !row.pursuit_id
    && typeof row.follows === 'string' && row.follows.startsWith(host.follows_prefix) && Array.isArray(row.components));
  if (!rows.length) return legacyDesired(settings);
  const ids = new Set(rows.flatMap(row => {
    const without = new Set(Array.isArray(row.without) ? row.without.map(currentToolId) : []);
    return row.components.filter(component => component?.kind === 'tool' && typeof component.id === 'string' && !without.has(currentToolId(component.id))).map(component => currentToolId(component.id));
  }));
  const programs = Object.entries(settings.programs ?? {}).filter(([, recipe]) => (recipe.inside && recipe.follow === 'always') || ids.has(currentToolId(recipe.tool_id))).map(([id]) => id);
  return { version: SAVED_VERSION, followed: true, programs, tools: Object.keys(settings.tools).filter(id => ids.has(currentToolId(id))) };
}

const valid = value => Boolean(value) && typeof value === 'object' && value.followed !== undefined && typeof value.followed === 'boolean'
  && Array.isArray(value.programs) && (value.tools === null || Array.isArray(value.tools));

/** The last saved set, or null when there is none or it cannot be read. */
export function savedDesired(file, read = readFileSync) {
  try { const value = JSON.parse(read(file, 'utf8')); return valid(value) ? value : null; } catch { return null; }
}

/**
 * The programs the saved file says this Mac runs, or null for "everything" (no file, a file that cannot be read, or the
 * legacy set): what the computer reader asks before it starts a piece it hosts.
 */
export function installedPrograms(file, read = readFileSync) {
  const saved = savedDesired(file, read);
  return saved?.followed ? saved.programs : null;
}

/** The reader's pieces that a program id gates: { piece: program id }, from the reader's recipe. */
export const readerGates = settings => settings.programs?.reader?.gates ?? {};

function writeAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  renameSync(part, file);
}

/**
 * The host. call(path, body, method) reaches /mcp/api; manage says whether to start and stop programs (a helper the app
 * started) or only to record the set. spawn, timers and the file are handed in so the whole of it can be tested.
 */
export function makeProgramHost({ settings, call, key = '', manage = true, spawn = spawnProcess, execPath = process.execPath, base = HERE,
  file = installedProgramsFile(settings), read = readFileSync, write = writeAtomic, timers = { setTimeout, clearTimeout }, now = Date.now, log = () => {} }) {
  const host = settings.program_host;
  const running = new Map();
  const waits = new Map();
  // Programs that failed to stay up `quick_failures_before_degrade` times in a row are left stopped (degraded) until the
  // next look at the account; `quick` counts each program's consecutive runs shorter than its steady_seconds.
  const quick = new Map();
  const degraded = new Set();
  // A program that keeps dying is given up on for a while: its recent exits, and until when it is let alone.
  const exits = new Map();
  const gaveUp = new Map();
  let current = null;
  let stopped = false;
  let lastWritten = null;

  const wait = (id, ranFor) => {
    const policy = settings.programs[id].restart_seconds ?? { first: 2, most: 60, steady_seconds: 60 };
    const next = ranFor >= policy.steady_seconds * 1000 || !waits.has(id) ? policy.first : Math.min(waits.get(id) * 2, policy.most);
    waits.set(id, next);
    return next;
  };

  function launch(id) {
    const recipe = settings.programs[id];
    if (stopped || !manage || !recipe?.entry || running.has(id) || degraded.has(id) || !current?.programs.includes(id)) return;
    // Resting after too many exits: not started again until its rest has passed (a later look at the account or resume starts it).
    if (gaveUp.has(id)) {
      if (now() < gaveUp.get(id)) return;
      gaveUp.delete(id);
      exits.delete(id);
      log({ program_trying_again: id });
    }
    let child;
    try { child = spawn(execPath, [join(base, recipe.entry), ...(recipe.args ?? [])], { stdio: ['pipe', 'inherit', 'inherit'] }); }
    catch (error) { log({ program_start_failed: id, error: String(error.message ?? error) }); return; }
    const state = { child, startedAt: now(), ending: false, timer: null, killer: null };
    running.set(id, state);
    child.stdin?.on?.('error', () => {});
    child.stdin?.end?.(`${key}\n`);
    log({ program_started: id });
    let gone = false;
    const exited = () => {
      if (gone) return;
      gone = true;
      clearTimeout(state.killer);
      running.delete(id);
      if (stopped || state.ending || !current?.programs.includes(id)) return;
      const policy = recipe.restart_seconds ?? {};
      const steady = now() - state.startedAt >= (policy.steady_seconds ?? 60) * 1000;
      quick.set(id, steady ? 0 : (quick.get(id) ?? 0) + 1);
      const limit = recipe.quick_failures_before_degrade ?? host.quick_failures_before_degrade ?? null;
      if (limit !== null && quick.get(id) >= limit) {
        degraded.add(id);
        log({ program_degraded: id, quick_failures: quick.get(id) });
        return;
      }
      // restart_seconds.budget { restarts, within_seconds, rest_seconds } (DATA): more exits than `restarts` inside
      // `within_seconds` means it is given up on for `rest_seconds`, and said so (status.gave_up_until).
      const budget = settings.programs[id].restart_seconds?.budget;
      if (budget) {
        const recent = [...(exits.get(id) ?? []), now()].filter(at => now() - at < budget.within_seconds * 1000);
        exits.set(id, recent);
        if (recent.length > budget.restarts) {
          gaveUp.set(id, now() + budget.rest_seconds * 1000);
          log({ program_given_up: id, exits: recent.length, rests_seconds: budget.rest_seconds });
          return;
        }
      }
      const seconds = wait(id, now() - state.startedAt);
      log({ program_exited: id, again_in_seconds: seconds });
      const entry = { timer: null };
      entry.timer = timers.setTimeout(() => { running.delete(id); launch(id); }, seconds * 1000);
      running.set(id, { ...state, child: null, timer: entry.timer, waiting: true });
    };
    child.once('exit', exited);
    child.once('error', exited);
  }

  function end(id) {
    const state = running.get(id);
    if (!state) return;
    state.ending = true;
    if (state.timer) timers.clearTimeout?.(state.timer);
    if (state.waiting) { running.delete(id); return; }
    try { state.child?.kill?.('SIGTERM'); } catch { /* already gone */ }
    state.killer = setTimeout(() => { try { state.child?.kill?.('SIGKILL'); } catch { /* already gone */ } }, (host.stop_grace_seconds ?? 5) * 1000);
    state.killer.unref?.();
  }

  const save = next => {
    const text = JSON.stringify(next);
    if (text === lastWritten) return;
    try { write(file, next); lastWritten = text; } catch (error) { log({ program_host_save_failed: String(error.message ?? error) }); }
  };

  /** After fresh account verification, resume the permitted set without waiting for an optional installation read. */
  function resume() {
    if (stopped) return current;
    current ??= savedDesired(file, read) ?? legacyDesired(settings);
    for (const id of current.programs) launch(id);
    return current;
  }

  /** One look at the account. Never throws; a failed read changes nothing that is running. */
  async function reconcile() {
    if (stopped) return current;
    let next, fresh = false;
    try {
      const answer = await call(host.installations_route, undefined, 'GET');
      if (!Array.isArray(answer?.installations)) throw new Error('the account did not list its installations');
      next = desiredFor(settings, answer.installations);
      fresh = true;
    } catch (error) {
      log({ program_host_read_failed: String(error.message ?? error) });
      next = current ?? savedDesired(file, read) ?? legacyDesired(settings);
    }
    if (stopped) return current;
    const leaving = fresh ? [...running.keys()].filter(id => !next.programs.includes(id)) : [];
    if (fresh) { degraded.clear(); quick.clear(); }
    current = next;
    if (fresh) save(next);
    for (const id of leaving) end(id);
    for (const id of next.programs) launch(id);
    return current;
  }

  /** The tool ids to publish: null while the legacy set is in force (every legacy tool). */
  const toolIds = () => (current?.followed ? current.tools : null);

  const status = id => {
    const state = running.get(id);
    const resting = gaveUp.has(id) && now() < gaveUp.get(id);
    return { running: Boolean(state && !state.waiting), wanted: Boolean(current?.programs.includes(id)), followed: current?.followed ?? null, managed: manage, degraded: degraded.has(id),
      ...(resting ? { gave_up_until: new Date(gaveUp.get(id)).toISOString() } : {}) };
  };

  async function stop() {
    stopped = true;
    for (const id of [...running.keys()]) end(id);
  }
  // A synchronous last word, for the process exiting: the children also end on their own when their parent is gone.
  const killAll = () => { for (const state of running.values()) { try { state.child?.kill?.('SIGTERM'); } catch { /* already gone */ } } };

  return { resume, reconcile, toolIds, status, stop, killAll, desired: () => current, running: () => [...running.entries()].filter(([, state]) => !state.waiting).map(([id]) => id) };
}

// The host in force, so the tools that answer for a program (tool:read-a-computer, ...) can say how it is going.
let live = null;
export const registerHost = host => { live = host; };
const programTool = id => async () => (live ? { program: id, ...live.status(id) } : { program: id, running: false, wanted: null, followed: null, managed: false });
export const programTools = { reader: programTool('reader'), connections: programTool('connections') };

/** Whether the helper was started by the app (it was given the key on standard input), the only helper that starts programs. */
export const startedByApp = (settings, argv = process.argv) => argv.includes(settings.program_host.app_flag);
