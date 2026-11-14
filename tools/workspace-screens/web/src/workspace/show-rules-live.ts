// src/workspace/show-rules-live.ts
//
// NO PRIOR: searched the Bitfield packages (packages/*/show) for "quiet hours", "snooze", "do not disturb" (only a Do
// Not Disturb radio in notifications/show/notification-setting-screen.tsx, one mode, no rule seam) and 21st.dev for
// "notification mute snooze menu" (menus only). The page's end of show rules (show-rules.mjs decides them).
//
// PURPOSE
//   Answers, for this page, the one question every surface asks before it shows something (parts/ui/show/show-rules
//   show-of.ts): how does this notice, tour, layout or any thing show now? It decides the person's show rules (their own
//   `show-rules` record, followed live, plus the starting rules everyone has) with the formula engine over the thing's
//   facts and this moment's: the device this page is on, whether it was opened from a link (first-use-tour.mjs, the
//   same answer the tour hold always gave), the hour and weekday where the person is. It offers the quick choices on
//   any thing's menu and keeps the rule a choice makes in the same record through the generic records write, so a rule
//   set here, in Notification settings or by an AI reaches every surface on every open page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a subject, a fact, an effect or a choice; they are show-rules.json DATA and the caller's.
//   2. Until the evaluator has loaded the answerer is not ready: surfaces that start things by themselves (the tour
//      host) wait for it; everything else shows. Once ready, every answer is in the same call.
//   3. The person's record is read once for the session and again only on its own change notice (the records' change
//      with its label; a trigger or workflow that changes a rule writes the record, which sends it). The rules given to
//      them arrive with the page's first answers and are read again only on the store's change notice for them (or a
//      Space membership changing). Surfaces are told to ask again then, and when the clock passes a moment a rule names.
//   4. Every control (and every subject DATA marks `changed_only`, the arrangement limits) is decided in one pass when
//      the rules change (show-rules-map.mjs decideEvery: each rule once over every control's row) into one flat map;
//      asking a control is a lookup in it, never a store read and never an engine call. A thing whose answer needs its
//      own facts (a notice, a tour, a control asked with a fact a rule reads) is decided once and kept until the rules
//      change or its `next_change_at` passes; a thing is known by its subject and fields.

import data from 'trillion-workshop/tools/set-up-my-account/read-data/show-rules.json';
import { changedRecord, deviceOf, everyRule, quickRule, rulesInForce, showDecision, withChanges } from './show-rules.mjs';
import { decideEvery } from './show-rules-map.mjs';
import { selfStartingToursMayShow } from './first-use-tour.mjs';
import { readInputValue, subscribeRecordChanges, updateInputValueDurably } from './records';
import { loadRowFilterNow } from './record-filter';
import { readJson } from './api';
import { onStoreChange } from './store-changes';
import { answerShowWith, announceShowChange, onShowSpaceMembershipChange, verifiedShowSpaceIds, type ShowAnswer, type ShowAnswerer, type ShowMenu, type ShowThing } from '../../parts/ui/show/show-rules/show-of';

type Rule = { id: string; label?: string; subject?: string; effect?: string; until?: string | null; on?: boolean; starting?: boolean; when?: unknown };
type Profile = { id: string; label?: string; rules?: { id: string; label?: string }[] };
type Kept = { rules?: Rule[]; starting?: { [id: string]: { on: boolean } }; types?: Profile[]; in_use?: string[] };
type Decision = ShowAnswer & { next_change_at: number | null };
type Filter = (input: { tree: unknown; fields: { id: string; kind: string }[]; rows: { [field: string]: unknown }[] }) => { matches: number[] };
export type AppliedShowRules = { rules: Rule[]; authority?: string; controls?: { id: string }[] };
type Change = { save?: unknown; remove?: string; starting?: { id: string; on: boolean }; use?: { type: string; on: boolean }; remove_type?: string };
let assignedRules: Rule[] = [];
const assignedSpaceRules = new Map<string, Rule[]>();
// Whose rules the read answered for (`operator` or `personal`): it decides which fields a rule may change.
let authority: string | null = null;

// The person's rules are their own record. A change is decided by changedRecord over the record as the store holds it
// now and kept through the generic records write, compared and retried against that same value.
async function keepChange(change: Change): Promise<void> {
  await updateInputValueDurably(data.record, current => changedRecord(data,
    current && typeof current === 'object' && !Array.isArray(current) ? current : null, change, Date.now(), authority));
  announceShowChange();
}

