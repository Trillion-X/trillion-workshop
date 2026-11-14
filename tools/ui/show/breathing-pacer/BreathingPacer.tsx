// packages/ui/show/breathing-pacer/BreathingPacer.tsx
//
// A guided breathing pacer (Calm / Headspace / Breathwrk anatomy): a large soft
// circle inside a track ring that slowly grows and shrinks, with the phase
// instruction ("Breathe in" / "Hold" / "Breathe out") swapping in the center in
// time with the motion. The user does NOTHING — they watch and co-regulate. The
// purest zero-input value there is (L083).
//
// Pure presentation: it paints an already-decoded BreathingCycleView (see
// decode-breathing-cycle.ts) and owns its keyframes in one <style>. It never
// knows which pattern it is — box breathing, 4-7-8, coherence, the sigh are all
// the same component, different DATA (L069/L090). Motion is disabled under
// prefers-reduced-motion (the circle rests, the first instruction stays).
// Raw elements are allowed here (this is a `ui` primitive, the styling floor).

import * as React from 'react';

import { cn } from '../cn';
import {
  decodeBreathingCycle,
  type BreathingCycleView,
  type RawBreathingPhase,
} from './decode-breathing-cycle';

export interface BreathingPacerProps {
  /** Raw phases OR a pre-decoded cycle. Raw is the common path (DATA in). */
  phases?: RawBreathingPhase[];
  cycle?: BreathingCycleView;
  /** Deterministic seed for animation names (avoids collisions across pacers). */
  idSeed?: string;
  /** Base circle diameter in px (scaled by the cycle). Default 220. */
  size?: number;
  /** Title above the circle, e.g. the pattern name ("Box breathing"). */
  title?: string;
  /** Steadying line below the circle. */
  caption?: string;
  /** Show the quiet per-phase count chips row ("Breathe in 4 · Hold 4 · …"). */
  showPattern?: boolean;
  className?: string;
}

const REDUCED_MOTION_CSS = `@media (prefers-reduced-motion: reduce) {
  .bf-breathe-animated { animation: none !important; }
  .bf-breathe-label { opacity: 0 !important; }
  .bf-breathe-label.bf-breathe-label-first { opacity: 1 !important; }
}`;

export function BreathingPacer({
  phases,
  cycle,
  idSeed,
  size = 220,
  title,
  caption,
  showPattern = false,
  className,
}: BreathingPacerProps) {
  const resolved: BreathingCycleView =
    cycle ?? decodeBreathingCycle(phases ?? [], { idSeed });

  const hasMotion = resolved.totalSeconds > 0 && resolved.maxScale !== resolved.minScale;
  const restScale = resolved.startScale || 1;
  const patternPhases = phases ?? [];

  return (
    <div className={cn('flex w-full flex-col items-center', className)}>
      <style>{`${resolved.keyframesCss}\n${REDUCED_MOTION_CSS}`}</style>

      {title ? (
        <span
          className="mb-3 text-center text-sm font-semibold"
          style={{ color: 'var(--text-muted)' }}
        >
          {title}
        </span>
      ) : null}

      {/* Quiet per-phase count chips (Breathwrk anatomy): "Breathe in 4 · Hold 4". */}
      {showPattern && patternPhases.length > 0 ? (
        <div className="mb-8 flex flex-row items-center justify-center gap-2" data-testid="breathe-pattern-chips">
          {patternPhases.map((phase, index) => (
            <span
              key={`${phase.label}-${index}`}
              className="rounded-full px-3 py-1 text-xs"
              style={{
                color: 'var(--text-secondary, rgba(255,255,255,0.7))',
                background: 'var(--glass-bg-subtle, rgba(255,255,255,0.05))',
                boxShadow: 'inset 0 0 0 1px var(--border-subtle, rgba(255,255,255,0.1))',
              }}
            >
              {phase.label} {phase.seconds}
            </span>
          ))}
        </div>
      ) : null}

      {/* Track ring the breath lives inside — a defined halo field, so the
          breath sits in a place rather than floating on nothing. */}
      <div
        className="relative flex items-center justify-center"
        style={{ width: size * 1.25, height: size * 1.25 }}
      >
        <span
          aria-hidden
          className="absolute rounded-full"
          style={{
            inset: 0,
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.14))',
            opacity: 0.55,
          }}
        />
        <span
          aria-hidden
          className="absolute rounded-full"
          style={{
            inset: size * 0.06,
            border: '1px solid var(--border-subtle, rgba(255,255,255,0.10))',
            opacity: 0.35,
          }}
        />
        {/* The breathing circle — a soft, CENTERED, ethereal bloom (Calm /
            TIDE / WHOOP anatomy): a bright-soft core that fades smoothly to a
            translucent edge, so it reads as a glowing breath, not a metallic
            3-D sphere. Neutral white (not `--accent`, which could tint it) and
            centred at 50% 50% (the old off-centre 50% 38% + hard 42% stop is
            what produced the chrome-ball shading). */}
        <div
          aria-hidden
          className={cn('absolute rounded-full', hasMotion ? 'bf-breathe-animated' : undefined)}
          style={{
            width: size,
            height: size,
            transformOrigin: 'center',
            transform: hasMotion ? undefined : `scale(${restScale})`,
            // not-a-panel: the breathing orb itself is the thing the person watches.
            background:
              'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.88) 52%, rgba(255,255,255,0.42) 78%, rgba(255,255,255,0.12) 92%, transparent 100%)',
            boxShadow: '0 0 72px 4px rgba(255,255,255,0.18)',
            filter: 'blur(2px)',
            ...(hasMotion
              ? {
                  animationName: resolved.coreAnimationName,
                  animationDuration: `${resolved.totalSeconds}s`,
                  animationTimingFunction: 'ease-in-out',
                  animationIterationCount: 'infinite',
                }
              : {}),
          }}
        />

        {/* Time-synced phase instructions stacked in the center. */}
        <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
          {resolved.labels.map((label, index) => (
            <span
              key={label.key}
              data-testid="breathe-phase-label"
              className={cn(
                'bf-breathe-label absolute text-center text-2xl font-semibold tracking-tight',
                index === 0 ? 'bf-breathe-label-first' : undefined,
                hasMotion ? 'bf-breathe-animated' : undefined,
              )}
              style={{
                color: 'var(--text-on-accent, #0b0b0f)',
                opacity: hasMotion ? 0 : index === 0 ? 1 : 0,
                ...(hasMotion
                  ? {
                      animationName: label.animationName,
                      animationDuration: `${resolved.totalSeconds}s`,
                      animationTimingFunction: 'ease-in-out',
                      animationIterationCount: 'infinite',
                    }
                  : {}),
              }}
            >
              {label.text}
            </span>
          ))}
        </div>
      </div>

      {caption ? (
        <span
          className="mt-8 max-w-[24rem] text-center text-sm leading-relaxed"
          style={{ color: 'var(--text-secondary, var(--text-muted))' }}
        >
          {caption}
        </span>
      ) : null}
    </div>
  );
}
