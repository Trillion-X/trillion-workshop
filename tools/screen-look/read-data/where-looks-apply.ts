// parts/screen-look/read-data/where-looks-apply.ts
//
// PURPOSE
//   Where a look applies: an ordered list of look rules the person keeps (where-looks-apply.json says their shape), each
//   a condition (the formula engine's rule tree over the app a screen is drawn in, the kind of device, the device, the
//   screen or area of the app, the hour and weekday in the rule's zone, now) and the look worn where it holds. The first
//   rule that holds wins; when none does the account's own look is worn, which is the last rule, "everywhere else", so
//   a person who keeps no rule sees exactly what one worn look always showed, and changing that look changes every screen.
//
//   The whole order a screen resolves its look in, kept here so no caller decides it again:
//     1. a look this device keeps for itself (do-work/device-screen-look.ts), when the person chose one on this device;
//     2. the first look rule that holds for this screen's facts (lookForFacts);
//     3. the account's worn look, "everywhere else";
//     4. then, only when step 3 gave the look, the person's look plan for the day (look-over-time.ts) moves it. A look
//        a rule or the device picked is pinned: the plan never takes it, because a rule that names an hour already says
//        when (resolve-chosen-screen-look.ts hands back which step decided).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no page, no records, no clock of its own, no storage. The caller hands in the rules, the facts, the moment
//      and the formula engine's row filter, so the page and the server give the same answer for the same facts.
//   2. Blind: nothing here names a look, an app, a device or a time; they are ids from the person's rules and rows of
//      where-looks-apply.json. A fact a rule names that the DATA does not declare is refused when the rule is kept.
//   3. A fact the caller did not say is unknown, which no comparison matches: a rule about ChatGPT never holds on a
//      screen that does not know it is in ChatGPT.
//   4. Synchronous when `filterRows` answers in the same call (the page, once the evaluator has loaded) and a promise
//      when it answers later (the store): one code path for both.
//   5. Every change goes through changeLookRules, and a rule with a problem is refused in plain words.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import data from '../where-looks-apply.json' with { type: 'json' };
import operators from '../../formula-engine/rules/rule-operators.json' with { type: 'json' };
import { isTimeZone } from './look-over-time.ts';

export type LookRuleTree = { kind: 'group'; combinator: string; negate?: boolean; rules: unknown[] } | { kind: 'rule'; field: string; operator: string; params?: Record<string, unknown> };
export type LookRule = { id: string; label?: string; when: LookRuleTree | null; look_id: string; time_zone?: string | null; on?: boolean; by?: string; made_at?: string };
/** What a screen knows about where it is drawn; anything it does not know is left out. */
export type LookFacts = { host?: string | null; device?: string | null; device_id?: string | null; place?: string | null };
export type LookRuleAnswer = {
  /** The look to wear: the first holding rule's, else the account's. */
  look_id: string;
  /** The rule that decided, or null when none held and the account's look is worn ("everywhere else"). */
  rule_id: string | null;
  /** The moment the answer can next change by itself (the next hour a rule reads), or null. */
  next_change_at: number | null;
};
type Filter = (input: { tree: unknown; fields: { id: string; kind: string }[]; rows: Record<string, unknown>[] }) => { matches: number[] } | Promise<{ matches: number[] }>;
type Fact = { id: string; kind: string; from_time?: string; clock?: boolean; turns?: string };

export const WHERE_LOOKS_APPLY = data;
export const LOOK_RULES_RECORD = data.record_key;

const HOUR_MS = 3_600_000;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const then = <T, R>(value: T | Promise<T>, next: (value: T) => R): R | Promise<R> => (value && typeof (value as Promise<T>).then === 'function' ? (value as Promise<T>).then(next) : next(value as T));
const FACTS = data.facts as Fact[];
const OPERATORS = new Set((operators.operators as { id: string }[]).map(row => row.id));
const COMBINATORS = new Set((operators.combinators as { id: string }[]).map(row => row.id));

const formatters = new Map<string, Intl.DateTimeFormat>();
function clockIn(now: number, zone: string): { hour: number; weekday: string; minute: number } {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'long' });
    formatters.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute), weekday: String(parts.weekday).toLowerCase() };
}

