// One-to-one port of trillion@b6ae0ebf815f2f5271eed34e6e023c7e1767ec04 src/space-permissions.mjs75–343.
// The normal immutable baseline commit precedes this active target. Current semantic record reads replace SQL;
// the public compiled formula/effect/DATA owners replace retired imports. Stored policy is never reset by identity.
import { readFileSync } from 'node:fs';
import permissions from '../../space-permission-rules/src/space-permission-rules.json' with { type: 'json' };
import { initSync, compileRules, filterRecords } from 'trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine.js';
import recordSharing from '../../decide-when-things-show/read-data/record-sharing.json' with { type: 'json' };
import { decideRuleEffects } from '../../set-up-my-account/read-data/rule-decisions.mjs';
// The formula engine is loaded on the first rule read, from its bytes beside the built module.
let engineReady = false;
const engine = () => {
  if (!engineReady) {
    initSync({ module: readFileSync(new URL(import.meta.resolve('trillion-workshop/tools/formula-engine/built-stored-bytes/formula-engine/formula_engine_bg.wasm'))) });
    engineReady = true;
  }
};
const filterRows = input => { engine(); return filterRecords({ records: input.rows, fields: input.fields, tree: input.tree }); };
export const unknown = message => Object.assign(new Error(message), { code: 'SPACE_PERMISSION_UNKNOWN' });
export const deadlineOf = (rules, at) => rules.reduce((deadline, rule) => {
  const until = typeof rule.until === 'number' ? rule.until : rule.until == null ? Infinity : Date.parse(rule.until);
  return Number.isFinite(until) && until > at ? Math.min(deadline, until) : deadline;
}, Infinity);
const AUTHOR_FIELDS = permissions.facts.map(({ id, kind }) => ({ id, kind }));
const ACTIONS = new Map(permissions.actions.map(action => [action.id, action]));
const EFFECTS = new Map((permissions.effects ?? []).map(effect => [effect.id, effect]));
const NOT_A_MEMBER = ACTIONS.get('read_space').refused;
// The rules a space starts with, by its label (default_rules_by_label), else default_rules; one text per label.
const STARTING_TEXT = new Map(Object.entries(permissions.default_rules_by_label ?? {}).map(([label, rules]) => [label, JSON.stringify(rules)]));
const DEFAULT_TEXT = JSON.stringify(permissions.default_rules);
const startingText = label => STARTING_TEXT.get(label) ?? DEFAULT_TEXT;

const WHO = new Map(permissions.who_kinds.map(kind => [kind.kind, kind]));
const condition = (field, operator, values) => ({ kind: 'rule', field, operator, params: { values } });

// Who a rule is about, as conditions over the facts (who_kinds DATA): a fact that must be true, or one that must be
// the id the rule names, and, for a named member type or person, being in the space now. null: `who` is not usable.
function whoConditions(who) {
  const kind = WHO.get(who?.kind);
  if (!kind) return null;
  if (!kind.fact) return [];
  if (!kind.needs) return [condition(kind.fact, 'is_any_of', [kind.value])];
  const id = who[kind.needs];
  if (typeof id !== 'string' || !id.trim()) return null;
  return [...(kind.member ? [condition('is_member', 'is_any_of', [true])] : []), condition(kind.fact, kind.operator ?? 'is_any_of', [id])];
}

// A rule's whole condition: its who, its actions and its when, all of which must hold (a tree the engine reads).
function conditionOf(rule) {
  const parts = [...(rule.who === undefined ? [] : whoConditions(rule.who) ?? []), ...(Array.isArray(rule.actions) ? [condition('action', 'is_any_of', rule.actions)] : []), ...(rule.when ? [rule.when] : [])];
  return { kind: 'group', combinator: 'and', rules: parts };
}

const nodesOf = node => (node?.kind === 'group' ? [node, ...(node.rules ?? []).flatMap(nodesOf)] : [node]);

