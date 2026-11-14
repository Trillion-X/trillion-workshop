// parts/ui/show/show-rules/show-of.ts
//
// NO PRIOR: searched bitfield-packages/packages/*/show for "mute", "silence", "snooze", "do not disturb",
// "quiet hours", "shown_when", "visible_when" (only media silence detection and a notification settings form, no rule
// seam), and 21st.dev for "notification mute snooze menu" (menus only, no seam).
//
// PURPOSE
//   The one question every surface asks before it shows something: "how does this thing show now?" A notice before it
//   pops up, a tour before it starts by itself, a layout before it is listed, any later surface the same way. The app
//   answers it once for the whole page (src/workspace/show-rules-live.ts installs the answerer, which decides the
//   person's show rules); a surface only passes what it is (its subject) and its own fields, and draws the answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a subject, a fact, an effect or a rule: the subject and the thing are the caller's, the
//      answer is the app's.
//   2. With no answerer installed (tests, previews), everything shows. An installed answerer may not be ready yet (its
//      evaluator still loading): it answers that everything shows, and a surface that starts something by itself (the
//      tour host) waits for `showReady()` instead, so nothing the rules would hold slips out while they load.
//   3. When the answers can have changed (a rule saved, the clock passing a moment a rule names) the answerer says so
//      once, and every surface that drew an answer asks again (`onShowChange`, `useShowChange`).
//   4. A quick choice (Silence for 1 hour, Only on this phone) is offered and made through the same answerer, so a menu
//      on any thing offers what the app's DATA offers.
//   5. A rule can also change the thing (its words, its look): `showChanged` hands back the thing with those fields set,
//      and an edit made on the thing is kept through `saveShowRule`, the same record every other rule is kept in.
//   6. Every control a part draws (a sidebar's position, a pane's tab bar, a menu's choice, the bar above selected
//      words) is a thing of subject `control`, named by a dotted path its part declares (`sidebar.position`,
//      `arrangement.header.tabs`): `controlShown` asks about it with `within`, the path and every path it sits in, so a
//      rule about `arrangement.header` holds for every control in a pane's header, and one about a control alone for it.
//   7. A control's answer is a lookup: the answerer decides every control at once into one map when the person's rules
//      change (`shownFromMap`), and `controlShown` reads it. Asking a control reads no store and calls no engine; only a
//      control asked with its own facts that a rule in force reads (a sidebar list's id) is decided on its own.

import React from 'react';

export type ShowRuleSummary = {id: string; label: string; effect: string; until: string | null; starting: boolean};
/** One field a rule that changes things sets on this thing: `rule` is the rule's id, so the change can be taken back. */
export type ShowChange = {rule: string; label: string; path: (string | number)[]; value: unknown; starting: boolean};
export type ShowAnswer = {hidden: boolean; silenced: boolean; until: string | null; rules: ShowRuleSummary[]; changes?: ShowChange[]};
export type ShowChoice = {id: string; label: string};
/** What a thing's menu offers: its heading, the quick choices, and the rules holding it now (each one offered back). */
export type ShowMenu = {heading: string; choices: ShowChoice[]; holding: {id: string; label: string}[]};
export type ShowThing = Record<string, unknown>;

export interface ShowAnswerer {
  /** Whether answers are decided by the rules yet (false while the evaluator loads). */
  readonly ready: boolean;
  /** How a thing shows now. */
  showOf(subject: string, thing: ShowThing): ShowAnswer;
  /** What a thing's menu offers (For 1 hour, Until tomorrow, Always, Only on this phone, and Turn back on). */
  menu(subject: string, thing: ShowThing): ShowMenu;
  /** Makes the rule a quick choice stands for, kept in the person's own rules. */
  choose(subject: string, thing: ShowThing, choiceId: string): Promise<void>;
  /** Takes a rule away (or turns a starting rule off). */
  remove(ruleId: string): Promise<void>;
  /** The thing as the rules that change things leave it (every field their `set` names, in the order they were kept). */
  changed<T extends ShowThing>(subject: string, thing: T): T;
  /** Keeps one rule the person made on the thing itself (an edit made on the canvas), replacing one with its id. */
  save(rule: ShowThing): Promise<void>;
  /** Whether the thing of `subject` known as `key` shows, read from the map every thing of the subject was decided
   *  into at once (invariant 7). `thingOf` makes any key's own fields; `facts` are this ask's own, beyond those. */
  shownFromMap?(subject: string, key: string, thingOf: (key: string) => ShowThing, facts: ShowThing, space_id: string | null): boolean;
}