function conditionsIn(tree: unknown, out: Array<{ field: string; operator: string }> = []): Array<{ field: string; operator: string }> {
  if (!object(tree)) return out;
  if (tree.kind === 'rule') out.push({ field: String(tree.field), operator: String(tree.operator) });
  if (Array.isArray(tree.rules)) for (const child of tree.rules) conditionsIn(child, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Which look a screen wears
// ---------------------------------------------------------------------------------------------------------------------

/** Which app a screen is drawn in, from what the page can see of itself (`seen`: page globals present, the user agent,
 *  the page's protocol): the first `hosts` row whose detect matches, the last being the plain web. */
export function hostOf(seen: { globals?: readonly string[]; userAgent?: string; protocol?: string }): string | null {
  const globals = new Set(seen.globals ?? []);
  const found = data.hosts.find(row => {
    const detect = row.detect as { global?: string; user_agent?: string; protocol?: string };
    const wants = Object.keys(detect).length;
    if (!wants) return true;
    return (!detect.global || globals.has(detect.global)) && (!detect.user_agent || new RegExp(detect.user_agent, 'i').test(seen.userAgent ?? '')) && (!detect.protocol || detect.protocol === seen.protocol);
  });
  return found?.id ?? null;
}

/** The kind of device a user agent is on: the first `devices` row whose pattern matches. */
export function deviceKindOf(userAgent = ''): string | null {
  return data.devices.find(row => !row.user_agent || new RegExp(row.user_agent, 'i').test(userAgent))?.id ?? null;
}

/** Which look a screen wears for `facts` at `now` (ms): the first of `rules` that is on, whose `when` holds, else
 *  `accountLook`. Answers at once when `filterRows` does and as a promise when it does not (invariant 4). */
export function lookForFacts({ rules, facts, accountLook, now, filterRows, zone = 'UTC' }: {
  rules: readonly LookRule[] | null | undefined;
  facts: LookFacts;
  accountLook: string;
  now: number;
  filterRows: Filter;
  /** The zone hour and weekday are read in for a rule with none of its own: the device's. */
  zone?: string;
}): LookRuleAnswer | Promise<LookRuleAnswer> {
  const live = (rules ?? []).filter(rule => rule && rule.on !== false && text(rule.look_id));
  const fields = FACTS.map(fact => ({ id: fact.id, kind: fact.kind }));
  const rowFor = (rule: LookRule) => {
    const clock = clockIn(now, isTimeZone(rule.time_zone) ? rule.time_zone : zone);
    return Object.fromEntries(FACTS.map(fact => [fact.id, fact.clock ? now : fact.from_time ? (clock as Record<string, unknown>)[fact.from_time] ?? null : (facts as Record<string, unknown>)[fact.id] ?? null]));
  };
  const verdicts = live.map(rule => (rule.when ? then(filterRows({ tree: rule.when, fields, rows: [rowFor(rule)] }), answer => Array.isArray(answer?.matches) && answer.matches.length > 0) : true));
  const finish = (holds: boolean[]): LookRuleAnswer => {
    const at = holds.findIndex(Boolean);
    // The next hour any rule reads, since that is the soonest the time a rule asks about turns by itself.
    const reading = live.some(rule => conditionsIn(rule.when).some(one => FACTS.find(fact => fact.id === one.field)?.turns));
    const clock = clockIn(now, zone);
    return {
      look_id: at >= 0 ? live[at].look_id : accountLook,
      rule_id: at >= 0 ? live[at].id : null,
      next_change_at: reading ? now + (60 - clock.minute) * 60_000 - (now % 60_000) || now + HOUR_MS : null,
    };
  };
  return verdicts.some(verdict => verdict && typeof (verdict as Promise<boolean>).then === 'function') ? Promise.all(verdicts).then(finish) : finish(verdicts as boolean[]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The rules a person keeps
// ---------------------------------------------------------------------------------------------------------------------

/** The rules in a stored record, anything that is not a rule dropped; the record is { rules: [...] }. */
export function readLookRules(value: unknown): LookRule[] {
  const rules = object(value) && Array.isArray(value.rules) ? value.rules : [];
  return rules.filter((rule): rule is LookRule => object(rule) && typeof rule.id === 'string' && typeof rule.look_id === 'string');
}

/** The words of a rule's problem, or null when it can be kept: every fact it names is one the DATA declares, every
 *  comparison one the formula engine has, and the look one the person can wear (`looks`). */
export function lookRuleProblem(rule: unknown, looks: readonly string[]): string | null {
  if (!object(rule)) return 'A look rule is { label?, when?, look_id, time_zone? }.';
  if (!text(rule.look_id)) return 'look_id says which look is worn where the rule holds: a look_id from list_looks.';
  if (!looks.includes(text(rule.look_id))) return `There is no look ${text(rule.look_id)}. The looks are ${looks.join(', ')}.`;
  if (rule.time_zone !== undefined && rule.time_zone !== null && !isTimeZone(rule.time_zone)) return `${String(rule.time_zone)} is not a time zone; use one like America/Los_Angeles.`;
  if (rule.when === undefined || rule.when === null) return null;
  const known = FACTS.map(fact => fact.id);
  const wellFormed = (node: unknown): boolean => object(node) && (node.kind === 'group'
    ? Array.isArray(node.rules) && node.rules.length > 0 && node.rules.every(wellFormed) && COMBINATORS.has(String(node.combinator))
    : node.kind === 'rule' && typeof node.field === 'string' && typeof node.operator === 'string' && (node.params === undefined || object(node.params)));
  if (!wellFormed(rule.when) || (rule.when as { kind?: string }).kind !== 'group') return 'when is a rule tree: { kind: "group", combinator: "and", negate: false, rules: [{ kind: "rule", field, operator, params }] }, or null for always.';
  const unknownFact = conditionsIn(rule.when).find(one => !known.includes(one.field));
  if (unknownFact) return `This rule names "${unknownFact.field}", which is not something Trillion knows about where a look applies. Use one of: ${known.join(', ')}.`;
  const unknownOperator = conditionsIn(rule.when).find(one => !OPERATORS.has(one.operator));
  if (unknownOperator) return `There is no comparison "${unknownOperator.operator}".`;
  return null;
}

/** The record after a change: { save: rule } keeps one (the same id replaces it; a new one goes first, so the most
 *  specific rule a person adds last-minute is read before the older ones, unless `at` says where), { remove: id } takes
 *  one away, { move: { id, to } } puts one at a place in the order. Throws the problem in words. */
export function changeLookRules(record: unknown, change: { save?: unknown; remove?: string; move?: { id: string; to: number }; at?: number }, looks: readonly string[], now: number): { rules: LookRule[] } {
  const rules = readLookRules(record).slice();
  if (change.save !== undefined) {
    const problem = lookRuleProblem(change.save, looks);
    if (problem) throw new Error(problem);
    const given = change.save as Record<string, unknown>;
    const id = text(given.id) || `look-rule-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (id === data.default_rule.id) throw new Error(`${id} is the look worn everywhere else; wear_look changes it.`);
    const kept: LookRule = { ...(given as unknown as LookRule), id, look_id: text(given.look_id), when: (given.when as LookRuleTree | null | undefined) ?? null, on: given.on !== false, made_at: text(given.made_at) || new Date(now).toISOString() };
    const held = rules.findIndex(rule => rule.id === id);
    if (held >= 0) rules[held] = kept;
    else rules.splice(Number.isInteger(change.at) ? Math.max(0, Math.min(rules.length, change.at as number)) : 0, 0, kept);
    if (rules.length > data.most_rules) throw new Error(`A person keeps at most ${data.most_rules} look rules; remove one first.`);
  }
  if (change.remove !== undefined) {
    const at = rules.findIndex(rule => rule.id === change.remove);
    if (at < 0) throw new Error(`There is no look rule ${change.remove}.`);
    rules.splice(at, 1);
  }
  if (change.move) {
    const from = rules.findIndex(rule => rule.id === change.move!.id);
    if (from < 0) throw new Error(`There is no look rule ${change.move.id}.`);
    const [moved] = rules.splice(from, 1);
    rules.splice(Math.max(0, Math.min(rules.length, Math.trunc(change.move.to))), 0, moved);
  }
  return { rules };
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');

/** The rules in words, in the order they are read, ending with the look worn everywhere else. */
export function sayLookRules(rules: readonly LookRule[], accountLook: string, nameOf: (id: string) => string): string {
  if (!rules.length) return fill(data.words.nothing_yet, { look: nameOf(accountLook) });
  return [
    ...rules.map(rule => fill(data.words.rule, { label: rule.label || rule.id, look: nameOf(rule.look_id) }) + (rule.on === false ? ' (off)' : '')),
    fill(data.words.default, { look: nameOf(accountLook) }),
  ].join('; ') + '.';
}
