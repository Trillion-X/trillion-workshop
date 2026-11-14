// parts/ui/show/catch-up/catch-up.ts
//
// NO PRIOR: searched parts/ui/show for "sync", "offline", "catch up", "conflict", "two versions" and "devices": only
// persistence-status (one dot and a word, no sources, no devices, no versions) and status-vocabulary (words for a key).
// 21st.dev "Data Refresh State" (id 29369) gave the anatomy only (a compact pill, an inline strip and a panel; never a
// progress number nobody measured; announce a change of state once), written fresh here.
//
// PURPOSE
//   Whether every copy of the person's things is in step, from anything that keeps a copy: this device's own waiting
//   changes, each of their devices catching up, a recording still sending, a record kept as two versions because two
//   copies changed it apart. Each keeper is a source the page provides (`provideCatchUpSource`); a source reports facts
//   (a thing in a state, with its counts) and the versions it kept apart, and does the actions its states offer. What a
//   state is called, its tone, icon, rank and actions are the caller's DATA (`CatchUpWords`), so this file never names
//   a state, a source, a device or a kind of record.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: a state is an open key; its words, tone, icon, rank, actions and whether it stays quiet are DATA. A key with
//      no row reads as its own words, quiet, so a new state a source starts reporting never breaks a screen.
//   2. One summary for everything: the fact whose state ranks highest leads; its count is the sum over every fact in that
//      state, and a percent is shown only when the facts in that state measured how far they got (`done` of `total`).
//      Nothing here invents a number.
//   3. A fact that has not caught up in a while becomes the state its DATA `ages` row names (a device behind), decided
//      from `now`, which is handed in.
//   4. One registry per document (globalThis), so every bundle on the page reads the same sources; a source that
//      changes says so once and every reader asks again.
//   5. Settling two versions goes back to the source that kept them: keep one side, keep both, or keep a merged value.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';

/** One thing a source keeps a copy of, in a state, with its counts. */
export type CatchUpFact = {
  /** Unique within its source. */
  readonly id: string;
  /** The open state key; its words come from DATA. */
  readonly state: string;
  /** Its own name (a device, a recording). */
  readonly title?: string;
  /** What kind of thing it is, in the source's own word; DATA names its icon. */
  readonly kind?: string;
  /** Changes not yet sent on from it. */
  readonly waiting?: number;
  /** How far catching up got, measured: `done` of `total`. Left out when not measured. */
  readonly done?: number;
  readonly total?: number;
  /** When it last caught up (ISO text or milliseconds). */
  readonly at?: string | number;
  /** This is the device the page runs on. */
  readonly here?: boolean;
  /** The actions its keeper can do for it here; a state's actions are offered only where they can be done. */
  readonly can?: readonly string[];
};

/** One copy of a record kept apart: where it came from, when, and its value. */
/** `keep` is the words of its keep button when its keeper names them; otherwise the words fill `keep_side` with `from`. */
export type KeptSide = { readonly id: string; readonly from: string; readonly keep?: string; readonly at?: string | number; readonly value: unknown; readonly current?: boolean };
/** A record kept as two (or more) versions because copies changed it apart. */
export type KeptApart = { readonly id: string; readonly thing: { readonly kind: string; readonly id: string; readonly title: string }; readonly sides: readonly KeptSide[] };
/** How two versions are settled: keep one side, keep both as separate things, or keep a merged value. */
export type Settle = { readonly keep: 'one'; readonly side: string } | { readonly keep: 'both' } | { readonly keep: 'merged'; readonly value: unknown };

/** What a source reports now. */
export type CatchUpReport = { readonly facts: readonly CatchUpFact[]; readonly apart?: readonly KeptApart[] };

export interface CatchUpSource {
  /** What it reports now (answered from what it holds; never a read per call). */
  read(): CatchUpReport;
  /** Calls `listener` when what it reports changed; answers the call that stops it. */
  subscribe(listener: () => void): () => void;
  /** Does an action its states offer, for one of its facts. */
  act?(action: string, fact: CatchUpFact): Promise<unknown> | void;
  /** Settles a record it kept apart. */
  settle?(apart: KeptApart, settle: Settle): Promise<unknown>;
}

/** One state's DATA row. `{count}` and `{percent}` fill in; `label_one` is used for a count of one and `label_measured`
 *  when how far it got is measured. */
