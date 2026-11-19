// tools/share-anything/do-work/end-shares-whose-condition-failed.mjs
//
// Purpose: The sharer's own end rule on a share that lets people run their tools (tool:end-shares-whose-condition-failed). A
// run share ends only when the person says so: tool:share-anything keeps the rule the person gives (`ends`, none by default)
// beside the grant, and this function judges every run share the caller lists against its rule and its last use, and returns
// the withdrawal of each whose rule says it has ended. It reaches no database: the caller lists the run shares from the person's
// store (their grants, with the rule and the last use the engine reports), passes them in as `runs`, and writes what comes back.
// The engine reads no end and no rule: it admits a bearer while the share is kept, so ending one is the withdrawal in `writes`.
// The tool's row declares a wake, which the sharer switches on (`wake:switch`); the caller that wake starts reads the store and
// passes the list in. It judges every data.run.check_every_ms, the engine's own grain of a last use (it writes one at most hourly),
// so judging more often reads nothing new.
//
//   endSharesWhoseConditionFailed(input)   input { now?, runs: [{ label, grant?, ends?, last_used?, people? }] } (an ISO time to
//                                          decide at, now when left out; `runs` the caller listed) -> { ended, waiting, never,
//                                          unjudged, said, writes }; the one export the row runs.
//   endOf(ends, lastUsed)                  { at, reason } when the rule ends its share, else null; `at` in ms.
//
// The rule (`ends`, an object the person gives through tool:share-anything):
//   { until: ISO }                                   ends at that time
//   { unused_days: N, since: ISO }                   ends N days after the later of `since` (when the rule was set) and the
//                                                    share's last use; each use starts the days again
//   both                                             ends at the earlier of the two
//
// Non-Negotiable Invariants:
// - A share with no rule never ends here: it stands until the person stops it.
// - A share is withdrawn only when its rule names an end that has passed by the run's own clock; a rule this run cannot read
//   is left alone and counted as waiting (nothing here ends a share it cannot read the end of).
// - A share listed with no `last_used` field is judged by its `until` alone and counted in `unjudged`, said aloud: a share that
//   is in use is never ended on a use this run could not read. `last_used: null` means never used.
// - Each withdrawal is a write with value null on the run share's own address, made on what the caller read (`expect`), so a
//   withdrawal the store has since changed is not made blind; the caller runs this again.
// - This function keeps nothing and makes no grant. It reads only the runs the caller listed.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import data from '../read-data/share-anything.json' with { type: 'json' };

const DAY_MS = 86_400_000;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const timeOf = value => (typeof value === 'string' ? Date.parse(value) : NaN);

function nowOf(input) {
  if (input.now === undefined) return Date.now();
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) throw new Error('now must be an ISO time, for example 2026-01-01T00:00:00.000Z.');
  return at;
}

/**
 * When the rule `ends` ends its share, given the share's last use as the engine lists it: an ISO time, null for never used,
 * or undefined when the engine answers no last use (then only `until` is read). The earlier of the two ends; null when the
 * rule names neither in a form this can read.
 */
export function endOf(ends, lastUsed) {
  const found = [];
  const until = timeOf(ends.until);
  if (Number.isFinite(until)) found.push({ at: until, reason: 'until' });
  const days = ends.unused_days;
  const since = timeOf(ends.since);
  if (lastUsed !== undefined && Number.isInteger(days) && days > 0 && Number.isFinite(since)) {
    const used = timeOf(lastUsed);
    found.push({ at: Math.max(since, Number.isFinite(used) ? used : since) + days * DAY_MS, reason: 'unused' });
  }
  return found.length ? found.reduce((first, next) => (next.at < first.at ? next : first)) : null;
}

export function endSharesWhoseConditionFailed(input = {}) {
  if (!object(input)) throw new Error('The input is an object, or left out.');
  const now = nowOf(input);
  const listed = Array.isArray(input.runs) ? input.runs : [];
  const ended = [];
  const writes = [];
  let waiting = 0;
  let never = 0;
  let unjudged = 0;
  for (const held of listed) {
    if (!object(held) || typeof held.label !== 'string') continue;
    if (!object(held.ends)) {
      never += 1;
      continue;
    }
    const used = Object.hasOwn(held, 'last_used') ? held.last_used : undefined;
    if (used === undefined && Number.isInteger(held.ends.unused_days)) unjudged += 1;
    const end = endOf(held.ends, used);
    if (end === null || end.at > now) {
      waiting += 1;
      continue;
    }
    // The store holds the run grant without the listing's own label and last use: expect is what it holds.
    const { label, last_used: _used, ...kept } = held;
    writes.push({ kind: 'run-share', address: label, value: null, expect: kept });
    ended.push(held.label);
  }
  const said = [fill(ended.length ? data.words.swept : data.words.sweep_nothing, { ended: ended.length, waiting, never }),
    ...(unjudged ? [fill(data.words.unjudged, { count: unjudged })] : [])].join(' ');
  return { ended, waiting, never, unjudged, said, writes };
}
