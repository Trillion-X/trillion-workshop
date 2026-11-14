// packages/ui/show/transport-bar/TransportBar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Premium video transport row for DreamCut-style cinematic editors. Renders a
// circular play-affordance slot, a scrubber track with a draggable-looking
// thumb, time readouts, and a zoom chip. Purely presentational — no real
// playback logic.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ALL colors use CSS vars from ApplyCurrentScreenLook token set
// 2. progressPct drives width via inline style only (dynamic numeric value)
// 3. No real media events — visual affordance only
// 4. children slot replaces the default play-icon circle when provided
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Play } from 'lucide-react';
import { cn } from '../cn';
import { Icon } from '../icon/Icon';
import { RangeInput } from '../range-input';

// ---------------------------------------------------------------------------
// PROPS
// ---------------------------------------------------------------------------

export interface TransportBarProps {
  /** Timecode shown left of the scrubber (e.g. "0:42") */
  currentLabel?: string;
  /** Total duration shown right of the scrubber (e.g. "3:18") */
  totalLabel?: string;
  /** Scrubber fill 0–100 */
  progressPct?: number;
  /** Current media time in seconds. Required with durationSeconds/onSeek to make the track interactive. */
  currentTimeSeconds?: number;
  /** Media duration in seconds. */
  durationSeconds?: number;
  /** Seek the playing media to an absolute time in seconds. */
  onSeek?: (seconds: number) => void;
  /** Zoom level chip label (e.g. "100%") */
  zoomLabel?: string;
  /** Replaces the default play-icon circle when provided */
  children?: React.ReactNode;
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Cinematic transport bar for video editors.
 *
 * @example
 * ```tsx
 * <TransportBar
 *   currentLabel="0:42"
 *   totalLabel="3:18"
 *   progressPct={21}
 *   zoomLabel="100%"
 * />
 * ```
 */
export function TransportBar({
  currentLabel = '0:00',
  totalLabel = '0:00',
  progressPct = 0,
  currentTimeSeconds = 0,
  durationSeconds = 0,
  onSeek,
  zoomLabel,
  children,
  className,
}: TransportBarProps) {
  const clampedPct = Math.max(0, Math.min(100, progressPct));
  const canSeek = Boolean(onSeek && Number.isFinite(durationSeconds) && durationSeconds > 0);

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-3 py-2',
        'rounded-xl',
        'bg-[var(--glass-bg-subtle)] border border-[var(--border-primary)]',
        'backdrop-blur-md',
        className,
      )}
    >
      {/* Play affordance slot */}
      <div
        className={cn(
          'flex items-center justify-center shrink-0',
          'w-9 h-9 rounded-full',
          'bg-[var(--glass-bg-hover)] border border-[var(--border-primary)]',
        )}
      >
        {children ?? (
          <Icon icon={Play} size="md" color="white" />
        )}
      </div>

      {/* Time: current */}
      <span
        className="shrink-0 text-xs tabular-nums text-[var(--text-muted)] select-none"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {currentLabel}
      </span>

      {/* Scrubber track */}
      <div className="relative flex-1 h-1.5 rounded-full bg-[var(--glass-bg-hover)] overflow-visible focus-within:ring-1 focus-within:ring-[var(--border-focus)]">
        {/* Filled portion */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent-primary)]"
          style={{ width: `${clampedPct}%` }}
        />
        {/* Thumb */}
        <div
          className={cn(
            'absolute top-1/2 -translate-y-1/2 -translate-x-1/2',
            'w-3 h-3 rounded-full',
            'bg-[var(--text-primary)] border-2 border-[var(--accent-primary)]',
            'shadow-[0_0_6px_var(--accent-primary)]',
          )}
          style={{ left: `${clampedPct}%` }}
        />
        {canSeek && onSeek ? (
          <RangeInput
            aria-label="Seek video"
            value={Math.max(0, Math.min(durationSeconds, currentTimeSeconds))}
            min={0}
            max={durationSeconds}
            step={1}
            onValueChange={onSeek}
            width="100%"
            className="absolute left-0 top-1/2 z-10 h-8 min-w-0 -translate-y-1/2 opacity-0"
            data-testid="transport-scrubber"
          />
        ) : null}
      </div>

      {/* Time: total */}
      <span
        className="shrink-0 text-xs tabular-nums text-[var(--text-muted)] select-none"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {totalLabel}
      </span>

      {/* Zoom chip */}
      {zoomLabel && (
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums select-none px-2 py-0.5 rounded-md',
            'bg-[var(--glass-bg-active)] border border-[var(--border-secondary)]',
            'text-[var(--text-secondary)]',
          )}
        >
          {zoomLabel}
        </span>
      )}
    </div>
  );
}
