// packages/ui/show/clip-block/ClipBlock.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Timeline clip primitive for the DreamCut video editor. Represents a named
// segment on a track lane — the fundamental block users see, arrange, and trim.
// Tones map to track categories (source, audio, analysis, etc.) with a thick
// left accent bar and a subtly gradient-tinted fill.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. TOKENS ONLY: All colors from the authorized CSS variable list.
//    No hardcoded hex, no invented token names.
// 2. TONE COLORS: Each tone maps to exactly one accent token (see TONE_MAP).
//    The mapping is the single source of truth — never duplicate it.
// 3. WIDTH: widthPct sets percentage width with a 6rem floor; omitting it
//    makes the clip flex-1 to fill available lane space.
// 4. WAVEFORM: Imported from @/packages/ui/show/waveform — never reimplemented.
// 5. ACTIVE RING: ring-1 in --border-focus when active=true, never elsewhere.
// 6. HOVER: brightens fill to --glass-bg-active; no other hover states.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../cn';
import { Waveform, type WaveformTone } from '../waveform/Waveform';

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export type ClipBlockTone =
  | 'source'
  | 'audio'
  | 'analysis'
  | 'motion'
  | 'identity'
  | 'output';

export interface ClipBlockProps {
  label: string;
  detail?: string;
  tone?: ClipBlockTone;
  active?: boolean;
  /** Width as a percentage of the parent container (min ~6rem). Omit to flex-1. */
  widthPct?: number;
  /** Allow exact timeline geometry where a minimum visual width would distort time. */
  minWidth?: string;
  showWaveform?: boolean;
  seed?: string;
  /**
   * Real decoded audio peaks in [0, 1] from decodeAudioPeaks(). When provided
   * and non-empty, the Waveform renders the true waveform shape instead of the
   * deterministic synthetic fallback.
   */
  peaks?: number[];
  /**
   * Thumbnail image URL for a VIDEO clip. When set, the clip fill becomes a
   * horizontally-tiled filmstrip of this frame (Descript/VEED/ElevenLabs style)
   * with a legibility scrim behind the label. Takes precedence over the
   * waveform — a video clip shows frames, not bars.
   */
  thumbSrc?: string;
  onClick?: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// TONE MAP — single source of truth for all tone-to-token relationships
// ---------------------------------------------------------------------------

const TONE_MAP: Record<
  ClipBlockTone,
  { accentToken: string; waveformTone: WaveformTone; tintToken: string }
> = {
  source:   { accentToken: 'var(--accent-blue)',    waveformTone: 'blue',    tintToken: 'var(--accent-blue)' },
  audio:    { accentToken: 'var(--accent-emerald)', waveformTone: 'emerald', tintToken: 'var(--accent-emerald)' },
  output:   { accentToken: 'var(--accent-emerald)', waveformTone: 'emerald', tintToken: 'var(--accent-emerald)' },
  analysis: { accentToken: 'var(--accent-purple)',  waveformTone: 'purple',  tintToken: 'var(--accent-purple)' },
  identity: { accentToken: 'var(--accent-indigo)',  waveformTone: 'blue',    tintToken: 'var(--accent-indigo)' },
  motion:   { accentToken: 'var(--accent-cyan)',    waveformTone: 'cyan',    tintToken: 'var(--accent-cyan)' },
};

// ---------------------------------------------------------------------------
// CVA VARIANTS
// ---------------------------------------------------------------------------

const clipVariants = cva(
  'relative flex flex-col overflow-hidden rounded-md border border-[var(--border-primary)] cursor-pointer select-none transition-colors',
  {
    variants: {
      active: {
        true: 'ring-1 ring-[var(--border-focus)]',
        false: '',
      },
    },
    defaultVariants: { active: false },
  }
);

// ---------------------------------------------------------------------------
// COMPONENT
// ---------------------------------------------------------------------------

/**
 * Timeline clip block. Named segment on a track lane with a thick left accent
 * bar, optional embedded waveform, and tone-based coloring.
 *
 * @example
 * ```tsx
 * <ClipBlock label="Interview A" detail="00:02:14" tone="source" showWaveform seed="clip-1" />
 * <ClipBlock label="Narration" tone="audio" active widthPct={30} showWaveform seed="clip-2" />
 * ```
 */
export function ClipBlock({
  label,
  detail,
  tone = 'source',
  active = false,
  widthPct,
  minWidth = '6rem',
  showWaveform = false,
  seed = 'clip',
  peaks,
  thumbSrc,
  onClick,
  className,
}: ClipBlockProps) {
  const { accentToken, waveformTone, tintToken } = TONE_MAP[tone];

  const widthStyle: React.CSSProperties =
    widthPct != null
      ? { width: `${widthPct}%`, minWidth, flexShrink: 0 }
      : { flex: '1 1 0', minWidth };

  return (
    <div
      className={cn(clipVariants({ active }), className)}
      style={{
        ...widthStyle,
        background: `linear-gradient(to right, color-mix(in srgb, ${tintToken} 12%, var(--glass-bg-hover)), var(--glass-bg-hover))`,
      }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); } : undefined}
    >
      {/* Filmstrip fill — a video clip tiles its thumbnail frame horizontally
          (Descript/VEED/ElevenLabs), with a scrim so the label stays legible. */}
      {thumbSrc && (
        <>
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              backgroundImage: `url(${thumbSrc})`,
              backgroundRepeat: 'repeat-x',
              backgroundSize: 'auto 100%',
              backgroundPosition: 'left center',
            }}
          />
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'linear-gradient(to top, color-mix(in srgb, var(--glass-bg-hover) 88%, transparent) 0%, color-mix(in srgb, var(--glass-bg-hover) 20%, transparent) 46%, transparent 100%)',
            }}
          />
        </>
      )}

      {/* Thick left accent bar — full height, tone color */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          backgroundColor: accentToken,
          borderRadius: '4px 0 0 4px',
        }}
      />

      {/* Content area — inset past the accent bar, above the filmstrip fill */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          paddingLeft: 10,
          paddingRight: 6,
          paddingTop: 4,
          paddingBottom: 4,
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minWidth: 0,
          gap: 2,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span
            className="text-[var(--text-primary)] font-semibold truncate"
            style={{ fontSize: 12, lineHeight: 1.3 }}
          >
            {label}
          </span>
          {detail && (
            <span
              className="text-[var(--text-muted)] truncate"
              style={{ fontSize: 'var(--font-size-caption)', lineHeight: 1.3 }}
            >
              {detail}
            </span>
          )}
        </div>

        {showWaveform && !thumbSrc && (
          <div style={{ flex: 1, minHeight: 16, minWidth: 0, overflow: 'hidden' }}>
            <Waveform tone={waveformTone} seed={seed} bars={40} peaks={peaks} />
          </div>
        )}
      </div>
    </div>
  );
}