const LONGEST_WAIT_MS = 2_147_483_647;
const fill = (template: string, values: { [name: string]: string }) => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');
// The person's record as this page last read it: read once, and again only on its change notice (invariant 3).
let kept: Kept | null | undefined;
const readKept = (): Kept | null => {
  const value = readInputValue<unknown>(data.record);
  kept = value && typeof value === 'object' && !Array.isArray(value) ? value as Kept : null;
  return kept;
};
const keptNow = (): Kept | null => (kept === undefined ? readKept() : kept);
type Subjects = { [id: string]: { changed_only?: boolean; facts?: { id: string; path?: string[] }[] } };
// The key of the thing a fact of `subject` is read from: the first step of its declared path (the `screen` fact of a
// screen is its `id`), else the fact's own name. A pass is kept only for a thing carrying none of these keys.
const thingKeyOf = (subject: string, field: string): string =>
  (data.subjects as Subjects)[subject]?.facts?.find(fact => fact.id === field)?.path?.[0] ?? field;
// Every field the in-force rules of a subject read from the thing itself (not the moment's).
const momentIds = new Set((data.moment_facts as { id: string }[]).map(fact => fact.id));
const leafFields = (tree: unknown): string[] => {
  if (!tree || typeof tree !== 'object') return [];
  const node = tree as { kind?: string; field?: unknown; rules?: unknown[] };
  if (node.kind === 'rule') return typeof node.field === 'string' ? [node.field] : [];
  return Array.isArray(node.rules) ? node.rules.flatMap(leafFields) : [];
};
// One pass's answers for one Space (or none): the rules in force, the flat map of every control (key → shown, per
// subject asked by key), the fields its rules read from things, and each changed-only subject's decision.
type Pass = { rules: Rule[]; shown: Map<string, Map<string, boolean>>; reads: Map<string, Set<string>>; limits: Map<string, Decision>; next_change_at: number | null };

