// src/workspace/sidebar-looks.ts
//
// NO PRIOR: the page's end of src/sidebar.mjs `change_sidebar` { do: "style" }, and of the `screen` show rules a
// person makes on Edit on canvas (src/workspace/canvas-edit.json, show-rules.json effect `change`).
//
// PURPOSE
//   Lays what the person changed on each screen over the app's rows, in one place every drawing of a screen reads (the
//   sidebar row, the pane tab, the command palette): the `sidebar-looks` record (by row id: `colour`, a palette hue,
//   and `place`, a region of the sidebar, as surface DATA `sidebar_colour` and `sidebar_place`), then the person's
//   `screen` change rules (a screen's name, icon or colour for this screen or every screen). A look or rule written
//   while the page is open shows without a reload, because the page records follow the store (records.ts) and show
//   rules announce their changes (show-of.ts).
//
// NON-NEGOTIABLE INVARIANTS
//   1. The app's rows stay as the app gave them; the person's changes are laid over a copy, field by field.
//   2. Nothing here names a row, a colour, a place or a field.
//   3. Whoever publishes the app's rows again (a pursuit added, a tool's screen arriving), the changes are laid over
//      them again: the published rows are compared by identity with the last rows laid here.

import { onShowChange, showChanged } from '../../parts/ui/show/show-rules/show-of';
import { readInputValue, readRecordAt, showRecords, subscribe } from './records';

type Row = Record<string, unknown> & { id: string };
type Look = { colour?: unknown; place?: unknown };

/** The show-rules subject a screen row is decided under (show-rules.json `subjects`). */
export const SCREEN_SUBJECT = 'screen';

/** Keep the screens record at `label` as `offered` with the person's looks and changes laid over it, now and as they change. */
export function keepSidebarLooks(offered: readonly Row[], label: string): () => void {
  let laid: Row[] | null = null;
  let looksSeen: unknown;
  let showRevision = 0;
  let laidRevision = -1;
  const lay = () => {
    const kept = readInputValue<Record<string, Look> | null>('sidebar-looks');
    if (laid && readRecordAt(label) === laid && kept === looksSeen && laidRevision === showRevision) return;
    looksSeen = kept;
    laidRevision = showRevision;
    const looks = kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
    laid = offered.map(row => {
      const look = looks[row.id];
      const styled = look ? {
        ...row,
        ...(typeof look.colour === 'string' ? { sidebar_colour: look.colour } : {}),
        ...(typeof look.place === 'string' ? { sidebar_place: look.place } : {}),
      } : row;
      return showChanged(SCREEN_SUBJECT, styled);
    });
    showRecords({ [label]: laid });
  };
  lay();
  const stopRecords = subscribe(lay);
  const stopShow = onShowChange(() => { showRevision += 1; lay(); });
  return () => { stopRecords(); stopShow(); };
}
