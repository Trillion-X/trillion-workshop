// tools/listen-for-a-while/read-data/recording-rules.mjs
//
// Purpose
//   Opt-in rules about recording and transcribing, in the one place every entry point (a button, an MCP tool, an agent, an
//   automation) and the capture owner ask: may this recording start, and may it go on. With no rules, everything is allowed;
//   rules are DATA a workspace chooses to add, never a gate the product imposes.
//   It holds: rule evaluation (block wins, a required fact that is not known yet is `pending`, a required fact that is false
//   blocks), a request/grant book for who may record (once or persistent), the notice step (one coordinated sender, never typing
//   into a field in use, a fallback and an optional stop), per-meeting consent events with exclusion of a person's words, and the
//   mid-session recheck.
//
// Non-negotiable invariants
//   1. Default open: no rule matching means allowed. A rule only restricts what its own DATA row says (recording-rules.json
//      `words`, and the rows given to evaluate()); this file names no space, app or person.
//   2. Block wins over require; require with a false fact blocks; require with an unknown fact is pending, never allowed.
//   3. Refusals are distinct and worded: not allowed by a rule, pending, no grant, already running.
//   4. The decision is a pure function of rules, facts and time, so the same evaluate() is used by the action owner and, again,
//      inside the capture helper (a bypassed caller still cannot write).
//   5. A consent event is keyed by meeting and person, append-only; a person's latest choice decides, and exclusion removes only
//      that person\'s words from what is kept.
//
import words from './recording-rules.json' with { type: 'json' };

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const matches = (when = {}, facts) => Object.entries(when).every(([key, want]) => (Array.isArray(want) ? want.includes(facts[key]) : facts[key] === want));

/** { state: 'allowed' | 'blocked' | 'pending', by: [rule ids], why } for facts about this recording. */
export function evaluate(rules = [], facts = {}, copy = words) {
  const hit = rules.filter(rule => matches(rule.when, facts));
  const blocking = hit.filter(rule => rule.effect === 'block');
  if (blocking.length) return { state: 'blocked', by: blocking.map(rule => rule.id), why: fill(copy.blocked, { rule: blocking[0].says ?? blocking[0].id }) };
  const needs = hit.filter(rule => rule.effect === 'require').flatMap(rule => (rule.facts ?? []).map(name => ({ rule, name })));
  const unmet = needs.filter(need => facts[need.name] === false);
  if (unmet.length) return { state: 'blocked', by: [...new Set(unmet.map(need => need.rule.id))], why: fill(copy.unmet, { fact: unmet[0].name }) };
  const unknown = needs.filter(need => facts[need.name] === undefined || facts[need.name] === null);
  if (unknown.length) return { state: 'pending', by: [...new Set(unknown.map(need => need.rule.id))], why: fill(copy.pending, { fact: unknown[0].name }) };
  return { state: 'allowed', by: [], why: '' };
}

/** The engine-layer check every entry point calls: distinct refusals for not allowed, pending and already running. */
export function mayStart({ rules, facts, running = false, copy = words }) {
  if (running) return { ok: false, code: 'busy', why: copy.busy };
  const verdict = evaluate(rules, facts, copy);
  return verdict.state === 'allowed' ? { ok: true } : { ok: false, code: verdict.state === 'pending' ? 'pending' : 'refused', why: verdict.why, by: verdict.by };
}

/** The mid-session recheck: a recording that was allowed stops when the rules or facts now say blocked; pending does not stop it. */
export function recheck({ rules, facts, copy = words }) {
  const verdict = evaluate(rules, facts, copy);
  return verdict.state === 'blocked' ? { keep: false, why: verdict.why, by: verdict.by } : { keep: true };
}

/** Who may record: people ask, someone with authority grants once or for good, and a once-grant is spent by its first use. */
export function grantBook() {
  const asks = new Map(); const grants = new Map();
  return {
    request(person, at = Date.now()) { asks.set(person, at); return { person, asked_at: at }; },
    grant(person, { scope = 'once', by, at = Date.now() }) { grants.set(person, { scope, by, at }); asks.delete(person); return grants.get(person); },
    revoke(person) { return grants.delete(person); },
    /** Uses the grant: persistent stays, once is spent. */
    use(person) { const grant = grants.get(person); if (!grant) return false; if (grant.scope === 'once') grants.delete(person); return true; },
    pending: () => [...asks.keys()],
    granted: () => [...grants.entries()].map(([person, grant]) => ({ person, ...grant })),
  };
}

/**
 * The next step for the recording notice. `rule` is { senders_choose: 'lowest', fallback: 'frame' | null, stop_after_seconds | null };
 * `state` { senders: [ids], me, field_empty: bool|null, sent: bool, frame_available: bool, waited_seconds }.
 * One coordinated sender types it, only into an empty field; otherwise the fallback; otherwise (when the rule says so) stop.
 */
export function noticeStep(rule, state) {
  if (state.sent) return { do: 'none', why: words.notice_sent };
  const sender = [...state.senders].sort()[0];
  if (sender === state.me && state.field_empty === true) return { do: 'type', why: words.notice_type };
  if (sender === state.me && state.field_empty === false) return rule.fallback === 'frame' && state.frame_available ? { do: 'frame', why: words.notice_frame } : stopOrWait(rule, state);
  return rule.fallback === 'frame' && state.frame_available && sender !== state.me ? { do: 'wait', why: words.notice_other } : stopOrWait(rule, state);
}
const stopOrWait = (rule, state) => (rule.stop_after_seconds != null && state.waited_seconds >= rule.stop_after_seconds ? { do: 'stop', why: words.notice_stop } : { do: 'wait', why: words.notice_wait });

/** Append-only consent events by meeting and person; the latest choice decides. */
export function consentLog() {
  const events = [];
  return {
    record(meeting, person, choice, at = Date.now()) { events.push({ meeting, person, choice, at }); return events.at(-1); },
    latest(meeting, person) { return events.filter(row => row.meeting === meeting && row.person === person).at(-1)?.choice ?? null; },
    excluded(meeting) { const people = new Set(events.filter(row => row.meeting === meeting).map(row => row.person)); return [...people].filter(person => ['leave', 'decline'].includes(this.latest(meeting, person))); },
    /** Turns without the excluded people's words. */
    keep(meeting, turns) { const out = new Set(this.excluded(meeting)); return turns.filter(turn => !out.has(turn.person)); },
    events: () => events.slice(),
  };
}
