// src/workspace/show-rules.mjs
//
// NO PRIOR: what decides whether anything Trillion would show shows, shared by the page (show-rules-live.ts, the seam
// every surface asks through parts/ui/show/show-rules) and the person store (src/show-rules-store.mjs: the routes and
// MCP tools that read and set rules, and tell()'s check before each device channel).
//
// PURPOSE
//   A person keeps show rules (show-rules.json says their shape): each is about a subject (notices, tours, layouts, any
//   surface), holds when the formula engine says its `when` tree holds over the thing's facts and the moment's facts
//   (where it is shown, the device, whether the page was opened from a link, the hour and weekday in the rule's own time
//   zone, now itself), and has an effect (hide, silence) until its `until`. Every surface asks one question, "how does
//   this thing show now?", and gets plain effects back: hidden, silenced, until when, which rules, and when that answer
//   can next change by itself.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a subject, a fact, an effect or a choice: all are DATA (show-rules.json) or the caller's.
//      A fact a rule names that the subject's DATA does not declare is read from the thing itself, so a surface nobody
//      listed works with its own facts.
//   2. The formula engine decides every `when` (the same rule tree the sidebar's shown_when uses); a thing's declared
//      facts are read by the sidebar's one fact reader (sidebar-rules.mjs factsOf). A fact that cannot be read is null,
//      which no comparison matches.
//   3. `now` is handed in; nothing here reads a clock. `next_change_at` is the earliest moment ahead at which the answer
//      can turn by itself (an until, a clock moment a rule names, the next hour or day a rule's hour or weekday reads).
//   4. The decision is synchronous when `filterRows` answers in the same call (the page, once the evaluator is loaded)
//      and a promise when it answers later (the store): one code path for both.
//   5. Effects combine by strength: the strongest effect that holds wins; `silenced` is true whenever anything holds,
//      since a hidden thing is silent too.
//   6. Starting rules (show-rules.json) apply to everyone unless the person's record turns them off; the person's own
//      rules apply while `on` is not false and their until is ahead. An expired rule decides nothing.
//      Fields marked with an authority in a subject's change_fields can only be changed or disabled by that owner.
//      Strict subjects keep missing facts and unfinished conditions unresolved; their caller decides how to show it.
//   7. Rules can also be given to a person by someone who may set rules for them (the service's owner today): the
//      types they hold (the giver's own record `types`, each { id, label, inherits, rules }, a type taking
//      every rule of the types it inherits, at any depth; no type ships in DATA) and the giver's rules whose `audience` (a rule tree over the
//      account facts) holds for them. A given rule decides like the person's own, and the person cannot remove it.
//   8. An effect marked `shows` (Shown) that is the strongest holding effect wins over a weaker hide: the thing shows
//      and is not silenced, so an AI or a person can show one thing, for a while, that a broader rule hides.
//

import { decideRuleEffects } from 'trillion-workshop/tools/set-up-my-account/read-data/rule-decisions.mjs';
import { factsOf, nextTurn, rulesIn } from 'trillion-workshop/tools/set-up-my-account/read-data/sidebar-rules.mjs';
import { timeZoneName } from 'trillion-workshop/tools/run-work-later-or-on-a-repeat/do-work/wall-time.ts';

const HOUR_MS = 3_600_000;
// A path never walks into an object's prototype.
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const timeOf = value => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
const text = value => (typeof value === 'string' ? value.trim() : '');
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The hour (0-23), minute and weekday a moment has in a time zone; an unknown zone reads as UTC.
// One formatter per time zone, made once: making an Intl.DateTimeFormat costs about a millisecond, and every show
// decision reads the clock once per rule, so a formatter made per read held a busy page's main thread for seconds.
const formatters = new Map();
const formatterIn = zone => {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'long' });
    formatters.set(zone, formatter);
  }
  return formatter;
};

