// harness/wake-handlers/take-open-work.mjs
//
// Purpose
//   A handler for harness/wake-sessions.mjs that hands work given to no agent in particular to the taker,
//   harness/take-open-work.mjs (its default export runs one pass: claim, run the person's chosen AI headless, record).
//   Trillion tells every reachable agent about such work (handoff.created with no handed_to); this takes the one sent to
//   the computer's own agent, so each piece of open work starts one pass on this computer. Work that could not start
//   when it was announced (every slot busy, the day's limit spent) is not left until it is announced again: a pass over
//   all the waiting work runs when the helper starts, every full_pass_every_minutes (take-open-work.json), and as soon
//   as the runs a pass started have ended, so a freed slot is filled at once, highest priority first. A full pass that
//   sorted nothing and started nothing doubles the wait before the next one, up to idle_pass_most_minutes; new work
//   announced on the stream, or a pass that did something, brings it back to full_pass_every_minutes.
//
// Non-negotiable invariants
//   1. One full pass at a time: a pass asked for while one runs starts once that one ends, never beside it.
//   2. Nothing runs without the person's chosen AI on this computer (chosen-ai.mjs).
//   3. One timer: starting again (the person chose another AI) stops the earlier one.
//   4. An idle account is looked at less and less often; the stream, never the timer, is how new work arrives.
//
import takeOpenWork, { readSettings } from '../take-open-work.mjs';
import { chosenAi } from '../chosen-ai.mjs';

/** One full pass at a time: asked for while one runs, it runs once more after that one ends. Resolves when it ends. */
export function passer({ run, log = () => {} }) {
  let going = null;
  let again = false;
  const pass = () => {
    if (going) { again = true; return going; }
    going = Promise.resolve().then(run).catch(error => log(`Waiting work could not start: ${error.message}`))
      .finally(() => { going = null; if (again) { again = false; pass(); } });
    return going;
  };
  return pass;
}

/**
 * The wait before the next full pass: full_pass_every_minutes after a pass that did something or new work arriving,
 * doubled after each idle pass up to idle_pass_most_minutes.
 */
export function passWait({ every_minutes, most_minutes }) {
  let minutes = every_minutes;
  return {
    after(result) { minutes = result?.idle ? Math.min(most_minutes, minutes * 2) : every_minutes; return minutes; },
    woken() { minutes = every_minutes; return minutes; },
    minutes: () => minutes,
  };
}

let fullPass = null;
let timer = null;
let wait = null;
let schedule = () => {};

export const wants = ({ event, helper, taker }) => Boolean(helper || taker) && event.type === 'handoff.created' && !event.refs?.handed_to;

export const handle = ({ event, key, origin }) => {
  // New work on the stream: the account is no longer idle, so the next full pass comes at the usual time.
  const waited = wait?.minutes();
  if (wait && wait.woken() !== waited) schedule();
  return takeOpenWork(event, null, key, origin, { afterRuns: () => fullPass?.() });
};

// The helper also takes work that was already waiting before this computer connected, and looks again on a timer.
export const start = ({ key, origin, rules, log }) => {
  if (!chosenAi(rules)) return null;
  // Started again (the person chose another AI): the earlier timer stops, so one timer runs.
  clearTimeout(timer);
  const settings = readSettings();
  wait = passWait({ every_minutes: settings.full_pass_every_minutes, most_minutes: settings.idle_pass_most_minutes ?? settings.full_pass_every_minutes });
  schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(fullPass, wait.minutes() * 60_000);
    timer.unref?.();
  };
  fullPass = passer({ run: async () => {
    try { wait.after(await takeOpenWork(null, null, key, origin, { afterRuns: () => fullPass() })); }
    finally { schedule(); }
  }, log });
  fullPass();
  return timer;
};
