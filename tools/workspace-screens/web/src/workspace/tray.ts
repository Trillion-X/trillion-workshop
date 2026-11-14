// src/workspace/tray.ts
//
// NO PRIOR: the tray's store and picker are shared parts (parts/ui/show/selection tray-store.ts, pick-things.ts); this
// file only wires them into this workspace.
//
// PURPOSE
//   Your tray in the signed-in workspace: one tray for the page, picking over every screen by the rules in tray.json,
//   and two entries in the one right-click menu (parts/ui/show/node-actions contributed-node-actions.ts): Add to tray
//   takes the thing under the pointer, Send… takes it and opens the tray to choose where it goes. A record view's
//   explicit bulk Add to tray action reads its selected IDs from the screen's records, including rows not drawn yet.
//
// NON-NEGOTIABLE INVARIANTS
//   1. What counts as a thing and every word are DATA (tray.json); a screen's name comes from the screens this person
//      is offered (surfaces.json), never from this file.
//   2. One tray per page, started once; the tray screen and the menu read the same store.
//   3. A picked thing opens on the screen it was picked on (`screenRowOf`), from the same offered screens.
//   4. A selected record carries its owner's share reference; the same record from two views has one tray key.

import { contributeNodeActions } from '../../parts/ui/show/node-actions';
import { installPicking, makeTrayStore, trayKeyOf, type PickRule, type SelectedRecordDrag, type TrayThing } from '../../parts/ui/show/selection';
import type { BulkAction } from '../../parts/ui/show/record-views/record-views';
import { notify } from '../../parts/ui/show/coss/notifications';
import { openScreen } from './open-screen';
import { controlShown } from '../../parts/ui/show/show-rules/show-of';
import settings from './tray.json';

/** The tray screen's row id in surfaces.json. */
export const TRAY_SCREEN = 'trillion.tray';

export const tray = makeTrayStore({ storageKey: settings.storage_key, limit: settings.limit });

/** Whether the person's show rules let them pick things into the tray and add to it (the control tray.json declares). */
const trayShown = (): boolean => controlShown(settings.control);

type Row = { id: string; label?: unknown; package_entry?: { entry_name?: unknown }; surface_input?: { screen?: unknown } };

let started = false;
// Each screen's row id by its entry, read from the screens this person is offered, so a picked thing can be opened
// where it was picked.
const screenRows = new Map<string, string>();
const screenNames = new Map<string, string>();
const recordRule = settings.pick.find(rule => rule.selector === '[data-record-id]');

function pickedRecord({ id, record, title, screen, context }: { id: string; record: string; title: string; screen?: string; context?: TrayThing['context'] }): TrayThing {
  const kind = recordRule?.kind ?? 'Row';
  const label = title.trim() || record;
  return {
    key: trayKeyOf({ kind, label, id, screen, share_record: record, context }),
    kind, label, id, share_record: record,
    ...(recordRule?.icon ? { icon: recordRule.icon } : {}),
    ...(screen ? { screen, ...(screenNames.get(screen) ? { screen_label: screenNames.get(screen) } : {}) } : {}),
    ...(globalThis.location?.pathname ? { address: globalThis.location.pathname } : {}),
    ...(context ? { context } : {}),
  };
}

/** A selected record drag and an explicit Add to tray use the same identity and metadata. */
export function addDraggedRecordsToTray(drag: SelectedRecordDrag): number {
  const context = drag.context && settings.contexts.kinds.includes(drag.context.kind) ? drag.context : undefined;
  const before = new Set(tray.read().things.map(thing => thing.key));
  const things = drag.records.map(({ id, record, title }) => pickedRecord({ id, record, title, screen: drag.screen, context }));
  tray.add(things);
  const after = new Set(tray.read().things.map(thing => thing.key));
  return things.filter(thing => !before.has(thing.key) && after.has(thing.key)).length;
}

/** The selected records in any list join the same tray as the page-wide click and box picker. */
export function addSelectedToTrayAction<T>(root: Element, rowOf: (id: string) => T | undefined, recordOf: (row: T) => string | null, titleOf: (row: T) => string | null): BulkAction {
  return {
    id: 'add-to-tray', label: settings.menu.add.label, icon: settings.menu.add.icon,
    appliesTo: (row: T) => trayShown() && Boolean(recordOf(row)),
    run: (ids: string[]) => {
      const pane = root.closest('[data-trillion-screen]');
      const screen = pane?.getAttribute('data-trillion-screen') ?? undefined;
      const place = root.closest(`[${settings.contexts.kindAttribute}]`);
      const placeKind = place?.getAttribute(settings.contexts.kindAttribute);
      const placeId = place?.getAttribute(settings.contexts.idAttribute);
      const context = placeKind && placeId && settings.contexts.kinds.includes(placeKind) ? { kind: placeKind, id: placeId } : undefined;
      const things: TrayThing[] = [];
      for (const id of ids) {
        const row = rowOf(id);
        const shareRecord = row && recordOf(row);
        if (!row || !shareRecord) continue;
        things.push(pickedRecord({ id, record: shareRecord, title: titleOf(row) ?? shareRecord, screen, context }));
      }
      if (!things.length) { notify(settings.words.nothing_here); return; }
      const before = new Set(tray.read().things.map(thing => thing.key));
      tray.add(things);
      const after = new Set(tray.read().things.map(thing => thing.key));
      const added = things.filter(thing => !before.has(thing.key) && after.has(thing.key)).length;
      notify(added ? settings.words.added : settings.words.already_added);
    },
  };
}

/** The row id of the screen whose entry is `screen`, when this person is offered it. */
export const screenRowOf = (screen: string | undefined): string | undefined => (screen ? screenRows.get(screen) : undefined);

/** Starts picking on this page and adds the tray's entries to the right-click menu. */
export function startTray(offered: readonly Row[]): void {
  if (started) return;
  started = true;
  const names = new Map<string, string>();
  for (const row of offered) {
    const screen = typeof row.surface_input?.screen === 'string' ? row.surface_input.screen : row.package_entry?.entry_name;
    if (typeof screen === 'string' && typeof row.label === 'string' && !names.has(screen)) { names.set(screen, row.label); screenNames.set(screen, row.label); screenRows.set(screen, row.id); }
  }
  const picking = installPicking({ store: tray, rules: settings.pick as PickRule[], ignore: settings.ignore, screenName: screen => names.get(screen), contexts: settings.contexts });
  const take = (): boolean => {
    const thing = picking.pointed();
    if (!thing) { notify(settings.words.nothing_here); return false; }
    tray.add([thing]);
    return true;
  };
  contributeNodeActions([
    { id: 'tray-add', label: settings.menu.add.label, icon: settings.menu.add.icon, priority: -2, accepts: trayShown, run: () => { if (take()) notify(settings.words.added); } },
    { id: 'tray-send', label: settings.menu.send.label, icon: settings.menu.send.icon, priority: -1, accepts: trayShown, run: () => { if (take()) openScreen(TRAY_SCREEN); } },
  ]);
}
