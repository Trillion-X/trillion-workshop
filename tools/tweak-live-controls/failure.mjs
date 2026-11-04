// One machine-readable failure contract for HTTP, MCP and internal retry decisions.
// Trillion-created failures carry a stable code. Cloudflare-created errors are adapted here, once, at the boundary.
import codes from './failure-codes.json' with { type: 'json' };
import platform from './platform-failures.json' with { type: 'json' };
import effectOutcomes from './effect-outcomes.json' with { type: 'json' };

/** The triple every failed or unsettled receipt carries (src/effect-outcomes.json): { retryable, side_effect,
 * required_next, next_said } for an effect state; a state with no row answers as the fallback row (unknown), never as
 * safe to repeat. `given` narrows it with what the target answered: it may say a known failure is not retryable or
 * name another next step that has a row, never that an unknown effect is safe to repeat. */
export function effectOutcome(state, given = {}) {
  const row = effectOutcomes.states[state] ?? effectOutcomes.states[effectOutcomes.fallback_state];
  const required_next = typeof given.required_next === 'string' && Object.hasOwn(effectOutcomes.next, given.required_next) ? given.required_next : row.required_next;
  const retryable = row.retryable && given.retryable !== false;
  const side_effect = typeof given.side_effect === 'string' && given.side_effect && row.side_effect !== 'unknown' ? given.side_effect.slice(0, 200) : row.side_effect;
  return { retryable, side_effect, required_next, next_said: effectOutcomes.next[required_next].said };
}
/** Whether a handoff holding an unknown effect admits only looking (src/effect-outcomes.json lock_while_unknown). */
export const lockWhileUnknown = () => effectOutcomes.lock_while_unknown === true;

const known = code => Object.hasOwn(codes, code);
const messageOf = error => String(error?.message ?? error ?? '');
// The exact words an own-records book that is moving answers with (src/record-book.mjs refuseMovedSource): busy, not refused.
export const MOVING_OWN_RECORDS = 'These records are moving to a new home. Try again shortly.';
// The exact words an own-records book answers while its own upkeep brings its records up to date (src/record-book.mjs
// rebuildRecordProjection): busy, not refused.
// The exact words a Space answers with while its content owner and shards are being set up (src/network.mjs
// resolveSharedResource): busy, not refused. Nothing has begun when it is said.
export const SPACE_MOUNTING = 'This Space is being set up. Try again in a moment.';
/** The refusal a Space answers while it is being set up: busy (503) with when to ask again, nothing begun. */
export const spaceMountingRefusal = () => Object.assign(new Error(SPACE_MOUNTING), { status: 503, failure_code: 'service-busy', not_begun: true, retry_after_ms: 1000 });
/** The busy-Space refusal in `error` or under it, or null. A command layer that could not tell whether its request was done adds
 *  its own sentence after the Space's words ("Whether this request was done is not known yet: ask again with request_key ..."), so the
 *  words are matched by their start, never by equality: a list that names a Space still being set up in `mounting` and goes on must
 *  still do so then (2026-10-21: one Space's set-up answered a person's whole pursuits list 503 every 30 s for an hour). */
export const spaceMountingIn = error => {
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) if (typeof cause.message === 'string' && cause.message.startsWith(SPACE_MOUNTING)) return cause;
  return null;
};
/** A failure's own words, then the words of each cause under it (the first error that stopped the work often sits under a
 *  later one's "measurement_uncertain"), once each and bounded, so a record or a log line reads the real cause. */
export const causeWords = (error, most = 600) => {
  const words = [];
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth++) { const text = String(cause?.message ?? cause); if (text && !words.includes(text)) words.push(text); }
  return words.join(' | ').slice(0, most);
};
/** Most nested dependency commands one command may start below it (each dependency's parent is awaited inside its own handler,
 *  so they nest). The platform stops a request chain at 16 hops of every kind; commands account for several each. */
export const MOST_DEPENDENCY_DEPTH = 8;
export const DEPENDENCY_TOO_DEEP = 'This is nested too deeply right now. Try again in a moment.';
/** The depth a dependency command below `parentCommitment` has, or the typed, retryable refusal when it would pass the most.
 *  `label` names this level (its method), so the warning from depth 6 on says which commands are stacked, outermost first. */
