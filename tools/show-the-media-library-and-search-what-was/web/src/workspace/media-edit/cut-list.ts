// src/workspace/media-edit/cut-list.ts
//
// The cut, as an ordered list of clips (stretches of source files), and every change a person makes to it: split at
// a moment, take a stretch out, put a stretch of a file in, move a clip. Plus the one reading of the cut the track
// lanes draw. Pure functions: each returns a new list and never changes the one it was given.
//
// Invariants
//   1. Times are of two kinds and never mixed: a clip's `start`/`end` are seconds inside its source file; "cut time"
//      is seconds into the finished video. Every function says which it takes.
//   2. A clip whose length is not known yet (`end: null`) plays for 0 seconds in cut time until it is measured; no
//      function invents a length for it.
//   3. Taking a stretch out keeps exactly what is left of each clip (range complement), and inserting a stretch of a
//      file refuses one that is already used, with the reason in plain words (read-data/range-complement.mjs).

import { insertSourceRange, moveSequenceItem, rangeComplement } from '../../../parts/media-composition/read-data/range-complement.mjs';
import type { MaterializedClip, MaterializedComposition, MaterializedLane } from '../../../parts/media-composition/read-data/compose-timeline';
import type { MediaEditCaption, MediaEditClip, MediaEditLayer } from './panel-types';
import tracks from './track-lanes.json' with { type: 'json' };

/** Shortest piece a change may leave behind, in seconds; anything shorter is dropped. */
export const SHORTEST_PIECE = 0.04;

const length = (clip: MediaEditClip) => clip.end === null ? 0 : Math.max(0, clip.end - clip.start);

/** Where each clip starts in cut time, and the whole cut's length. */
export function cutOffsets(clips: readonly MediaEditClip[]): { offsets: number[]; total: number } {
  const offsets: number[] = [];
  let total = 0;
  for (const clip of clips) { offsets.push(total); total += length(clip); }
  return { offsets, total };
}

/** The clip playing at `seconds` of cut time (the last one at the very end), with where it starts. */
export function clipAt(clips: readonly MediaEditClip[], seconds: number): { index: number; offset: number } | null {
  const { offsets, total } = cutOffsets(clips);
  if (!clips.length || !Number.isFinite(seconds) || seconds < 0 || seconds > total) return null;
  for (let index = 0; index < clips.length; index += 1) {
    if (seconds < offsets[index] + length(clips[index])) return { index, offset: offsets[index] };
  }
  return { index: clips.length - 1, offset: offsets[clips.length - 1] };
}

/** Two clips where one was, cut at `seconds` of cut time. Refuses a moment on an existing cut or too near one. */
export function splitAt(clips: readonly MediaEditClip[], seconds: number): { clips: MediaEditClip[]; selected: number } {
  const found = clipAt(clips, seconds);
  if (!found) throw new Error('Move the playhead inside a clip to split it.');
  const clip = clips[found.index];
  if (clip.end === null) throw new Error('This clip is still being measured. Try again in a moment.');
  const at = Math.round((clip.start + seconds - found.offset) * 1000) / 1000;
  if (at - clip.start < SHORTEST_PIECE || clip.end - at < SHORTEST_PIECE) throw new Error('Move the playhead away from the edge of the clip to split it.');
  return { clips: [...clips.slice(0, found.index), { ...clip, end: at }, { ...clip, start: at }, ...clips.slice(found.index + 1)], selected: found.index + 1 };
}

/** The cut with `from`..`to` of cut time taken out; whatever is left of each clip stays in order. */
export function removeRange(clips: readonly MediaEditClip[], from: number, to: number): MediaEditClip[] {
  const { offsets, total } = cutOffsets(clips);
  const start = Math.max(0, Math.min(from, to)), end = Math.min(total, Math.max(from, to));
  if (!(end - start >= SHORTEST_PIECE)) throw new Error('Choose a stretch to take out.');
  const next = clips.flatMap((clip, index) => {
    const span = length(clip);
    const cutFrom = Math.max(start, offsets[index]) - offsets[index], cutTo = Math.min(end, offsets[index] + span) - offsets[index];
    if (clip.end === null || span <= 0 || cutTo - cutFrom <= 0) return [clip];
    return rangeComplement([{ start: cutFrom, end: cutTo }], span)
      .filter(piece => piece.end - piece.start >= SHORTEST_PIECE)
      .map(piece => ({ ...clip, start: Math.round((clip.start + piece.start) * 1000) / 1000, end: Math.round((clip.start + piece.end) * 1000) / 1000 }));
  });
  if (!next.length) throw new Error('Taking out all of it would leave nothing to play. Keep at least a moment.');
  return next;
}

