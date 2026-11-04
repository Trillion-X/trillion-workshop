// packages/sidebar/read-data/sidebar-settings.ts
//
// PURPOSE
// What a sidebar lets a person do, decided by DATA at three levels: the whole
// sidebar (the app's `sidebar_settings`), one list (its collection meta
// `settings`), and one row (the screen's `sidebar_settings`, or the list
// member's `settings`). A narrower level overrides a wider one, and a list
// inside a list inherits from the list that holds it, so a switch can be set
// once for everything or down to a single row.
//
// NON-NEGOTIABLE INVARIANTS
// 1. Settings are named true/false switches; anything else is ignored.
// 2. A switch no level names is on: a sidebar offers everything unless DATA
//    turns it off (a billing row that cannot be removed says so on its own row).
// 3. The switches this sidebar acts on are listed in SIDEBAR_SWITCHES; the
//    reader keeps every named switch, so an app can carry its own.
// 4. What the window's sidebar offers at a width is DATA too: width rows
//    (sidebar-settings-by-width.json) each turn switches on or off while the
//    window is narrower than the row's width, a narrower row winning. Code
//    never names a control next to a width.

/** Named switches, each on unless a level turns it off. */
export type SidebarSettings = Readonly<Record<string, boolean>>;

/** The switches the sidebar itself acts on. */
export const SIDEBAR_SWITCHES = {
  /** "Remove from this list" on a row. */
  removeFromList: 'remove_from_list',
  /** "Add to list" under a list. */
  addToList: 'add_to_list',
  /** Moving a row within its list by its handle. */
  reorder: 'reorder',
  /** Dragging a row out of its list into another list. */
  moveBetweenLists: 'move_between_lists',
  /** Unpinning a list into its own floating panel. */
  unpin: 'unpin',
  /** Letting a list hide until pointed at. */
  autoHide: 'auto_hide',
  // The window sidebar's own controls; `sidebar_capabilities` names the same keys.
  /** The Position control: docking the sidebar on the left, right, top or bottom. */
  position: 'position',
  /** Collapse / Expand. */
  collapse: 'collapse',
  /** Undock into a floating panel / Dock. */
  undock: 'undock',
  /** Show / Hide: the sidebar slides off its edge until pointed at. */
  hide: 'hide',
  /** Dragging the sidebar's edge to resize it. */
  resize: 'resize',
  /** Off: open or collapsed is kept on this screen only, it starts collapsed,
   * and choosing a screen collapses it again, so it never covers the work. */
  stayOpen: 'stay_open',
  /** Off: collapsed on a window edge it is only its handle, never a bar along the edge (on a seam it stays a bar). */
  rail: 'rail',
} as const;

/** Switches that apply while the window is narrower than `narrower_than_px`. */
export interface SidebarWidthRow {
  readonly narrower_than_px: number;
  readonly settings: SidebarSettings;
}

/** The well-formed width rows of a DATA value; a row without a width or settings is dropped. */
export function readSidebarWidthRows(value: unknown): SidebarWidthRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const width = (row as Record<string, unknown>).narrower_than_px;
    const settings = readSidebarSettings((row as Record<string, unknown>).settings);
    return typeof width === 'number' && width > 0 && settings ? [{ narrower_than_px: width, settings }] : [];
  });
}

/** The switches the width rows set at `width`: every row wider than it applies, the narrowest last so it wins. */
export function sidebarSettingsAtWidth(rows: readonly SidebarWidthRow[], width: number): SidebarSettings {
  return mergeSidebarSettings(...rows
    .filter((row) => width < row.narrower_than_px)
    .sort((a, b) => b.narrower_than_px - a.narrower_than_px)
    .map((row) => row.settings));
}

/** The true/false entries of a settings value, or undefined when it has none. */
export function readSidebarSettings(value: unknown): SidebarSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Wider level first; each later level overrides the ones before it. */
export function mergeSidebarSettings(...levels: ReadonlyArray<SidebarSettings | undefined>): SidebarSettings {
  return Object.assign({}, ...levels.filter(Boolean)) as SidebarSettings;
}

/** Whether a switch is on after the levels were merged. */
export function sidebarAllows(settings: SidebarSettings | undefined, key: string): boolean {
  return settings?.[key] !== false;
}
