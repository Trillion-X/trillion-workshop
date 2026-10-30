// tools/headless-browser/virtual-clock.mjs
//
// A PAGE'S CLOCK THAT MOVES ONLY WHEN TOLD, SO A RECORDING IS THE SAME EVERY TIME AND EVERY FRAME IS WHERE ITS TIME SAYS.
//
// Purpose: a recorder that watches a page in real time gets whatever frames the machine managed to paint, at whatever moments.
// With the page's virtual time paused and moved forward one frame at a time, timers, animation frames, CSS and Web animations,
// `Date.now()` and `performance.now()` all advance together by exactly one frame, a picture is taken, and the next frame begins.
// The same steps then give the same frames, whatever load the machine is under, and a demo or a regression video can be compared.
//
// Non-negotiable invariants:
//   1. The page's time moves only inside `sleep`, `advance` and `live`; between them it is paused.
//   2. Frames are taken on the grid `index / fps` seconds of virtual time; `sleep(ms)` takes every frame that falls inside the
//      time it moves, in order, and ends exactly at the requested time.
//   3. `now()` is the virtual time in seconds and never reads a real clock.
//   4. An input (a hover, a press, a key) is answered only after some of the page's time passes, so `input(work)` sends it and
//      then moves a fixed `ms` of virtual time; the same input always costs the same time.
//   5. `live(work)` lets the page's own time run while `work` loads or navigates (a network wait cannot be stepped), then pauses
//      it again however `work` ends. Virtual time does not advance during it.
//   6. The browser is driven only through `send(method, params)` and `on(listener)`, both handed in (tools/headless-browser/devtools.mjs).
//
// Key concept: `createVirtualClock({ browser, fps, capture })` -> { start, now, sleep, advance, input, live }.
//   `capture(t, index)` is asked to keep the frame for virtual second `t`.

import deterministic from './deterministic-switches.json' with { type: 'json' };

/** The switches to start the browser with for a virtual-clock recording: `openBrowser(path, { ...size, switches: virtualClockSwitches })`. */
export const virtualClockSwitches = deterministic.switches;

/** A virtual clock for the page `browser` drives, taking `fps` frames a second through `capture`. */
export function createVirtualClock({ browser, fps, capture }) {
  let seconds = 0;
  let nextFrame = 0;
  let waiting = null;
  browser.on((data) => {
    if (data.method === 'Emulation.virtualTimeBudgetExpired' && waiting) { const done = waiting; waiting = null; done(); }
  });

  /** Moves the page's time forward by `ms` and waits until the browser says it has. */
  const advance = async (ms) => {
    if (ms <= 0) return;
    const expired = new Promise((done) => { waiting = done; });
    await browser.send('Emulation.setVirtualTimePolicy', { policy: 'pauseIfNetworkFetchesPending', budget: ms });
    await expired;
    seconds = Math.round(seconds * 1000 + ms) / 1000;
  };

  const clock = {
    /** Pauses the page's time. Call once the page has loaded. */
    start: () => browser.send('Emulation.setVirtualTimePolicy', { policy: 'pause' }),
    now: () => seconds,
    advance,
    /** Moves `ms` of virtual time forward, taking each frame that falls inside it. */
    async sleep(ms) {
      const target = Math.round(seconds * 1000 + ms) / 1000;
      for (;;) {
        const due = Math.round((nextFrame * 1000) / fps) / 1000;
        if (due > target + 1e-9) break;
        await advance(Math.round((due - seconds) * 1000));
        seconds = due;
        await capture(due, nextFrame);
        nextFrame += 1;
      }
      await advance(Math.round((target - seconds) * 1000));
      seconds = target;
    },
    /**
     * Sends an input to the page (`work` returns the browser's answer) and moves `ms` of virtual time right after it. A page that is
     * paused cannot take an input in: a hover, a press or a key is answered only once some of the page's time has passed.
     */
    async input(work, ms = 17) {
      const answer = work();
      answer.catch(() => {});
      await clock.sleep(ms);
      return answer;
    },
    /** Runs `work` with the page's own time running (to load or navigate), then pauses it again. */
    async live(work) {
      await browser.send('Emulation.setVirtualTimePolicy', { policy: 'advance' });
      try { return await work(); } finally { await browser.send('Emulation.setVirtualTimePolicy', { policy: 'pause' }); }
    },
  };
  return clock;
}
