// src/workspace/script-view.ts
//
// NO PRIOR: searched the Bitfield packages (packages/*/show) for 'script view', 'scriptView' and 'teleprompter mode';
// the Record and Record video screens are the only places a script is read aloud and neither kept a way of reading it
// before recording.json script_views.
//
// PURPOSE
//   The way the person reads a script on the teleprompter (recording.json script_views: in full, as its structure, as
//   its ideas), the same on every screen that shows a script and kept on this browser, so the choice made on one screen
//   is the one the next opens with.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The ways come from recording.json; nothing here names one. A kept choice that is no longer a row opens the first.
//   2. A browser that keeps nothing still switches; only the remembering is lost.

import * as React from 'react';
import { scriptViews } from './recording.mjs';

export type ScriptView = ReturnType<typeof scriptViews>[number];

const KEPT = 'trillion.record.script-view';

/** The ways a script can be read, the one chosen, and how to choose another. */
export function useScriptView(): { views: ScriptView[]; view: ScriptView; choose: (id: string) => void } {
  const views = React.useMemo(() => scriptViews(), []);
  const [id, setId] = React.useState(() => {
    const kept = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEPT);
    return views.some(view => view.id === kept) ? (kept as string) : views[0].id;
  });
  const choose = React.useCallback((next: string) => {
    setId(next);
    try { localStorage.setItem(KEPT, next); } catch { /* switching still works */ }
  }, []);
  return { views, view: views.find(view => view.id === id) ?? views[0], choose };
}
