// src/show-rules-store.mjs
//
// Purpose
//   The person store's end of show rules (src/workspace/show-rules.mjs decides them): reading the rules a person keeps,
//   keeping one, taking one away or turning a starting rule off, and deciding how one thing shows on a channel, for
//   tell()'s check before each device channel and for their AIs. The rules are the person's own workspace record (label
//   from show-rules.json `record`), the same record the open page follows live, so a rule an AI keeps reaches the page
//   without a reload.
//
//   GET  /show-rules              { rules, subjects, moment_facts, effects, quick, operators, controls, said }
//                                 (controls: every control the parts declare, parts/ui/show/show-rules/declared-controls.mjs)
//   POST /show-rules/set          { rule } | { starting: { id, on } } | { type } | { remove_type } | { use: { type, on } } | { give }
//                                                                           { rule?, rules, types, in_use?, said }
//   POST /show-rules/remove       { id }                                     { rules, said }
//   POST /show-rules/decide       { subject, thing, moment? }                { hidden, silenced, until, rules, next_change_at }
//   POST /show-rules/accounts     { filter? }                                { accounts, said } (the service's owner only)
//
// Non-negotiable invariants
//   1. Nothing here names a subject, a fact or an effect: show-rules.json and the caller say them.
//   2. Every change is src/workspace/show-rules.mjs changedRecord, and a rule with a problem is refused in its words.
//   3. The formula engine decides (the store's tool:filter-rows-by-rules); this file decides nothing itself.
//   4. Types are kept in the same record ({ type } keeps one, { remove_type } takes one away). A person switches their own
//      kept profiles on and off with { use } (record.in_use); a profile applies only while it is on, and never by audience.
//      Which types an account holds is its cohorts in the giver's setup-context record (the one the setup steps already
//      read, keyed by account): { give: { account_id, add?, remove? } } changes them, and only the service's owner
//      (authority operator) gives.
//

import data from './workspace/show-rules.json' with { type: 'json' };
import operators from '../parts/formula-engine/rules/rule-operators.json' with { type: 'json' };
import { changedRecord, everyRule, givenEditRules, givenRules, profileRules, ruleProblem, showDecision, typeProblem, typesOf } from './workspace/show-rules.mjs';
import { compileRules, ruleVocabulary } from '../parts/formula-engine/rules/compile-rules.mjs';
import setupSettings from './setup-steps.json' with { type: 'json' };
import { DECLARED_CONTROLS } from '../parts/ui/show/show-rules/declared-controls.mjs';
import { ACCOUNT_RULE_FIELDS, accountFacts, accountRuleFields, createdAtFor, declaredAccountTags } from './work-for-ais.mjs';
import { decideRuleEffects } from './rule-decisions.mjs';
import { failureOf } from './failure.mjs';

export const isShowRulesPath = path => path === '/show-rules' || path.startsWith('/show-rules/');
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// An actor the edit rules or the service's ownership do not allow: refused as 403, apart from a malformed edit's 400.
const notAllowed = message => Object.assign(new Error(message), { status: 403 });
const words = list => list.map(({ id, label, kind, choices }) => ({ id, label, ...(kind ? { kind } : {}), ...(choices ? { choices } : {}) }));

/** Only facts referenced by the current giver's audiences need their account owners to be read. */
export function givenAccountFields(giver) {
  const fields = new Set();
  const visit = tree => {
    if (!object(tree)) return;
    if (tree.kind === 'rule' && typeof tree.field === 'string') fields.add(tree.field);
    if (tree.kind === 'group' && Array.isArray(tree.rules)) tree.rules.forEach(visit);
  };
  typesOf(giver).forEach(type => { visit(type.audience); (type.edit_rules ?? []).forEach(rule => visit(rule.audience)); });
  (Array.isArray(giver?.rules) ? giver.rules : []).filter(rule => rule?.on !== false).forEach(rule => visit(rule?.audience));
  (Array.isArray(giver?.edit_rules) ? giver.edit_rules : []).filter(rule => rule?.on !== false).forEach(rule => visit(rule?.audience));
  return fields;
}

/**
 * The rules the operator gives one account (src/workspace/show-rules.mjs givenRules) and that account's facts as its
 * audience sees them, including self-assignment. One owner for the account's own store and its own records resource.
 *   giverRecords: { workspaceRecord(label) } the operator's records (its own, or the service's edge copy every other account reads)
 *   accountId, workFacts(needed): this account's (src/work-for-ais.mjs: created_at, created_known, plan, setup_included, setup_done,
 *     operator); needed is the set of account fields the audiences name
 *   readAccess({ require_current_contracts }) → its current access, read only when an audience names offers or capabilities
 *   passkeys() → its sign-up passkeys, read only when no creation date is known; noteCreated(ms) keeps the date found
 *   filterRows: the formula engine's row filter
 */
