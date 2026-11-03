// tools/decide-agent-actions/do-work/decide-action.mjs
//
// Purpose
//   The gate every action an AI agent is about to take passes: allow, ask the person first, or refuse. Pure: the action, the
//   person's policy rows, grants, declined actions and the clock all arrive in the request; nothing is read or kept.
//
// Non-negotiable invariants
//   1. Decision order, the first that applies decides: policy paused; refusing rules (a refusing rule whose `when` cannot be
//      evaluated refuses too, failing closed); an earlier decline not followed by a message from the person; a grant; the
//      other rules in order (a rule that cannot be evaluated is skipped and listed, it never allows); the policy's
//      `otherwise`, else the vocabulary default. Then, if no one can be asked, an ask becomes a refusal.
//   2. Every verdict, behaviour, scope and sentence is DATA (read-data/action-policy-vocabulary.json); this file names none.
//   3. A rule's `when` is evaluated by tools/formulas (filterRecords) over the one action; this file keeps no comparison.
//   4. An action's identity is tools/content-identity's BLAKE3 identity of the canonical JSON of its identity fields.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { isDeepStrictEqual } from 'node:util';
import { filterRecords } from '../../formulas/do-work/requests.mjs';
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';
import vocabulary from '../read-data/action-policy-vocabulary.json' with { type: 'json' };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, sentence) => { if (!ok) throw new Error(sentence); };
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const isTime = value => typeof value === 'string' && isoTime.test(value) && !Number.isNaN(Date.parse(value));
const words = ids => ids.join(', ');
const verdictIds = vocabulary.verdicts.map(({ id }) => id);
const behaviourIds = vocabulary.behaviours.map(({ id }) => id);
const behaviourOf = id => vocabulary.behaviours.find(row => row.id === id);
const scopeOf = id => vocabulary.scopes.find(row => row.id === id);

/** The identity of an action: the BLAKE3 identity of its identity fields (content-identity's canonical JSON). */
export function actionIdentity(action, identityFields) {
  return makeHashCodeHexFromJson(Object.fromEntries(identityFields.map(name => [name, action[name] ?? null])));
}

const fill = (sentence, values) => sentence.replace(/\{(\w+)\}/g, (_, name) => values[name]);

function readPolicy(policy, fields, operators) {
  need(isObject(policy) && Array.isArray(policy.rules), 'policy must be { rules: [{ id, says, when?, then }], otherwise?, paused? }.');
  need(policy.rules.every(rule => isObject(rule) && typeof rule.id === 'string' && rule.id !== ''), 'every rule of the policy needs an id (text).');
  filterRecords({ records: [], fields, operators });
}

/** One rule against the one action: does its `when` hold, and could it be evaluated at all. */
function evaluateRule(rule, action, fields, operators) {
  if (rule.when === undefined || rule.when === null) return { holds: true, evaluated: true };
  const answer = filterRecords({ records: [action], fields, tree: rule.when, operators });
  const evaluated = answer.incomplete.length === 0 && answer.error_rows === 0;
  return { holds: evaluated && answer.matches.length === 1, evaluated };
}

function readRequest(request) {
  need(isObject(request), 'Send an object with action, fields, policy and now.');
  need(isObject(request.action), 'action must be an object: the action the AI is about to take (for example { tool, target, arguments }).');
  need(Array.isArray(request.fields), 'fields must be a list of { id, kind, path? }, the fields the policy rules may read from the action.');
  need(isTime(request.now), 'now must be an ISO time with a zone, for example 2026-01-02T03:04:05Z: the tool has no clock.');
  readPolicy(request.policy, request.fields, request.operators);
  const { rules } = request.policy;
  need(new Set(rules.map(rule => rule.id)).size === rules.length, 'two rules share an id; each rule id must be its own.');
  for (const rule of rules) need(behaviourIds.includes(rule.then), `rule ${rule.id} needs a \`then\` that is one of: ${words(behaviourIds)}.`);
  const identityFields = request.identity_fields ?? vocabulary.identity_fields;
  need(Array.isArray(identityFields) && identityFields.length > 0 && identityFields.every(name => typeof name === 'string' && name !== ''), 'identity_fields must be a list of names of fields of the action.');
  const grants = request.grants ?? [];
  need(Array.isArray(grants) && grants.every(grant => isObject(grant) && typeof grant.id === 'string' && typeof grant.identity === 'string'), 'grants must be a list of { id, identity, scope, thread?, used?, expires_at? }.');
  for (const grant of grants) {
    need(scopeOf(grant.scope) !== undefined, `grant ${grant.id} needs a scope that is one of: ${words(vocabulary.scopes.map(({ id }) => id))}.`);
    need(grant.expires_at === undefined || isTime(grant.expires_at), `grant ${grant.id}: expires_at must be an ISO time with a zone.`);
  }
  const declined = request.declined ?? [];
  need(Array.isArray(declined) && declined.every(item => isObject(item) && typeof item.identity === 'string' && isTime(item.at)), 'declined must be a list of { identity, at } with at an ISO time.');
  need(request.last_person_message_at === undefined || isTime(request.last_person_message_at), 'last_person_message_at must be an ISO time with a zone.');
  const askedFor = request.asked_for ?? [];
  need(Array.isArray(askedFor) && askedFor.every(item => typeof item === 'string'), 'asked_for must be a list of action identities.');
  return { identityFields, grants, declined, askedFor, rules };
}

