// packages/media-composition/show/components/MediaTimeline.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Renders a MaterializedComposition as an interactive timeline editor.
// Each MaterializedLane becomes a labeled track row; each MaterializedClip is
// positioned and sized proportionally by real geometry (laneStart/laneEnd vs
// lane.duration). A single Playhead overlays all tracks and moves with
// playheadPct. Clicking a track area seeks to that clip's laneStart.
//
// NON-NEGOTIABLE INVARIANTS
//
//   1. NO raw HTML elements, className strings, or inline-style objects in this
//      file — all layout uses Container/Card/Text/ClipBlock/Playhead/TimeRuler.
//   2. Clip geometry is derived purely from MaterializedClip timing fields:
//      widthPct = (laneEnd - laneStart) / max(lane.duration, ε) × 100.
//   3. The Playhead is a SINGLE element overlaid across the tracks region via a
//      relative-positioned Container wrapper.
//   4. PINNED PROPS: this component accepts exactly MediaTimelineProps and no
//      other external shape.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';

import type { MaterializedComposition, MaterializedLane, MaterializedClip } from '../../read-data/compose-timeline';
import { Card } from '../../../ui/show/card';
import { ClipBlock } from '../../../ui/show/clip-block';
import { Container } from '../../../ui/show/container';
import { Playhead } from '../../../ui/show/playhead';
import { Text } from '../../../ui/show/text';
import { TimeRuler } from '../../../ui/show/time-ruler';

import { type MediaClipTone } from './MediaClip';

// ── Public API ────────────────────────────────────────────────────────────────