// The clock in a zone (UTC when none is named). A zone that is not one gives no clock, so a rule on the hour or the day
// fails closed instead of reading another zone's time.
function clockIn(now, timeZone) {
  const zone = timeZoneName(timeZone || 'UTC');
  if (!zone) return { hour: null, minute: null, weekday: null };
  const parts = Object.fromEntries(formatterIn(zone).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute), weekday: String(parts.weekday).toLowerCase() };
}
// The moment ahead at which a fact read from the time turns by itself, from its `turns` (the next hour or the next day).
const TURNS = {
  hour: (now, clock) => now + (60 - clock.minute) * 60_000 - (now % 60_000),
  day: (now, clock) => now + ((23 - clock.hour) * 60 + (60 - clock.minute)) * 60_000 - (now % 60_000),
};

/** Which device a page is on, by its user agent: the first `devices` row whose pattern matches. */
export function deviceOf(data, userAgent = '') {
  return (data.devices ?? []).find(row => !row.user_agent || new RegExp(row.user_agent, 'i').test(userAgent))?.id ?? null;
}

/** The rules in force for a person: the starting rules they have not turned off, their own that are on, then the
 *  rules given to them (invariant 7). */
export function rulesInForce(data, record, given = [], space_id = null) {
  const own = Array.isArray(record?.rules) ? record.rules : [];
  const starting = object(record?.starting) ? record.starting : {};
  return [
    ...(data.starting_rules ?? []).filter(rule => starting[rule.id]?.on !== false).map(rule => ({ ...rule, starting: true })),
    ...own.filter(rule => rule && rule.on !== false),
    ...profileRules(data, record, space_id),
    ...(Array.isArray(given) ? given : []).filter(rule => rule && rule.on !== false),
  ];
}

/** Every type a giver offers: the types their own record keeps, one per id (a later one with the same id wins). */
export function typesOf(record) {
  const byId = new Map();
  for (const type of Array.isArray(record?.types) ? record.types : []) if (object(type) && text(type.id)) byId.set(type.id, type);
  return [...byId.values()];
}

/**
 * The ids of the types `held` names and of every type they inherit, at any depth, each once, in precedence order: a type
 * held directly comes before the types it inherits, nearer parents before farther ones, and held order breaks a tie.
 */
export function heldTypes(types, held) {
  const byId = new Map(types.map(type => [type.id, type]));
  const depth = new Map();
  let level = [...new Set(Array.isArray(held) ? held : [])].filter(id => byId.has(id));
  for (let at = 0; level.length; at++) {
    const next = [];
    for (const id of level) {
      if (depth.has(id)) continue;
      depth.set(id, at);
      next.push(...(byId.get(id).inherits ?? []).filter(parent => byId.has(parent)));
    }
    level = next;
  }
  return [...depth.keys()];
}

// The rules of the types held (`held` ids, expanded through inheritance by heldTypes), one per local id, from the most
// precedent type that names it: a child's version of a parent's rule replaces it, switched off or not, so a type can
// override what it inherits.
function rulesOfTypes(types, held, family = 'rules') {
  const byId = new Map(types.map(type => [type.id, type]));
  const named = new Set();
  const fromTypes = [];
  for (const id of heldTypes(types, held)) {
    const type = byId.get(id);
    for (const rule of Array.isArray(type[family]) ? type[family] : []) {
      if (!object(rule) || named.has(rule.id)) continue;
      named.add(rule.id);
      if (rule.on !== false) fromTypes.push({ ...rule, id: `type:${type.id}:${rule.id}`, given: type.label ?? type.id });
    }
  }
  return fromTypes;
}

/** The rules of the profiles a person has switched on (record.in_use) from the types they keep. A scoped profile applies
 *  only in its space (`space_id`), as a given type does. Profiles apply to the person's own things, never by audience. */
export function profileRules(data, record, space_id = null) {
  const types = typesOf(record).filter(type => !object(type.scope) || type.scope.space_id === space_id);
  return rulesOfTypes(types, Array.isArray(record?.in_use) ? record.in_use : []);
}

