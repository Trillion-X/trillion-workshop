// src/sign-in-calls.mjs
//
// How many calls one sign-in makes, counted at the Worker before anything wakes the person's store: a personal key, an
// app grant or (when a call names neither) the account itself may make at most its tier's `limit` calls in
// `period_seconds` (src/sign-in-calls.json), counted by the Cloudflare rate limiting binding that tier names. Which tier
// is DATA: the first rule matching what the person's plan holds, what signed in and how it was approved. A caller past
// it is answered 429 with when to ask again, and the person's store is never woken for it, so one runaway AI cannot keep
// a person's store busy for their other AIs or run up its time.
//
// Invariants:
// - The count is by sign-in, never by address, so one AI on a shared network never slows another person's.
// - Answering costs no store wake and no storage read: the binding keeps the count where the call arrived, and what the
//   plan holds is the store's own answer to an earlier call, kept for `plan_kept_seconds` (src/kept-reads.mjs).
// - Every binding is declared by scripts/deploy-worker.mjs from the same DATA; a Worker run without one (a test, a local
//   run) counts nothing.
import settings from './sign-in-calls.json' with { type: 'json' };

export const SIGN_IN_CALLS = settings;
const listed = (want, value) => want === undefined || (Array.isArray(want) ? want.includes(value) : want === value);

/** What signed in: a personal key, an AI app's grant, or the account itself. */
export const callerOfProps = props => (props?.key_id ? 'key' : props?.client_id ? 'app' : 'account');

/** The tier the first matching rule picks. holds: the accesses the person's plan gives (any rule's `holds` is checked). */
export function callsTier({ holds = [], caller = null, approved_by: approvedBy = null } = {}) {
  const rule = settings.rules.find(({ when = {} }) => (when.holds === undefined || holds.includes(when.holds)) && listed(when.caller, caller) && listed(when.approved_by, approvedBy));
  return settings.tiers.find(tier => tier.id === rule.tier);
}

/** The accesses any rule asks about, of those `capabilities` holds: what the store hands back for the Worker to keep. */
export const planMarks = capabilities => settings.rules.map(rule => rule.when?.holds).filter(mark => mark && capabilities.includes(mark));

/** A 429 answer when `caller` has made too many calls lately under `tier`, else null. */
export async function tooManyCalls(env, key, tier = callsTier()) {
  const counter = env[tier.binding];
  if (!counter) return null;
  const { success } = await counter.limit({ key });
  if (success) return null;
  return Response.json(
    { error: settings.words.refused.replace('{limit}', String(tier.limit)).replace('{seconds}', String(tier.period_seconds)), retry_after_seconds: settings.retry_after_seconds },
    { status: 429, headers: { 'retry-after': String(settings.retry_after_seconds) } },
  );
}

/** Calls a sign-in made this minute, counted in the person's store's memory as each is accepted (nothing written). */
export function makeCallCounter(now = () => Date.now(), most = 2000) {
  const counts = new Map();
  const minute = () => Math.floor(now() / 60000);
  return {
    note(signIn) {
      const at = minute(), held = counts.get(signIn);
      if (held?.minute === at) { held.count += 1; return; }
      if (counts.size >= most) counts.delete(counts.keys().next().value);
      counts.set(signIn, { minute: at, count: 1 });
    },
    // This minute's count, or the last minute's while this one has none yet.
    lastMinute(signIn) {
      const at = minute(), held = counts.get(signIn);
      return held && at - held.minute <= 1 ? held.count : 0;
    },
    /** Every sign-in counted lately, by id. */
    all() { return Object.fromEntries([...counts.keys()].map(signIn => [signIn, this.lastMinute(signIn)]).filter(([, used]) => used)); },
  };
}

/** Connections' words for one AI: its tier's limit, and how much of it the last minute used. */
export function callsWords(tier, used) {
  const line = settings.words.line.replace('{limit}', tier.limit.toLocaleString('en-US'));
  return used ? `${line} · ${settings.words.used.replace('{used}', used.toLocaleString('en-US'))}` : line;
}

/** The rate limiting bindings the deploy declares, from the same DATA. */
export const signInCallsBindings = () => settings.tiers.map(tier => ({ name: tier.binding, namespace_id: tier.namespace_id, simple: { limit: tier.limit, period: tier.period_seconds } }));
