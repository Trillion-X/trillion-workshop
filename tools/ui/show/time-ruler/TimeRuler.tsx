// packages/ui/show/time-ruler/TimeRuler.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Horizontal time ruler for the DreamCut video editor timeline. Renders evenly
// spaced tick marks with time labels across the full width of its container.
// Sits above track lanes as a fixed reference band.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. TOKENS ONLY: Colors from --text-muted (labels) and --border-secondary
//    (tick marks). No hardcoded hex, no invented token names.
// 2. EVEN SPACING: Ticks are distributed with CSS flex/space so the ruler
//    always spans 100% of its container regardless of tick count.
// 3. TABULAR NUMS: Labels use font-variant-numeric tabular-nums so time
//    values align cleanly as playback progresses.
// 4. THIN: The ruler has minimal visual weight — 11px labels, fine ticks.
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

export interface TimeRulerTick {
  label: string;
}

export interface TimeRulerProps {
  ticks: TimeRulerTick[];
  className?: string;
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Horizontal time ruler. Evenly spaces the provided tick labels across its
 * full width with fine tick marks below each. Place above timeline track lanes.
 *
 * @example
 * ```tsx
 * <TimeRuler ticks={[
 *   { label: '0:00' }, { label: '0:15' }, { label: '0:30' },
 *   { label: '0:45' }, { label: '1:00' },
 * ]} />
 * ```
 */
export function TimeRuler({ ticks, className }: TimeRulerProps) {
  return (
    <div
      className={cn('w-full select-none', className)}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        height: 24,
        borderBottom: '1px solid var(--border-secondary)',
      }}
      aria-hidden="true"
    >
      {ticks.map((tick, i) => (
        <div
          key={i}
          style={{
            flex: '1 1 0',
            display: 'flex',
            flexDirection: 'column',
            alignItems: i === 0 ? 'flex-start' : i === ticks.length - 1 ? 'flex-end' : 'center',
          }}
        >
          {/* Label */}
          <span
            style={{
              fontSize: 'var(--font-size-caption)',
              lineHeight: 1,
              color: 'var(--text-muted)',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0.01em',
              paddingBottom: 3,
              paddingLeft: i === 0 ? 0 : undefined,
              paddingRight: i === ticks.length - 1 ? 0 : undefined,
            }}
          >
            {tick.label}
          </span>
          {/* Tick mark */}
          <div
            style={{
              width: 1,
              height: 5,
              backgroundColor: 'var(--border-secondary)',
              flexShrink: 0,
            }}
          />
        </div>
      ))}
    </div>
  );
}
