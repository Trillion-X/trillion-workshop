// computer/pace.mjs
//
// Purpose
//   How often this computer's reader looks, as a pace that follows what the computer is doing: a laptop on battery that
//   nobody is using looks slowly, the one in use and on power looks at the base pace. The reader (read-this-computer.mjs)
//   asks for its next wait after every look, so the pace changes as soon as the computer's state does.
//
// Non-negotiable invariants
//   1. The state names, the commands that sense them, the patterns that read their output and the multipliers are DATA
//      (computer-sources.json `pace`). This file names no power source, no idle limit and no multiplier.
//   2. A row matches when every key of its `when` equals the sensed state; the first matching row decides; a row with
//      no `when` matches everything. Nothing matching means the base pace.
//   3. A state that cannot be sensed (the command failed or its output did not match) is not guessed: it is left out of
//      the state, so a row that needs it does not match and the pace never slows on a guess.
//   4. Sensing runs at most once per `sense_every_seconds`, whatever the number of timers asking.
//   5. Sensing only reads: it runs the listed commands (no shell) and keeps nothing.
//
import { execFile } from 'node:child_process';

/**
 * The sensed state ({ [name]: value }) from the `sense` rows: { name, command[], pattern, map? | threshold? }. The
 * pattern's first group is read as text (`map` turns it into the value) or as a number (`threshold`: { above, is,
 * otherwise } is `is` above the number, `otherwise` at or below it). run(command[]) → output text (or throws).
 */
export async function senseState(sense, run = runCommand) {
  const state = {};
  for (const row of sense ?? []) {
    try {
      const found = new RegExp(row.pattern).exec(await run(row.command));
      if (!found) continue;
      const value = row.threshold
        ? (Number(found[1]) > row.threshold.above ? row.threshold.is : row.threshold.otherwise)
        : row.map?.[found[1]];
      if (value !== undefined && !Number.isNaN(value)) state[row.name] = value;
    } catch { /* a state that cannot be sensed stays out of the state (invariant 3) */ }
  }
  return state;
}

/** The multiplier of the first row whose `when` the state holds (1 when none does). */
export const multiplierFor = (state, rows) => rows.find(row => Object.entries(row.when ?? {}).every(([name, value]) => state[name] === value))?.multiply ?? 1;

/**
 * A repeating look at a base pace that follows the computer's state: look(), then wait base × the multiplier now.
 * pace: computer-sources.json `pace`; senseNow(): the sensed state (defaults to senseState over pace.sense);
 * timers: { set(fn, ms), clear(handle) } (defaults to the global timers, unref'd). → { stop }.
 */
export function pacedEvery(look, baseSeconds, pace, { senseNow = () => senseState(pace.sense), timers = { set: (fn, ms) => setTimeout(fn, ms).unref?.() ?? 0, clear: clearTimeout }, now = Date.now } = {}) {
  let handle = null, stopped = false, sensed = { at: -Infinity, state: {} };
  const state = async () => {
    if (now() - sensed.at >= pace.sense_every_seconds * 1000) sensed = { at: now(), state: await senseNow() };
    return sensed.state;
  };
  const arm = async () => {
    if (stopped) return;
    const wait = baseSeconds * multiplierFor(await state(), pace.rows) * 1000;
    if (!stopped) handle = timers.set(next, wait);
  };
  const next = async () => {
    try { await look(); } finally { await arm(); }
  };
  arm();
  return { stop() { stopped = true; if (handle !== null) timers.clear(handle); } };
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    execFile(command[0], command.slice(1), { encoding: 'utf8', timeout: 5000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}