/**
 * The rules a giver gives one account (invariant 7): every rule of each type the account holds (a type is a cohort:
 * the account's `cohorts` fact, the setup-context record's per-account cohorts) and
 * every giver rule whose `audience` holds for the account's facts. `matches(tree, facts)` is the formula engine's row
 * filter over the one row of facts, answering a boolean or a promise of one. Each given rule names the type or the
 * rule it came from (`given`); its id is kept apart from the person's own. A type with a `scope` { space_id } counts
 * only inside that space (`space_id`); outside it, the type is as if it were not offered, so it is neither held nor inherited.
 * `spaceTypes` are a space's own member types read through to show-rules (src/space-member-types.mjs showRuleTypesOf).
 */
async function givenFamilyRules({ data, giver, facts, matches, family, space_id = null, spaceTypes = [] }) {
  const types = [...typesOf(giver), ...spaceTypes].filter(type => !object(type.scope) || type.scope.space_id === space_id);
  const assigned = [...(Array.isArray(facts?.cohorts) ? facts.cohorts : [])];
  // A profile may be given explicitly or selected by the same live account facts as an aimed rule. Inheritance
  // applies after selection, so plans, contracts, cohorts and experiments share one profile graph.
  for (const type of types) if (object(type.audience) && await matches(type.audience, facts)) assigned.push(type.id);
  const fromTypes = rulesOfTypes(types, assigned, family);
  const aimed = [];
  for (const rule of Array.isArray(giver?.[family]) ? giver[family] : []) {
    if (!object(rule) || !object(rule.audience) || rule.on === false) continue;
    if (!(await matches(rule.audience, facts))) continue;
    const { audience: _audience, ...kept } = rule;
    aimed.push({ ...kept, id: `given:${rule.id}`, given: rule.label || rule.id });
  }
  return [...fromTypes, ...aimed];
}

export async function givenRules({ data, giver, facts, matches, space_id = null, spaceTypes = [] }) {
  return givenFamilyRules({ data, giver, facts, matches, family: 'rules', space_id, spaceTypes });
}

/** The edit policy a person receives from each profile and aimed policy that matches current account facts. */
export async function givenEditRules({ data, giver, facts, matches, space_id = null, spaceTypes = [] }) {
  return givenFamilyRules({ data, giver, facts, matches, family: 'edit_rules', space_id, spaceTypes });
}

/** Every rule a person keeps, as a list shows them: starting rules with whether they are on, then their own. */
export function everyRule(data, record) {
  const starting = object(record?.starting) ? record.starting : {};
  return [
    ...(data.starting_rules ?? []).map(rule => ({ ...rule, starting: true, on: starting[rule.id]?.on !== false })),
    ...(Array.isArray(record?.rules) ? record.rules : []).map(rule => ({ ...rule, on: rule.on !== false })),
  ];
}

// The fields a rule may name for a subject: its declared facts, the moment's facts, and any other field the rule names,
// read from the thing itself (invariant 1).
function fieldsFor(data, subject, tree) {
  const declared = [...(data.subjects?.[subject]?.facts ?? []), ...(data.moment_facts ?? [])];
  const known = new Set(declared.map(fact => fact.id));
  const own = [...new Set(rulesIn(tree).map(rule => rule.field).filter(field => typeof field === 'string' && !known.has(field)))]
    .map(id => ({ id, kind: 'choice', path: [id] }));
  return [...declared, ...own];
}

// One row of facts for a rule: the thing's own facts, then the moment's (from the caller, or from the time in the
// rule's zone).
function rowFor(rule, facts, thing, moment, now, readRecord) {
  const clock = clockIn(now, rule.time_zone ?? moment.time_zone);
  const own = facts.filter(fact => !fact.moment && !fact.from_time && !fact.clock);
  const row = factsOf(thing, own, readRecord, now);
  for (const fact of facts) {
    if (fact.clock) row[fact.id] = now;
    else if (fact.from_time) row[fact.id] = clock[fact.from_time] ?? null;
    // A moment fact the caller did not say may be said by the thing itself (a surface naming where it shows it).
    else if (fact.moment) row[fact.id] = moment[fact.moment] ?? thing?.[fact.id] ?? null;
  }
  return { row, clock };
}

