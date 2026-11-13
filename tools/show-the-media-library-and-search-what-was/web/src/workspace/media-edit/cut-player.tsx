// src/workspace/media-edit/cut-player.tsx
//
// The editor's one player: the whole cut played straight from its original files (with the sounds and pictures panels
// lay over it, a picture dragged or resized in place, and what the panels add, such as captions in their style), or only
// the selected clip. Nothing is rendered to preview; the shared live player (parts/ui LiveCompositionPreview) plays
// each clip's stretch in order.
//
// Invariants
//   1. The playhead it reports is always in cut time, whichever it plays, so the lanes and the panels read one clock.
//   2. A clip still being measured is left out until its length is known.
//   3. Composed only from shared parts (Container, Text, SegmentedControl, LiveCompositionPreview).

import React from 'react';
import { Container, SegmentedControl, Text } from '../../../parts/ui';
import { LiveCompositionPreview } from '../../../parts/ui/show/selection/LiveCompositionPreview';
import type { MediaEditClip, MediaEditLayerChange } from './panel-types';
import type { CutLayer } from './cut-list';

export type CutPlayerScope = 'cut' | 'clip';

type Props = {
  clips: readonly MediaEditClip[];
  selected: number;
  /** Where the selected clip starts in cut time. */
  selectedStart: number;
  dimensions: [number, number];
  /** Sounds and pictures laid over the cut; heard and seen when the whole cut plays. */
  layers: readonly CutLayer[];
  /** A picture was dragged or resized in the preview. */
  onLayerChange: (layer: CutLayer, change: MediaEditLayerChange) => void;
  scope: CutPlayerScope;
  onScope: (scope: CutPlayerScope) => void;
  /** Cut time the player is at. */
  onTime: (seconds: number) => void;
  /** Ask the player to jump to a moment of cut time. */
  seek: { seconds: number; requestId: number } | null;
  /** What the editor's panels add to what the player draws (captions in their style), in cut time. */
  additions?: Record<string, unknown>;
};

const SCOPES = [{ id: 'cut', label: 'Whole cut' }, { id: 'clip', label: 'Selected clip' }];

export function CutPlayer({ clips, selected, selectedStart, dimensions, layers, onLayerChange, scope, onScope, onTime, seek, additions }: Props) {
  const [chosenPicture, setChosenPicture] = React.useState<number | null>(null);
  const laid = scope === 'cut' ? layers : [];
  const pictures = laid.filter(layer => layer.plays === 'picture');
  const layersKey = JSON.stringify(laid.map(({ id, identity, bytes, start, in: from, out, volume, x, y, scale, opacity }) => [id, identity, bytes, start, from, out, volume, x, y, scale, opacity]));
  const shown = scope === 'clip' ? clips.slice(selected, selected + 1) : clips;
  const offset = scope === 'clip' ? selectedStart : 0;
  const measured = shown.filter(clip => clip.end !== null);
  const key = measured.map(clip => `${clip.identity}:${clip.start}:${clip.end}`).join('|');
  const sourcesKey = clips.map(clip => `${clip.identity}:${clip.bytes}`).join('|');
  const composition = React.useMemo(() => ({
    width: dimensions[0],
    height: dimensions[1],
    segments: measured.map(clip => ({ id: clip.identity, start: clip.start, end: clip.end as number })),
    sources: Object.fromEntries([
      ...clips.map(clip => [clip.identity, { preview_url: clip.bytes, media_kind: clip.mediaKind || 'video' }]),
      ...laid.map(layer => [layer.identity, { preview_url: layer.bytes, media_kind: layer.mediaKind }]),
    ]),
    audio: laid.filter(layer => layer.plays === 'sound').map(layer => ({ id: layer.identity, start: layer.start, in: layer.in, out: layer.out, volume: layer.volume ?? 1 })),
    visuals: pictures.map(layer => ({ id: layer.identity, start: layer.start, in: layer.in, out: layer.out ?? layer.in, x: layer.x ?? 0.5, y: layer.y ?? 0.5, scale: layer.scale ?? 0.3, opacity: layer.opacity ?? 1 })),
    selectedVisual: chosenPicture,
    onVisualSelect: setChosenPicture,
    onVisualMove: (index: number, change: MediaEditLayerChange) => { const layer = pictures[index]; if (layer) onLayerChange(layer, change); },
    // Panel additions are in cut time; the selected clip alone plays from its own start, so they wait for the whole cut.
    ...(scope === 'cut' ? additions : {}),
  }), [key, sourcesKey, dimensions[0], dimensions[1], layersKey, chosenPicture, scope, additions]);
  const request = React.useMemo(() => seek ? { seconds: Math.max(0, seek.seconds - offset), requestId: seek.requestId } : null, [seek?.requestId, offset]);
  return <Container as="section" aria-label="Preview" data-media-edit-panel="preview" layout="vertical" gap="sm" minWidth="0">
    <Container layout="horizontal" justifyContent="end">
      <SegmentedControl ariaLabel="What the player plays" value={scope} onValueChange={value => onScope(value as CutPlayerScope)} items={SCOPES} />
    </Container>
    {measured.length
      ? <LiveCompositionPreview key={scope} composition={composition} seekRequest={request} onTimeChange={(seconds: number) => onTime(offset + seconds)} />
      : <Container padding="xl" role="status"><Text variant="body" color="muted">Reading how long each clip is…</Text></Container>}
  </Container>;
}