const SHOWS: ShowAnswer = {hidden: false, silenced: false, until: null, rules: []};
const GLOBAL_KEY = '__trillionShowAnswerer';
type SpaceMembership = { member: boolean; stamp: string };
type Shared = {answerer: ShowAnswerer | null; listeners: Set<() => void>; spaceMembershipListeners: Set<() => void>; verifiedSpaceMembers: Map<string, Set<SpaceMembership>>};
type AuthenticatedSpaceContext = { space_id: string; members: { you?: boolean; role?: string | null }[]; member_types?: { id: string; inherits?: string[] }[] };

// One answerer per document, shared through globalThis, so every bundle on the page asks the same one.
function shared(): Shared {
  const scope = globalThis as unknown as Record<string, Shared | undefined>;
  const state = (scope[GLOBAL_KEY] ??= {answerer: null, listeners: new Set(), spaceMembershipListeners: new Set(), verifiedSpaceMembers: new Map()});
  state.spaceMembershipListeners ??= new Set();
  state.verifiedSpaceMembers ??= new Map();
  return state;
}

/** Installs the page's answerer (or takes it away with null) and tells every surface to ask again. */
export function answerShowWith(answerer: ShowAnswerer | null): void {
  shared().answerer = answerer;
  announceShowChange();
}

/** Tells every surface that drew an answer to ask again. */
export function announceShowChange(): void {
  for (const listener of [...shared().listeners]) {
    try { listener(); } catch (error) { console.error('A show-rule listener failed', error); }
  }
}

/** Calls `listener` whenever answers can have changed; answers the function that stops it. */
export function onShowChange(listener: () => void): () => void {
  shared().listeners.add(listener);
  return () => { shared().listeners.delete(listener); };
}

/** Calls `listener` when an authenticated Space snapshot adds, changes or releases a current membership. */
export function onShowSpaceMembershipChange(listener: () => void): () => void {
  shared().spaceMembershipListeners.add(listener);
  return () => { shared().spaceMembershipListeners.delete(listener); };
}

function announceSpaceMembershipChange(): void {
  for (const listener of [...shared().spaceMembershipListeners]) {
    try { listener(); } catch (error) { console.error('A Space-membership listener failed', error); }
  }
}

/** The exact spaces whose current membership an authenticated Space snapshot has established on this page. */
export function verifiedShowSpaceIds(): string[] {
  return [...shared().verifiedSpaceMembers].filter(([, leases]) => leases.size && [...leases].some(lease => lease.member)).map(([id]) => id);
}

/** How a thing shows now: everything shows until the app installs an answerer. */
export function showOf(subject: string, thing: ShowThing): ShowAnswer {
  return shared().answerer?.showOf(subject, thing) ?? SHOWS;
}

/** The show-rules subject every control is decided under. */
export const CONTROL_SUBJECT = 'control';

/** The paths a control sits in, its own last: `a.b.c` is within `a`, `a.b` and `a.b.c`. */
export function controlWithin(control: string): string[] {
  const parts = control.split('.');
  return parts.map((_, index) => parts.slice(0, index + 1).join('.'));
}

// A control's own fields as a rule reads them: its path and every path it sits in.
const controlThing = (control: string): ShowThing => ({ control, within: controlWithin(control) });

/** Whether the control at `control` (a dotted path its part declares) is drawn now: shown until a rule hides it. */
export function controlShown(control: string, context: Record<string, unknown> & { space_id?: string } = {}): boolean {
  const members = shared().verifiedSpaceMembers;
  const leases = typeof context.space_id === 'string' ? members.get(context.space_id) : undefined;
  const space_id = leases?.size && [...leases].some(lease => lease.member) ? context.space_id! : null;
  const { space_id: _askedSpace, control: _control, within: _within, ...facts } = context;
  const answerer = shared().answerer;
  if (answerer?.shownFromMap) return answerer.shownFromMap(CONTROL_SUBJECT, control, controlThing, facts, space_id);
  return !showOf(CONTROL_SUBJECT, {...facts, ...controlThing(control), ...(space_id ? { space_id } : {})}).hidden;
}