export type CatchUpStateRow = {
  readonly label: string;
  readonly label_one?: string;
  readonly label_measured?: string;
  readonly detail?: string;
  /** A tone word: good, attention, bad, info, quiet. */
  readonly tone?: string;
  readonly icon?: string;
  /** The highest ranking state among all facts leads the summary. */
  readonly rank?: number;
  /** Action ids this state offers (their words are `actions`). */
  readonly actions?: readonly string[];
  /** Nothing to show while this state leads (all caught up): the compact mark draws nothing or its quiet form. */
  readonly quiet?: boolean;
  /** The mark breathes while this state leads (work going on). */
  readonly moving?: boolean;
};
export type CatchUpActionRow = { readonly label: string; readonly icon?: string; readonly pending?: string; readonly done?: string };
/** A fact in `from` whose `at` is older than `older_than_ms` reads as `becomes`. */
export type CatchUpAge = { readonly from: readonly string[]; readonly older_than_ms: number; readonly becomes: string };
export type CatchUpWords = {
  readonly states: Readonly<Record<string, CatchUpStateRow>>;
  readonly actions?: Readonly<Record<string, CatchUpActionRow>>;
  /** Icon names by a fact's kind. */
  readonly kinds?: Readonly<Record<string, { readonly icon: string }>>;
  readonly ages?: readonly CatchUpAge[];
  /** The state records kept apart put everything in (counted by how many), weighed against every fact's state. */
  readonly apart_state?: string;
  /** Every other word the parts show. */
  readonly words: Readonly<Record<string, string>>;
};

/** A fact as the screen shows it: its state row, words and when. */
export type ShownFact = CatchUpFact & { readonly source: string; readonly key: string; readonly row: CatchUpStateRow; readonly words: string; readonly offers: readonly string[] };
export type ShownApart = KeptApart & { readonly source: string };
/** The whole picture: the leading state with its words, and every fact and every record kept apart. */
export type CatchUpView = {
  /** The fact whose state leads, or null when no source reports anything. */
  readonly lead: ShownFact | null;
  readonly state: string;
  readonly row: CatchUpStateRow;
  readonly label: string;
  readonly count: number;
  readonly percent: number | null;
  readonly facts: readonly ShownFact[];
  readonly apart: readonly ShownApart[];
};

const timeOf = (value: string | number | undefined) => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
export const plainWords = (key: string) => {
  const words = key.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
};

/** The DATA row of a state key, or its own words, quiet (invariant 1). */
export function stateRow(words: CatchUpWords, key: string): CatchUpStateRow {
  return words.states[key] ?? { label: plainWords(key), tone: 'quiet', rank: 0, quiet: true };
}

/** A state row's words for a count and a percent. */
export function fillWords(row: CatchUpStateRow, count: number, percent: number | null): string {
  const template = percent !== null && row.label_measured ? row.label_measured : count === 1 && row.label_one ? row.label_one : row.label;
  return template.replace('{count}', String(count)).replace('{percent}', percent === null ? '' : String(percent)).replace(/\s+/g, ' ').trim();
}

/** The state a fact reads as now: its own, or the one its age names (invariant 3). */
export function stateNow(words: CatchUpWords, fact: CatchUpFact, now: number): string {
  const at = timeOf(fact.at);
  for (const age of words.ages ?? []) {
    if (age.from.includes(fact.state) && Number.isFinite(at) && now - at > age.older_than_ms) return age.becomes;
  }
  return fact.state;
}

/** The whole picture from every source's report (invariant 2). */
export function catchUpView(reports: ReadonlyMap<string, CatchUpReport>, words: CatchUpWords, now: number): CatchUpView {
  const facts: ShownFact[] = [];
  const apart: ShownApart[] = [];
  for (const [source, report] of reports) {
    for (const fact of report.facts) {
      const key = stateNow(words, fact, now);
      const row = stateRow(words, key);
      facts.push({ ...fact, source, key, row, words: fillWords(row, fact.waiting ?? 0, measured([fact])), offers: (row.actions ?? []).filter(action => fact.can?.includes(action)) });
    }
    for (const kept of report.apart ?? []) apart.push({ ...kept, source });
  }
  facts.sort((a, b) => Number(Boolean(b.here)) - Number(Boolean(a.here)) || (b.row.rank ?? 0) - (a.row.rank ?? 0) || (a.title ?? a.id).localeCompare(b.title ?? b.id));
  const lead = facts.reduce<ShownFact | null>((best, fact) => (!best || (fact.row.rank ?? 0) > (best.row.rank ?? 0) ? fact : best), null);
  // Records kept apart lead when their state outranks every fact's (they wait on the person, not on a device).
  const apartRow = apart.length && words.apart_state ? stateRow(words, words.apart_state) : null;
  if (apartRow && (!lead || (apartRow.rank ?? 0) > (lead.row.rank ?? 0))) {
    return { lead: null, state: words.apart_state!, row: apartRow, label: fillWords(apartRow, apart.length, null), count: apart.length, percent: null, facts, apart };
  }
  const state = lead?.key ?? '';
  const row = lead ? lead.row : stateRow(words, '');
  const same = facts.filter(fact => fact.key === state);
  const count = same.reduce((sum, fact) => sum + (fact.waiting ?? 0), 0);
  const percent = measured(same);
  return { lead, state, row, label: lead ? fillWords(row, count, percent) : '', count, percent, facts, apart };
}

