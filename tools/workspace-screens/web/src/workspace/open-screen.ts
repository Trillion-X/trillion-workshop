// src/workspace/open-screen.ts
//
// PURPOSE
//   Opens another screen of this workspace (by its id, or by one of its addresses) the way the sidebar opens it (the arrangement answers the placeable-surface
//   event with the screen's row from surfaces.json), and names such an opening as a way forward a screen state offers.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A screen is named by its id in surfaces.json; nothing here lists screens.

import { PLACEABLE_SURFACE_MIME } from '../../parts/ui/show/placeable-surface-intent/placeable-surface-intent';
import type { StateAction } from '../../parts/ui/show/screen-state';
import { screenOfAddress } from './addresses.mjs';
import { answerTarget, readInputValue, useBitfieldData } from './records';
import surfaces from './screens.mjs';

/** One screen this person is offered, as its row reads (src/workspace/screens.mjs `surfaceOfScreenTool`). */
export type OfferedScreen = {
  id: string; label?: string; description?: string; icon?: string; listed?: boolean; sidebar_collection?: string;
  surface_input?: Record<string, unknown>; package_entry?: { package_name: string; entry_name: string };
  /** How the screen sits as a piece of a board of placed screens (a Home piece): `group` it is offered under there,
   *  whether the board frames it (`frame`, false for a screen that draws its own card) and the width it starts at. */
  [field: string]: unknown;
};

const SCREEN_LIST = { input: 'placeable-surface-list-by-address-label', params: { addressLabel: surfaces.address_label } };
const offeredFrom = (rows: unknown) => (Array.isArray(rows) && rows.length ? rows : surfaces.surfaces) as OfferedScreen[];

/** The screens this person is offered (the app's rows and every tool's own screen row), as the sidebar holds them; the
 *  app's rows alone before the workspace has started. */
export const offeredScreens = (): OfferedScreen[] => offeredFrom(readInputValue<unknown[]>(SCREEN_LIST));

/** The same list, read again in a React screen whenever it changes (a tool's screen added on another device). */
export const useOfferedScreens = (): OfferedScreen[] => offeredFrom(useBitfieldData<unknown[]>(SCREEN_LIST));
const offered = offeredScreens;

type Surface = { id: string; package_entry?: { entry_name?: string }; surface_input?: Record<string, unknown> };
/** The screen a pane holds: the offered screen with its entry whose own input the pane's input matches. */
export function surfaceOf(offered: Surface[], entry: string, input: Record<string, unknown>): string | null {
  // A screen's input values may be objects (an arrangement), handed over as copies, so they compare by what they hold;
  // when several rows share an entry, the one whose input says most about this one is it.
  const held = (value: unknown): unknown => (Array.isArray(value) ? value.map(held)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, held((value as Record<string, unknown>)[key])]))
    : value);
  const same = (left: unknown, right: unknown) => left === right || JSON.stringify(held(left)) === JSON.stringify(held(right));
  const matches = offered.filter(surface => surface.package_entry?.entry_name === entry
    && Object.entries(surface.surface_input ?? {}).every(([key, value]) => same(input[key], value)));
  const size = (surface: Surface) => Object.keys(surface.surface_input ?? {}).length;
  return matches.reduce<Surface | null>((best, surface) => (!best || size(surface) > size(best) ? surface : best), null)?.id ?? null;
}

/** The target a DATA-described effect opens a screen through (a tour button's `perform`: `{ target: OPEN_SCREEN_TARGET,
 *  operation: 'open', params: { id, input, title } }`), so a button that opens a list is DATA, never a new control. */
export const OPEN_SCREEN_TARGET = 'workspace.open-screen';
answerTarget(OPEN_SCREEN_TARGET, payload => {
  const { id, input, title } = (payload ?? {}) as { id?: unknown; input?: unknown; title?: unknown };
  if (typeof id !== 'string' || !offered().some(item => item.id === id)) return { opened: false };
  openScreenOn(id, input && typeof input === 'object' ? input as Record<string, unknown> : {}, typeof title === 'string' ? title : undefined);
  return { opened: true };
});

/** Opens the screen `id` in the arrangement. */
export function openScreen(id: string): void {
  window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { id } }));
}

/** The request that opens one stored file in its own tab (file-screen.tsx): `id` is its identity (or its path), with
 *  the name (a path or a file name) and media type the opener already knows, so the tab names the file and starts
 *  showing it before any read, and keeps its name when the person's files hold it under none. */
export function fileTab({ id, name, type, at, transcriptFileId, recordingOwner }: { id: string; name?: string | null; type?: string | null; at?: number; transcriptFileId?: string | null; recordingOwner?: { part: string; recorded_file_id: string; recorded_at?: string } }) {
  return {
    id: 'trillion.file',
    ...(name ? { title: name.slice(name.lastIndexOf('/') + 1) } : {}),
    surfaceInput: { id, ...(name ? { name } : {}), ...(type ? { type } : {}), ...(at && at > 0 ? { at } : {}), ...(transcriptFileId ? { transcriptFileId } : {}), ...(recordingOwner ? { recordingOwner } : {}) },
  };
}

/** Opens one stored file in its own tab (fileTab). */
export function openFile(file: Parameters<typeof fileTab>[0]): void {
  window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: fileTab(file) }));
}

/** Opens the screen `id` on one item: `input` is added to the screen's own input, and `title` names its tab. Any screen
 *  this person is offered opens so, a tool's own screen too (its row's id is the tool's id). */
export function openScreenOn(id: string, input: Record<string, unknown>, title?: string): void {
  const surface = offered().find(item => item.id === id);
  if (!surface) return;
  window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { ...surface, ...(title ? { title } : {}), surfaceInput: { ...surface.surface_input, ...input } } }));
}

/**
 * Opens the screen an address of this workspace names (`/decisions/<id>` opens that decision in its tab), as the sidebar
 * would; answers false, opening nothing, when the address is no screen of the workspace. `openPlacement` (a layer and
 * size) opens it as a window over the work instead of a tab.
 */
export function openAddress(address: string, openPlacement?: Record<string, unknown>): boolean {
  const url = new URL(address, location.origin);
  if (url.origin !== location.origin) return false;
  const routed = screenOfAddress(offered(), url.pathname, url.search) as { row: { id: string; surface_input?: Record<string, unknown> }; input: Record<string, string> | null } | null;
  if (!routed) return false;
  if (openPlacement) {
    // Asked for as a window over the work (a notification's Open): the arrangement places it in its overlay layer.
    window.dispatchEvent(new CustomEvent(PLACEABLE_SURFACE_MIME, { cancelable: true, detail: { ...routed.row, openPlacement, ...(routed.input ? { surfaceInput: { ...routed.row.surface_input, ...routed.input } } : {}) } }));
    return true;
  }
  if (routed.input) openScreenOn(routed.row.id, routed.input);
  else openScreen(routed.row.id);
  return true;
}

/** A way forward that opens the screen `id`: "Open Files". */
export const goTo = (label: string, id: string): StateAction => ({ label, run: () => openScreen(id) });
