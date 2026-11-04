// computer/log-policy.mjs
//
// Purpose
//   One place decides what the computer's programs write to their log: each event is logged always, never, only when it
//   differs from its last line, or only the first time (computer/log-policy.json events), and a secret never reaches the
//   log because redaction happens here, at the point of writing, not at each caller. A failing dependency that is asked
//   again every few seconds used to write the same line all night.
//
// Non-negotiable invariants
//   1. Which events are logged how, which keys and shapes are secret, and what counts as a change are DATA
//      (computer/log-policy.json); a mode is a row (`drop`, `compare`), not a branch here.
//   2. An event with no row is logged under `default_mode` and reported once by name, so a new event is never silent
//      and never unreviewed.
//   3. Redaction applies to every line whatever its mode, nested values included, and to text lines too.
//   4. What the policy remembers is bounded (`most_remembered_events`).
import settings from './log-policy.json' with { type: 'json' };

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The name of a logged line: its `event`, or its first key. Pure. */
export const eventOf = entry => (isObject(entry) ? (typeof entry.event === 'string' ? entry.event : Object.keys(entry)[0] ?? '') : '');

/** `value` with every secret replaced (keys by name, text by shape). Pure; does not change its argument. */
export function redact(value, rules = settings.redact) {
  const keyPattern = new RegExp(rules.key_patterns.join('|'), rules.key_flags ?? '');
  const textPatterns = rules.text_patterns.map(pattern => new RegExp(pattern, rules.text_flags ?? 'g'));
  const clean = text => textPatterns.reduce((out, pattern) => out.replace(pattern, rules.replacement), text);
  const walk = (item, key) => {
    if (key !== undefined && keyPattern.test(key)) return rules.replacement;
    if (typeof item === 'string') return clean(item);
    if (Array.isArray(item)) return item.map(entry => walk(entry));
    if (isObject(item)) return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, walk(entry, name)]));
    return item;
  };
  return walk(value);
}

/**
 * `write(entry)` wrapped in the policy: the function programs call as `log`.
 * Returns log(entry); `log.remembered()` says how many events are held.
 */
export function policedLog(write, { policy = settings } = {}) {
  const last = new Map();
  const seen = new Set();
  const reported = new Set();
  const ignored = new Set(policy.ignore_when_comparing);
  const fingerprint = entry => JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([key]) => !ignored.has(key))));
  const room = () => last.size + seen.size < policy.most_remembered_events;

  const log = entry => {
    const clean = redact(entry, policy.redact);
    if (!isObject(clean)) { write(clean); return; }
    const name = eventOf(clean);
    const listed = Object.hasOwn(policy.events, name);
    const mode = policy.modes[listed ? policy.events[name] : policy.default_mode];
    if (!listed && !reported.has(name) && reported.size < policy.most_remembered_events) {
      reported.add(name);
      write({ [policy.unlisted_event_words]: name });
    }
    if (mode.drop) return;
    if (mode.compare === 'seen') {
      if (seen.has(name)) return;
      if (room()) seen.add(name);
    } else if (mode.compare === 'last') {
      const now = fingerprint(clean);
      if (last.get(name) === now) return;
      if (last.has(name) || room()) last.set(name, now);
    }
    write(clean);
  };
  log.remembered = () => last.size + seen.size;
  return log;
}