export type MediaTimelineProps = {
  composition: MaterializedComposition;
  playheadPct: number;
  selectedClipId: string | null;
  controls?: React.ReactNode;
  /**
   * Real decoded peaks keyed by source ID. Passed down to each ClipBlock so
   * clips whose source has been decoded show the true waveform; others fall
   * back to the deterministic synthetic shape automatically.
   */
  peaksBySource?: Record<string, number[]>;
  onSeek: (laneTimeSeconds: number) => void;
  onSelectClip: (clipId: string) => void;
  onSplit: () => void;
  onTrim: (clipId: string, inPoint: number, outPoint: number) => void;
  onMove: (clipId: string, laneStart: number, laneRole: string) => void;
  onDelete: (clipId: string) => void;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimum denominator guard — avoids divide-by-zero on empty lanes. */
const EPSILON = 0.001;

/** Known render tones — a fixed palette primitive, NOT domain vocabulary. */
const KNOWN_TONES: readonly MediaClipTone[] = ['source', 'audio', 'motion', 'analysis', 'identity', 'output'];

/**
 * The timeline is a BLIND renderer: it paints the tone the DATA resolved for the lane
 * (compose-timeline owns the role→tone mapping at the translation boundary). It never
 * re-derives tone from role keywords, so a lane of any configured role renders correctly;
 * an unrecognized value falls back to the neutral slot. (Physics vs Society / L039.)
 */
function laneTone(lane: MaterializedLane): MediaClipTone {
  return (KNOWN_TONES as readonly string[]).includes(lane.tone)
    ? (lane.tone as MediaClipTone)
    : 'source';
}

/**
 * A lane shows a waveform when it actually carries signal data — proven by resolved peaks,
 * never inferred from a role name like "audio".
 */
function laneHasSignal(lane: MaterializedLane, peaksBySource?: Record<string, number[]>): boolean {
  if (!peaksBySource) return false;
  return lane.clips.some((clip) => (peaksBySource[clip.sourceId]?.length ?? 0) > 0);
}

/** Width of a clip as a percentage of the lane duration. Floor at 1% so zero-duration clips remain visible. */
function clipWidthPct(clip: MaterializedClip, laneDuration: number): number {
  const denominator = Math.max(laneDuration, EPSILON);
  const span = Math.max(0, clip.laneEnd - clip.laneStart);
  return Math.max(1, (span / denominator) * 100);
}

/** Left offset of a clip as a percentage of the lane duration. */
function clipLeftPct(clip: MaterializedClip, laneDuration: number): number {
  const denominator = Math.max(laneDuration, EPSILON);
  return Math.min(100, Math.max(0, (clip.laneStart / denominator) * 100));
}

/** Generate evenly-spaced TimeRuler ticks from a total duration in seconds. */
function buildTicks(durationSeconds: number): { label: string }[] {
  const dur = Math.max(6, Math.ceil(durationSeconds));
  // Aim for 5 ticks (0, 25%, 50%, 75%, 100%)
  const count = 5;
  return Array.from({ length: count }, (_, i) => {
    const seconds = Math.round((dur / (count - 1)) * i);
    const m = Math.floor(seconds / 60);
    const s = String(seconds % 60).padStart(2, '0');
    return { label: `${m}:${s}` };
  });
}

// ── Lane label card ───────────────────────────────────────────────────────────

function LaneLabel({ lane, tone }: { lane: MaterializedLane; tone: MediaClipTone }) {
  return (
    <Card variant="nested" padding="sm" layout="stack">
      <Text variant="body-xs" weight="semibold" truncate>{lane.label}</Text>
      <Text variant="caption" color="faint">{lane.clips.length} clips</Text>
    </Card>
  );
}

// ── Track clips row (relative container for absolute Playhead) ────────────────

function TrackRow({
  lane,
  tone,
  selectedClipId,
  peaksBySource,
  onSelectClip,
  onSeek,
}: {
  lane: MaterializedLane;
  tone: MediaClipTone;
  selectedClipId: string | null;
  peaksBySource?: Record<string, number[]>;
  onSelectClip: (clipId: string) => void;
  onSeek: (t: number) => void;
}) {
  const waveform = laneHasSignal(lane, peaksBySource);

  if (lane.clips.length === 0) {
    return (
      <Card variant="ghost" padding="xs" layout="row">
        <Text variant="caption" color="faint">Empty track</Text>
      </Card>
    );
  }

  return (
    <Container layout="horizontal" gap="none" position="relative" width="full">
      {lane.clips.map((clip) => (
        <ClipBlock
          key={clip.clipId}
          label={clip.label}
          detail={`${clip.laneStart.toFixed(1)}s`}
          tone={tone}
          active={clip.clipId === selectedClipId}
          widthPct={clipWidthPct(clip, lane.duration)}
          showWaveform={waveform}
          seed={clip.clipId}
          peaks={peaksBySource?.[clip.sourceId]}
          onClick={() => {
            onSelectClip(clip.clipId);
            onSeek(clip.laneStart);
          }}
        />
      ))}
    </Container>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * MaterializedComposition timeline editor.
 *
 * Renders one labeled track row per lane, with clips sized and positioned by
 * real laneStart/laneEnd geometry. A single Playhead overlays the tracks region.
 *
 * @example
 * ```tsx
 * <MediaTimeline
 *   composition={composition}
 *   playheadPct={32}
 *   selectedClipId={null}
 *   onSeek={handleSeek}
 *   onSelectClip={handleSelect}
 *   onSplit={handleSplit}
 *   onTrim={handleTrim}
 *   onMove={handleMove}
 *   onDelete={handleDelete}
 * />
 * ```
 */
export function MediaTimeline({
  composition,
  playheadPct,
  selectedClipId,
  controls,
  peaksBySource,
  onSeek,
  onSelectClip,
}: MediaTimelineProps) {
  const ticks = buildTicks(composition.durationSeconds);

  return (
    <Container layout="vertical" gap="sm">

      {/* Header */}
      <Container layout="horizontal" justifyContent="between" alignItems="center" gap="md" wrap>
        <Text variant="heading">Timeline</Text>
        {controls}
      </Container>

      {/* Ruler */}
      <Container layout="horizontal" gap="md" alignItems="center">
        <Text variant="body-xs" color="faint">Tracks</Text>
        <Container layout="horizontal" flex="1">
          <TimeRuler ticks={ticks} />
        </Container>
      </Container>

      {/* Tracks — wrapped in a relative Container so the shared Playhead overlays correctly */}
      <Container layout="vertical" gap="xs" position="relative">

        {composition.lanes.map((lane) => {
          const tone = laneTone(lane);
          return (
            <Container key={lane.laneId} layout="horizontal" gap="md" alignItems="center">

              {/* Lane label — fixed-width identity column */}
              <LaneLabel lane={lane} tone={tone} />

              {/* Clips row — flex-1 fills the remaining width */}
              <Container layout="horizontal" flex="1" position="relative">
                <TrackRow
                  lane={lane}
                  tone={tone}
                  selectedClipId={selectedClipId}
                  peaksBySource={peaksBySource}
                  onSelectClip={onSelectClip}
                  onSeek={onSeek}
                />
              </Container>

            </Container>
          );
        })}

        {/* Single shared Playhead — absolutely positioned over the tracks region */}
        <Playhead positionPct={playheadPct} />

        {/* Empty state */}
        {composition.lanes.length === 0 && (
          <Container layout="vertical" gap="sm" alignItems="center">
            <Text variant="heading">Add media to build a timeline.</Text>
            <Text variant="body" color="faint">Add media or run analysis, then the tracks appear here.</Text>
          </Container>
        )}

      </Container>

    </Container>
  );
}