export function nextDependencyDepth(parentCommitment, label = '') {
  const depth = (Number.isInteger(parentCommitment?.dependency?.depth) ? parentCommitment.dependency.depth : 0) + 1;
  if (depth > MOST_DEPENDENCY_DEPTH) throw Object.assign(new Error(DEPENDENCY_TOO_DEEP), { status: 503, failure_code: 'service-busy', not_begun: true, retry_after_ms: 3000, dependency_depth: depth, dependency_path: dependencyPathOf(parentCommitment, label) });
  if (depth >= MOST_DEPENDENCY_DEPTH - 2) console.warn('dependency command nested deep', { depth, path: dependencyPathOf(parentCommitment, label) });
  return depth;
}
/** The labels of the dependency commands above and including this level, outermost first, at most 10 of 40 characters. */
export const dependencyPathOf = (parentCommitment, label = '') => [...(Array.isArray(parentCommitment?.dependency?.path) ? parentCommitment.dependency.path : []), String(label).slice(0, 40)].slice(-10);
/** Whether a failure, or any cause under it, is the platform's own transient refusal of a call to an object (the object was
 *  reset, is overloaded, or its instance went away): no typed answer of ours, so asking again later is the right answer. */
export const platformTransient = error => {
  for (let cause = error, depth = 0; cause && depth < 6; cause = cause.cause, depth++) {
    if (cause.overloaded === true || cause.retryable === true && !Number.isInteger(cause.status)) return true;
    if (/this Durable Object instance is no longer active|Durable Object is overloaded|Durable Object reset because its code was updated|Network connection lost|This is nested too deeply right now/.test(String(cause?.message ?? ''))) return true;
  }
  return false;
};
// Whether a failure, or any cause under it, is the platform's limit on nested requests (it arrives as a plain error).
export const spaceMountTooDeep = error => {
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) if (/Subrequest depth limit exceeded/.test(String(cause?.message ?? cause))) return true;
  return false;
};
/** The calls a depth-limit failure passed through, outermost first: each stub call that sees the platform's nested-request
 *  limit come back adds its own address and operation as the failure unwinds, so the failure reaches the top naming the
 *  whole chain (the platform gives no stack). Returns `error`. */
export function withHopTrail(label, error) {
  if (error && typeof error === 'object' && spaceMountTooDeep(error)) {
    const trail = Array.isArray(error.hop_trail) ? error.hop_trail : [];
    try { error.hop_trail = [label, ...trail].slice(0, 40); } catch { /* a frozen error keeps the trail it has */ }
  }
  return error;
}
/** The hop trail of a failure or of any cause under it, as short text for a log line. */
export function hopTrailOf(error) {
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) if (Array.isArray(cause.hop_trail)) return cause.hop_trail.map(hop => String(hop).replace(/membership_[0-9a-f]{8}[0-9a-f]*/g, id => `M${id.slice(11, 15)}`).replace(/:[0-9a-f]{40,}/g, ':#')).map(hop => hop.length > 90 ? `${hop.slice(0, 56)}...${hop.slice(-31)}` : hop);
  return null;
}
export const RECORDS_CATCHING_UP = 'These records are catching up. Try again in a moment.';
// The exact words an account's store answers, for a record family it no longer keeps, once its own records were carried to
// the account's own records book (PersonStore recordsSource): the caller asks that book instead (src/account-app-state.mjs
// accountAppReply, src/public-app-visitor-call.mjs). Its code and its words each say it, however the error arrives.
export const OWN_RECORDS_CARRIED = "These records are kept in the account's own records book now.";
export const ownRecordsCarriedRefusal = () => Object.assign(new Error(OWN_RECORDS_CARRIED), { status: 409, code: 'own_records_carried' });
export const ownRecordsWereCarried = error => error?.code === 'own_records_carried' || String(error?.message ?? '').includes(OWN_RECORDS_CARRIED);
// A transient fence matched by its exact words, so it is busy however its error arrives (a stand-in, a replayed reply).
// A Durable Object call keeps an error's own fields: status, code and cause arrive intact through a jsrpc throw
// (measured in Miniflare at compatibility date 2026-09-01, 2026-10-18), so the words are a second road, not the only one.
const accountPolicyChanging = error => new Set([
  MOVING_OWN_RECORDS,
  RECORDS_CATCHING_UP,
  SPACE_MOUNTING,
  'Account rights are changing. Retry after they settle.',
  'Account rights are changing. Retry shortly.',
  'Resource rights are changing. Retry shortly.',
  'Current scope projection requires the authoritative reach.',
  'Account policy is changing.',
  'Resource quota: quota_fenced',
  'Account controls changed during reading.',
  'Account rights changed during admission. Retry.',
  'Account rights changed during meter carry. Retry.',
  'Account rights changed during quota initialization. Retry.',
]).has(messageOf(error));
// Which code an error the platform made is: the first row of src/platform-failures.json that holds for it.
const platformRows = platform.rows.map(row => ({ ...row, words: row.contains?.toLowerCase() }));
const platformCode = error => {
  const message = messageOf(error).toLowerCase();
  return platformRows.find(row => (row.flag ? error?.[row.flag] === true : row.reply_status ? row.reply_status.includes(error?.reply_status) : message.includes(row.words)))?.code ?? 'unexpected';
};

