// tools/sign-in-build-and-hold/read-data/verify-every-port-sign-in-call-limits.mjs
//
// How many calls one sign-in makes, counted as each call is admitted, before any work runs. A personal key, an AI app's
// grant or the account itself may make at most its tier's `limit` calls in `period_seconds`; a caller past it is answered
// 429 with when to ask again, and nothing it asked for runs, so one AI that runs away cannot keep the person's computer
// busy for their other AIs. Ported from the earlier code base's src/sign-in-calls.mjs (b6ae0ebf815f).
//
// Storage-free: the counts are a plain Map that the caller keeps and passes in; every function answers a new value and
// writes nothing. The host that holds the Map is the owner that decides where it lives.
//
// Invariants:
// - The count is by sign-in (`signIn`), never by address, so one AI on a shared network never slows another.
// - Which tier applies is DATA: the first rule whose `when` all hold (read-data/verify-every-port-sign-in-call-limits.json).
// - A refused call is not counted. A restart forgets every count, which only admits.
// - The eviction when the Map is full drops the oldest NEW sign-in, never one already counted (the earlier code evicted
//   on every write once full; here an existing sign-in's count is never discarded by another sign-in's call).
//
// Dropped from the earlier code, and why:
// - the Cloudflare rate limiting binding names, namespace ids and `signInCallsBindings` (host plumbing, the deploy's);
// - `plan_kept_seconds` and the store's kept plan read (a cache of the host, not a rule);
// - `planMarks` (it reads which accesses a rule asks about, from the host's capability list; the caller passes `holds`).
import settings from './verify-every-port-sign-in-call-limits.json' with { type: 'json' };

export const SIGN_IN_CALLS = settings;

const MINUTE_MS = 60_000;
const listed = (want, value) => want === undefined || (Array.isArray(want) ? want.includes(value) : want === value);
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));
const minuteOf = nowMs => Math.floor(nowMs / MINUTE_MS);

/** What signed in: a personal key, an AI app's grant, or the account itself (`props` as the sign-in reads them). */
export const callerOfProps = props => (props?.key_id ? 'key' : props?.client_id ? 'app' : 'account');

/** The tier the first matching rule picks. `holds`: the accesses the person's plan gives; `approved_by`: how an app's
 *  grant was approved, or null. */
export function callsTier({ holds = [], caller = null, approved_by: approvedBy = null } = {}) {
  const rule = settings.rules.find(({ when = {} }) => (when.holds === undefined || holds.includes(when.holds))
    && listed(when.caller, caller) && listed(when.approved_by, approvedBy));
  return settings.tiers.find(tier => tier.id === rule.tier);
}

/** The answer for a call that would be the `count`th of its sign-in in its tier's period: null when it may go, else the
 *  429 status, the Retry-After value and the body the words name (the limit and the period). */
export function refusalFor({ tier, count }) {
  if (count <= tier.limit) return null;
  return {
    status: 429,
    retry_after: String(settings.retry_after_seconds),
    body: {
      error: fill(settings.words.refused, { limit: tier.limit, seconds: tier.period_seconds }),
      retry_after_seconds: settings.retry_after_seconds,
    },
  };
}

/** The counts after `signIn` makes one call at `nowMs`. `counts` is a Map of sign-in to { minute, count } and is never
 *  changed; the answer is a new Map. */
export function noteCall(counts, signIn, nowMs, most = settings.most_counted) {
  const at = minuteOf(nowMs), next = new Map(counts), held = next.get(signIn);
  if (held?.minute === at) {
    next.set(signIn, { minute: at, count: held.count + 1 });
    return next;
  }
  if (!held && next.size >= most) next.delete(next.keys().next().value);
  next.set(signIn, { minute: at, count: 1 });
  return next;
}

/** How many calls `signIn` made this minute, or the last minute's while this one has none yet (0 after that). */
export function lastMinute(counts, signIn, nowMs) {
  const at = minuteOf(nowMs), held = counts.get(signIn);
  return held && at - held.minute <= 1 ? held.count : 0;
}

/** Every sign-in with a use that still shows, by id: { [signIn]: used }. */
export function allLastMinute(counts, nowMs) {
  return Object.fromEntries([...counts.keys()].map(signIn => [signIn, lastMinute(counts, signIn, nowMs)]).filter(([, used]) => used));
}

/** Connections' words for one AI: its tier's limit, and how much of it the last minute used. */
export function callsWords(tier, used) {
  const line = fill(settings.words.line, { limit: tier.limit.toLocaleString('en-US') });
  return used ? `${line} · ${fill(settings.words.used, { used: used.toLocaleString('en-US') })}` : line;
}
