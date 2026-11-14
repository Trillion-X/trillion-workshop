// src/workspace/show-rules-map.mjs
//
// NO PRIOR: show-rules.mjs showDecision decides one thing at a time; every drawn control asking it on its own was what
// made the page's show rules cost a records read and an engine call per rule for every control, on every draw.
//
// PURPOSE
//   Decides every thing of one subject at once: one row of facts per thing, and each rule in force asked of the
//   formula engine once over all the rows (a rule with no `when` holds for every row without asking). The answer is a
//   flat list of hidden/shown, in the things' order, the fields the rules read from the things themselves, and the
//   earliest moment ahead at which any answer can turn by itself. The page keeps it as a map (show-rules-live.ts) and
//   every control reads the map, never the store and never the engine.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a subject, a fact, a control or an effect beyond what showDecision reads by the same name:
//      the subject's facts, the moment's facts and the effects are show-rules.json DATA; the things are the caller's.
//   2. An answer here is the answer showDecision gives the same thing (test/show-rules-one-read.test.mjs checks it):
//      effects combine by strength, a `shows` effect at the top wins, an effect that `changes` hides nothing.
//   3. Formula-engine calls are at most one per rule in force for the subject, however many things there are.
//   4. `reads` names every field a rule reads from the thing itself (not the moment): a caller whose thing carries more
//      fields than the rows did may use the answer only when no rule reads one of them.
//   5. A strict subject is not decided here (`strict` comes back true): its caller decides each thing as before.

import { timeZoneName } from 'trillion-workshop/tools/wall-time/read-data/wall-time.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const timeOf = value => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);

// Every leaf of a rule tree.
function leaves(tree) {
  if (!object(tree)) return [];
  if (tree.kind === 'rule') return [tree];
  return Array.isArray(tree.rules) ? tree.rules.flatMap(leaves) : [];
}

// One formatter per time zone, as show-rules.mjs keeps them.
const formatters = new Map();
function clockIn(now, requestedZone) {
  const zone = timeZoneName(requestedZone || 'UTC');
  if (!zone) return { hour: null, minute: null, weekday: null };
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'long' });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return { hour: Number(parts.hour), minute: Number(parts.minute), weekday: String(parts.weekday).toLowerCase() };
}
const TURNS = {
  hour: (now, clock) => now + (60 - clock.minute) * 60_000 - (now % 60_000),
  day: (now, clock) => now + ((23 - clock.hour) * 60 + (60 - clock.minute)) * 60_000 - (now % 60_000),
};

// A thing's own fact, read by its declared path (or by its id when it has none).
function factOf(thing, fact) {
  let at = thing;
  for (const key of Array.isArray(fact.path) ? fact.path : [fact.id]) {
    if (!object(at) || !Object.hasOwn(at, key)) return null;
    at = at[key];
  }
  return at ?? null;
}

/**
 * Every thing of `subject` decided in one pass.
 *   data:       show-rules.json
 *   rules:      the rules in force (show-rules.mjs rulesInForce), any subject
 *   subject:    the subject every thing is of
 *   things:     the things' own fields, one per row
 *   moment:     { device?, arrived_by_link?, channel?, time_zone? }
 *   now:        ms
 *   filterRows: the formula engine's row filter, answering in the same call
 * Answers { hidden: boolean[], reads: string[], next_change_at, strict, engine_calls }.
 */
