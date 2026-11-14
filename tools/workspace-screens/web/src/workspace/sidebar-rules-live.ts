import { onShowChange, showChanged } from '../../parts/ui/show/show-rules/show-of';
import { SCREEN_SUBJECT } from './sidebar-looks';
// src/workspace/sidebar-rules-live.ts
//
// NO PRIOR: the page's end of the sidebar's lists a rule fills (sidebar-rules.mjs).
//
// PURPOSE
//   Keeps the lists a rule fills (New, what an AI suggested, a tag's list) current on this page: the formula engine
//   decides them from the rows' facts (sidebar-rules.mjs), and the sidebar and every empty pane follow the answer
//   (parts/sidebar/read-data/live-graph.ts). They are decided again when a record a fact reads changes (a note an AI
//   left, a row first seen) and at the moment the clock passes one a rule names, so a row leaves New on its own when
//   it stops being new and a list shown until a date goes at that date.
//   It also keeps the moment each row was first offered to this person (the `sidebar-seen` record): the first time it
//   is kept every row counts as long known, and a row that appears after that is seen from the moment it appears.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a list, a row or a fact; they are surfaces.json DATA.
//   2. Only the records the facts read wake a new decision; any other record change does nothing here.
//   3. A page with no list a rule fills runs no rule reads or fact subscriptions; its catalog still replaces rows.
//   4. A list whose DATA names a `row_chip` marks each row it holds with that chip wherever else the row is drawn
//      (parts/ui/show/surface-chips): the rows New holds say New in their own lists.
//   5. Catalog row changes and rule answers replace the same graph through this owner. A catalog status alone
//      never clears a rule-filled list; a changed row set retains its current rule memberships until the next answer.

import { decideSidebarRules, hasSidebarRules } from 'trillion-workshop/tools/set-up-my-account/read-data/sidebar-rules.mjs';
import { sidebarCollections, type DecidedRules, type ScreenRow, type SidebarList, type SidebarListsData } from './sidebar-lists';
import { replaceProjectedGraph } from '../../parts/sidebar/read-data/live-graph';
import { readInputValue, subscribe, writeInputValue } from './records';
import { filterRowsByRules } from './record-filter';
import { publishSurfaceChips, type SurfaceChip } from '../../parts/ui/show/surface-chips/surface-chips';

type Facts = { from?: string }[];
type Data = SidebarListsData & { sidebar_row_facts?: Facts };

// Every list at any depth that marks the rows it holds with a chip (DATA `row_chip`, such as New's).
const chipLists = (lists: readonly SidebarList[] = []): SidebarList[] => lists.flatMap(list => [...(list.row_chip ? [list] : []), ...chipLists(list.collections)]);

const SEEN = 'sidebar-seen';
const LONG_KNOWN = 0;
// The longest a browser timer can wait (about 24.8 days); a later moment is waited for in steps.
const LONGEST_WAIT_MS = 2_147_483_647;

const recordOf = (name: string): Record<string, unknown> | null => {
  const value = readInputValue<unknown>(name);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
};

/** Keep the first time each offered row was seen: every row long known the first time, a new row from now. */
function keepFirstSeen(rows: readonly ScreenRow[], now: number) {
  const seen = recordOf(SEEN);
  const missing = rows.filter(row => !seen || !(row.id in seen));
  if (!missing.length) return;
  const at = seen ? now : LONG_KNOWN;
  void writeInputValue(SEEN, { ...(seen ?? {}), ...Object.fromEntries(missing.map(row => [row.id, at])) });
}

/** Keep every projection of `first` under one owner: a catalog refresh preserves the last rule answer until its
 * replacement is ready, and a status-only refresh never replaces the lists with an undecided graph. */
export function keepSidebarRules(initialRows: readonly ScreenRow[], data: Data, hostPackage: string, first: object): {
  reoffer(rows: readonly ScreenRow[]): void;
  stop(): void;
} {
  let rows = [...initialRows];
  let rowsText = JSON.stringify(rows);
  let showRevision = 0;
  const presentedRows = () => rows.map(row => showChanged(SCREEN_SUBJECT, row));
  let decided: DecidedRules = { holds: {}, hidden: [] };
  const rules = hasSidebarRules(data);
  const watched = [...new Set((data.sidebar_row_facts ?? []).map(fact => fact.from).filter((name): name is string => Boolean(name)))];
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let read = '';
  let deciding = 0;

  const publishChips = () => {
    // A retained rule answer may still name a withdrawn row while its replacement is pending. Only current rows
    // may carry chips, whether this publication follows a rule answer or an immediate catalog replacement.
    const offeredIds = new Set(rows.map(row => row.id));
    const chips = new Map<string, SurfaceChip>();
    for (const list of chipLists(data.sidebar_collections)) for (const id of decided.holds[list.id] ?? []) if (offeredIds.has(id) && !chips.has(id)) chips.set(id, { ...list.row_chip!, from: `${hostPackage}-${list.id}` });
    publishSurfaceChips(chips);
  };

  async function decide() {
    const mine = ++deciding;
    const now = Date.now();
    const offered = presentedRows();
    keepFirstSeen(offered, now);
    const answer = await decideSidebarRules({ data, rows: offered, readRecord: recordOf, now, filterRows: filterRowsByRules });
    if (stopped || mine !== deciding) return;
    decided = answer;
    replaceProjectedGraph(first, sidebarCollections(presentedRows(), data, hostPackage, decided));
    // Each row a chip list holds wears its chip in its other lists ("New" beside the name).
    publishChips();
    if (timer) clearTimeout(timer);
    timer = answer.next_change_at === null ? null : setTimeout(() => { void decide().catch(() => {}); }, Math.min(Math.max(answer.next_change_at - Date.now(), 0) + 50, LONGEST_WAIT_MS));
  }

  const follow = () => {
    const now = JSON.stringify([rowsText, showRevision, watched.map(recordOf)]);
    if (now === read) return;
    read = now;
    void decide().catch(() => {});
  };
  if (rules) follow();
  const unsubscribe = rules ? subscribe(follow) : () => {};
  const unsubscribeShow = onShowChange(() => {
    if (stopped) return;
    ++showRevision;
    replaceProjectedGraph(first, sidebarCollections(presentedRows(), data, hostPackage, decided));
    if (rules) follow();
  });
  return {
    reoffer: next => {
      if (stopped) return;
      const text = JSON.stringify(next);
      if (text === rowsText) return;
      rows = [...next];
      rowsText = text;
      // Withdrawn rows leave at once; rows already held by a rule keep their place while the new answer is read.
      replaceProjectedGraph(first, sidebarCollections(presentedRows(), data, hostPackage, decided));
      publishChips();
      if (rules) follow();
    },
    stop: () => { stopped = true; ++deciding; unsubscribe(); unsubscribeShow(); if (timer) clearTimeout(timer); },
  };
}
