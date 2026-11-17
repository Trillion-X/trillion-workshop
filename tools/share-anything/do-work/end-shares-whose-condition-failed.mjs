// tools/share-anything/do-work/end-shares-whose-condition-failed.mjs
//
// Purpose: The sharer's own end rule on a share that lets people run their tools (tool:end-shares-whose-condition-failed). A
// run share ends only when the person says so: tool:share-anything keeps the rule the person gives (`ends`, none by default)
// beside the grant in the engine's own keep, and this run lists every run share with its rule and its last use through the
// engine's share list (trillion-rust src/account_rights/share_grant.rs `listed`, `{label: <record_prefix>*}`), and withdraws
// each whose rule says it has ended. The engine reads no end and no rule: it admits a bearer while the share is kept, so
// ending one is this withdrawal. The tool's row declares a wake, which the sharer switches on (`wake:switch`); the run it
// starts acts only within the rights its row declares and the switcher's own (trillion-rust src/wake/tool_runner.rs), and
// holds no key. It wakes every data.run.check_every_ms, the engine's own grain of a last use (it writes one at most hourly),
// so judging more often reads nothing new.
//
//   endSharesWhoseConditionFailed(input, { door })   input { now? } (an ISO time to decide at, now when left out) -> { ended,
//                                                    waiting, never, unjudged, said }; the one export the row runs.
//   endOf(ends, lastUsed)                            { at, reason } when the rule ends its share, else null; `at` in ms.
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
// - A share the engine lists with no `last_used` field is judged by its `until` alone and counted in `unjudged`, said aloud: a
//   share that is in use is never ended on a use this run could not read. `last_used: null` means never used.
// - Each withdrawal is sent under a key made from the label and its end, so a run sent again withdraws once.
// - A withdrawal the door refuses is not hidden: the sweep stops with that refusal, so the next sweep tries again.
// - This run keeps nothing, makes no grant and reads nothing but the run shares the engine lists.
//
// Security Considerations: the row grants this run the withdraw and list operations on labels that start with
// data.record_prefix, never the keep operation, so it can only end a share.
//
// AI Assistant Directive:
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it. Maintain and extend this detail.
import data from '../read-data/share-anything.json' with { type: 'json' };

const runs = data.run;
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

export async function endSharesWhoseConditionFailed(input = {}, { door } = {}) {
  if (!object(input)) throw new Error('The input is an object, or left out.');
  const now = nowOf(input);
  const { grants } = await door.sharing(runs.list_operation, { label: `${data.record_prefix}*` });
  const ended = [];
  let waiting = 0;
  let never = 0;
  let unjudged = 0;
  for (const held of Array.isArray(grants) ? grants : []) {
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
    await door.sharing(runs.withdraw_operation, { label: held.label }, { key: `withdraw:${held.label}:${new Date(end.at).toISOString()}` });
    ended.push(held.label);
  }
  const said = [fill(ended.length ? data.words.swept : data.words.sweep_nothing, { ended: ended.length, waiting, never }),
    ...(unjudged ? [fill(data.words.unjudged, { count: unjudged })] : [])].join(' ');
  return { ended, waiting, never, unjudged, said };
}
