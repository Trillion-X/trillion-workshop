// packages/media-composition/show/media-editor-session-store.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Shared CROSS-SURFACE editor-session state for the media editor.
//
// The media editor renders as an embedded screen-arrangement: each pane
// (Choose media, Preview media, Edit timeline, Change media, Choose tool) is a
// SEPARATE React mount of MediaCompositionPanel. Local `useState` therefore does
// NOT cross between panes, so selecting a source in one pane, playing in
// another, and scrubbing in a third would each be isolated.
//
// This module-singleton store (the same pattern as media-workspace-optimistic-
// store) is the ONE playback/selection clock every pane subscribes to, so:
//   * clicking a source in Choose media updates the Preview + inspector,
//   * pressing play in Preview advances the Edit-timeline playhead,
//   * scrubbing the Edit-timeline moves the Preview playback position.
//
// The Preview pane OWNS the real <video> element: it pushes the element's clock
// into `currentTime` while playing, and obeys `seekNonce`/`seekTarget` seek
// requests authored by any pane. Every other pane is a pure reader/writer of
// this store and none of them touch a media element.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Selector-based subscription: a pane that reads only `selectedSourceId`
//      does NOT re-render when `currentTime` ticks (getSnapshot returns the
//      selected primitive, so React bails on Object.is equality).
//   2. `requestSeek` is the ONLY way to move playback: it bumps `seekNonce` so
//      the video-owning pane can distinguish an explicit seek from a clock tick.
//   3. No React state, no I/O: a plain observable singleton.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

export type EditorSessionState = {
  /** The source currently open in the preview + inspector ('' = none). */
  selectedSourceId: string;
  /** Playhead position in seconds, the ONE clock every pane renders. */
  currentTime: number;
  /** Whether the preview media is playing. */
  isPlaying: boolean;
  /** Bumped on every explicit seek request so the video owner can react to it
   *  distinctly from a clock tick (a tick also updates currentTime). */
  seekNonce: number;
  /** The absolute time (seconds) the latest seek request asked for. */
  seekTarget: number;
};

let state: EditorSessionState = {
  selectedSourceId: '',
  currentTime: 0,
  isPlaying: false,
  seekNonce: 0,
  seekTarget: 0,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Set the open source. No-op (no emit) when unchanged. */
export function setSelectedSourceId(sourceId: string) {
  if (state.selectedSourceId === sourceId) return;
  state = { ...state, selectedSourceId: sourceId };
  emit();
}

/** Push the media element's clock (called by the video-owning pane on rAF). */
export function setCurrentTime(seconds: number) {
  if (state.currentTime === seconds) return;
  state = { ...state, currentTime: seconds };
  emit();
}

/** Set the play/pause flag. */
export function setPlaying(playing: boolean) {
  if (state.isPlaying === playing) return;
  state = { ...state, isPlaying: playing };
  emit();
}

/** Ask playback to move to `seconds`. Any pane may call it, and the video-owning
 *  pane observes `seekNonce` and applies it to the media element. It also moves
 *  the rendered playhead immediately so the UI is responsive before the seek
 *  lands on the element. */
export function requestSeek(seconds: number) {
  const target = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  state = { ...state, seekTarget: target, currentTime: target, seekNonce: state.seekNonce + 1 };
  emit();
}

/** Test/reset hook, clears the session back to defaults. */
export function resetEditorSessionForTests() {
  state = { selectedSourceId: '', currentTime: 0, isPlaying: false, seekNonce: 0, seekTarget: 0 };
  emit();
}

/**
 * Subscribe to a SLICE of the session. The selector must return a primitive (or
 * a stable reference) so React bails out via Object.is when the slice is
 * unchanged. That is what keeps Choose media from re-rendering on every clock
 * tick.
 *
 * @example const selectedSourceId = useEditorSession((s) => s.selectedSourceId);
 */
export function useEditorSession<T>(selector: (state: EditorSessionState) => T): T {
  const getSelected = React.useCallback(() => selector(state), [selector]);
  return React.useSyncExternalStore(subscribe, getSelected, getSelected);
}