export async function givenShowRulesSource({ giverRecords, accountId, workFacts, readAccess, passkeys, noteCreated = null, filterRows, candidateGiver = undefined, factsGiver = candidateGiver }) {
  const [currentGiver, context] = await Promise.all([giverRecords.workspaceRecord(data.record), giverRecords.workspaceRecord(setupSettings.policy.context_record)]);
  const giver = candidateGiver === undefined ? currentGiver : candidateGiver;
  const entry = context?.[setupSettings.policy.account_context_key]?.[accountId] ?? {};
  const needed = new Set([...givenAccountFields(currentGiver), ...givenAccountFields(factsGiver ?? giver)]);
  // The facts the audiences name decide what is read: an owner that must ask for its access skips it when none names it.
  const mine = await workFacts(needed);
  const access = needed.has('offers') || needed.has('capabilities') ? await readAccess({ require_current_contracts: true }) : null;
  const offers = access ? [...new Set([...(access.active_offers ?? []), ...(access.episodes ?? []).filter(row => row.state === 'active' && row.offer_id).map(row => row.offer_id)])] : null;
  const { createdAt, found } = await createdAtFor({ context: entry, known: mine.created_known, firstSeen: mine.created_at, passkeys });
  if (found !== null && noteCreated) await noteCreated(found);
  const facts = accountFacts({ accountId, plan: mine.plan, offers, capabilities: access?.capabilities ?? null, createdAt, context: entry, setupIncluded: mine.setup_included, setupDone: mine.setup_done, operator: mine.operator, attributes: entry.attributes });
  const declared = new Map([...(currentGiver?.attribute_fields ?? []), ...(factsGiver?.attribute_fields ?? []), ...(giver?.attribute_fields ?? [])].map(field => [field.id, field]));
  const fields = accountRuleFields([...declared.values()]);
  const factsValue = { ...facts, cohorts: Array.isArray(entry.cohorts) ? entry.cohorts : [] };
  return { giver: giver ?? null, current_giver: currentGiver ?? null, facts: factsValue,
    stamp: JSON.stringify([currentGiver ?? null, factsValue]),
    matches: async (tree, row) => (await filterRows({ tree, fields, rows: [row] })).matches.length === 1 };
}

/**
 * records:    { read(label) → value | null, write([{ address_label, payload }]), update(label, change) } (the person's workspace
 *             records; update changes one record in one step)
 * filterRows: the formula engine's row filter (a promise of { matches })
 * now:        () → Date
 * givenSource: (proposedGiver?, factsGiver?) => { giver, facts, matches, stamp? } | null, the rules the operator gives this account
 *             (person-store givenSource); the separate facts giver lets current policy use facts referenced only by a candidate.
 */
