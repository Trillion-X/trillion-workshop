// computer/isolated-run.mjs
//
// PURPOSE
//   Runs one Mac tool call in a worker thread of its own, with a heap cap and a wall-clock limit, so a tool that hangs,
//   leaks or crashes ends only its own run and never the host that holds the other runs. Which tools run this way, and
//   with which limits, is a row in computer/mac-tools.json (`isolate` on a tools row); a tool with no row runs in the host
//   as before.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: this file names no tool. The module, export and name come from the tools row, and the limits from its
//      `isolate` row (timeout_ms, max_old_generation_mb, stop_grace_ms).
//   2. One run id is one live run: a second start with an id still running is refused, never joined or doubled.
//   3. Stopping is two steps: the worker is asked to stop, and terminated after stop_grace_ms if it has not.
//   4. Sleep ends runs: while any run is live a watchdog ticks every `sleep_check_ms`; a tick that arrives later than
//      `sleep_gap_ms` means the Mac slept, and every live run is stopped (a run begun before sleep must not resume into a
//      world that moved on). `stopAll` does the same on demand.
//   5. Nothing but plain data crosses: the call's input and a plain subset of its context go in, the tool's answer or a
//      refusal (message, status, retry) comes out. A malformed answer or a worker that vanished is a refusal in words.
//
import { Worker } from 'node:worker_threads';

const WORKER = new URL('./isolated-run-worker.mjs', import.meta.url);
const live = new Set();
const stoppers = new Map();
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const refusal = (message, status, retry) => Object.assign(new Error(message), { status, retry });

/** The ids of runs in flight, so tests and the host can see that a stopped run left nothing behind. */
export const liveRuns = () => [...live];

let watchdog = null;
function watch(isolate) {
  if (watchdog || !(isolate.sleep_gap_ms > 0)) return;
  let last = Date.now();
  watchdog = setInterval(() => {
    const late = Date.now() - last - isolate.sleep_check_ms;
    last = Date.now();
    if (late > isolate.sleep_gap_ms) stopAll('asleep');
  }, isolate.sleep_check_ms);
  watchdog.unref();
}

/** Stops every live run now (the Mac slept, or the host is ending); each one's caller gets a refusal in words. */
export function stopAll(reason = 'stopped') {
  for (const stop of [...stoppers.values()]) stop(reason);
}

export function runIsolated({ id, module, export: exported, name, input, context = {}, isolate, words }) {
  if (live.has(id)) return Promise.reject(refusal(fill(words.isolated_duplicate, { id }), 409, false));
  live.add(id);
  watch(isolate);
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { module, exported, name, input, context },
      resourceLimits: { maxOldGenerationSizeMb: isolate.max_old_generation_mb } });
    let settled = false, killer = null, stopping = false;
    const tooSlow = () => refusal(fill(words.isolated_timeout, { id, seconds: Math.round(isolate.timeout_ms / 1000) }), 504, true);
    const done = (finish, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killer);
      live.delete(id); stoppers.delete(id);
      if (!live.size && watchdog) { clearInterval(watchdog); watchdog = null; }
      worker.terminate().catch(() => {});
      finish(value);
    };
    stoppers.set(id, reason => done(reject, refusal(fill(reason === 'asleep' ? words.isolated_asleep : words.isolated_stopped, { id }), 503, true)));
    const timer = setTimeout(() => {
      stopping = true;
      worker.postMessage({ stop: true });
      killer = setTimeout(() => done(reject, tooSlow()), isolate.stop_grace_ms);
    }, isolate.timeout_ms);
    worker.once('message', message => {
      if (message?.ok === true) done(resolve, message.value);
      else if (message?.error) done(reject, Object.assign(new Error(message.error.message), { status: message.error.status, retry: message.error.retry,
        reaction: message.error.reaction, reaction_said: message.error.reaction_said, outcome: message.error.outcome }));
      else done(reject, refusal(fill(words.isolated_malformed, { id }), 502, true));
    });
    worker.once('error', error => done(reject, error?.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? refusal(fill(words.isolated_memory, { id, mb: isolate.max_old_generation_mb }), 507, false)
      : refusal(fill(words.isolated_failed, { id, error: String(error?.message ?? error).slice(0, 200) }), 502, true)));
    worker.once('exit', () => done(reject, stopping ? tooSlow() : refusal(fill(words.isolated_gone, { id }), 502, true)));
  });
}
