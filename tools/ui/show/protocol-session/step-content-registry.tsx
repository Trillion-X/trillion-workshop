// packages/ui/show/protocol-session/step-content-registry.tsx
//
// Step content renderers for a protocol session, resolved by an open string
// key through the shared blind registry. Each renderer draws ONE active step
// from its data bag and reports interactions back through the callbacks.
// A new way to guide a step is one register() call — the session component
// never enumerates content kinds.

import * as React from 'react';

import { createBlindRegistry, registerAll, type BlindRegistry } from '../blind-registry/blind-registry';
import { BreathingPacer } from '../breathing-pacer/BreathingPacer';
import type { RawBreathingPhase } from '../breathing-pacer/decode-breathing-cycle';
import { cn } from '../cn';
import { IconTile } from '../icon-tile/IconTile';
import { resolveNamedIcon } from '../icon/NamedIcon';

/** Everything a content renderer may read/report. All step meaning arrives as data. */
export interface StepContentProps {
  /** The step row's open data bag (label, caption, choices, pacer phases, …). */
  data: Readonly<Record<string, unknown>>;
  /** Planned seconds for the step (0/absent = untimed). */
  plannedSeconds: number;
  /** Live seconds elapsed in this step. */
  elapsedSeconds: number;
  /** Record an input for this step. */
  onCapture: (fieldId: string, value: unknown) => void;
  /** Advance-by-tap control (renderers surface it where it belongs). */
  onTapNext: () => void;
}

export type StepContentRenderer = (props: StepContentProps) => React.ReactElement | null;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Shared step text block: big instruction + quiet caption beneath. */
function StepText({ data }: { data: Readonly<Record<string, unknown>> }) {
  const label = text(data.step_label);
  const caption = text(data.step_caption);
  if (!label && !caption) return null;
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      {label ? (
        <span className="text-2xl font-semibold tracking-tight" style={{ color: 'var(--text-primary, #fff)' }}>
          {label}
        </span>
      ) : null}
      {caption ? (
        <span className="max-w-[24rem] text-sm leading-relaxed" style={{ color: 'var(--text-secondary, var(--text-muted))' }}>
          {caption}
        </span>
      ) : null}
    </div>
  );
}

/** prompt — the instruction card. Untimed steps advance by tap (control lives in the session shell). */
const renderPrompt: StepContentRenderer = ({ data }) => <StepText data={data} />;

/** pacer — a bounded breathing pacer for the step's duration. */
const renderPacer: StepContentRenderer = ({ data }) => {
  const phases = Array.isArray(data.pacer_phases)
    ? (data.pacer_phases.filter(
        (p) => p && typeof (p as RawBreathingPhase).label === 'string' && typeof (p as RawBreathingPhase).seconds === 'number',
      ) as RawBreathingPhase[])
    : [];
  return (
    <div className="flex flex-col items-center gap-4">
      <BreathingPacer phases={phases} idSeed={text(data.step_label) ?? 'pacer'} caption={text(data.step_caption)} />
    </div>
  );
};

/** timer — a countdown ring with the remaining seconds in the center. */
const renderTimer: StepContentRenderer = ({ data, plannedSeconds, elapsedSeconds }) => {
  const total = Math.max(plannedSeconds, 0.001);
  const remaining = Math.max(0, Math.ceil(plannedSeconds - elapsedSeconds));
  const progress = Math.min(1, elapsedSeconds / total);
  const size = 180;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center gap-6">
      <div className="relative" style={{ width: size, height: size }} data-testid="step-timer">
        <svg width={size} height={size} aria-hidden>
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="var(--border-subtle, rgba(255,255,255,0.14))" strokeWidth={stroke}
          />
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="var(--accent, rgba(150,185,245,0.9))" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
        <span
          className="absolute inset-0 flex items-center justify-center text-4xl font-semibold tabular-nums"
          style={{ color: 'var(--text-primary, #fff)' }}
        >
          {remaining}
        </span>
      </div>
      <StepText data={data} />
    </div>
  );
};