// When a rule's answer can next turn by itself: its until, a clock moment it names, the next hour or day it reads.
function turnOf(rule, facts, thing, clock, now, readRecord) {
  const moments = [timeOf(rule.until), nextTurn(thing, rule.when, facts, readRecord, now)];
  for (const named of rulesIn(rule.when)) {
    const fact = facts.find(one => one.id === named.field);
    if (fact?.turns && TURNS[fact.turns]) moments.push(TURNS[fact.turns](now, clock));
  }
  return moments.filter(moment => Number.isFinite(moment) && moment > now).reduce((soonest, moment) => (soonest === null || moment < soonest ? moment : soonest), null);
}

/**
 * How one thing shows now.
 *   data:       show-rules.json
 *   record:     the person's show-rules record ({ rules, starting }), or null
 *   subject:    what the thing is (a key of data.subjects, or any surface's own)
 *   thing:      the thing's own fields (its kind, id, title...)
 *   moment:     { device?, arrived_by_link?, channel?, time_zone? } what the caller knows about where it is shown
 *   now:        ms
 *   filterRows: the formula engine's row filter, answering now or later
 *   space_id:   the space the thing shows in (a scoped profile or type applies only there), or null
 * Answers { hidden, silenced, until, rules: [{ id, label, effect, until, starting }], changes: [{ rule, label, path, value,
 * starting }], next_change_at }, or a promise of it. `rules` are the rules hiding or silencing it; `changes` are the
 * field values the rules that change it set, in the order they were kept (withChanges applies them).
 */
export function showDecision({ data, record, given = [], subject, thing, moment = {}, now, filterRows, readRecord = () => null, space_id = null }) {
  const strength = new Map((data.effects ?? []).map(effect => [effect.id, effect.strength ?? 0]));
  const showing = new Set((data.effects ?? []).filter(effect => effect.shows).map(effect => effect.id));
  const candidates = rulesInForce(data, record, given, space_id)
    .filter(rule => rule.subject === subject && strength.has(rule.effect))
    .map(rule => {
      const facts = fieldsFor(data, subject, rule.when);
      const { row, clock } = rowFor(rule, facts, thing ?? {}, moment, now, readRecord);
      return { rule, facts, row, clock, fields: facts.map(fact => ({ id: fact.id, kind: fact.kind })) };
    });
  const strict = data.subjects?.[subject]?.strict_facts === true;
  const knownness = data.subjects?.[subject]?.knownness_operators ?? [];
  const missing = candidates.flatMap(({ rule, row }) => strict ? rulesIn(rule.when)
    .filter(one => row[one.field] == null && !knownness.includes(one.operator))
    .map(problem => ({ rule: rule.id, field: problem.field, reason: 'missing-fact' })) : []);
  const missingRules = new Set(missing.map(problem => problem.rule));
  const fields = [...new Map(candidates.flatMap(candidate => candidate.fields).map(field => [field.id, field])).values()];
  const decide = decideRuleEffects({ entries: candidates.filter(({ rule }) => !missingRules.has(rule.id)), effects: data.effects, fields, now, filterRows, strict, isolateIncomplete: strict });
  const finish = resolution => {
    const held = resolution.held;
    const incomplete = [...missing, ...resolution.incomplete.map(problem => ({ ...problem })), ...(resolution.malformed ? [{ reason: 'unreadable-rule-answer' }] : [])];
    const holding = held.filter(({ rule }) => !data.effects.find(effect => effect.id === rule.effect)?.changes);
    const changes = resolution.changes
      .flatMap(({ rule }) => (Array.isArray(rule.set) ? rule.set : []).map(one => ({ rule: rule.id, label: rule.label ?? '', path: one.path, value: one.value, starting: Boolean(rule.starting) })));
    const winners = resolution.winners;
    // The strongest effect lasts until the last of its rules ends; a rule with no until keeps it with no end.
    const until = winners.length && winners.every(({ rule }) => rule.until) ? Math.max(...winners.map(({ rule }) => timeOf(rule.until))) : null;
    const next = candidates.filter(({ rule }) => !rule.until || timeOf(rule.until) > now)
      .map(({ rule, facts, clock }) => turnOf(rule, facts, thing ?? {}, clock, now, readRecord))
      .filter(moment => moment !== null).reduce((soonest, moment) => (soonest === null || moment < soonest ? moment : soonest), null);
    const hideStrength = strength.get('hide');
    // The strongest holding effect shows the thing (invariant 8): nothing weaker hides or silences it.
    const shown = winners.some(({ rule }) => showing.has(rule.effect));
    return {
      hidden: !shown && holding.length > 0 && winners.some(({ rule }) => strength.get(rule.effect) === hideStrength),
      silenced: !shown && holding.length > 0,
      until: until === null ? null : new Date(until).toISOString(),
      rules: holding.map(({ rule }) => ({ id: rule.id, label: rule.label ?? '', effect: rule.effect, until: rule.until ?? null, starting: Boolean(rule.starting),
        ...(rule.given !== undefined ? { given: rule.given } : {}) })),
      changes,
      next_change_at: next,
      ...(strict || incomplete.length ? { incomplete } : {}),
    };
  };
  return decide && typeof decide.then === 'function' ? decide.then(finish) : finish(decide);
}

