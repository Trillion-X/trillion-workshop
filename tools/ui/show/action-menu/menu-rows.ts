// parts/ui/show/action-menu/menu-rows.ts
//
// PURPOSE
//   The rows every ⋯ menu offers for the thing it is about. A menu that says what it is about (ActionMenu `about`: a
//   file, a screen, a list row, anything described by its own facts) shows its own rows and then the rows the page's
//   one source offers for that thing: every tool, screen, saved action and way of sending that applies, nested as deep
//   as the source nests them. The page installs the source once (provideMenuRows); a menu never names a row.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a kind of thing, a row or a source: the thing is the caller's, the rows are the source's.
//   2. With no source installed (tests, previews), a menu shows only its own rows.
//   3. One source per document, shared through globalThis, so every bundle on the page asks the same one.
//   4. A source answers from what it already read whenever it can (`peek`), so a menu opened again draws at once; a
//      read happens only when the menu opens, never for every menu drawn.
//   5. When the rows can have changed (a tool added, a saved action renamed) the source says so once and every open
//      menu asks again (`announceMenuRows`).

import * as React from 'react';
import type { ActionMenuItem } from './ActionMenu';
import type { DrillRow, DrillSection } from '../drill-menu/DrillMenu';

/** What a menu is about: its kind, its own id, a title for the words, and any facts the source and the rules read. */
export type MenuThing = { readonly kind: string; readonly id: string; readonly title: string; readonly [fact: string]: unknown };

export interface MenuRowSource {
  /** The rows already read for this thing, or null when they must be read first. */
  peek(thing: MenuThing): readonly ActionMenuItem[] | null;
  /** Reads the rows for this thing (nested rows open as submenus). */
  rows(thing: MenuThing): Promise<readonly ActionMenuItem[]>;
  /** Does one of the rows it offered; its answer is the words to show when it is done. */
  act(thing: MenuThing, id: string): Promise<string | void> | string | void;
}

const GLOBAL_KEY = '__trillionMenuRows';
type Shared = { source: MenuRowSource | null; listeners: Set<() => void> };
function shared(): Shared {
  const scope = globalThis as unknown as Record<string, Shared | undefined>;
  return (scope[GLOBAL_KEY] ??= { source: null, listeners: new Set() });
}

/** Installs the page's source of menu rows (or takes it away with null); every open menu asks again. */
export function provideMenuRows(source: MenuRowSource | null): () => void {
  shared().source = source;
  announceMenuRows();
  return () => { if (shared().source === source) provideMenuRows(null); };
}

/** The installed source, if any. */
export const menuRowSource = (): MenuRowSource | null => shared().source;

/** Tells every open menu that its rows may have changed. */
export function announceMenuRows(): void {
  for (const listener of [...shared().listeners]) listener();
}

/** Every id a row and the rows inside it carry. */
export function rowIds(rows: readonly ActionMenuItem[], into: Set<string> = new Set()): Set<string> {
  for (const row of rows) { into.add(row.id); if (row.items) rowIds(row.items, into); }
  return into;
}

/** The rows the source offers for `thing`, read when `open` turns true (and answered at once from what it holds). */
export function useMenuRows(thing: MenuThing | undefined, open: boolean): readonly ActionMenuItem[] {
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const [read, setRead] = React.useState<{ key: string; rows: readonly ActionMenuItem[] } | null>(null);
  const key = thing ? JSON.stringify(thing) : '';
  React.useEffect(() => {
    const listeners = shared().listeners;
    const heard = () => { setRead(null); redraw(); };
    listeners.add(heard);
    return () => { listeners.delete(heard); };
  }, []);
  const source = shared().source;
  const held = thing && source ? source.peek(thing) : null;
  React.useEffect(() => {
    if (!open || !thing || !source || held || read?.key === key) return;
    let live = true;
    source.rows(thing).then(rows => { if (live) setRead({ key, rows }); }, () => { if (live) setRead({ key, rows: [] }); });
    return () => { live = false; };
  }, [open, key, source, held, read?.key]);
  if (!thing || !source) return [];
  return held ?? (read?.key === key ? read.rows : []);
}

/** The same rows as the shared drill-down menu's rows (parts/ui/show/drill-menu), for a menu drawn with it: a row
 *  holding rows opens them as its own level, a row with a panel opens the panel as a level, each group its own section. */
export function drillRowsOf(rows: readonly ActionMenuItem[], close: () => void): DrillRow[] {
  return rows.map((row): DrillRow => {
    const icon = typeof row.icon === 'string' ? row.icon : 'Sparkles';
    if (row.panel) return { id: row.id, label: row.label, icon, next: { id: row.id, title: row.label, width: 'panel', sections: [{ id: row.id, panel: row.panel(close) }] } };
    if (row.items) return { id: row.id, label: row.label, icon, next: { id: row.id, title: row.label, sections: drillSectionsOf(row.items, close) } };
    return { id: row.id, label: row.label, icon, ...(row.hint ? { hint: row.hint } : {}), ...(row.disabled ? { disabled: true } : {}) };
  });
}

/** Rows as drill-down sections, a new section wherever their group changes. */
export function drillSectionsOf(rows: readonly ActionMenuItem[], close: () => void): DrillSection[] {
  const sections: { id: string; rows: ActionMenuItem[] }[] = [];
  for (const row of rows) {
    const last = sections[sections.length - 1];
    if (last && last.id === (row.group ?? '')) last.rows.push(row);
    else sections.push({ id: row.group ?? '', rows: [row] });
  }
  return sections.map((section, index) => ({ id: section.id || `rows-${index}`, rows: drillRowsOf(section.rows, close) }));
}