/** The bounded valence vocabulary surfaces speak (positive/caution/critical/
 *  neutral) mapped to the IconTile's semantic tones. Unknown/absent -> accent,
 *  so EVERY tile carries the same depth treatment regardless of its data. */
const VALENCE_TO_TILE_TONE: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
  positive: 'success',
  caution: 'warning',
  critical: 'error',
  neutral: 'neutral',
};

/** choice — one-tap options; each tap captures the value and the step can
 *  advance on input-given. A choice may carry `icon` (a named icon), an
 *  `icon_image` (any served image URL — takes precedence), and `tone`;
 *  EVERY tile gets the same IconTile treatment (uniform depth — no per-option
 *  special-casing), the tone only tints it. */
const renderChoice: StepContentRenderer = ({ data, onCapture }) => {
  const fieldId = text(data.step_capture) ?? 'choice';
  const raw = Array.isArray(data.choices) ? data.choices : [];
  const choices = raw
    .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>) : undefined))
    .filter((c): c is Record<string, unknown> => !!c && typeof c.value === 'string' && typeof c.label === 'string');
  return (
    <div className="flex flex-col items-center gap-6">
      <StepText data={data} />
      <div className="flex w-full flex-row flex-wrap items-stretch justify-center gap-3" data-testid="step-choices">
        {choices.map((c) => {
          const iconImage = text(c.icon_image);
          const IconComp = resolveNamedIcon(text(c.icon));
          const tone = text(c.tone);
          return (
            <button
              key={String(c.value)}
              type="button"
              data-choice={String(c.value)}
              onClick={() => onCapture(fieldId, c.value)}
              className={cn(
                'flex min-w-[7.5rem] flex-1 basis-28 flex-col items-center gap-3 rounded-2xl px-5 py-5',
                'transition-transform hover:scale-[1.02] active:scale-[0.98]',
              )}
              style={{
                color: 'var(--text-primary, #fff)',
                background: 'var(--glass-bg-subtle, rgba(255,255,255,0.05))',
                boxShadow: 'inset 0 0 0 1px var(--border-subtle, rgba(255,255,255,0.12))',
              }}
            >
              {iconImage || IconComp ? (
                <IconTile
                  icon={IconComp ?? undefined}
                  image={iconImage}
                  tone={(tone && VALENCE_TO_TILE_TONE[tone]) || 'accent'}
                  size="lg"
                  glow
                  label={String(c.label)}
                />
              ) : null}
              <span className="text-lg font-semibold">{String(c.label)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** text — a free entry captured into the step's field as the athlete types. */
function TextEntry({ data, onCapture }: StepContentProps) {
  const fieldId = text(data.step_capture) ?? 'entry';
  const [value, setValue] = React.useState('');
  return (
    <div className="flex w-full max-w-[28rem] flex-col items-center gap-6">
      <StepText data={data} />
      <textarea
        data-testid="step-text-entry"
        value={value}
        rows={3}
        placeholder={text(data.entry_placeholder) ?? ''}
        onChange={(e) => {
          setValue(e.currentTarget.value);
          if (e.currentTarget.value.trim().length > 0) onCapture(fieldId, e.currentTarget.value.trim());
        }}
        className="w-full resize-none rounded-2xl px-4 py-3 text-base leading-relaxed outline-none"
        style={{
          color: 'var(--text-primary, #fff)',
          background: 'var(--glass-bg-subtle, rgba(255,255,255,0.05))',
          boxShadow: 'inset 0 0 0 1px var(--border-subtle, rgba(255,255,255,0.12))',
        }}
      />
    </div>
  );
}
const renderTextEntry: StepContentRenderer = (props) => <TextEntry {...props} />;

const BUILT_IN: Record<string, StepContentRenderer> = {
  prompt: renderPrompt,
  pacer: renderPacer,
  timer: renderTimer,
  choice: renderChoice,
  text: renderTextEntry,
};

/** Registry seeded with the built-ins; unknown kinds fall back to the prompt card (safe). */
export function createStepContentRegistry(): BlindRegistry<StepContentRenderer> {
  const reg = createBlindRegistry<StepContentRenderer>({ fallback: renderPrompt });
  return registerAll(reg, BUILT_IN);
}