/** The words of a rule's problem, or null when it can be kept: every field it names is one the subject or the moment
 *  has (or the subject is one nobody declared), its effect is a row, its until a time. */
export function ruleProblem(data, rule, authority = null) {
  if (!object(rule)) return 'A rule is { subject, effect, when?, until?, label? }.';
  if (!text(rule.subject)) return `subject names what the rule is about: one of ${Object.keys(data.subjects ?? {}).join(', ')}, or any surface's own subject.`;
  const effects = (data.effects ?? []).map(effect => effect.id);
  if (!effects.includes(rule.effect)) return `effect is one of ${effects.join(', ')}.`;
  const subject = data.subjects?.[rule.subject];
  if (Array.isArray(subject?.allowed_effects) && !subject.allowed_effects.includes(rule.effect)) return `This subject uses ${subject.allowed_effects.join(', ')}; hiding it cannot change what is required.`;
  if (rule.until !== undefined && rule.until !== null && !Number.isFinite(timeOf(rule.until))) return 'until is a date and time, like 2026-10-05T08:00:00Z.';
  if (rule.time_zone !== undefined && rule.time_zone !== null && !timeZoneName(rule.time_zone)) return `${String(rule.time_zone)} is not a time zone; use one like America/Los_Angeles.`;
  if (rule.audience !== undefined && rule.audience !== null && (!object(rule.audience) || rule.audience.kind !== 'group')) return 'audience is a rule tree over the account facts (account_id, plan, created_at, cohorts, experiments, bucket...), like when.';
  if ((data.effects ?? []).find(effect => effect.id === rule.effect)?.changes) {
    const set = rule.set;
    if (!Array.isArray(set) || !set.length) return 'A rule that changes things carries set: [{ path: ["field", ...], value }], the fields it changes.';
    const bad = set.find(one => !object(one) || !Array.isArray(one.path) || !one.path.length || !one.path.every(key => (typeof key === 'string' && key.length > 0) || Number.isInteger(key)) || !('value' in one) || one.path.some(key => UNSAFE_KEYS.has(key)));
    if (bad) return 'Each entry of set is { path, value }: path is a list of field names (or positions) inside the thing, value what that field becomes.';
    if (Array.isArray(subject?.change_fields)) {
      for (const change of set) {
        const field = subject.change_fields.find(one => JSON.stringify(one.path) === JSON.stringify(change.path));
        if (!field) return 'That field belongs to the action owner and cannot be changed by a display rule.';
        if (authority && field.authority && field.authority !== authority) return `Only the ${field.authority} can change ${change.path.join('.')}.`;
        if (typeof change.value !== field.type || (field.type === 'number' && !Number.isFinite(change.value))) return `The value for ${change.path.join('.')} must be ${field.type}.`;
        if (field.max_chars && change.value.length > field.max_chars) return `${change.path.join('.')} is too long.`;
      }
    }
  }
  if (rule.when !== undefined && rule.when !== null) {
    if (!object(rule.when) || rule.when.kind !== 'group') return 'when is a rule tree: { kind: "group", combinator: "and", negate: false, rules: [{ kind: "rule", field, operator, params }] }.';
    const declared = data.subjects?.[rule.subject];
    if (declared?.strict_facts) {
      const wellFormed = node => object(node) && (node.kind === 'group'
        ? Array.isArray(node.rules) && node.rules.length > 0 && node.rules.every(wellFormed) &&
          declared.combinators.includes(node.combinator) && (node.negate === undefined || typeof node.negate === 'boolean')
        : node.kind === 'rule' && typeof node.field === 'string' && typeof node.operator === 'string' &&
          (node.params === undefined || object(node.params)));
      if (!wellFormed(rule.when)) return 'Finish every condition before using this rule. Use when: null for an unconditional rule.';
    }
    if (declared) {
      const known = [...declared.facts, ...(data.moment_facts ?? [])].map(fact => fact.id);
      const unknown = rulesIn(rule.when).map(one => one.field).find(field => !known.includes(field));
      if (unknown) return `This rule names "${unknown}", which is not something Trillion knows about ${declared.label.toLowerCase()}. Use one of: ${known.join(', ')}.`;
      const changesAuthority = Array.isArray(rule.set) && rule.set.some(change => declared.change_fields?.some(field => field.authority && JSON.stringify(field.path) === JSON.stringify(change.path)));
      if (changesAuthority && rulesIn(rule.when).some(one => declared.facts.find(fact => fact.id === one.field)?.untrusted)) return 'A required policy cannot depend on a personal declaration or the current browser. Use facts verified by its owner.';
    }
  }
  return null;
}

