// packages/file-editor/show/create-file-editor-search-panel.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Bridges CodeMirror's search panel slot to our React find/replace widget. The
// `search()` extension accepts `createPanel: (view) => Panel`; this factory
// supplies a Panel whose `dom` is a bare mount node into which we render
// FileEditorSearchPanel via mountReactSurface. CodeMirror therefore renders NONE
// of its native `.cm-search` DOM — the entire visible widget is tools/ui.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This file is pure glue — zero styling, zero search logic. The mount `dom`
//    is an empty <div> (a mount point, not painted UI); all chrome lives in the
//    React widget + the kept `.cm-panels` theme rule.
// 2. CodeMirror ViewUpdates are fanned out to the React widget through a small
//    listener set so the live match count can refresh; `destroy` unmounts React
//    and clears listeners (no leak).
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';
import { mountReactSurface, type ReactSurfaceUnmount } from '../../ui/index.ts';
import { FileEditorSearchPanel } from './FileEditorSearchPanel.tsx';

/**
 * Panel factory passed to `search({ createPanel })`. Renders the React
 * find/replace widget into the panel's mount node and bridges CodeMirror update
 * events into it so the match count stays live.
 */
export function createFileEditorSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  const listeners = new Set<(update: ViewUpdate) => void>();
  let unmount: ReactSurfaceUnmount | null = null;

  const subscribeToUpdates = (listener: (update: ViewUpdate) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    dom,
    top: true,
    mount() {
      unmount = mountReactSurface(
        dom,
        React.createElement(FileEditorSearchPanel, { view, subscribeToUpdates }),
      );
    },
    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
      listeners.forEach((listener) => listener(update));
    },
    destroy() {
      unmount?.();
      unmount = null;
      listeners.clear();
    },
  };
}
