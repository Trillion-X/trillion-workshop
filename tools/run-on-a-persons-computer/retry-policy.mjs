// src/retry-policy.mjs
//
// Purpose: the one place that says whether a failure is worth asking again, and the one switch that turns every retry off.
//
// Non-negotiable invariants
//   1. The classes of retriable failure are DATA (src/retry-policy.json): a status, a status range, a code, a method, a
//      pattern over the words. Nothing here names a service, a tool or an error.
//   2. `retriable` classifies; `mayRetry` decides. The switch (the file's `enabled`, or the environment variable it
//      names) changes only `mayRetry`, so a refusal that is final stays final while retries are off, and a passing
//      failure is not mistaken for one.
//   3. A rows list that cannot be read as rows retries nothing: an unknown shape never widens what is retried.
import policy from './retry-policy.json' with { type: 'json' };

const messageOf = error => String(error?.message ?? error ?? '');

function holds(row, error, call) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  if (row.status !== undefined && !(Array.isArray(row.status) && status !== null && row.status.includes(status))) return false;
  if (row.status_range !== undefined && !(Array.isArray(row.status_range) && status !== null && status >= row.status_range[0] && status <= row.status_range[1])) return false;
  if (row.no_status === true && status !== null) return false;
  if (row.code !== undefined && error?.code !== row.code) return false;
  if (row.method !== undefined && call?.method !== row.method) return false;
  if (row.message_matches !== undefined && !new RegExp(row.message_matches, 'i').test(messageOf(error))) return false;
  return true;
}

/** Whether the failure is of a class worth asking again, whatever the switch says. call: { method? }. */
export function retriable(error, call = {}, rules = policy) {
  const rows = value => (Array.isArray(value) ? value : []);
  if (rows(rules.never).some(row => error?.[row.field] === row.equals)) return false;
  return rows(rules.retriable).some(row => holds(row, error, call));
}

/** Whether retries are on: the policy's `enabled` and the environment switch it names. */
export const retriesOn = (rules = policy, environment = process.env) => rules.enabled !== false && environment[rules.off_by_environment] !== '1';

/** Whether to ask again: the failure is retriable and retries are on. */
export const mayRetry = (error, call = {}, rules = policy, environment = process.env) => retriesOn(rules, environment) && retriable(error, call, rules);
