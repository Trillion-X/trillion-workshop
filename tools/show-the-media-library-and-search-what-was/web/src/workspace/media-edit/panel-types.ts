// src/workspace/media-edit/panel-types.ts
//
// The contract every media editor side panel implements. A panel is one row in
// `panels.ts`; the editor renders it in the side panel area, hands it the
// current cut, and merges what it adds into the saved and rendered edit.
//
// Invariants
//   1. A panel never reaches into editor internals. It reads `MediaEditPanelProps`
//      and changes the cut only through `change`, and its own saved choices only
//      through `setPanelState`.
//   2. A panel's own saved choices live under its id in the saved edit
//      (`edit.panels[id]`), so adding a panel never edits the save format.
//   3. What a panel adds to the rendered video comes from its pure `edl` and
//      `segment` functions; the editor merges them, the panel never renders.

import type React from 'react';

/** One clip in the cut, in order. `start`/`end` are seconds inside the source. */
export type MediaEditClip = {
  identity: string;
  name: string;
  start: number;
  end: number | null;
  bytes: string;
  mediaType: string;
  mediaKind: string;
  lookStack?: string;
};

/** One caption on the whole cut's time. `x`/`y` (fractions of the frame) place it; without them it sits where its
 *  style puts captions. `words` are its spoken words' own times, kept while they still spell its text. */
export type MediaEditCaption = { id: string; text: string; start: number; end: number; x?: number; y?: number; words?: { text: string; start: number; end: number }[] };

/** What the editor knows right now, handed to every panel. */
export type MediaEditPanelContext = {
  editId: string;
  title: string;
  clips: MediaEditClip[];
  selected: number;
  active: MediaEditClip | undefined;
  /** Seconds where the selected clip starts and ends in the whole cut. */
  timelineStart: number;
  activeTimelineEnd: number;
  /** Length of the whole cut in seconds. */
  total: number;
  /** Seconds into the whole cut where the playhead sits. */
  playhead: number;
  ratio: string;
  dimensions: [number, number];
  captions: MediaEditCaption[];
};

export type MediaEditPanelProps<State = unknown> = MediaEditPanelContext & {
  /** Replace the cut (undoable). `choice` selects a clip afterwards. */
  change: (next: MediaEditClip[], choice?: number) => void;
  select: (index: number) => void;
  seek: (seconds: number) => void;
  setCaptions: (next: MediaEditCaption[]) => void;
  setStatus: (text: string) => void;
  /** This panel's own saved choices (undefined until it first sets them). */
  panelState: State | undefined;
  setPanelState: (next: State | undefined) => void;
};

/** A sound under the cut or a picture over it that a panel lays down, as the preview plays it and the timeline shows
 *  it. `start` is cut time; `in`/`out` are seconds inside the file (`out` null: to its end). A picture's `x`,`y` are
 *  where its centre sits and `scale` its width, all as shares of the frame. `lane` names a row of track-lanes.json. */
export type MediaEditLayer = {
  id: string; lane: string; label: string; identity: string; bytes: string; mediaKind: string;
  plays: 'sound' | 'picture'; start: number; in: number; out: number | null;
  volume?: number; x?: number; y?: number; scale?: number; opacity?: number;
};
/** A change to one laid-down layer, from the timeline (times) or from dragging it in the preview (place). */
export type MediaEditLayerChange = { start?: number; in?: number; out?: number; x?: number; y?: number; scale?: number };

export type MediaEditPanel<State = unknown> = {
  /** Stable id; also the key its choices are saved under. */
  id: string;
  label: string;
  /** lucide icon name, as ExpandableTabs expects. */
  icon: string;
  Panel: React.ComponentType<MediaEditPanelProps<State>>;
  /** Top-level additions to the rendered edit, given the edit so far (the editor's own plus earlier panels'), so a
   *  panel adds to a list another already started instead of replacing it. */
  edl?: (state: State | undefined, context: MediaEditPanelContext, edit: Record<string, unknown>) => Record<string, unknown> | undefined;
  /** This panel's choices read from a saved edit that has none for it yet (an edit saved before the panel existed). */
  fromSavedEdit?: (edl: Record<string, unknown>) => State | undefined;
  /** What this panel adds to the player's composition (parts/ui LiveCompositionPreview), such as captions drawn in
   *  their style, so the preview shows the panel's choices the moment they change. */
  preview?: (state: State | undefined, context: MediaEditPanelContext) => Record<string, unknown> | undefined;
  /** The sounds and pictures this panel lays over the cut, for the preview and the timeline. */
  layers?: (state: State | undefined, context: MediaEditPanelContext) => MediaEditLayer[];
  /** This panel's choices after one of its layers was retimed on the timeline or moved in the preview. */
  changeLayer?: (state: State | undefined, id: string, change: MediaEditLayerChange) => State | undefined;
  /** Per-clip additions to each rendered segment. */
  segment?: (state: State | undefined, clip: MediaEditClip, index: number, context: MediaEditPanelContext) => Record<string, unknown> | undefined;
};

/** Keeps a panel row's State type at its definition without casts at the call site. */
export function definePanel<State>(panel: MediaEditPanel<State>): MediaEditPanel {
  return panel as unknown as MediaEditPanel;
}