/** The cut with `range` (seconds inside `source`'s file) played as a new clip at position `at` in the order. */
export function insertRange(clips: readonly MediaEditClip[], source: MediaEditClip, range: { start: number; end: number }, at: number): MediaEditClip[] {
  const key = (clip: MediaEditClip) => clip.identity;
  const segments = clips.map(clip => ({ id: key(clip), start: clip.start, end: clip.end ?? clip.start, clip }));
  const placed = insertSourceRange(segments, key(source), { start: range.start, end: range.end }, Math.max(0, Math.min(at, clips.length)));
  return placed.map((segment: { id: string; start: number; end: number; clip?: MediaEditClip }) => segment.clip ?? { ...source, start: segment.start, end: segment.end });
}

/** The cut with clip `index` moved to the nearest boundary to `seconds` of cut time. */
export function moveTo(clips: readonly MediaEditClip[], index: number, seconds: number): { clips: MediaEditClip[]; selected: number } {
  if (clips.some(clip => clip.end === null)) throw new Error('Wait until every clip is measured to move clips.');
  const moved = moveSequenceItem(clips.map((clip, order) => ({ order, start: clip.start, end: clip.end as number })), index, Math.max(0, seconds));
  return { clips: moved.map((row: { order: number }) => clips[row.order]), selected: moved.findIndex((row: { order: number }) => row.order === index) };
}

/** A sound or picture a panel lays over the cut, with the panel that owns it, as the track lanes show it. */
export type CutLayer = MediaEditLayer & { panel: string };

type LaneKind = keyof typeof tracks.lanes;
const lane = (kind: LaneKind, clips: MaterializedClip[], duration: number): MaterializedLane => ({ laneId: kind, ...(tracks.lanes[kind] as Omit<MaterializedLane, 'laneId' | 'clips' | 'duration'>), clips, duration });
const piece = (clipId: string, sourceId: string, laneRole: string, label: string, inPoint: number, outPoint: number, laneStart: number, laneEnd: number): MaterializedClip =>
  ({ clipId, sourceId, laneRole, label, inPoint, outPoint, laneStart, laneEnd, transform: {} });

/** Clip ids the lanes use, read back by the editor when a lane reports a select, trim or move. */
export const laneClipId = {
  picture: (index: number) => `picture:${index}`,
  words: (id: string) => `words:${id}`,
  layer: (panel: string, id: string) => `layer:${panel}:${id}`,
};
export function readLaneClipId(clipId: string): { lane: 'picture'; index: number } | { lane: 'words'; id: string } | { lane: 'layer'; panel: string; id: string } | null {
  if (clipId.startsWith('layer:')) { const [panel, ...id] = clipId.slice('layer:'.length).split(':'); return { lane: 'layer', panel, id: id.join(':') }; }
  if (clipId.startsWith('picture:')) return { lane: 'picture', index: Number(clipId.slice('picture:'.length)) };
  if (clipId.startsWith('words:')) return { lane: 'words', id: clipId.slice('words:'.length) };
  return null;
}

/** The track lanes for the cut: its pictures in order, its captions and text on screen, and the sounds and pictures
 *  panels lay over it, each on the lane it names (track-lanes.json order), from its own start to where it stops. */
export function cutComposition(clips: readonly MediaEditClip[], words: readonly MediaEditCaption[], layers: readonly CutLayer[]): MaterializedComposition {
  const { offsets, total } = cutOffsets(clips);
  const duration = Math.max(total, 0.001);
  const lanes = [lane('picture', clips.map((clip, index) => piece(laneClipId.picture(index), clip.identity, tracks.lanes.picture.role, clip.name, clip.start, clip.end ?? clip.start, offsets[index], offsets[index] + length(clip))), duration)];
  const timed = words.filter(row => row.end > row.start && row.start < duration);
  if (timed.length) lanes.push(lane('words', timed.map(row => piece(laneClipId.words(row.id), row.id, tracks.lanes.words.role, row.text, row.start, Math.min(row.end, duration), row.start, Math.min(row.end, duration))), duration));
  for (const kind of Object.keys(tracks.lanes) as LaneKind[]) {
    const pieces = layers.filter(layer => layer.lane === kind && layer.start < duration).map(layer => {
      const plays = Math.min(layer.out === null ? Infinity : layer.out - layer.in, duration - layer.start);
      return piece(laneClipId.layer(layer.panel, layer.id), layer.identity, tracks.lanes[kind].role, layer.label, layer.in, layer.in + plays, layer.start, layer.start + plays);
    }).filter(row => row.laneEnd > row.laneStart);
    if (pieces.length) lanes.push(lane(kind, pieces, duration));
  }
  return { lanes, durationSeconds: duration, markers: [], globalTransform: {}, overlays: [] };
}