/** Starts answering show questions for this page; answers the stop. */
export async function keepShowRules(initial: AppliedShowRules): Promise<() => void> {
  if (!Array.isArray(initial?.rules)) throw new Error('The current workspace rules could not be read.');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const device = deviceOf(data, typeof navigator === 'undefined' ? '' : navigator.userAgent);
  // Whether this page was opened at an address the person came for, read once, as the tour hold always read it.
  const arrivedByLink = selfStartingToursMayShow(location.pathname, location.search) ? 'no' : 'yes';
  const moment = { device, arrived_by_link: arrivedByLink, time_zone: timeZone };
  const deviceLabel = data.devices.find(row => row.id === device)?.label ?? device ?? '';
  let filter: Filter | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wakeAt: number | null = null;
  let stopped = false;
  assignedRules = initial.rules.filter(rule => typeof (rule as Rule & { given?: unknown }).given === 'string');
  authority = typeof initial.authority === 'string' ? initial.authority : null;
  assignedSpaceRules.clear();

  // The clock moment a rule names: every surface asks again then (invariant 3).
  const wakeBy = (at: number | null) => {
    if (at === null || (wakeAt !== null && wakeAt <= at)) return;
    wakeAt = at;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { wakeAt = null; timer = null; announceShowChange(); }, Math.min(Math.max(at - Date.now(), 0) + 50, LONGEST_WAIT_MS));
  };
  // A decision is kept per thing until the person's rules change or the moment it can next turn by itself (invariant 4):
  // a notice change asks about every notice, and deciding each afresh held a busy page's main thread for seconds.
  const decided = new Map<string, Decision>();
  const KEPT_MOST = 5000;
  const decide = (subject: string, thing: ShowThing): Decision => {
    const now = Date.now();
    const key = `${subject}\u0000${JSON.stringify(thing)}`;
    const kept = decided.get(key);
    if (kept && (kept.next_change_at === null || now < kept.next_change_at)) return kept;
    // A SpaceView supplies this only after its authenticated snapshot proves current membership. The scoped server
    // read rechecks membership with the Space owner before applying that member's type inheritance.
    const space_id = typeof thing.space_id === 'string' ? thing.space_id : null;
    const given = space_id && assignedSpaceRules.has(space_id) ? assignedSpaceRules.get(space_id)! : assignedRules;
    const answer = showDecision({ data, record: keptNow(), given, subject, thing, moment, now, filterRows: filter!, space_id }) as Decision;
    if (decided.size >= KEPT_MOST) decided.clear();
    decided.set(key, answer);
    wakeBy(answer.next_change_at);
    return answer;
  };
  const keep = async (change: Change) => { forget(); await keepChange(change); };

  // The one pass (invariant 4), per Space: the changed-only subjects' decisions (the arrangement limits) when it is
  // made, and every thing of a subject asked by key (every control the store lists) decided at once on its first ask.
  const listed = (Array.isArray(initial.controls) ? initial.controls : []).map(row => row?.id).filter((id): id is string => typeof id === 'string');
  const passes = new Map<string, Pass>();
  const forget = () => { decided.clear(); passes.clear(); };
  const subjects = data.subjects as Subjects;
  const spaceOf = (thing: ShowThing) => (typeof thing.space_id === 'string' && assignedSpaceRules.has(thing.space_id) ? thing.space_id : null);
  const givenIn = (space_id: string | null) => (space_id && assignedSpaceRules.has(space_id) ? assignedSpaceRules.get(space_id)! : assignedRules);
  const sooner = (one: number | null, other: number | null) => (one === null ? other : other === null ? one : Math.min(one, other));
  const passFor = (space_id: string | null): Pass => {
    const now = Date.now();
    const held = passes.get(space_id ?? '');
    if (held && (held.next_change_at === null || now < held.next_change_at)) return held;
    const given = givenIn(space_id);
    const rules = rulesInForce(data, keptNow(), given, space_id) as Rule[];
    const pass: Pass = { rules, shown: new Map(), reads: new Map(), limits: new Map(), next_change_at: null };
    for (const [limited, declared] of Object.entries(subjects)) {
      if (!declared.changed_only) continue;
      const answer = showDecision({ data, record: keptNow(), given, subject: limited, thing: {}, moment, now, filterRows: filter!, space_id }) as Decision;
      pass.limits.set(limited, answer);
      pass.reads.set(limited, new Set(rules.filter(rule => rule.subject === limited).flatMap(rule => leafFields(rule.when)).filter(field => !momentIds.has(field)).map(field => thingKeyOf(limited, field))));
      pass.next_change_at = sooner(pass.next_change_at, answer.next_change_at);
    }
    passes.set(space_id ?? '', pass);
    wakeBy(pass.next_change_at);
    return pass;
  };
  // Every key of a subject decided into the pass's map at once: each rule once over all of their rows.
  const mapInto = (pass: Pass, subject: string, keys: string[], thingOf: (key: string) => ShowThing) => {
    const now = Date.now();
    const every = decideEvery({ data, rules: pass.rules, subject, things: keys.map(thingOf), moment, now, filterRows: filter! });
    const shown = pass.shown.get(subject) ?? new Map<string, boolean>();
    keys.forEach((key, index) => shown.set(key, every.strict || !every.hidden[index]));
    pass.shown.set(subject, shown);
    pass.reads.set(subject, every.strict ? new Set(['*']) : new Set(every.reads));
    pass.next_change_at = sooner(pass.next_change_at, every.next_change_at);
    wakeBy(every.next_change_at);
  };
  // A thing a pass answers: no rule in force reads one of the fields this ask carries beyond the pass's own rows.
  const passAnswers = (pass: Pass, subject: string, fields: string[]) => {
    const reads = pass.reads.get(subject);
    return Boolean(reads) && !reads!.has('*') && fields.every(field => !reads!.has(field));
  };
  const limitOf = (subject: string, thing: ShowThing): Decision | null => {
    if (!subjects[subject]?.changed_only) return null;
    const pass = passFor(spaceOf(thing));
    return passAnswers(pass, subject, Object.keys(thing)) ? pass.limits.get(subject) ?? null : null;
  };

  const answerer: ShowAnswerer = {
    get ready() { return filter !== null; },
    showOf: (subject, thing) => (filter ? limitOf(subject, thing) ?? decide(subject, thing) : { hidden: false, silenced: false, until: null, rules: [] }),
    shownFromMap(subject, key, thingOf, facts, space_id) {
      if (!filter) return true;
      const pass = passFor(space_id && assignedSpaceRules.has(space_id) ? space_id : null);
      if (!pass.shown.has(subject)) mapInto(pass, subject, listed.includes(key) ? listed : [...listed, key], thingOf);
      // A key the store did not list joins the map, decided on its own row once.
      if (!pass.shown.get(subject)!.has(key)) mapInto(pass, subject, [key], thingOf);
      if (!passAnswers(pass, subject, Object.keys(facts))) return !decide(subject, { ...facts, ...thingOf(key), ...(space_id ? { space_id } : {}) }).hidden;
      return pass.shown.get(subject)!.get(key) ?? true;
    },
    menu(subject, thing): ShowMenu {
      const declared = (data.subjects as { [id: string]: { label: string; menu_heading?: string } })[subject];
      const holding = filter ? decide(subject, thing).rules : [];
      return {
        heading: declared?.menu_heading ?? declared?.label ?? subject,
        choices: data.quick.filter(choice => !('device' in choice) || device).map(choice => ({ id: choice.id, label: fill(choice.label, { device: deviceLabel }) })),
        holding: holding.filter(rule => !(rule as Rule & { given?: unknown }).given).map(rule => ({ id: rule.id, label: fill(data.words.turn_back_on, { label: rule.label || declared?.label || subject }) })),
      };
    },
    async choose(subject, thing, choiceId) {
      const rule = quickRule(data, { choice: choiceId, subject, thing, device, now: Date.now(), time_zone: timeZone, by: 'person' });
      await keep({ save: rule });
    },
    async remove(ruleId) {
      if (assignedRules.some(rule => rule.id === ruleId)) throw new Error('This rule is set for your account.');
      await keep({ remove: ruleId });
    },
    changed(subject, thing) {
      if (!filter) return thing;
      return withChanges(thing, (limitOf(subject, thing) ?? decide(subject, thing)).changes) as typeof thing;
    },
    async save(rule) {
      await keep({ save: rule });
    },
  };
  filter = await loadRowFilterNow();
  kept = undefined;
  readKept();
  answerShowWith(answerer);
  forget();
  announceShowChange();
  let assignedRead = 0;
  const readAssigned = async () => {
    const request = ++assignedRead;
    try {
      const latest = await readJson<AppliedShowRules>('/work/api/show-rules', { cache: 'no-store' });
      if (stopped || request !== assignedRead || !Array.isArray(latest.rules)) return;
      const next = latest.rules.filter(rule => typeof (rule as Rule & { given?: unknown }).given === 'string');
      let changed = JSON.stringify(next) !== JSON.stringify(assignedRules);
      assignedRules = next;
      const active = new Set(verifiedShowSpaceIds());
      for (const id of [...assignedSpaceRules.keys()]) if (!active.has(id)) { assignedSpaceRules.delete(id); changed = true; }
      // Each scoped read is exact to one Space and the server revalidates the current membership before returning rules.
      for (const id of active) {
        try {
          const scoped = await readJson<AppliedShowRules>(`/work/api/show-rules?space_id=${encodeURIComponent(id)}`, { cache: 'no-store' });
          if (stopped || request !== assignedRead) return;
          if (!Array.isArray(scoped.rules)) {
            if (assignedSpaceRules.delete(id)) changed = true;
            continue;
          }
          const scopedRules = scoped.rules.filter(rule => typeof (rule as Rule & { given?: unknown }).given === 'string');
          if (JSON.stringify(scopedRules) !== JSON.stringify(assignedSpaceRules.get(id))) changed = true;
          assignedSpaceRules.set(id, scopedRules);
        } catch (error) {
          if (stopped || request !== assignedRead) return;
          if (assignedSpaceRules.delete(id)) changed = true;
          console.error('Space-assigned show rules could not be refreshed', id, error);
        }
      }
      if (!changed) return;
      forget();
      announceShowChange();
    } catch (error) { console.error('Assigned show rules could not be refreshed', error); }
  };
  const unsubscribeAssigned = onStoreChange(readAssigned, ['/work/api/show-rules']);
  const membershipChanged = () => {
    assignedSpaceRules.clear();
    forget();
    announceShowChange();
    void readAssigned();
  };
  const unsubscribeSpaceMemberships = onShowSpaceMembershipChange(membershipChanged);
  // The rules given to this person arrived with the page's first answers (`initial`): read again only on their change
  // notice above, or when a Space membership changes (invariant 3).
  // Any change to the person's rules (here, another device, their AI, a trigger or workflow writing the record) reaches
  // every surface: the record's own change notice reads it once and the next ask evaluates once.
  let read = JSON.stringify(kept);
  const unsubscribe = subscribeRecordChanges(labels => {
    if (!labels.includes(data.record)) return;
    const next = JSON.stringify(readKept());
    if (next === read) return;
    read = next;
    forget();
    announceShowChange();
  });
  return () => { stopped = true; unsubscribe(); unsubscribeAssigned(); unsubscribeSpaceMemberships(); if (timer) clearTimeout(timer); assignedRules = []; assignedSpaceRules.clear(); passes.clear(); kept = undefined; answerShowWith(null); };
}

/** Every rule the person keeps, as Notification settings lists them. */
export const showRulesNow = (): Rule[] => [...everyRule(data, keptNow()), ...assignedRules];

/** The profiles the person keeps, and which are switched on (record.types, record.in_use). */
export const profilesNow = (): { profiles: Profile[]; in_use: string[] } => ({ profiles: keptNow()?.types ?? [], in_use: keptNow()?.in_use ?? [] });

/** Keeps one change to the person's rules ({ save }, { remove }, { starting }, { use }, { remove_type }); throws a rule's problem in words. */
export async function changeShowRules(change: Change): Promise<void> {
  const id = change.remove ?? (change.save as { id?: unknown } | undefined)?.id;
  if (assignedRules.some(rule => rule.id === id)) throw new Error('This rule is set for your account.');
  await keepChange(change);
}
