// packages/ui/show/playhead/Playhead.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Glowing playhead indicator for the DreamCut video editor timeline. A thin
// vertical line positioned at a percentage offset within a relative-positioned
// track, with a round handle at the top and a soft glow in the accent color.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. TOKENS ONLY: Color from --accent-primary (fallback --text-primary).
//    No hardcoded hex, no invented token names.
// 2. ABSOLUTE POSITIONED: The consumer must wrap this in a `relative` container.
//    Playhead spans the full height of that container.
// 3. POINTER-EVENTS-NONE: Never intercepts mouse/touch events — the track
//    layer handles all interaction.
// 4. POSITION: left is set via inline style from positionPct (0–100).
//    Never use CSS classes for dynamic numeric positions.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export interface PlayheadProps {
  /** Position as a percentage of the track width (0–100). */
  positionPct: number;
  /** Optional timecode shown in a rounded badge at the top of the line
   *  (ElevenLabs/CapCut style — e.g. "0:13"). Omit for a bare handle. */
  label?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Thin glowing vertical playhead. Absolutely positioned within a
 * `relative`-positioned track container. Spans full container height.
 *
 * Consumer is responsible for the relative wrapper and any drag interaction.
 *
 * @example
 * ```tsx
 * <div className="relative h-full">
 *   <TimeRuler ticks={ticks} />
 *   <Playhead positionPct={32.5} />
 * </div>
 * ```
 */
export function Playhead({ positionPct, label, className }: PlayheadProps) {
  const clamped = Math.max(0, Math.min(100, positionPct));

  return (
    <div
      className={cn('absolute top-0 bottom-0 pointer-events-none z-10', className)}
      style={{ left: `${clamped}%` }}
      aria-hidden="true"
    >
      {/* Timecode badge at the top — pinned to the line, nudged in at the edges */}
      {label && (
        <div
          style={{
            position: 'absolute',
            top: -2,
            left: '50%',
            transform: `translateX(${clamped > 92 ? '-100%' : clamped < 8 ? '0' : '-50%'})`,
            padding: '1px 6px',
            borderRadius: 5,
            backgroundColor: 'var(--accent-primary, var(--text-primary))',
            color: 'var(--text-on-accent, var(--bg-primary))',
            fontSize: 'var(--font-size-caption)',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.4,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            boxShadow: '0 1px 4px color-mix(in srgb, var(--accent-primary, var(--text-primary)) 45%, transparent)',
          }}
        >
          {label}
        </div>
      )}
      {/* Round handle at the top — hidden when a badge is shown */}
      {!label && (
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 10,
          height: 10,
          borderRadius: '50%',
          backgroundColor: 'var(--accent-primary, var(--text-primary))',
          boxShadow: '0 0 6px 2px color-mix(in srgb, var(--accent-primary, var(--text-primary)) 60%, transparent)',
        }}
      />
      )}
      {/* Vertical line with glow */}
      <div
        style={{
          position: 'absolute',
          top: 5,
          bottom: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 1.5,
          backgroundColor: 'var(--accent-primary, var(--text-primary))',
          boxShadow: '0 0 4px 1px color-mix(in srgb, var(--accent-primary, var(--text-primary)) 50%, transparent)',
        }}
      />
    </div>
  );
}