export function decideEvery({ data, rules, subject, things, moment = {}, now, filterRows }) {
  const declared = data.subjects?.[subject];
  if (declared?.strict_facts === true) return { hidden: things.map(() => false), reads: [], next_change_at: null, strict: true, engine_calls: 0 };
  const effects = data.effects ?? [];
  const strength = new Map(effects.map(effect => [effect.id, effect.strength ?? 0]));
  const showing = new Set(effects.filter(effect => effect.shows).map(effect => effect.id));
  const changing = new Set(effects.filter(effect => effect.changes).map(effect => effect.id));
  const hideStrength = strength.get('hide');
  const momentFacts = data.moment_facts ?? [];
  const momentIds = new Set(momentFacts.map(fact => fact.id));
  const own = (declared?.facts ?? []);
  const inForce = rules.filter(rule => rule && rule.subject === subject && strength.has(rule.effect) && !changing.has(rule.effect)
    && !(rule.until && !(timeOf(rule.until) > now)));
  const reads = new Set();
  const turns = [];
  // The things' own facts, read once: the declared ones and any other field a rule names.
  const named = [...new Set(inForce.flatMap(rule => leaves(rule.when).map(leaf => leaf.field)).filter(field => typeof field === 'string'))];
  for (const field of named) if (!momentIds.has(field)) reads.add(field);
  const ownFacts = [...own, ...named.filter(field => !momentIds.has(field) && !own.some(fact => fact.id === field)).map(id => ({ id, kind: 'choice', path: [id] }))];
  const fields = [...ownFacts, ...momentFacts].map(fact => ({ id: fact.id, kind: fact.kind }));
  const base = things.map(thing => Object.fromEntries(ownFacts.map(fact => [fact.id, factOf(thing ?? {}, fact)])));
  // The rows in one time zone: the things' facts and the moment's, read in that zone's clock.
  const rowsByZone = new Map();
  const rowsIn = zone => {
    const key = zone ?? '';
    if (rowsByZone.has(key)) return rowsByZone.get(key);
    const clock = clockIn(now, zone);
    const momentRow = {};
    for (const fact of momentFacts) {
      if (fact.clock) momentRow[fact.id] = now;
      else if (fact.from_time) momentRow[fact.id] = clock[fact.from_time] ?? null;
      else if (fact.moment) momentRow[fact.id] = moment[fact.moment] ?? null;
    }
    const rows = base.map((row, index) => {
      const full = { ...row };
      for (const [id, value] of Object.entries(momentRow)) full[id] = value ?? things[index]?.[id] ?? null;
      return full;
    });
    const made = { rows, clock };
    rowsByZone.set(key, made);
    return made;
  };
  // Each rule once over every row (invariant 3): which rows it holds for.
  let engineCalls = 0;
  const top = things.map(() => ({ strength: -Infinity, shows: false, hides: false, holding: 0 }));
  for (const rule of inForce) {
    const zone = rule.time_zone ?? moment.time_zone;
    const { rows, clock } = rowsIn(zone);
    let holds;
    if (rule.when === undefined || rule.when === null) holds = rows.map((_, index) => index);
    else {
      engineCalls += 1;
      holds = filterRows({ tree: rule.when, fields, rows }).matches;
    }
    const at = strength.get(rule.effect);
    for (const index of holds) {
      const best = top[index];
      best.holding += 1;
      if (at > best.strength) { best.strength = at; best.shows = showing.has(rule.effect); best.hides = at === hideStrength; }
      else if (at === best.strength) { best.shows ||= showing.has(rule.effect); best.hides ||= at === hideStrength; }
    }
    // When this rule's answer can next turn by itself: its until, a clock moment it names, the next hour or day.
    if (rule.until) turns.push(timeOf(rule.until));
    for (const leaf of leaves(rule.when)) {
      const fact = momentFacts.find(one => one.id === leaf.field);
      if (fact?.turns && TURNS[fact.turns] && clock.hour !== null) turns.push(TURNS[fact.turns](now, clock));
      if (fact?.clock) for (const value of Object.values(leaf.params ?? {})) turns.push(timeOf(value));
    }
  }
  const ahead = turns.filter(moment => Number.isFinite(moment) && moment > now);
  return {
    hidden: top.map(best => !best.shows && best.holding > 0 && best.hides),
    reads: [...reads],
    next_change_at: ahead.length ? Math.min(...ahead) : null,
    strict: false,
    engine_calls: engineCalls,
  };
}