/** Every reason a rule list cannot be kept, in plain words; empty when all of it is finished. */
export const problemsWithRules = rules => ruleProblems(rules).map(problem => problem.says);

/** The same reasons, each with the index of the rule it is about (null when it is about the whole list), so a screen
 *  can show each beside its rule. */
export function ruleProblems(rules) {
  if (!Array.isArray(rules) || !rules.length || rules.length > 100) return [{ index: null, says: 'The rules are a list of 1 to 100 rules, each { id, effect, says, refuses?, who?, actions?, when? }.' }];
  const problems = [];
  const seen = new Set();
  for (const [index, rule] of rules.entries()) {
    const push = says => problems.push({ index, says });
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) { push('Each rule must be an object.'); continue; }
    const name = typeof rule?.id === 'string' && rule.id.trim() ? `The rule "${rule.id}"` : `Rule ${index + 1}`;
    if (typeof rule?.id !== 'string' || !rule.id.trim() || rule.id.length > 80) push(`${name} needs an id of up to 80 characters.`);
    else if (seen.has(rule.id)) push(`${name} is named twice.`);
    seen.add(rule?.id);
    if (!EFFECTS.has(rule?.effect)) push(`${name} needs effect ${[...EFFECTS.keys()].map(id => JSON.stringify(id)).join(' or ')}.`);
    if (typeof rule?.says !== 'string' || !rule.says.trim() || rule.says.length > 300) push(`${name} needs says: what it means, in up to 300 characters.`);
    if (rule?.refuses !== undefined && (typeof rule.refuses !== 'string' || !rule.refuses.trim() || rule.refuses.length > 300)) push(`${name} has refuses that is not words of up to 300 characters.`);
    if (rule?.until !== undefined && rule.until !== null && !Number.isFinite(typeof rule.until === 'number' ? rule.until : Date.parse(rule.until))) push(`${name} has until that is not a date and time.`);
    if (rule?.who !== undefined && !whoConditions(rule.who)) push(`${name} has who that is not one of: ${permissions.who_kinds.map(kind => (kind.needs ? `{ kind: "${kind.kind}", ${kind.needs} }` : `{ kind: "${kind.kind}" }`)).join(', ')}.`);
    if (rule?.actions !== undefined && (!Array.isArray(rule.actions) || !rule.actions.length)) push(`${name} has actions that is not a list of one or more actions.`);
    if (rule?.when !== undefined && rule.when?.kind !== 'group') { push(`${name} has when that is not a group of conditions.`); continue; }
    if (nodesOf(conditionOf(rule)).some(node => !node || !['group', 'rule'].includes(node.kind) ||
      node.kind === 'group' && (!['and', 'or'].includes(node.combinator) || !Array.isArray(node.rules)))) {
      push(`${name} has an unfinished group of conditions.`); continue;
    }
    let incomplete;
    engine();
    try { ({ incomplete } = compileRules({ tree: conditionOf(rule), fields: AUTHOR_FIELDS })); }
    catch { push(`${name} has conditions that cannot be compiled.`); continue; }
    if (incomplete.length) push(`${name} has ${incomplete.length === 1 ? 'a condition' : `${incomplete.length} conditions`} that ${incomplete.length === 1 ? 'is' : 'are'} not finished (a fact from ${AUTHOR_FIELDS.map(field => field.id).join(', ')}, a comparison and its values).`);
    const unknown = nodesOf(conditionOf(rule)).filter(node => node?.field === 'action').flatMap(node => node.params?.values ?? []).filter(value => !ACTIONS.has(value));
    if (unknown.length) push(`${name} names ${unknown.map(value => `"${value}"`).join(', ')}, which ${unknown.length === 1 ? 'is not an action' : 'are not actions'}; the actions are: ${[...ACTIONS.keys()].join(', ')}.`);
  }
  return problems;
}

