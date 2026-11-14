import { requiredCover } from 'trillion-workshop/tools/hold-one-thing-until-done/read-data/required-cover.mjs';

// The required-setup gate retries only while incomplete. Once complete, the existing live store socket and page
// visibility event keep it current without a timer. The read latch preserves a change that arrives during a read.
export function watchRequiredSetup({ initialComplete, intervalMs, read, onFailure, listen, page, timers = window }) {
  let alive = true;
  let reading = false;
  let rerun = false;
  let timer = null;
  const stopPolling = () => {
    if (timer === null) return;
    timers.clearInterval(timer);
    timer = null;
  };
  const startPolling = () => {
    if (timer === null) timer = timers.setInterval(() => { void refresh(); }, intervalMs);
  };
  const refresh = async () => {
    if (!alive) return;
    if (reading) { rerun = true; return; }
    reading = true;
    try {
      const complete = await read(() => alive);
      if (alive && typeof complete === 'boolean') {
        if (complete) stopPolling();
        else startPolling();
      }
    } catch {
      if (alive) onFailure?.();
    } finally {
      reading = false;
      if (rerun && alive) { rerun = false; void refresh(); }
    }
  };
  const changed = () => { void refresh(); };
  const stopListening = listen(changed);
  const shown = () => { if (page.visibilityState === 'visible') changed(); };
  page.addEventListener('visibilitychange', shown);
  if (initialComplete !== true) startPolling();
  void refresh();
  return () => {
    alive = false;
    stopPolling();
    stopListening();
    page.removeEventListener('visibilitychange', shown);
  };
}

/** The cover the page locks on while required setup is not done, from `setupSteps` (src/setup-steps.json) and the offered
 *  screens: { key, screen, admit, everySeconds }. An installed build once paired a setup-steps.json that had lost its
 *  gate with the hold component, so the gate's key was undefined and the lock never engaged; every part is read here
 *  and a missing part still covers. The key is the moved cover decision's (requiredCover: the gate's key, else its
 *  default); the screen is the gate's, else the offered screen the Get started read (`readPath`, its last part) opens;
 *  the admitted surfaces are none; the read interval is the gate's, else `fallbackSeconds`. */
export function coverOf(setupSteps, offered, readPath, fallbackSeconds) {
  const gate = setupSteps?.gate && typeof setupSteps.gate === 'object' ? setupSteps.gate : {};
  const named = String(readPath ?? '').split('/').pop();
  const screen = typeof gate.screen === 'string' && gate.screen ? gate.screen
    : (offered ?? []).find(row => row?.surface_input?.screen === named)?.id ?? null;
  return {
    key: requiredCover(null, gate).key,
    screen,
    admit: Array.isArray(gate.admit_surfaces) ? gate.admit_surfaces : [],
    everySeconds: Number.isFinite(gate.read_every_seconds) && gate.read_every_seconds > 0 ? gate.read_every_seconds : fallbackSeconds,
  };
}