/** How far the facts got, in whole percent, only when every one of them measured it. */
function measured(facts: readonly CatchUpFact[]): number | null {
  if (!facts.length || facts.some(fact => !(typeof fact.total === 'number' && fact.total > 0 && typeof fact.done === 'number'))) return null;
  const total = facts.reduce((sum, fact) => sum + (fact.total ?? 0), 0);
  const done = facts.reduce((sum, fact) => sum + Math.min(fact.done ?? 0, fact.total ?? 0), 0);
  return Math.floor((done / total) * 100);
}

// ---------------------------------------------------------------------------------------------------------------------
// The page's sources (invariant 4)
// ---------------------------------------------------------------------------------------------------------------------

type Shared = { sources: Map<string, CatchUpSource>; stops: Map<string, () => void>; listeners: Set<() => void>; version: number; words: CatchUpWords | null };
const GLOBAL_KEY = '__trillionCatchUpSources';
function shared(): Shared {
  const scope = globalThis as unknown as Record<string, Shared | undefined>;
  return (scope[GLOBAL_KEY] ??= { sources: new Map(), stops: new Map(), listeners: new Set(), version: 0, words: null });
}

/** Installs the page's words (its DATA), so a part that draws the mark without being handed them (a pane's bar) reads
 *  the same ones; with none installed such a part draws nothing. */
export function provideCatchUpWords(words: CatchUpWords | null): void {
  shared().words = words;
  announce();
}
/** The page's installed words, kept current. */
export function useCatchUpWords(): CatchUpWords | null {
  React.useSyncExternalStore(onCatchUpChange, () => shared().version, () => 0);
  return shared().words;
}
function announce() {
  const table = shared();
  table.version += 1;
  for (const listener of [...table.listeners]) listener();
}

/** Installs a source under its id (replacing one of the same id); answers the call that takes it away. */
export function provideCatchUpSource(id: string, source: CatchUpSource): () => void {
  const table = shared();
  table.stops.get(id)?.();
  table.sources.set(id, source);
  table.stops.set(id, source.subscribe(announce));
  announce();
  return () => {
    if (table.sources.get(id) !== source) return;
    table.stops.get(id)?.();
    table.stops.delete(id);
    table.sources.delete(id);
    announce();
  };
}

/** Every source's report now. */
export function catchUpReports(): Map<string, CatchUpReport> {
  return new Map([...shared().sources].map(([id, source]) => [id, source.read()]));
}

/** Calls `listener` when any source's report changed; answers the call that stops it. */
export function onCatchUpChange(listener: () => void): () => void {
  shared().listeners.add(listener);
  return () => { shared().listeners.delete(listener); };
}

/** Does an action on the source a fact came from; fails when that source cannot do it. */
export async function catchUpAct(action: string, fact: ShownFact): Promise<void> {
  const doing = shared().sources.get(fact.source)?.act?.(action, fact);
  if (!doing) throw new Error('This can no longer be done here');
  await doing;
}

/** Settles a record kept apart through the source that kept it (invariant 5). */
export async function settleKeptApart(apart: ShownApart, settle: Settle): Promise<void> {
  const source = shared().sources.get(apart.source);
  if (!source?.settle) throw new Error('These versions can no longer be settled here');
  await source.settle(apart, settle);
}

/** The whole picture, kept current; `now` moves each minute so a device that has fallen behind shows it. */
export function useCatchUp(words: CatchUpWords): CatchUpView {
  const version = React.useSyncExternalStore(onCatchUpChange, () => shared().version, () => 0);
  const [minute, setMinute] = React.useState(() => Math.floor(Date.now() / 60_000));
  React.useEffect(() => {
    const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 60_000);
    return () => clearInterval(timer);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => catchUpView(catchUpReports(), words, Date.now()), [version, minute, words]);
}
