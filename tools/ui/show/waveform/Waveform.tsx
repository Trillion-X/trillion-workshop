// packages/ui/show/waveform/Waveform.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Dense audio waveform visualization primitive for the DreamCut video editor
// timeline. Renders center-baseline mirrored bars with a gradient fill and a
// sine envelope so the waveform swells naturally in the middle.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. DETERMINISTIC: Shape derived solely from seed via string hash. Math.random()
//    is forbidden - waveform must be stable across renders.
// 2. TOKENS ONLY: All colors from the authorized CSS variable list.
// 3. CENTER-BASELINE: Gradient peaks at 50% of each bar, mirroring above/below.
// 4. FILLS PARENT: width 100%, height 100% - consumer controls dimensions.
// 5. GRADIENT FILL: linear-gradient from accent to transparent at both ends.
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

export type WaveformTone = 'blue' | 'emerald' | 'purple' | 'cyan';

export interface WaveformProps {
  tone?: WaveformTone;
  /** Seed string for deterministic bar heights. Changing seed changes shape. */
  seed?: string;
  /** Number of bars rendered. Default 40. */
  bars?: number;
  /**
   * Real decoded audio peaks in [0, 1]. When provided and non-empty the
   * component renders bars derived from this data instead of the synthetic
   * seed-based shape. Produced by decodeAudioPeaks() from decode-audio-peaks.ts.
   * The array length sets the bar count when peaks is used.
   */
  peaks?: number[];
  className?: string;
}

// ---------------------------------------------------------------------------
// TOKEN MAP
// ---------------------------------------------------------------------------

const TONE_TOKEN: Record<WaveformTone, string> = {
  blue: 'var(--accent-blue)',
  emerald: 'var(--accent-emerald)',
  purple: 'var(--accent-purple)',
  cyan: 'var(--accent-cyan)',
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/**
 * Deterministic per-bar float in [0, 1) from seed + bar index.
 * djb2-style bit mixing - same seed always yields the same sequence.
 */
function hashSeed(seed: string, index: number): number {
  let h = 5381;
  const s = seed + String(index);
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return (h % 1000) / 1000;
}

/** Sine envelope at normalized t in [0,1]. Peaks at 0.5, zero at edges. */
function sineEnvelope(t: number): number {
  return Math.sin(t * Math.PI);
}

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Dense audio-style waveform. Center-baseline mirrored bars with gradient
 * fill in the chosen tone accent and a sine envelope that swells the waveform
 * in the middle - matching the visual language of real DAWs.
 *
 * Fills its parent container. Wrap in a sized element to control dimensions.
 *
 * @example
 * ```tsx
 * <div style={{ width: 200, height: 40 }}>
 *   <Waveform tone='blue' seed='track-1' bars={40} />
 * </div>
 * ```
 */
export function Waveform({ tone = 'blue', seed = 'default', bars = 40, peaks, className }: WaveformProps) {
  const accentToken = TONE_TOKEN[tone];

  // When real peaks are provided use them directly; otherwise fall back to the
  // deterministic synthetic shape so the waveform is never blank.
  const barHeights: number[] = (peaks !== undefined && peaks.length > 0)
    ? peaks.map((p) => Math.max(0.08, Math.min(1, p)))
    : Array.from({ length: bars }, (_, i) => {
        const t = bars > 1 ? i / (bars - 1) : 0.5;
        const raw = 0.2 + hashSeed(seed, i) * 0.8;
        return Math.max(0.08, raw * sineEnvelope(t));
      });

  return (
    <div
      className={cn('relative w-full h-full', className)}
      aria-hidden='true'
    >
      <div
        className='absolute inset-0 flex items-center'
        style={{ gap: 1 }}
      >
        {barHeights.map((halfH, i) => {
          const heightPct = Math.min(halfH * 45, 45) * 2;
          const g0 = 'color-mix(in srgb, ' + accentToken + ' 0%, transparent) 0%';
          const g1 = accentToken + ' 50%';
          const g2 = 'color-mix(in srgb, ' + accentToken + ' 0%, transparent) 100%';
          return (
            <div
              key={i}
              style={{
                flex: '1 1 0',
                minWidth: 1,
                height: heightPct + '%',
                borderRadius: 2,
                background: 'linear-gradient(to bottom, ' + g0 + ', ' + g1 + ', ' + g2 + ')',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
