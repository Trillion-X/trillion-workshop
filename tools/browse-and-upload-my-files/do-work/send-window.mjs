// parts/live-namespace/do-work/send-window.mjs
//
// Purpose: how many chunks one sender keeps in flight to one person's namespace, decided by how the service answers.
// It starts at `start`, opens by one after every `start`-sized round of chunks the service took, up to `most`, and
// halves (never below `least`) the moment the service answers that it is busy or failing, so several files sent at
// once go as fast as the service keeps up and back off together the moment it does not. It is the TCP way of sharing
// a link, with the service's own answers as the signal.
//
// Invariants:
// - One window per client (one client per account in a process or a page), shared by every file sent through it, so
//   files sent at once share the person's service instead of each taking their own share of it.
// - A chunk takes a place before its request and gives it back with the request's outcome: 'ok' (stored), 'busy'
//   (a status in `busy_statuses`, any 5xx, or no answer) or 'done' (anything else, which neither opens nor closes it).
// - At most `size` chunks are in flight; a window that closed lets waiting chunks go only as places come back.
// - Its numbers are DATA (send-settings.json `in_flight_per_person`); nothing here names a service or a file kind.
//
// Security: holds no bytes, no names and no credentials; only counts.

/** The window's own rules, read from send-settings.json `in_flight_per_person`. */
export function windowRules(settings) {
  const start = Math.max(1, Number(settings?.start) || 1);
  const least = Math.max(1, Math.min(start, Number(settings?.least) || 1));
  const most = Math.max(start, Number(settings?.most) || start);
  return { start, least, most, busy: new Set((settings?.busy_statuses ?? []).map(Number)) };
}

/** What a request's answer says to the window: 'ok', 'busy' or 'done'. `status` is null when nothing answered. */
export function outcomeOf(status, rules) {
  if (status === null || status === undefined || status >= 500 || rules.busy.has(status)) return 'busy';
  return status >= 200 && status < 300 ? 'ok' : 'done';
}

/** A window of chunks in flight: take() waits for a place, give(outcome) gives it back. */
export function sendWindow(settings) {
  const rules = windowRules(settings);
  let size = rules.start;
  let running = 0;
  let taken = 0;
  const waiting = [];
  const wake = () => { while (waiting.length && running < size) { running += 1; waiting.shift()(); } };
  return {
    rules,
    size: () => size,
    running: () => running,
    take: () => new Promise(resolve => { waiting.push(resolve); wake(); }),
    give(outcome) {
      running -= 1;
      if (outcome === 'busy') { size = Math.max(rules.least, Math.floor(size / 2)); taken = 0; }
      else if (outcome === 'ok' && size < rules.most && (taken += 1) >= size) { size += 1; taken = 0; }
      wake();
    },
  };
}

/** The one window of a client: every file sent through the same client shares it. */
const windows = new WeakMap();
export function windowOf(client, settings) {
  if (!windows.has(client)) windows.set(client, sendWindow(settings));
  return windows.get(client);
}