/** A space's rules, plus why an invalid set refuses everything, if they do. */
function ruleSetFrom(text) {
  let rules;
  try { rules = JSON.parse(text); } catch { return { text, rules: [], broken: 'The rules of this pursuit cannot be read, so nothing is allowed in it until they are set again.' }; }
  const problems = problemsWithRules(rules);
  if (problems.length) return { text, rules: Array.isArray(rules) ? rules : [], broken: `${problems[0]} Until it is, nothing is allowed in this space.` };
  return { text, rules, broken: null };
}

// What each rule covers, in the actions' own words, for showing a rule to a person.
function coverOf(rule) {
  const named = nodesOf(conditionOf(rule)).filter(node => node?.field === 'action');
  const labels = ids => ids.map(id => ACTIONS.get(id)?.label ?? id);
  const only = named.filter(node => node.operator === 'is_any_of').flatMap(node => node.params?.values ?? []);
  const except = named.filter(node => node.operator === 'is_none_of').flatMap(node => node.params?.values ?? []);
  return { covers: only.length ? labels(only) : ['Everything'], except: labels(except) };
}

export const spacePermissionMethods = {
  // Confirmed absence alone seeds defaults. The atomic insert returns the winning stored row.
  async spaceRuleSet(spaceId) {
    let row = await this.records.rules(spaceId);
    if (row === null) {
      const space = await this.records.read(spaceId);
      if (!space) throw new Error(NOT_A_MEMBER);
      row = await this.records.ensureRules(spaceId, { rules: startingText(space.label), changed_at: new Date().toISOString() });
    }
    if (!row || typeof row.rules !== 'string') throw unknown('The stored space rules cannot be read.');
    const set = ruleSetFrom(row.rules);
    if (set.broken) throw unknown(set.broken);
    return { ...set, changed_at: row.changed_at };
  },

  // The one decision: whether `relay` may do `action` in `space` under `set`, to `thing` ({ by, origin }, or null when
  // the thing named is not there, which decides whether they may look in the space at all).
  async decideInSpace(space, relay, action, thing, set, { memberTypeOverride, memberTypesOverride, communityConfigOverride } = {}) {
    await this.admit(space.id, relay);
    if (!ACTIONS.has(action)) throw unknown('The named space action is unknown.');
    if (thing?.shared_here === false) return { allowed: false, says: recordSharing.refused.not_shared_here, rule: null };
    const admittedSourceOwner = action === 'withdraw_item' && thing?.by === relay && thing?.origin === 'private'
      ? await this.sourceAuthority({ spaceId: space.id, relay, action, thing }) === true : false;
    const invariants=(permissions.invariant_rules??[]).filter(rule=>!rule.actions||rule.actions.includes(action));
    if(invariants.length){
      const facts={action,admitted_private_source_owner:admittedSourceOwner};
      const decision=await decideRuleEffects({entries:invariants.map(rule=>({rule,when:conditionOf(rule),row:facts})),effects:permissions.effects,fields:AUTHOR_FIELDS,now:Date.now(),strict:true,filterRows});
      if(decision.malformed||decision.incomplete.length)throw unknown('The mandatory source controls cannot be verified.');
      const winner=decision.winners[0]?.rule,outcome=permissions.effects.find(effect=>effect.id===winner?.effect)?.outcome;
      if(outcome)return {allowed:outcome==='allow',says:winner.says,rule:winner.id};
    }
    set ??= await this.spaceRuleSet(space.id);
    if (set.broken) throw unknown(set.broken);
    const asked = thing === null ? 'read_space' : action;
    const member = relay ? await this.records.member(space.id, relay) : null;
    const membership = member?.state === 'member' ? member : null;
    const memberType = membership ? (relay === memberTypeOverride?.relay ? memberTypeOverride.type : membership.role || 'member') : null;
    const memberTypes = membership ? await this.memberTypeIdsOf(space, memberType, memberTypesOverride) : [];
    // A community keeps what its roles may do in its configuration; its owner is the space's own (created_by, which a
    // hand-over moves), as for every space.
    const config = communityConfigOverride === undefined ? await this.communityConfig(space.id) : communityConfigOverride;
    const owner = space.created_by;
    const community = await this.joinedByRules(space.id);
    const facts = {
      action: asked,
      admitted_private_source_owner: admittedSourceOwner,
      is_member: Boolean(membership),
      member_type: memberType,
      member_types: memberTypes,
      person: relay || null,
      holds_link: thing?.link === true,
      is_owner: Boolean(relay) && relay === owner,
      // Who puts meetings on, unless the space says: everyone in a team, the owner in a community joined by its rules.
      events_by: config?.events_by ?? (community ? 'owner' : 'members'),
      type_may: memberTypes.some(typeId => config?.roles?.[typeId]?.may?.includes(asked)),
      is_community: community,
      takes_invitations: Boolean(config?.join?.some(row => row.invited === true)),
      made_it: thing?.by === undefined ? null : thing.by === relay,
      maker_is_member: thing?.by ? await this.isMemberNow(space.id, thing.by) : null,
      thing_origin: thing?.origin ?? null,
      owner_shares_here: thing?.shared_here ?? null,
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const at = Date.now();
      const deadline = deadlineOf(set.rules, at);
      const decision = await decideRuleEffects({
        entries: set.rules.map(rule => ({ rule, when: conditionOf(rule), row: facts })),
        effects: permissions.effects, fields: AUTHOR_FIELDS, now: at, strict: true,
        filterRows,
      });
      // A rule expiring while the engine answers changes the winning policy, even when SQL did not change.
      if (Date.now() >= deadline) continue;
      if (decision.malformed || decision.incomplete.length) throw unknown('The rules of this pursuit cannot be read, so nothing is allowed in it until they are set again.');
      const winner = decision.winners[0]?.rule;
      const outcome = permissions.effects.find(effect => effect.id === winner?.effect)?.outcome;
      if (outcome === 'deny') return { allowed: false, says: winner.refuses ?? ACTIONS.get(asked)?.refused ?? NOT_A_MEMBER, rule: winner.id };
      if (outcome === 'allow') return { allowed: true, says: winner.says, rule: winner.id };
      return { allowed: false, says: ACTIONS.get(asked)?.refused ?? NOT_A_MEMBER, rule: null };
    }
    throw unknown('Space permission expiry changed while this was checked. Try again.');
  },

  // The space, when `relay` may do `action` in it; otherwise the refusal's own words are thrown. `thing` is what the
  // action is done to ({ by: who put it there, origin, link: true when it is an open invite link the person holds }), null when the thing named is not in the space (the caller
  // then says it is not there), or left out when the action is on the space itself.
  async spaceAccessState(spaceId, relay, thing) {
    const state = await this.records.accessState(spaceId, relay, thing);
    if (typeof state !== 'string' || !state) throw unknown('The current complete space access state is unavailable.');
    return state;
  },

  async assertSpaceAccessUnchanged(spaceId, relay, before, thing) {
    if (before !== await this.spaceAccessState(spaceId, relay, thing)) throw new Error('Space permissions changed while this was read. Try again.');
  },

  // Whether `relay` may know this space is there: a member, someone its rules let read it, or anyone at all when the
  // space is open to everyone (src/community.mjs openToEveryone: listed by its configuration or readable by its rules).
  // Anyone else is refused with the same words a space id that names nothing gets, so a refusal never tells a stranger
  // a space exists.
  async mayKnowSpace(space, relay, set) {
    if (relay && await this.isMemberNow(space.id, relay)) return true;
    if ((await this.decideInSpace(space, relay, 'read_space', undefined, set)).allowed) return true;
    return this.openToEveryone(space.id);
  },

  async allowedInSpace(spaceId, relay, action, thing) {
    const id = String(spaceId ?? '');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.admit(id, relay);
      const space = await this.records.read(id);
      if (!space) throw new Error(NOT_A_MEMBER);
      const set = await this.spaceRuleSet(id);
      const before = await this.spaceAccessState(id, relay, thing);
      const deadline = deadlineOf(set.rules, Date.now());
      const decided = await this.decideInSpace(space, relay, action, thing, set);
      if (before !== await this.spaceAccessState(id, relay, thing) || Date.now() >= deadline) continue;
      if (!decided.allowed) throw new Error(await this.mayKnowSpace(space, relay, set) ? decided.says : NOT_A_MEMBER);
      await this.admit(id, relay);
      await this.captureSpaceCommit({ spaceId: id, relay, thing, state: before, deadline });
      return space;
    }
    throw new Error('Space permissions changed while this action was checked. Try again.');
  },

  // The rules of a space as a member reads them: each rule with what it covers, the facts and actions a rule may
  // name, and whether this person may change them.
  async readSpaceRules({ relay, space_id: spaceId }) {
    const space = await this.allowedInSpace(spaceId, relay, 'read_rules');
    const set = await this.spaceRuleSet(space.id);
    const change = await this.decideInSpace(space, relay, 'change_rules');
    const setMemberType = await this.decideInSpace(space, relay, 'set_member_type');
    const nameOf = await this.memberNames(space.id);
    return {
      space_id: space.id, changed_at: set.changed_at, as_started: set.text === startingText(space.label), may_change: change.allowed, may_set_member_type: setMemberType.allowed,
      ...(set.broken ? { broken: set.broken } : {}),
      rules: set.rules.map(rule => ({ ...rule, ...(set.broken ? {} : coverOf(rule)) })),
      facts: permissions.facts, who_kinds: permissions.who_kinds.map(({ kind, label, needs }) => ({ kind, label, needs })), actions: permissions.actions.map(({ id, label }) => ({ id, label })),
      // Who a rule can name: each current member by the id a rule's who uses, the name they show here and their type.
      members: (await this.currentMembers(space.id)).map(row => ({ member_id: row.relay, name: nameOf(row.relay), member_type: row.role })),
      // The member types a rule can name here (src/space-member-types.mjs), in the order they are offered.
      member_types: await this.memberTypesOf(space),
    };
  },

  // Replaces a space's rules (null puts back the ones every space starts with). Kept only when every rule is
  // finished and the new rules still let the person saving them change the rules again.
  async setSpaceRules({ relay, space_id: spaceId, rules }) {
    const space = await this.allowedInSpace(spaceId, relay, 'change_rules');
    const text = rules === null ? startingText(space.label) : JSON.stringify(rules);
    const problems = problemsWithRules(JSON.parse(text));
    if (problems.length) throw new Error(`These rules cannot be kept: ${problems.join(' ')}`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.spaceAccessState(space.id, relay);
      const candidate = ruleSetFrom(text);
      const at = Date.now();
      const deadline = Math.min(deadlineOf((await this.spaceRuleSet(space.id)).rules, at), deadlineOf(candidate.rules, at));
      const current = await this.allowedInSpace(space.id, relay, 'change_rules');
      const after = await this.decideInSpace(current, relay, 'change_rules', undefined, candidate);
      if (before !== await this.spaceAccessState(space.id, relay) || Date.now() >= deadline) continue;
      if (!after.allowed) throw new Error('These rules would stop you changing them again. Keep a rule that lets you change who may do what.');
      await this.admit(space.id, relay);
      if (typeof this.records.compareAndSetRules !== 'function') throw unknown('Atomic space policy writes are unavailable.');
      const accepted = await this.records.compareAndSetRules(space.id, { state: before, deadline, relay, resource: this.resource, row: { rules: text, changed_at: new Date().toISOString() } });
      if (accepted !== true) continue;
      await this.spaceChanged(space.id);
      return this.readSpaceRules({ relay, space_id: space.id });
    }
    throw new Error('Space permissions changed while these rules were checked. Try again.');
  },
};
