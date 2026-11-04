// read-data/account-facts.mjs
//
// The account facts an audience reads, moved byte for byte from trillion src/work-for-ais.mjs (190f72754e) lines 74-122:
// accountFacts, createdAtFor, ACCOUNT_RULE_FIELDS, declaredAccountTags, accountRuleFields and tagAttributes, the part of
// that module src/show-rules-store.mjs imports. Only the imports are this folder's (ports/account-facts.json). The rest of
// work-for-ais.mjs (sending work rows to AIs) is not here.

import settings from './work-for-ais.json' with { type: 'json' };
import setupSettings from '../../set-up-my-account/read-data/setup-steps.json' with { type: 'json' };
import { observerBucket } from '../../run-experiments/read-data/score-candidates.ts';


/** The facts an audience reads for one account (settings.facts). Read from the account's own record, never from an editable one. */
export function accountFacts({ accountId, plan = 'free', offers = null, capabilities = null, createdAt = null, context = null, setupIncluded = false, setupDone = false, operator = false, attributes = null }) {
  const policy = setupSettings.policy;
  return {
    ...tagAttributes(attributes), account_id: accountId, plan, offers, capabilities, created_at: Number.isFinite(createdAt) ? createdAt : null,
    cohorts: Array.isArray(context?.cohorts) ? context.cohorts : [], experiments: Array.isArray(context?.experiments) ? context.experiments : [],
    bucket: accountId ? observerBucket(`${policy.bucket_epoch}:${accountId}`, policy.bucket_count) : null,
    setup_included: setupIncluded === true, setup_done: setupDone === true, ai_connected: true, operator: operator === true,
  };
}

/** The account's creation time (ms) that its audience reads: the date its context record gives, else the date its store first
 *  saw it, or else the earliest of its sign-up passkeys once found. `passkeys()` is read only when neither date is known, and
 *  `found` is that passkey date for the caller to keep, so the worker and the account's own store read one answer. */
export async function createdAtFor({ context = null, known = null, firstSeen = null, passkeys }) {
  const made = Date.parse(context?.created_at);
  if (Number.isFinite(made)) return { createdAt: made, found: null };
  if (Number.isFinite(firstSeen) && known) return { createdAt: firstSeen, found: null };
  const found = Math.min(...(await passkeys().catch(() => [])).map(passkey => Date.parse(passkey?.created_at)).filter(Number.isFinite));
  return Number.isFinite(found) ? { createdAt: found, found } : { createdAt: firstSeen, found: null };
}

/** The facts the work rows' audiences read of one account: its own work facts (`workFacts()` → { created_at, created_known,
 *  plan, setup_included, setup_done, operator }), its context row, and a creation date found in its sign-up passkeys when
 *  none is known yet, kept with `noteCreated(ms)`. */
export async function deliveryFacts({ accountId, workFacts, context = null, passkeys, noteCreated = null }) {
  const mine = await workFacts();
  const { createdAt, found } = await createdAtFor({ context, known: mine.created_known, firstSeen: mine.created_at, passkeys });
  if (found !== null && noteCreated) await noteCreated(found);
  return accountFacts({ accountId, plan: mine.plan, createdAt, context, setupIncluded: mine.setup_included, setupDone: mine.setup_done, operator: mine.operator });
}

/** The account fields a rule's audience may name (the same list the work rows read). */
export const ACCOUNT_RULE_FIELDS = settings.facts;

/** The tags the operator declares and keeps per account (the show-rules record's `attributes`): tags fields after the fixed facts.
 *  A declaration that repeats a fixed fact, or is not a tags kind, is not a field. */
export function declaredAccountTags(declared) {
  const fixed = new Set(ACCOUNT_RULE_FIELDS.map(fact => fact.id));
  return (Array.isArray(declared) ? declared : []).filter(fact => fact?.kind === 'tags' && typeof fact.id === 'string' && !fixed.has(fact.id));
}

/** The fields an audience may name for an account: the fixed facts, then the declared tags. */
export const accountRuleFields = declared => [...ACCOUNT_RULE_FIELDS, ...declaredAccountTags(declared)];

// The owner's kept tags per account, as lists of ids only; a fixed fact of the same name is set after these, so it is never overwritten.
const tagAttributes = attributes => Object.fromEntries(Object.entries(attributes && typeof attributes === 'object' ? attributes : {})
  .filter(([, ids]) => Array.isArray(ids) && ids.every(id => typeof id === 'string')));
