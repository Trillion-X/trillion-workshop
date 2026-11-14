// packages/media-composition/show/components/MediaPreviewStage.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Preview stage for the DreamCut media editor. Composes the media element
// (supplied as a ReactNode with videoRef already attached), an OverlayLayer
// containing live time-gated captions and text/PIP annotations, and a fully
// wired TransportBar with real play/pause + seek controls.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO raw HTML / className in this file — every element is a ui/ primitive.
//    MediaFrame is the ui/ layer and is the only place raw elements are allowed.
// 2. Transport controls are pure callbacks — no local playback state owned here.
// 3. Captions are time-gated: visible only when currentTime ∈ [start, end).
// 4. OverlayLayer is pointer-events-none; overlays never intercept media input.
// 5. mmss() is pure — no Date, no side-effects, no I/O.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { Play, Pause, SkipBack, SkipForward } from 'lucide-react';

import type { ClipTransform } from '../../read-data/compose-timeline';
import type { MediaWorkspaceSource } from '../../read-data/read-media-workspace';

import { Badge } from '../../../ui/show/badge';
import { Button } from '../../../ui/show/button';
import { CaptionOverlay } from '../../../ui/show/caption-overlay';
import { Card } from '../../../ui/show/card';
import { Container } from '../../../ui/show/container';
import { OverlayLayer } from '../../../ui/show/overlay-layer';
import { Text } from '../../../ui/show/text';
import { TextOverlay } from '../../../ui/show/text-overlay';
import { TransportBar } from '../../../ui/show/transport-bar';

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Format seconds as m:ss (e.g. 75 → "1:15"). Pure, deterministic, no I/O.
 * Returns "0:00" for NaN / negative inputs.
 */
function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export type MediaPreviewStageProps = {
  // ── existing props (unchanged) ────────────────────────────────────────────
  selectedSource?: MediaWorkspaceSource;
  selectedSourceDetail?: string;
  modeLabel?: string;
  toolLabel?: string;

  // ── transport ─────────────────────────────────────────────────────────────
  /** Ref to the underlying <video> element — attached by the panel, forwarded into preview. */
  videoRef: React.RefObject<HTMLVideoElement>;
  /** Live visual transform from the inspector panel. */
  liveTransform: ClipTransform;
  /** Whether the media is currently playing. */
  isPlaying: boolean;
  /** Current playhead position in seconds. */
  currentTime: number;
  /** Total duration in seconds. */
  duration: number;
  /** Toggle between play and pause. */
  onPlayPause: () => void;
  /** Seek to an absolute time in seconds. */
  onSeek: (t: number) => void;

  // ── overlays ──────────────────────────────────────────────────────────────
  /** Caption cues — each visible only when currentTime ∈ [start, end). */
  captions: { text: string; start: number; end: number }[];
  /**
   * Freeform overlay annotations.
   * type 'text' — renders a TextOverlay at (x, y) percent.
   * type 'pip'  — renders a TextOverlay label at (x, y) percent (PIP video TBD).
   */
  overlays: {
    type: 'text' | 'pip';
    text?: string;
    x?: number;
    y?: number;
    visible?: boolean;
  }[];

  // ── media element ─────────────────────────────────────────────────────────
  /** The media element (videoRef + liveTransform already wired in the panel). */
  preview: React.ReactNode;
};

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Cinematic preview stage for DreamCut.
 *
 * Renders the header row, the media preview composited with a live OverlayLayer,
 * and a TransportBar with play/pause and ±5s seek controls.
 *
 * @example
 * ```tsx
 * <MediaPreviewStage
 *   videoRef={videoRef}
 *   liveTransform={transform}
 *   isPlaying={playing}
 *   currentTime={time}
 *   duration={duration}
 *   onPlayPause={togglePlay}
 *   onSeek={seekTo}
 *   captions={[{ text: 'Chapter 1', start: 2, end: 6 }]}
 *   overlays={[{ type: 'text', text: 'Intro', x: 10, y: 10 }]}
 *   preview={
 *     <MediaFrame url={url} mediaType="video/mp4" label="clip.mp4"
 *                 videoRef={videoRef} transform={transform} />
 *   }
 * />
 * ```
 */
export function MediaPreviewStage({
  selectedSource,
  selectedSourceDetail,
  modeLabel,
  toolLabel,
  videoRef: _videoRef,
  liveTransform: _liveTransform,
  isPlaying,
  currentTime,
  duration,
  onPlayPause,
  onSeek,
  captions,
  overlays,
  preview,
}: MediaPreviewStageProps) {
  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <Card variant="surface" padding="md" layout="stack" flex={1} height="full" minHeight="0">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <Container
        layout="horizontal"
        justifyContent="between"
        alignItems="center"
        gap="md"
      >
        <Container layout="vertical" gap="xs">
          <Text variant="heading">Preview</Text>
          <Text variant="body-xs" color="faint">
            {selectedSource ? selectedSource.label : 'Waiting for a file'}
          </Text>
        </Container>

        <Container layout="horizontal" gap="sm" alignItems="center" wrap>
          {toolLabel ? (
            <Badge variant="neutral" size="sm">{toolLabel}</Badge>
          ) : null}
          {modeLabel ? (
            <Badge variant="accent" size="sm">{modeLabel}</Badge>
          ) : null}
          <Badge variant={selectedSource ? 'success' : 'neutral'} size="sm">
            {selectedSource ? (selectedSource.media_type.split('/')[0] === 'audio' ? 'Audio' : selectedSource.media_type.split('/')[0] === 'video' ? 'Video' : selectedSource.media_type.split('/')[0] === 'image' ? 'Image' : 'Media') : 'No media'}
          </Badge>
        </Container>
      </Container>

      {/* ── Preview + overlay compositing ───────────────────────────────── */}
      {/*
        position="relative" so OverlayLayer (absolute inset-0) fills exactly
        the preview bounds without overflowing into the header or transport.
      */}
      <Container
        layout="vertical"
        alignItems="center"
        justifyContent="center"
        flex={1}
        minHeight="0"
        width="full"
        position="relative"
      >
        {preview}

        <OverlayLayer>
          {captions.map((c, i) => (
            <CaptionOverlay
              key={i}
              text={c.text}
              position="bottom"
              visible={currentTime >= c.start && currentTime < c.end}
            />
          ))}

          {overlays.map((o, i) => (
            <TextOverlay
              key={i}
              text={o.text ?? ''}
              x={o.x}
              y={o.y}
              visible={o.visible !== false}
            />
          ))}
        </OverlayLayer>
      </Container>

      {/* ── Transport bar ────────────────────────────────────────────────── */}
      {/*
        TransportBar.children replaces the default static play-icon circle.
        We supply SkipBack / Play-Pause / SkipForward buttons wired to callbacks.
        The scrubber fill and thumb are driven by progressPct (live numeric).
        TransportBar has no onScrub prop, so ±5s buttons provide seek affordance.
      */}
      <TransportBar
        currentLabel={mmss(currentTime)}
        totalLabel={duration > 0 ? mmss(duration) : (selectedSourceDetail ?? 'Pick media on the left')}
        progressPct={progressPct}
        zoomLabel="100%"
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label="Seek back 5 seconds"
          onClick={() => onSeek(Math.max(0, currentTime - 5))}
        >
          <SkipBack size={14} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          aria-label={isPlaying ? 'Pause' : 'Play'}
          onClick={onPlayPause}
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          aria-label="Seek forward 5 seconds"
          onClick={() => onSeek(Math.min(duration, currentTime + 5))}
        >
          <SkipForward size={14} />
        </Button>
      </TransportBar>

    </Card>
  );
}