/** Whether current presentation rules offer a thing in navigation. Intrinsic `listed: false`
 * keeps its existing meaning (an explicit saved reference may still draw it); an active rule
 * changing `listed` governs every navigation projection, including saved collection members.
 * The underlying catalog and already-open content retain their original identities. */
export function showListed(subject: string, thing: ShowThing): boolean {
  const answer = showOf(subject, thing);
  if (answer.hidden) return false;
  const listed = answer.changes?.slice().reverse().find(change => change.path.length === 1 && change.path[0] === 'listed');
  return listed?.value !== false;
}

/** A SpaceView lease mirrors membership in its authenticated Space snapshot and releases it on unmount. */
export function registerShowSpaceMembership(space: AuthenticatedSpaceContext, active = true): { update: (space: AuthenticatedSpaceContext, active?: boolean) => void; release: () => void } {
  const spaceId = space.space_id;
  const memberships = shared().verifiedSpaceMembers;
  const lease: SpaceMembership = { member: active && space.members.some(member => member.you === true), stamp: JSON.stringify([space.members.find(member => member.you === true)?.role ?? null, space.member_types ?? null]) };
  const leases = memberships.get(spaceId) ?? new Set<SpaceMembership>();
  leases.add(lease);
  memberships.set(spaceId, leases);
  announceSpaceMembershipChange();
  announceShowChange();
  let registered = true;
  return {
    update(nextSpace, stillActive = true) {
      const next = stillActive && nextSpace.space_id === spaceId && nextSpace.members.some(member => member.you === true);
      const stamp = JSON.stringify([nextSpace.members.find(member => member.you === true)?.role ?? null, nextSpace.member_types ?? null]);
      if (!registered || (lease.member === next && lease.stamp === stamp)) return;
      lease.member = next;
      lease.stamp = stamp;
      announceSpaceMembershipChange();
      announceShowChange();
    },
    release() {
      if (!registered) return;
      registered = false;
      leases.delete(lease);
      if (!leases.size) memberships.delete(spaceId);
      announceSpaceMembershipChange();
      announceShowChange();
    },
  };
}

/** Whether answers come from the rules now: true with no answerer (everything shows), the answerer's word otherwise. */
export function showReady(): boolean {
  return shared().answerer?.ready ?? true;
}

/** The thing as the person's rules change it (the words or the look they set on it, for this one or every one like it);
 *  the thing as it is until the app installs an answerer. */
export function showChanged<T extends ShowThing>(subject: string, thing: T): T {
  return shared().answerer?.changed(subject, thing) ?? thing;
}

/** Keeps one rule made on the thing itself. Refuses in words when there is no answerer. */
export function saveShowRule(rule: ShowThing): Promise<void> {
  const answerer = shared().answerer;
  return answerer ? answerer.save(rule) : Promise.reject(new Error('Rules are not ready on this page yet.'));
}

/** What a thing's menu offers, or nothing when no answerer is installed. */
export function showMenu(subject: string, thing: ShowThing): ShowMenu | null {
  return shared().answerer?.menu(subject, thing) ?? null;
}

/** Makes a quick choice's rule. Refuses in words when there is no answerer. */
export function chooseShow(subject: string, thing: ShowThing, choiceId: string): Promise<void> {
  const answerer = shared().answerer;
  return answerer ? answerer.choose(subject, thing, choiceId) : Promise.reject(new Error('Rules are not ready on this page yet.'));
}

/** Takes a rule away. */
export function removeShowRule(ruleId: string): Promise<void> {
  const answerer = shared().answerer;
  return answerer ? answerer.remove(ruleId) : Promise.reject(new Error('Rules are not ready on this page yet.'));
}

/** A number that changes whenever answers can have changed, for a React surface to ask again on render. */
export function useShowChange(): number {
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => onShowChange(() => setRevision(value => value + 1)), []);
  return revision;
}