// The next moment an hour of the day comes round in a time zone.
function nextAtHour(now, hour, timeZone) {
  const clock = clockIn(now, timeZone);
  const hoursAhead = (hour - clock.hour + 24) % 24 || 24;
  return now + hoursAhead * HOUR_MS - clock.minute * 60_000 - (now % 60_000);
}

/**
 * The rule a quick choice on a thing makes (show-rules.json `quick`): about things like this one (the subject's
 * `same_fact`), with the subject's `quick_effect`, until the choice's span, on the device it was set on when it asks.
 * Answers the rule, ready to keep.
 */
export function quickRule(data, { choice, subject, thing, device = null, now, time_zone = null, by = null, label = null }) {
  const row = (data.quick ?? []).find(one => one.id === choice);
  if (!row) throw new Error(`choice is one of ${(data.quick ?? []).map(one => one.id).join(', ')}.`);
  if (time_zone !== null && !timeZoneName(time_zone)) throw new Error(`${String(time_zone)} is not a time zone; use one like America/Los_Angeles.`);
  const declared = data.subjects?.[subject] ?? {};
  const sameFact = (declared.facts ?? []).find(fact => fact.id === declared.same_fact);
  const sameValue = sameFact ? sameFact.path.reduce((held, key) => (held && typeof held === 'object' ? held[key] : undefined), thing) : undefined;
  const rules = [
    ...(sameFact && sameValue !== undefined && sameValue !== null ? [{ kind: 'rule', field: sameFact.id, operator: 'is_any_of', params: { values: [String(sameValue)] } }] : []),
    ...(row.device && device ? [{ kind: 'rule', field: 'device', operator: 'is_any_of', params: { values: [device] } }] : []),
  ];
  const until = row.until?.hours ? now + row.until.hours * HOUR_MS : typeof row.until?.next_at_hour === 'number' ? nextAtHour(now, row.until.next_at_hour, time_zone) : null;
  return {
    id: `rule-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label: label ?? text(thing?.title) ?? '',
    subject,
    effect: declared.quick_effect ?? (data.effects ?? []).filter(effect => !effect.changes && !effect.shows).at(-1)?.id,
    when: rules.length ? { kind: 'group', combinator: 'and', negate: false, rules } : null,
    ...(until ? { until: new Date(until).toISOString() } : {}),
    ...(time_zone ? { time_zone } : {}),
    ...(by ? { by } : {}),
    made_at: new Date(now).toISOString(),
    on: true,
  };
}

/**
 * The person's record after a change: { save: rule } keeps one (the same id replaces it), { remove: id } takes one
 * away, { starting: { id, on } } turns a starting rule off or on; expired rules leave on every change. Throws the
 * rule's problem in words.
 */
export function changedRecord(data, record, change, now, authority = null) {
  const rules = (Array.isArray(record?.rules) ? record.rules : []).filter(rule => !rule.until || timeOf(rule.until) > now);
  const starting = object(record?.starting) ? { ...record.starting } : {};
  const types = (Array.isArray(record?.types) ? record.types : []).filter(type => object(type) && text(type.id));
  let inUse = Array.isArray(record?.in_use) ? record.in_use : [];
  if (change.type) {
    const problem = typeProblem(data, change.type, [...typesOf(record).filter(type => type.id !== change.type.id), change.type], authority);
    if (problem) throw new Error(problem);
    const kept = { id: change.type.id.trim(), label: text(change.type.label) || change.type.id.trim(), inherits: Array.isArray(change.type.inherits) ? change.type.inherits : [],
      ...(change.type.audience != null ? { audience: change.type.audience } : {}),
      ...(Array.isArray(change.type.edit_rules) ? { edit_rules: change.type.edit_rules } : {}),
      ...(change.type.scope != null ? { scope: change.type.scope } : {}),
      rules: change.type.rules.map(rule => ({ ...rule, id: text(rule.id) || `rule-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}` })) };
    const at = types.findIndex(type => type.id === kept.id);
    if (at >= 0) types[at] = kept; else types.push(kept);
  }
  if (change.remove_type) {
    const at = types.findIndex(type => type.id === change.remove_type);
    if (at < 0) throw new Error(`No type ${change.remove_type} is kept here.`);
    // Removing a parent must never silently take inherited restrictions away from its children; the caller must
    // change those relationships explicitly.
    const remaining = typesOf({ types: types.filter(type => type.id !== change.remove_type) });
    for (const type of remaining) {
      const problem = typeProblem(data, type, remaining, authority);
      if (problem) throw new Error(`Cannot remove ${change.remove_type}: ${type.label || type.id} would be invalid. ${problem}`);
    }
    types.splice(at, 1);
    inUse = inUse.filter(id => id !== change.remove_type);
  }
  // A profile is switched on or off only while the person keeps it (record.types), so an operator's given type never is.
  if (change.use) {
    const { type, on } = change.use;
    if (typeof type !== 'string' || !type) throw new Error('use names type, the id of a profile you keep, and on: true to switch it on, false to switch it off.');
    if (typeof on !== 'boolean') throw new Error('use.on is true or false.');
    if (!types.some(one => one.id === type)) throw new Error(`No profile ${type} is kept here; keep it with { type } first. Kept profiles: ${types.map(one => one.id).join(', ') || 'none'}.`);
    inUse = on ? [...new Set([...inUse, type])] : inUse.filter(id => id !== type);
    // A type every account starts with in use is laid under the record by the store's reader (the starting set's
    // shipped default for this record, merge `switched: in_use off_in starting`): it stays in use until the record says
    // `starting.<type>.on: false`, so the switch keeps that too, and turning it back on clears it.
    starting[type] = { on };
  }
  if (change.save) {
    const problem = ruleProblem(data, change.save, authority);
    if (problem) throw new Error(problem);
    const id = text(change.save.id) || `rule-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const kept = { ...change.save, id, on: change.save.on !== false, made_at: change.save.made_at ?? new Date(now).toISOString() };
    const at = rules.findIndex(rule => rule.id === id);
    if (at >= 0) rules[at] = kept; else rules.push(kept);
    if (rules.length > (data.most_rules ?? Infinity)) throw new Error(`A person keeps at most ${data.most_rules} rules; remove one first.`);
  }
  if (change.remove) {
    const at = rules.findIndex(rule => rule.id === change.remove);
    if (at < 0 && !(data.starting_rules ?? []).some(rule => rule.id === change.remove)) throw new Error(`No rule ${change.remove}.`);
    if (at >= 0) rules.splice(at, 1);
    else {
      const problem = ruleProblem(data, data.starting_rules.find(rule => rule.id === change.remove), authority);
      if (problem) throw new Error(problem);
      starting[change.remove] = { on: false };
    }
  }
  if (change.starting) {
    const row = (data.starting_rules ?? []).find(rule => rule.id === change.starting.id);
    if (!row) throw new Error(`No starting rule ${change.starting.id}.`);
    const problem = ruleProblem(data, row, authority);
    if (problem) throw new Error(problem);
    starting[change.starting.id] = { on: change.starting.on !== false };
  }
  // Keys this change does not own (the operator's declared attribute_fields) carry forward unchanged.
  const { types: _previous, in_use: _inUse, ...kept } = object(record) ? record : {};
  return { ...kept, rules, starting, ...(types.length ? { types } : {}), ...(inUse.length ? { in_use: inUse } : {}) };
}

