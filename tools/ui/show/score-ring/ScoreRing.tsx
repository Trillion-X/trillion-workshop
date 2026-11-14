// packages/ui/show/score-ring/ScoreRing.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Canonical circular SCORE RING — a color-graded gauge ring with a big value in
// its center, plus an optional label and an interpretive caption. This is the
// hero anatomy of every "readiness / recovery / state" readout (WHOOP recovery
// %, Ultrahuman dynamic recovery, Visible morning stability, Oura readiness):
// a dominant ring whose fill sweeps 0 -> value, tone-graded (calm green when
// good, amber/red when not), with the number reading front-and-center.
//
// It is GENERIC (L069): it renders ANY 0..max score — flow, focus, recovery,
// mastery, NPS, mood — driven entirely by props. It names no domain. The tone
// is a prop (the CALLER decides good/caution/critical from DATA thresholds), so
// the ring itself hardcodes no scale meaning.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Tokens only: the graded arc + track ride screen-look status/accent tokens
//    (--status-success / --status-warning / --status-danger / --accent-purple),
//    never literal hex. The ring hole is the surface token so it reads as a ring.
// 2. The dynamic sweep (value -> conic angle) is the ONLY inline style, exactly
//    as ProgressBar computes its fill width inline — consumers never see it.
// 3. Center content is a slot: the big value + unit, or arbitrary children.
// 4. Pure presentational — no data reads, no domain vocabulary.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { Container } from '../container/container';
import { Text } from '../text/Text';

export type ScoreRingTone = 'positive' | 'caution' | 'critical' | 'neutral';

const TONE_VAR: Record<ScoreRingTone, string> = {
  positive: 'var(--status-success, #22c55e)',
  caution: 'var(--status-warning, #f59e0b)',
  critical: 'var(--status-danger, #ef4444)',
  neutral: 'var(--accent-purple, #a855f7)',
};

export interface ScoreRingProps {
  /** The reading. Interpreted against `max` to fill the arc. */
  value: number;
  /** Full-scale value the arc represents. Default 1 (a 0..1 probability). */
  max?: number;
  /** The tone grade of the arc — the CALLER derives this from DATA thresholds. */
  tone?: ScoreRingTone;
  /** Big centered text. Defaults to the rounded percentage of value/max. */
  displayValue?: string;
  /** Small unit beside/under the value (e.g. "%", "flow"). */
  unit?: string;
  /** A short label above the ring (e.g. "Flow"). */
  label?: string;
  /**
   * A short qualitative VERDICT pill under the ring ("Locked in", "Needs a
   * reset", "Above average") — the glanceable answer before the caption prose.
   * Tone-graded to match the arc. Omitted → no pill. This is the best-in-class
   * score-readout anatomy (Whoop/Oura/Indeed/Visitors): number → band → detail.
   */
  band?: string;
  /** An interpretive one-liner under the ring ("You're locked in."). */
  caption?: string;
  /** Diameter in px. Default 176. */
  size?: number;
  /** Arc thickness in px. Default 14. */
  thickness?: number;
  'aria-label'?: string;
}

/**
 * A tone-graded circular gauge with a centered reading.
 *
 * @example
 * ```tsx
 * <ScoreRing value={0.72} tone="positive" label="Flow" caption="You're locked in." />
 * ```
 */
export function ScoreRing({
  value,
  max = 1,
  tone = 'neutral',
  displayValue,
  unit,
  label,
  band,
  caption,
  size = 176,
  thickness = 14,
  'aria-label': ariaLabel,
}: ScoreRingProps): React.ReactElement {
  const safeMax = max > 0 ? max : 1;
  const fraction = Math.max(0, Math.min(1, (Number.isFinite(value) ? value : 0) / safeMax));
  const degrees = Math.round(fraction * 360);
  const arc = TONE_VAR[tone] ?? TONE_VAR.neutral;
  const center = displayValue ?? `${Math.round(fraction * 100)}`;

  return (
    <Container layout="vertical" gap="md" alignItems="center" width="full" data-role="score-ring">
      {label ? (
        <Text variant="label" color="muted">{label}</Text>
      ) : null}
      <div
        role="img"
        aria-label={ariaLabel ?? (label ? `${label}: ${center}${unit ?? ''}` : center)}
        style={{
          position: 'relative',
          width: size,
          height: size,
          borderRadius: '50%',
          // graded arc sweeps 0->value; the remainder is the muted track token.
          background: `conic-gradient(${arc} ${degrees}deg, var(--surface-muted, rgba(148,163,184,0.14)) ${degrees}deg 360deg)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // the arc casts a soft halo in its own tone, so the reading feels lit.
          boxShadow: `0 0 64px -12px ${arc}`,
        }}
      >
        <div
          style={{
            width: size - thickness * 2,
            height: size - thickness * 2,
            borderRadius: '50%',
            background: 'var(--surface-raised, var(--surface-base, #0b0f17))',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
          }}
        >
          <span
            style={{
              fontSize: Math.round(size * 0.26),
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: '-0.02em',
              color: 'var(--text-primary, #fff)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {center}
          </span>
          {unit ? <Text variant="label" color="muted">{unit}</Text> : null}
          {/* verdict word directly under the number, inside the ring (Oura order). */}
          {band ? (
            <span
              data-test="score-ring-band"
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: arc,
              }}
            >
              {band}
            </span>
          ) : null}
        </div>
      </div>
      {caption ? (
        <Text variant="body" color="secondary" align="center">{caption}</Text>
      ) : null}
    </Container>
  );
}