// Whether a failure's words are the platform's own (src/platform-failures.json own_words): never repeated in an answer.
const ownWordRows = platform.own_words.rows.map(row => ({ ...row, words: row.contains?.toLowerCase() }));
export const platformSaid = error => {
  const message = messageOf(error).toLowerCase();
  return ownWordRows.some(row => (row.code ? error?.code === row.code : message.includes(row.words)));
};

export class WorkFailure extends Error {
  constructor(code, message, { cause } = {}) {
    if (!known(code)) throw new TypeError(`Unknown failure code: ${code}`);
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WorkFailure';
    this.code = code;
    this.failure_code = code;
    Object.assign(this, codes[code]);
  }
}

/** The policy a caller uses, without parsing error words. */
export function failureOf(error) {
  const code = known(error?.failure_code) ? error.failure_code : accountPolicyChanging(error) ? 'service-busy' : platformCode(error);
  const retryAt = code === 'use-budget-reached' && Number.isFinite(error?.retry_at) ? error.retry_at : null;
  const { payload: _payload, ...policy } = codes[code];
  return { code, ...policy, ...(retryAt === null ? {} : {
    retry_at: new Date(retryAt).toISOString(),
    retry_after_seconds: Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)),
  }) };
}

/**
 * What an error may add to its emitted answer beyond the failure contract: only the fields its code lists in
 * src/failure-codes.json `payload`, read from the thrown error by name. An error that names a failure_code the registry
 * does not know is reclassified as unexpected and ships no payload at all. → { name: value }
 */
export function payloadOf(failure, error) {
  if (error?.failure_code !== undefined && !known(error.failure_code)) return {};
  const allowed = codes[failure.code]?.payload ?? [];
  return Object.fromEntries(allowed.filter(name => error?.[name] !== undefined && error[name] !== null && error[name] !== false).map(name => [name, error[name]]));
}

/** The HTTP status an owner's deliberate refusal answers with: its own 4xx/5xx status, or 400 for a request-refused
 * failure. Null for every other failure (a cut-off, a busy owner, a defect): those reach the Worker's one failure owner
 * unchanged, so a real defect answers 500 with its reference and is never passed off as the caller's mistake. */
export function refusalStatus(error) {
  const failure = failureOf(error);
  if (failure.tries_again_later) return null;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) return error.status;
  return failure.code === 'request-refused' ? 400 : null;
}

/** Restore only the owner's known failure code and reset time after an internal HTTP reply. */
export function failureFromReply(message, reply) {
  const error = known(reply?.failure_code) ? new WorkFailure(reply.failure_code, message) : new Error(message);
  const retryAt = typeof reply?.retry_at === 'string' ? Date.parse(reply.retry_at) : NaN;
  if (error.failure_code === 'use-budget-reached' && Number.isFinite(retryAt)) error.retry_at = retryAt;
  return error;
}

/** The refusal in `error` or its causes that the caller must see, or null: one that asks to be tried again shortly
 *  (status 503), or an owner's deliberate refusal of the request itself (refusalStatus 400, 401, 402,
 *  403, 404, 413 or 422, such as a request-refused failure). A command whose receipt is still unsettled answers this refusal as itself, so the
 *  caller sees why (and, for a 503, when: the same request key settles the receipt) instead of a fatal receipt error. */
const CALLER_REFUSAL_STATUSES = new Set([400, 401, 402, 403, 404, 413, 422]);
export function callerRefusalOf(error) {
  for (let held = error, depth = 0; held && depth < 8; held = held.cause, depth += 1) {
    // A 503 says to retry shortly (a busy owner, a credit not yet free, a projection still publishing).
    if (held.status === 503) return held;
    // 409 is not one: it is how receipts, quotas and generations say the attempt itself is unsettled or conflicted.
    if (CALLER_REFUSAL_STATUSES.has(refusalStatus(held))) return held;
  }
  return null;
}