/** The words of a type's problem, or null when it can be kept: an id, rules each of which can be kept, and inherited
 *  types that exist without the type ever inheriting itself. `all` is every type with this one in its place. */
export function typeProblem(data, type, all, authority = null) {
  if (!object(type) || !text(type.id) || !/^[a-z0-9][a-z0-9-]*$/.test(type.id.trim())) return 'A type is { id, label, inherits?, rules }: id is lowercase words joined by hyphens.';
  if (!Array.isArray(type.rules)) return 'A type carries rules: the show rules everyone holding it gets.';
  if (type.audience != null && (!object(type.audience) || type.audience.kind !== 'group')) return 'A type audience is a rule tree over the account facts.';
  if (type.scope != null && (!object(type.scope) || !text(type.scope.space_id))) return 'A type scope is { space_id }: the space the type applies in.';
  if (type.inherits !== undefined && (!Array.isArray(type.inherits) || type.inherits.some(id => !all.some(one => one.id === id)))) return `inherits names types that exist: ${all.map(one => one.id).join(', ')}.`;
  if (heldTypes(all, type.inherits ?? []).includes(type.id)) return 'A type cannot inherit itself, at any depth.';
  for (const rule of type.rules) {
    const problem = ruleProblem(data, rule, authority);
    if (problem) return problem;
  }
  return null;
}

/**
 * The thing with the fields a show decision's `changes` set (each { path, value }, in order), copied along each path
 * only, so every part of the thing no change touches is the same object as before. A path step that is a number picks a
 * place in a list; a step that does not exist yet is made (a list for a number, an object otherwise).
 */
export function withChanges(thing, changes) {
  if (!Array.isArray(changes) || !changes.length) return thing;
  let result = thing;
  for (const { path, value } of changes) {
    if (!Array.isArray(path) || !path.length || path.some(key => UNSAFE_KEYS.has(key))) continue;
    const setIn = (here, at) => {
      const key = path[at];
      const copy = Array.isArray(here) ? [...here] : object(here) ? { ...here } : typeof key === 'number' ? [] : {};
      copy[key] = at === path.length - 1 ? value : setIn(copy[key], at + 1);
      return copy;
    };
    result = setIn(result, 0);
  }
  return result;
}