export function makeShowRules({ records, filterRows, authority = 'personal', now = () => new Date(), givenSource = null, spaceContext = null, changedForAccount = null, readConflict = null, resolveConflict = null, validateActor = async actor => Boolean(actor?.account_id) }) {
  const record = () => { const value = records.read(data.record); return object(value) ? value : null; };
  const keep = (next, before) => records.write([{ address_label: data.record, payload: next,
    ...(records.identity ? { expected_identity: before ? records.identity(before) : null } : {}) }]);
  const activeEditRules = value => (Array.isArray(value?.edit_rules) ? value.edit_rules : data.edit_authority.starting_rules)
    .filter(rule => object(rule) && rule.on !== false);
  const editFields = data.edit_authority.facts;
  const editVocabulary = ruleVocabulary(operators);
  const audienceFields = value => accountRuleFields(value?.attribute_fields);
  const validateAudienceTree = (tree, fields = audienceFields(record())) => {
    if (!object(tree) || tree.kind !== 'group' || !['and', 'or'].includes(tree.combinator) || typeof tree.negate !== 'boolean' || !Array.isArray(tree.rules)
      || tree.rules.some(node => node?.kind === 'group' ? !validateAudienceTree(node, fields) : node?.kind !== 'rule' || typeof node.field !== 'string' || typeof node.operator !== 'string' || !object(node.params))) return false;
    return compileRules(tree, { fields, vocabulary: editVocabulary }).incomplete.length === 0;
  };
  const validTree = tree => {
    if (!object(tree) || tree.kind !== 'group' || !['and', 'or'].includes(tree.combinator) || typeof tree.negate !== 'boolean' || !Array.isArray(tree.rules)) return false;
    return tree.rules.every(node => node?.kind === 'group' ? validTree(node)
      : node?.kind === 'rule' && typeof node.field === 'string' && typeof node.operator === 'string' && object(node.params));
  };
  const condition = (field, value) => ({ kind: 'rule', field, operator: 'is_any_of', params: { values: Array.isArray(value) ? value : [value] } });
  const editCondition = rule => ({ kind: 'group', combinator: 'and', negate: false, rules: [
    ...(rule.who?.kind === 'account_owner' ? [{ kind: 'rule', field: 'account_owner', operator: 'is_true', params: {} }] : []),
    ...(rule.who?.kind === 'reader' && typeof rule.who.reader === 'string' ? [condition('reader', rule.who.reader)] : []),
    ...(Array.isArray(rule.actions) ? [condition('action', data.edit_authority.actions.filter(action => rule.actions.includes(action)))] : []),
    ...(rule.when ? [rule.when] : []),
  ] });
  const editRuleProblem = (rule, accountFields = audienceFields(record())) => {
    if (!object(rule) || typeof rule.id !== 'string' || !rule.id.trim() || !['allow', 'deny'].includes(rule.effect)) return 'An edit rule needs an id and allow or deny effect.';
    if (!['account_owner', 'reader'].includes(rule.who?.kind) || (rule.who.kind === 'reader' && (typeof rule.who.reader !== 'string' || !rule.who.reader))) return 'An edit rule names account_owner or one trusted reader.';
    if (!Array.isArray(rule.actions) || !rule.actions.length || rule.actions.some(action => !data.edit_authority.actions.includes(action))) return `An edit rule names one or more actions: ${data.edit_authority.actions.join(', ')}.`;
    if (rule.until != null && !(Number.isFinite(typeof rule.until === 'number' ? rule.until : Date.parse(rule.until)))) return 'An edit rule until must be a date and time.';
    if (rule.when != null && (!validTree(rule.when) || compileRules(rule.when, { fields: editFields, vocabulary: editVocabulary }).incomplete.length)) return 'An edit rule when must be a complete rule tree over the declared edit facts and operators.';
    if (rule.audience != null && (!validTree(rule.audience) || compileRules(rule.audience, { fields: accountFields, vocabulary: editVocabulary }).incomplete.length)) return 'An edit rule audience must be a complete rule tree over the account facts and operators.';
    return null;
  };
  const decideEdit = async (actor, action, rules = activeEditRules(record()), accountFields = audienceFields(record())) => {
    if (!await validateActor(actor) || !Array.isArray(rules) || rules.some(rule => editRuleProblem(rule, accountFields))) return { allowed: false, validUntil: Infinity };
    const reader = typeof actor.reader === 'string' && actor.reader ? actor.reader : null;
    const at = now().getTime();
    const validUntil = rules.map(rule => rule.until == null ? Infinity : typeof rule.until === 'number' ? rule.until : Date.parse(rule.until))
      .filter(until => Number.isFinite(until) && until > at).reduce((earliest, until) => Math.min(earliest, until), Infinity);
    const facts = { account_owner: true, actor_kind: reader ? 'ai' : 'person', reader, action, now: at };
    const decision = await decideRuleEffects({
      entries: rules.map(rule => ({ rule, when: editCondition(rule), row: facts })),
      effects: data.edit_authority.effects, fields: editFields, now: at, strict: true,
      filterRows,
    });
    if (decision.malformed || decision.incomplete.length || now().getTime() >= validUntil) return { allowed: false, validUntil };
    const allowed = decision.winners.some(entry => entry.rule.effect === 'deny') ? false
      : decision.winners.some(entry => entry.rule.effect === 'allow');
    return { allowed, validUntil };
  };
  const mayEdit = async (actor, action, rules = activeEditRules(record()), accountFields = audienceFields(record())) => (await decideEdit(actor, action, rules, accountFields)).allowed;
  const editRulesNow = async (value, proposedGiver = undefined, factsGiver = proposedGiver) => {
    const source = givenSource ? await givenSource(proposedGiver, factsGiver) : null;
    const giver = authority === 'operator' && proposedGiver ? proposedGiver : source?.giver;
    const inherited = source ? await givenEditRules({ data, ...source, giver }) : [];
    const declared = new Map([...(value?.attribute_fields ?? []), ...(source?.giver?.attribute_fields ?? []), ...(factsGiver?.attribute_fields ?? [])].map(field => [field.id, field]));
    return { rules: [...activeEditRules(value), ...inherited], accountFields: accountRuleFields([...declared.values()]), source, stamp: source ? source.stamp ?? JSON.stringify([source.current_giver ?? source.giver, source.facts]) : 'null' };
  };
  const requireEdit = async (actor, action, value, factsGiver = undefined) => {
    const current = await editRulesNow(value, undefined, factsGiver);
    if (!await mayEdit(actor, action, current.rules, current.accountFields)) throw notAllowed('The current show-rule edit rules do not let this account actor make that change.');
    return current;
  };
  const confirmPolicySnapshot = async (expected, actor, actions, candidate) => {
    const current = await editRulesNow(record(), undefined, candidate);
    if (current.stamp !== expected.stamp) throw new Error('Show-rule edit authority changed during this edit. Read the current rules and retry.');
    let validUntil = Infinity;
    for (const action of actions) {
      const decision = await decideEdit(actor, action, current.rules, current.accountFields);
      if (!decision.allowed) throw notAllowed('Current show-rule edit authority expired or changed before the write. Read the current rules and retry.');
      validUntil = Math.min(validUntil, decision.validUntil);
    }
    const future = await editRulesNow(candidate, authority === 'operator' ? candidate : null, candidate);
    for (const action of actions) {
      const decision = await decideEdit(actor, action, future.rules, future.accountFields);
      if (!decision.allowed) throw notAllowed('The proposed show-rule edit authority expired or changed before the write. Read the current rules and retry.');
      validUntil = Math.min(validUntil, decision.validUntil);
    }
    const finalSnapshot = await editRulesNow(record(), undefined, candidate);
    if (finalSnapshot.stamp !== expected.stamp) throw new Error('Show-rule edit authority changed during this edit. Read the current rules and retry.');
    return validUntil;
  };
  const requireValidEditRules = (rules, { allowEmpty = false, accountFields = audienceFields(record()) } = {}) => {
    if (!Array.isArray(rules) || (!allowEmpty && !rules.length) || rules.length > 100) throw new Error(`edit_rules is a list of ${allowEmpty ? '0' : '1'} to 100 rules.`);
    const ids = new Set();
    for (const rule of rules) {
      const problem = editRuleProblem(rule, accountFields);
      if (problem) throw new Error(problem);
      if (ids.has(rule.id)) throw new Error(`The edit rule ${rule.id} is named twice.`);
      ids.add(rule.id);
    }
  };
  const validateProfileUse = value => {
    if (Object.hasOwn(value, 'in_use')) {
      const own = new Set((Array.isArray(value.types) ? value.types : []).map(type => type?.id));
      if (!Array.isArray(value.in_use) || value.in_use.length > 100 || new Set(value.in_use).size !== value.in_use.length
        || value.in_use.some(id => typeof id !== 'string' || !id.trim() || !own.has(id))) {
        throw new Error('in_use is a unique list of ids of profiles kept in this record.');
      }
    }
  };
  const validateRecord = (value, accountFields = audienceFields(value)) => {
    if (!object(value) || Object.keys(value).some(key => !['rules', 'starting', 'types', 'edit_rules', 'attribute_fields', 'in_use'].includes(key))) {
      throw new Error('A kept show-rules version must be a show-rules record.');
    }
    validateProfileUse(value);
    if (value.attribute_fields != null) {
      if (!Array.isArray(value.attribute_fields)) throw new Error('Account attribute fields must be a list.');
      const names = new Set();
      for (const fact of value.attribute_fields) {
        if (!object(fact) || fact.kind !== 'tags' || typeof fact.id !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(fact.id)
          || typeof fact.label !== 'string' || !fact.label.trim() || names.has(fact.id) || ACCOUNT_RULE_FIELDS.some(field => field.id === fact.id)) {
          throw new Error('Each account attribute needs a unique nonfixed id, label and tags kind.');
        }
        names.add(fact.id);
      }
    }
    if (value.rules != null) {
      if (!Array.isArray(value.rules) || value.rules.length > (data.most_rules ?? Infinity)) throw new Error('A show-rules record needs a valid rules list.');
      const ids = new Set();
      for (const rule of value.rules) {
        if (!object(rule) || typeof rule.id !== 'string' || !rule.id) throw new Error('A show rule needs an id.');
        if (ids.has(rule.id)) throw new Error(`The show rule ${rule.id} is named twice.`);
        ids.add(rule.id);
        const problem = ruleProblem(data, rule, authority);
        if (problem) throw new Error(problem);
      }
    }
    if (value.starting != null) {
      if (!object(value.starting)) throw new Error('Starting-rule state must be a map of ids to { on }.');
      const known = new Set((data.starting_rules ?? []).map(rule => rule.id));
      for (const [id, state] of Object.entries(value.starting)) {
        if (!known.has(id) || !object(state) || typeof state.on !== 'boolean') throw new Error(`Starting-rule state for ${id} is not valid.`);
        const starting = data.starting_rules.find(rule => rule.id === id);
        const problem = ruleProblem(data, starting, authority);
        if (problem) throw new Error(problem);
      }
    }
    if (value.types != null) {
      if (!Array.isArray(value.types) || value.types.length > 100) throw new Error('A show-rules record needs a valid types list.');
      const all = typesOf({ types: value.types });
      const ids = new Set();
      for (const type of value.types) {
        if (!object(type) || typeof type.id !== 'string' || ids.has(type.id)) throw new Error('A show-rules type needs a unique id.');
        ids.add(type.id);
        const problem = typeProblem(data, type, all, authority);
        if (problem) throw new Error(problem);
        if (Object.hasOwn(type, 'edit_rules')) {
          requireValidEditRules(type.edit_rules, { allowEmpty: true, accountFields });
          if (type.edit_rules.some(rule => rule.audience != null && !validateAudienceTree(rule.audience, accountFields))) throw new Error('A profile edit-rule audience must be a complete rule tree over account facts and operators.');
        }
      }
    }
    if (value.edit_rules != null) requireValidEditRules(value.edit_rules, { accountFields });
    return value;
  };
  const familyChanges = (before, after) => {
    const actions = new Set();
    const rows = (value, family) => Array.isArray(value?.[family]) ? value[family] : [];
    const differences = (left, right) => {
      const oldRows = new Map(rows(left, 'rows').map(row => [row.id, row]));
      const newRows = new Map(rows(right, 'rows').map(row => [row.id, row]));
      return [...new Set([...oldRows.keys(), ...newRows.keys()])].filter(id => JSON.stringify(oldRows.get(id) ?? null) !== JSON.stringify(newRows.get(id) ?? null))
        .map(id => ({ id, removed: oldRows.has(id) && !newRows.has(id) }));
    };
    for (const change of differences({ rows: rows(before, 'rules') }, { rows: rows(after, 'rules') })) actions.add(change.removed ? 'remove_rule' : 'change_rule');
    const oldStarting = object(before?.starting) ? before.starting : {};
    const newStarting = object(after?.starting) ? after.starting : {};
    if (JSON.stringify(oldStarting) !== JSON.stringify(newStarting)) actions.add('toggle_starting');
    for (const change of differences({ rows: rows(before, 'types') }, { rows: rows(after, 'types') })) actions.add(change.removed ? 'remove_type' : 'change_type');
    if (JSON.stringify(before?.edit_rules ?? null) !== JSON.stringify(after?.edit_rules ?? null)) actions.add('change_edit_rules');
    if (JSON.stringify(before?.attribute_fields ?? null) !== JSON.stringify(after?.attribute_fields ?? null)) actions.add('change_attribute');
    if (JSON.stringify(before?.in_use ?? []) !== JSON.stringify(after?.in_use ?? [])) actions.add('change_type');
    const oldTypes = new Map(rows(before, 'types').map(type => [type.id, type]));
    const newTypes = new Map(rows(after, 'types').map(type => [type.id, type]));
    for (const id of new Set([...oldTypes.keys(), ...newTypes.keys()])) {
      const oldType = oldTypes.get(id), newType = newTypes.get(id);
      const oldHasPolicy = Boolean(oldType && Object.hasOwn(oldType, 'edit_rules'));
      const newHasPolicy = Boolean(newType && Object.hasOwn(newType, 'edit_rules'));
      if (oldHasPolicy !== newHasPolicy || (oldHasPolicy && newHasPolicy && JSON.stringify(oldType.edit_rules) !== JSON.stringify(newType.edit_rules))) actions.add('change_edit_rules');
    }
    return [...actions];
  };
  const authorizeCandidate = async (actor, before, candidate, currentlyAuthorized = null) => {
    if (!await validateActor(actor)) throw notAllowed('The authenticated account actor cannot change these show rules.');
    // The shared pure constructor normalizes empty use state; malformed current activation must never be erased into a valid candidate.
    validateProfileUse(before ?? {});
    validateRecord(candidate, authority === 'operator' ? audienceFields(candidate) : currentlyAuthorized?.accountFields ?? audienceFields(candidate));
    const actions = familyChanges(before, candidate);
    for (const action of actions) {
      const current = currentlyAuthorized ?? await editRulesNow(before);
      if (!await mayEdit(actor, action, current.rules, current.accountFields)) {
        throw notAllowed(`The current show-rule edit rules do not let this account actor ${action.replaceAll('_', ' ')}.`);
      }
    }
    const future = await editRulesNow(candidate, authority === 'operator' ? candidate : null, candidate);
    for (const action of actions) {
      if (!await mayEdit(actor, action, future.rules, future.accountFields)) {
        throw new Error('This change would stop the actor from making the same show-rule changes again. Keep a future edit rule that allows them.');
      }
    }
    return actions;
  };
  const current = (list, at) => list.filter(rule => !rule.until || Date.parse(rule.until) > at);
  const tellAssignedAccounts = async () => {
    if (authority !== 'operator' || !changedForAccount) return;
    const context = records.read(setupSettings.policy.context_record);
    const failures = [];
    for (const accountId of Object.keys(context?.[setupSettings.policy.account_context_key] ?? {})) {
      try { await changedForAccount(accountId); }
      catch (error) { failures.push(accountId); console.error('Assigned workspace rules refresh failed', accountId, error?.message ?? error); }
    }
    return failures;
  };
  // The owner declares an attribute once (a tags field an audience may name); give then assigns its ids per account.
  const declaredAttribute = ({ id, label } = {}) => {
    if (authority !== 'operator') throw notAllowed('Only the owner of this Trillion service declares account attributes.');
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(id) || typeof label !== 'string' || !label.trim())
      throw new Error('attribute is { id, label }: id is a lowercase word of up to 40 letters, digits or underscores; label says what it is.');
    if (ACCOUNT_RULE_FIELDS.some(fact => fact.id === id)) throw new Error(`${id} is a fixed account fact, not a new attribute.`);
    const fact = { id, label: label.trim(), kind: 'tags' };
    return fact;
  };
  // Which types an account holds: its cohorts in this giver's setup-context record (invariant 4).
  const give = async ({ account_id: accountId, add = [], remove = [], cohorts = null, experiments = null, attributes = null } = {}, actor) => {
    if (attributes !== null && !object(attributes)) throw new Error('attributes is a map of declared ids to add/remove lists.');
    if (authority !== 'operator') throw notAllowed('Only the owner of this Trillion service gives types to other accounts.');
    if (typeof accountId !== 'string' || !accountId) throw new Error('give names account_id, the account the types are given to.');
    if (![add, remove].every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && id))) throw new Error('add and remove are lists of type ids.');
    const audienceChanges = Object.entries({ cohorts, experiments }).filter(([, change]) => change !== null);
    const declaredTags = declaredAccountTags(record()?.attribute_fields).map(fact => fact.id);
    const tagChanges = Object.entries(attributes ?? {});
    const listChangeOk = change => object(change) && Object.keys(change).every(key => ['add', 'remove'].includes(key))
      && [change.add ?? [], change.remove ?? []].every(ids => Array.isArray(ids) && ids.length <= 100
        && ids.every(id => typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 100));
    for (const [field, change] of audienceChanges) {
      if (!listChangeOk(change)) throw new Error(`${field} is { add?: [ids], remove?: [ids] }, with at most 100 nonempty ids per list.`);
    }
    for (const [id, change] of tagChanges) {
      if (!declaredTags.includes(id)) throw new Error(`No attribute ${id} is declared; declare it in the show-rules record first. Declared: ${declaredTags.join(', ') || 'none'}.`);
      if (!listChangeOk(change)) throw new Error(`attributes.${id} is { add?: [ids], remove?: [ids] }, with at most 100 nonempty ids per list.`);
    }
    const known = new Set(typesOf(record()).map(type => type.id));
    const unknown = [...add].find(id => !known.has(id));
    if (unknown) throw new Error(`No type ${unknown}; keep it with { type } first. Types: ${[...known].join(', ')}.`);
    const { context_record: label, account_context_key: key } = setupSettings.policy;
    const prior = record();
    validateRecord(prior ?? {});
    const beforeContext = records.read(label);
    const contextStamp = JSON.stringify(beforeContext ?? null), recordStamp = JSON.stringify(prior);
    let held = [], audience = {};
    const proposedContext = (() => {
      const before = beforeContext;
      const value = object(before) ? before : {};
      const accounts = object(value[key]) ? value[key] : {};
      const entry = object(accounts[accountId]) ? accounts[accountId] : {};
      const next = { ...entry };
      for (const [field, change] of audienceChanges) {
        next[field] = [...new Set([...(Array.isArray(next[field]) ? next[field] : []).filter(id => !(change.remove ?? []).includes(id)), ...(change.add ?? [])])];
        if (next[field].length > 100) throw new Error(`An account holds at most 100 ${field}.`);
      }
      held = [...new Set([...(Array.isArray(next.cohorts) ? next.cohorts : []).filter(id => !remove.includes(id)), ...add])];
      if (held.length > 100) throw new Error('An account holds at most 100 cohorts, including assigned types.');
      next.cohorts = held;
      for (const [id, change] of tagChanges) {
        const kept = object(next.attributes) ? next.attributes : {};
        const ids = [...new Set([...(Array.isArray(kept[id]) ? kept[id] : []).filter(value => !(change.remove ?? []).includes(value)), ...(change.add ?? [])])];
        if (ids.length > 100) throw new Error(`An account holds at most 100 ${id}.`);
        next.attributes = { ...kept, [id]: ids };
      }
      audience = { cohorts: held, experiments: Array.isArray(next.experiments) ? next.experiments : [], ...(tagChanges.length ? { attributes: object(next.attributes) ? next.attributes : {} } : {}) };
      return { ...value, [key]: { ...accounts, [accountId]: next } };
    })();
    const futureRules = async current => {
      if (accountId !== actor?.account_id) return current.rules;
      const source = current.source;
      const entry = proposedContext[key][accountId];
      const facts = { ...(source?.facts ?? accountFacts({ accountId, context: entry })),
        ...Object.fromEntries(declaredTags.map(id => [id, Array.isArray(entry.attributes?.[id]) ? entry.attributes[id] : []])), cohorts: entry.cohorts, experiments: entry.experiments ?? [] };
      return [...activeEditRules(prior), ...await givenEditRules({ data, giver: source?.giver ?? prior, facts,
        matches: source?.matches ?? (async (tree, row) => {
          const answer = await filterRows({ tree, fields: accountRuleFields(prior?.attribute_fields), rows: [row] });
          if (!Array.isArray(answer?.incomplete) || answer.incomplete.length) throw new Error('Assignment audience rules could not be fully read.');
          return answer.matches?.includes(0) === true;
        }) })];
    };
    const authorization = await editRulesNow(prior);
    let validUntil = Infinity;
    const authorize = async current => {
      const decision = await decideEdit(actor, 'change_assignment', current.rules, current.accountFields);
      if (!decision.allowed) throw new Error('The current show-rule edit rules do not let this account actor change assignment.');
      const future = await decideEdit(actor, 'change_assignment', await futureRules(current), current.accountFields);
      if (!future.allowed) throw new Error('This assignment would stop the actor from changing assignments again. Keep a future edit rule that allows them.');
      validUntil = Math.min(validUntil, decision.validUntil, future.validUntil);
    };
    await authorize(authorization);
    const confirmed = await editRulesNow(prior);
    if (confirmed.stamp !== authorization.stamp) throw new Error('Show-rule edit authority changed during this assignment. Read the current rules and retry.');
    await authorize(confirmed);
    const final = await editRulesNow(prior);
    if (final.stamp !== authorization.stamp) throw new Error('Show-rule edit authority changed during this assignment. Read the current rules and retry.');
    records.update(label, currentContext => {
      if (JSON.stringify(currentContext ?? null) !== contextStamp || JSON.stringify(record()) !== recordStamp)
        throw new Error('Account assignments or show rules changed while this assignment was being saved. Read them again and retry.');
      if (now().getTime() >= validUntil) throw new Error('Show-rule assignment authority expired during validation. Read the current rules and retry.');
      return proposedContext;
    });
    let refreshPending = false;
    if (changedForAccount) try { await changedForAccount(accountId); }
    catch (error) { refreshPending = true; console.error('Assigned workspace rules refresh failed', accountId, error?.message ?? error); }
    return { account_id: accountId, types: held, audience, ...(refreshPending ? { refresh_pending: [accountId] } : {}),
      said: held.length ? `That account holds ${held.join(', ')}.` : 'That account holds no types.' };
  };
  // The accounts the operator's setup-context record holds, with the facts that record holds for each, filtered by a rule
  // tree over the account facts (the admin's selection: one, many or a filtered set). A fact the record does not hold is
  // null, never a guess: plan, setup and AI connection live in each account's own store.
  const accounts = async ({ filter = null } = {}) => {
    if (authority !== 'operator') throw notAllowed('Only the owner of this Trillion service lists accounts.');
    if (filter !== null && (!object(filter) || filter.kind !== 'group')) throw new Error('filter is a rule tree over the account facts: { kind: "group", combinator: "and", negate: false, rules: [...] }.');
    const { context_record: label, account_context_key: key } = setupSettings.policy;
    const context = records.read(label);
    const directory = object(context) && object(context[key]) ? context[key] : {};
    const listed = Object.entries(directory).filter(([, entry]) => object(entry)).map(([accountId, entry]) => ({
      account_id: accountId,
      facts: { ...accountFacts({ accountId, createdAt: Date.parse(entry.created_at), context: entry, attributes: entry.attributes }),
        plan: null, setup_included: null, setup_done: null, ai_connected: null, operator: null },
    }));
    const matched = filter === null || listed.length === 0 ? listed
      : (await filterRows({ tree: filter, fields: accountRuleFields(record()?.attribute_fields), rows: listed.map(row => row.facts) })).matches.map(index => listed[index]);
    return { accounts: matched, said: `${matched.length} of ${listed.length} accounts match.` };
  };
  // The profiles a person has switched on (record.in_use), by id; only profiles they kept themselves can be on.
  const inUse = () => (Array.isArray(record()?.in_use) ? record().in_use : []);
  // The operator's rules for this account (invariant 7), read live. The person's switched-on profiles are part of the
  // record itself, so showDecision and read_show_rules see them through the same owner (profileRules).
  const givenNow = async spaceId => {
    const source = givenSource ? await givenSource() : null;
    if (!source) return [];
    let facts = source.facts;
    let spaceTypes = [];
    if (spaceId && spaceContext) {
      const context = await spaceContext(spaceId);
      if (context?.member_type && Array.isArray(context.member_types)) {
        const ids = new Set(context.member_types.map(type => type.id));
        const scopedId = id => ids.has(id) ? `space:${spaceId}:${id}` : id;
        spaceTypes = context.member_types.map(type => ({
          id: scopedId(type.id), label: type.label ?? type.id,
          inherits: (type.inherits ?? []).map(scopedId), rules: [], scope: { space_id: spaceId },
        }));
        const held = ids.has(context.member_type) ? scopedId(context.member_type) : `space:${spaceId}:${context.member_type}`;
        if (!ids.has(context.member_type)) spaceTypes.push({ id: held, label: context.member_type, inherits: [], rules: [], scope: { space_id: spaceId } });
        facts = { ...facts, cohorts: [...(Array.isArray(facts?.cohorts) ? facts.cohorts : []), held] };
      }
    }
    return givenRules({ data, ...source, facts, spaceTypes, space_id: spaceId });
  };
  return {
    async decide({ subject, thing = {}, moment = {}, space_id = null } = {}) {
      if (typeof subject !== 'string' || !subject.trim()) throw new Error(`subject names what is shown: one of ${Object.keys(data.subjects).join(', ')}, or any surface's own.`);
      const spaceId = typeof space_id === 'string' && space_id.trim() ? space_id.trim() : null;
      return showDecision({ data, record: record(), given: await givenNow(spaceId), subject, thing: object(thing) ? thing : {}, moment: object(moment) ? moment : {}, now: now().getTime(), filterRows, space_id: spaceId });
    },
    async read({ space_id = null } = {}) {
      const spaceId = typeof space_id === 'string' && space_id.trim() ? space_id.trim() : null;
      const rules = current([...everyRule(data, record()), ...profileRules(data, record(), spaceId), ...await givenNow(spaceId)], now().getTime());
      const editAuthority = await editRulesNow(record());
      return {
        rules,
        subjects: Object.fromEntries(Object.entries(data.subjects).map(([id, subject]) => [id, { label: subject.label, facts: words(subject.facts),
          ...(subject.allowed_effects ? { allowed_effects: subject.allowed_effects } : {}),
          ...(subject.change_fields ? { change_fields: subject.change_fields.filter(field => !field.authority || field.authority === authority) } : {}) }])),
        authority,
        edit_authority: { actions: data.edit_authority.actions, effects: data.edit_authority.effects, facts: editFields, rules: editAuthority.rules },
        types: typesOf(record()).map(type => ({ id: type.id, label: type.label ?? type.id, inherits: type.inherits ?? [], rules: type.rules ?? [], ...(type.edit_rules ? { edit_rules: type.edit_rules } : {}), ...(type.audience != null ? { audience: type.audience } : {}), ...(type.scope != null ? { scope: type.scope } : {}) })),
        attribute_fields: declaredAccountTags(record()?.attribute_fields),
        in_use: inUse(),
        record: data.record,
        moment_facts: words(data.moment_facts),
        effects: words(data.effects),
        quick: words(data.quick),
        operators: (operators.operators ?? []).map(row => row.id ?? row).filter(Boolean),
        controls: DECLARED_CONTROLS,
        said: rules.some(rule => rule.on) ? `${rules.filter(rule => rule.on).length} rules are on.` : 'No rules are on: everything shows.',
      };
    },
    async set(input = {}, { actor = null } = {}) {
      const at = now().getTime();
      if (object(input.give)) return give(input.give, actor);
      const attribute = object(input.attribute) ? declaredAttribute(input.attribute) : null;
      const use = object(input.use) ? input.use : null;
      const change = object(input.starting) ? { starting: input.starting } : object(input.type) ? { type: input.type }
        : typeof input.remove_type === 'string' ? { remove_type: input.remove_type }
          : Array.isArray(input.edit_rules) ? { edit_rules: input.edit_rules } : { save: input.rule };
      const prior = record();
      let next;
      if (use) {
        next = changedRecord(data, prior, { use }, at, authority);
      } else if (attribute) {
        next = { ...(prior ?? {}), attribute_fields: [...declaredAccountTags(prior?.attribute_fields).filter(fact => fact.id !== attribute.id), attribute] };
      } else if (change.edit_rules) {
        requireValidEditRules(change.edit_rules, { accountFields: audienceFields(prior) });
        next = { ...(prior ?? {}), edit_rules: change.edit_rules };
      } else {
        if (change.type && prior) {
          const existing = typesOf(prior).find(type => type.id === change.type.id);
          // Omission preserves a nested policy; an explicit [] intentionally clears the profile override.
          if (existing && !Object.hasOwn(change.type, 'edit_rules') && Object.hasOwn(existing, 'edit_rules')) {
            change.type = { ...change.type, edit_rules: existing.edit_rules };
          }
        }
        next = changedRecord(data, prior, change, at, authority);
      }
      const authorization = use ? await requireEdit(actor, 'change_type', prior, next) : await editRulesNow(prior, undefined, next);
      if (change.type?.audience != null && !validateAudienceTree(change.type.audience, authorization.accountFields)) throw new Error('A profile audience must be a complete rule tree over the account facts and operators.');
      const actions = await authorizeCandidate(actor, prior, next, authorization);
      if (use && !actions.includes('change_type')) actions.push('change_type');
      const validUntil = await confirmPolicySnapshot(authorization, actor, actions, next);
      if (now().getTime() >= validUntil) throw new Error('Show-rule edit authority expired during validation. Read the current rules and retry.');
      const saved = await keep(next, prior);
      if (saved?.conflicts?.length) throw new Error('Show rules changed while this edit was being saved. Read them again and retry.');
      // Existing assigned accounts must hear changes to their inherited types and aimed rules as well as assignment.
      const refreshPending = await tellAssignedAccounts();
      const rule = change.save ? next.rules.find(one => change.save.id ? one.id === change.save.id : !(prior?.rules ?? []).some(before => before.id === one.id)) : null;
      return { ...(use ? { in_use: next.in_use ?? [] } : {}), ...(attribute ? { attribute } : {}), ...(rule ? { rule } : {}), ...(refreshPending?.length ? { refresh_pending: refreshPending } : {}), rules: current(everyRule(data, next), at), types: typesOf(next).map(type => type.id),
        said: use ? `${use.on ? 'Switched on' : 'Switched off'} ${next.types.find(type => type.id === use.type)?.label ?? use.type}.` : attribute ? `Declared the attribute ${attribute.label}.` : rule ? `Kept: ${rule.label || rule.subject}.` : change.type ? `Kept the type ${change.type.label || change.type.id}.` : 'Changed.' };
    },
    async remove({ id } = {}, { actor = null } = {}) {
      if (typeof id !== 'string' || !id) throw new Error('id is a rule id from read_show_rules.');
      const at = now().getTime();
      const prior = record();
      const next = changedRecord(data, prior, { remove: id }, at, authority);
      const authorization = await editRulesNow(prior, undefined, next);
      const actions = await authorizeCandidate(actor, prior, next, authorization);
      const validUntil = await confirmPolicySnapshot(authorization, actor, actions, next);
      if (now().getTime() >= validUntil) throw new Error('Show-rule edit authority expired during validation. Read the current rules and retry.');
      const saved = await keep(next, prior);
      if (saved?.conflicts?.length) throw new Error('Show rules changed while this edit was being saved. Read them again and retry.');
      const refreshPending = await tellAssignedAccounts();
      return { ...(refreshPending?.length ? { refresh_pending: refreshPending } : {}), rules: current(everyRule(data, next), at), said: 'Taken away.' };
    },
    async resolve({ id, branch_identity: branchIdentity } = {}, { actor = null } = {}) {
      if (typeof id !== 'string' || !id || typeof branchIdentity !== 'string' || !branchIdentity) throw new Error('Choose one exact kept show-rules version.');
      if (typeof readConflict !== 'function' || typeof resolveConflict !== 'function') throw new Error('Show-rule conflict recovery is not available here.');
      const conflict = await readConflict(id);
      if (!object(conflict) || conflict.state !== 'open' || conflict.id !== id || conflict.address !== data.record || !Array.isArray(conflict.branches)) {
        throw new Error('Those show-rule versions are no longer open. Read the current conflict again.');
      }
      const selected = conflict.branches.find(branch => branch.identity === branchIdentity);
      if (!selected) throw new Error('Choose one of the exact versions kept in this conflict.');
      const prior = record();
      const currentIdentity = prior ? records.identity?.(prior) ?? null : null;
      const knownCurrent = conflict.branches.some(branch => (branch.found ? branch.identity : null) === currentIdentity);
      if (!knownCurrent) throw new Error('The current show-rules record changed again. Read the new conflict before resolving it.');
      const candidate = selected.found ? selected.value : {};
      const authorization = await editRulesNow(prior, undefined, candidate);
      const actions = await authorizeCandidate(actor, prior, candidate, authorization);
      const validUntil = await confirmPolicySnapshot(authorization, actor, actions, candidate);
      if (now().getTime() >= validUntil) throw new Error('Show-rule edit authority expired during validation. Read the current rules and retry.');
      const outcome = await resolveConflict(id, selected.identity, {
        conflict_identity: records.identity?.(conflict) ?? null,
        current_identity: currentIdentity,
      });
      if (!outcome?.resolved) throw new Error('The conflict or current show-rules record changed during resolution. Read it again and retry.');
      const refreshPending = await tellAssignedAccounts();
      return { ...outcome, ...(refreshPending?.length ? { refresh_pending: refreshPending } : {}), said: 'Kept that exact show-rules version.' };
    },
    accounts,
  };
}

export async function handleShowRulesRequest(rules, request) {
  const path = new URL(request.url).pathname;
  const verb = path === '/show-rules' ? 'read' : path.slice('/show-rules/'.length);
  if (!Object.hasOwn(rules, verb) || (request.method === 'GET') !== (verb === 'read')) return Response.json({ error: 'Not found' }, { status: 404 });
  try {
    const actor = { account_id: request.headers.get('x-trillion-user'), reader: request.headers.get('x-trillion-reader') };
    const input = request.method === 'GET'
      ? Object.fromEntries(new URL(request.url).searchParams.entries())
      : await request.json().catch(() => ({}));
    return Response.json(await rules[verb](input, { actor }));
  } catch (error) {
    if (error?.status === 403) return Response.json({ error: error.message }, { status: 403 });
    const code = failureOf(error).code;
    // A read failure is a backend outcome, never a bad customer request. Preserve
    // shared operational failures on writes for the Worker's common failure owner;
    // ordinary edit validation and explicit request refusals remain 400 responses.
    if (request.method === 'GET' || (code !== 'unexpected' && code !== 'request-refused')) throw error;
    return Response.json({ error: error.message }, { status: 400 });
  }
}