/** Decide one action: { verdict, enforced, decided_by, says, retry, identity, grant_used, unevaluated, checked_rules }. */
export function decideAction(request) {
  const { identityFields, grants, declined, askedFor, rules } = readRequest(request);
  const { action, fields, operators, policy, now } = request;
  const identity = actionIdentity(action, identityFields);
  const verdictWords = id => vocabulary.verdicts.find(row => row.id === id).says;
  const results = rules.map(rule => ({ rule, ...evaluateRule(rule, action, fields, operators) }));
  const unevaluated = results.filter(({ evaluated }) => !evaluated).map(({ rule }) => rule.id);

  let verdict = null;
  let decidedBy = null;
  let says = null;
  let retry = null;
  let grantUsed = null;

  const decide = (next, by, nextSays, nextRetry = null) => { verdict = next; decidedBy = by; says = nextSays; retry = nextRetry; };
  const ruleSays = ({ rule }, next) => rule.says ?? verdictWords(next);

  if (policy.paused === true) decide(vocabulary.outcomes.paused, { kind: 'paused' }, vocabulary.paused_says, vocabulary.retry.paused);

  if (verdict === null) {
    const firstRefusal = results.find(item => behaviourOf(item.rule.then).checked_first && (item.holds || !item.evaluated));
    if (firstRefusal) {
      const next = behaviourOf(firstRefusal.rule.then).verdict;
      decide(next, { kind: 'rule', id: firstRefusal.rule.id }, ruleSays(firstRefusal, next), vocabulary.retry.refused_by_rule);
    }
  }

  if (verdict === null) {
    const spoken = request.last_person_message_at === undefined ? null : Date.parse(request.last_person_message_at);
    if (declined.some(item => item.identity === identity && (spoken === null || Date.parse(item.at) > spoken))) {
      decide(vocabulary.outcomes.declined, { kind: 'declined' }, vocabulary.declined_says, vocabulary.retry.declined);
    }
  }

  if (verdict === null) {
    const grant = grants.find(item => item.identity === identity
      && (item.expires_at === undefined || Date.parse(item.expires_at) > Date.parse(now))
      && scopeOf(item.scope).requires.every(condition => (condition === 'unused' ? item.used !== true : item.thread !== undefined && item.thread === request.thread)));
    if (grant) {
      decide(vocabulary.outcomes.grant, { kind: 'grant', id: grant.id }, vocabulary.grant_says);
      grantUsed = scopeOf(grant.scope).consumed_on_use ? grant.id : null;
    }
  }

  if (verdict === null) {
    const deciding = results.find(item => !behaviourOf(item.rule.then).checked_first && item.holds);
    if (deciding) {
      const behaviour = behaviourOf(deciding.rule.then);
      const next = behaviour.verdict_when_asked_for !== undefined && askedFor.includes(identity) ? behaviour.verdict_when_asked_for : behaviour.verdict;
      decide(next, { kind: 'rule', id: deciding.rule.id }, ruleSays(deciding, next));
    }
  }

  if (verdict === null) {
    const next = verdictIds.includes(policy.otherwise) ? policy.otherwise : vocabulary.default_verdict;
    decide(next, { kind: 'default' }, verdictWords(next));
  }

  const { from, to } = vocabulary.when_nobody_can_ask;
  if (verdict === from && request.can_ask === false) {
    verdict = to;
    retry = vocabulary.retry.cannot_ask;
  }

  return {
    verdict,
    enforced: request.dry_run !== true,
    decided_by: decidedBy,
    says,
    retry,
    identity,
    grant_used: grantUsed,
    unevaluated,
    checked_rules: rules.length,
  };
}

/** The problems of a policy before it is relied on: { ok, problems: [{ rule, problem, says }] }. */
export function checkPolicy(request) {
  need(isObject(request), 'Send an object with fields and policy.');
  need(Array.isArray(request.fields), 'fields must be a list of { id, kind, path? }, the fields the policy rules may read from an action.');
  readPolicy(request.policy, request.fields, request.operators);
  const { rules } = request.policy;
  const problems = [];
  const report = (rule, problem, values = {}) => problems.push({ rule, problem, says: fill(vocabulary.problems[problem], { rule, ...values }) });
  const seen = new Set();
  for (const [at, rule] of rules.entries()) {
    if (seen.has(rule.id)) report(rule.id, 'repeated-id');
    seen.add(rule.id);
    const behaviour = behaviourOf(rule.then);
    if (behaviour === undefined) {
      report(rule.id, 'unknown-behaviour', { then: String(rule.then), other: words(behaviourIds) });
      continue;
    }
    if (rule.when !== undefined && rule.when !== null && filterRecords({ records: [], fields: request.fields, tree: rule.when, operators: request.operators }).incomplete.length > 0) report(rule.id, 'incomplete-when');
    const sameWhen = other => isDeepStrictEqual(other.when ?? null, rule.when ?? null);
    const blocker = rules.find((other, index) => other !== rule && behaviourOf(other.then) !== undefined && sameWhen(other)
      && (behaviourOf(other.then).checked_first ? !behaviour.checked_first || index < at : !behaviour.checked_first && index < at));
    if (blocker) report(rule.id, 'never-decides', { other: blocker.id });
  }
  return { ok: problems.length === 0, problems };
}
