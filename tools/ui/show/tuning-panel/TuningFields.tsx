// parts/ui/show/tuning-panel/TuningFields.tsx
//
// NO PRIOR: searched 'scrub|drag number|shadow editor|bezier|timing curve' in parts/ui/show and
// bitfield-packages/packages/*/show (only plain range tracks and number inputs); Diffusion Studio's inspector
// (design-systems/diffusion-studio, MPL-2.0, Solid) was read for its anatomy only, no code was taken.
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The fine controls of the one inspector (TuningPanel), drawn the way Figma and Diffusion Studio draw them:
//   - a number field with a short prefix (X, Y, Blur) you drag sideways to change the number, type into, or nudge
//     with the arrow keys (Shift for ten steps at once);
//   - a shadow: where it sits (x, y), how soft it is (blur), how far it reaches (spread), its colour and opacity;
//   - a timing curve: the curve drawn as itself with two handles to drag, and named curves to start from.
// Each control changes the value on every move; whether and when a change is kept is the caller's.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Values are plain DATA: a number, a shadow object, a curve as four numbers. The CSS helpers here
//    (shadowCss / readShadowCss / curveCss / readCurveCss) are the one place a shadow or a curve meets CSS text.
// 2. A number never leaves its bounds and keeps the precision of its step.
// 3. Every control is reachable by keyboard: the number field takes arrow keys, the curve's handles take arrow keys.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';

import { cn } from '../cn';
import { NamedIcon } from '../icon/NamedIcon';
import { TuningColorField } from './TuningPanel';

/** A shadow as DATA: where it sits (x, y), how soft (blur), how far it reaches past the shape (spread), its colour
 *  and opacity (0 to 1). Pixels are the caller's units. */
export interface TuningShadow {
  readonly x: number;
  readonly y: number;
  readonly blur: number;
  readonly spread: number;
  readonly colour: string;
  readonly opacity: number;
}

/** A timing curve as the four numbers of a cubic Bézier from (0,0) to (1,1): x1, y1, x2, y2. */
export type TuningCurve = readonly [number, number, number, number];

/** The shadow a person gets when they add one: soft, straight down, faint. */
export const SOFT_SHADOW: TuningShadow = { x: 0, y: 4, blur: 12, spread: 0, colour: '#000000', opacity: 0.25 };

function decimalsOf(step: number): number {
  const text = String(step);
  return text.includes('e-') ? Number(text.split('e-')[1]) : (text.split('.')[1] ?? '').length;
}

function hexPair(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
}

/** A shadow as CSS (`box-shadow` order: x y blur spread colour). */
export function shadowCss(shadow: TuningShadow): string {
  const hex = /^#([0-9a-f]{6})/i.exec(shadow.colour)?.[1] ?? '000000';
  const [r, g, b] = [0, 2, 4].map(at => Number.parseInt(hex.slice(at, at + 2), 16));
  const alpha = Math.round(Math.min(1, Math.max(0, shadow.opacity)) * 1000) / 1000;
  return `${shadow.x}px ${shadow.y}px ${shadow.blur}px ${shadow.spread}px rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The first shadow of a CSS shadow list (as written or as the browser reports it), or null when there is none. */
export function readShadowCss(text: string): TuningShadow | null {
  const first = text.trim().split(/,(?![^(]*\))/)[0]?.trim() ?? '';
  if (!first || first === 'none') return null;
  const colour = /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/i.exec(first)?.[0] ?? '';
  const lengths = first.replace(colour, ' ').replace(/\binset\b/i, ' ').trim().split(/\s+/).filter(Boolean).map(part => Number.parseFloat(part));
  if (lengths.length < 2 || lengths.some(n => !Number.isFinite(n))) return null;
  const channels = /rgba?\(([^)]*)\)/i.exec(colour)?.[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  const hex = channels && channels.length >= 3
    ? `#${channels.slice(0, 3).map(hexPair).join('')}`
    : /^#[0-9a-f]{6}$/i.test(colour) ? colour.toLowerCase() : '#000000';
  const opacity = channels && channels.length > 3 ? channels[3] : colour ? 1 : 0.25;
  return { x: lengths[0], y: lengths[1], blur: lengths[2] ?? 0, spread: lengths[3] ?? 0, colour: hex, opacity };
}

/** The curves CSS names, as their four numbers (CSS Easing Functions, the closed set the language defines). */
const NAMED_CURVES: Readonly<Record<string, TuningCurve>> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
};

export function curveCss(curve: TuningCurve): string {
  return `cubic-bezier(${curve.join(', ')})`;
}

/** A CSS timing function as its four numbers; null when it is not a curve (steps, or unreadable). */
export function readCurveCss(text: string): TuningCurve | null {
  const trimmed = text.trim().split(/,(?![^(]*\))/)[0]?.trim() ?? '';
  if (NAMED_CURVES[trimmed]) return NAMED_CURVES[trimmed];
  const numbers = /^cubic-bezier\(([^)]*)\)$/i.exec(trimmed)?.[1].split(',').map(Number);
  return numbers && numbers.length === 4 && numbers.every(Number.isFinite) ? [numbers[0], numbers[1], numbers[2], numbers[3]] : null;
}

/** A curve read from a value that may be four numbers or "x1,y1,x2,y2" (how option rows write one). */
export function curveOf(value: unknown): TuningCurve | null {
  const numbers = Array.isArray(value) ? value.map(Number) : typeof value === 'string' ? value.split(',').map(Number) : [];
  return numbers.length === 4 && numbers.every(Number.isFinite) ? [numbers[0], numbers[1], numbers[2], numbers[3]] : null;
}

export interface ScrubFieldProps {
  /** What the number is, for screen readers and the tooltip. */
  readonly label: string;
  /** The short word drawn at the field's start, the part you drag (X, Y, Blur). The label's first letter when left out. */
  readonly prefix?: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly onChange: (value: number) => void;
  readonly className?: string;
}

/** Pixels of sideways drag per step. */
const PIXELS_PER_STEP = 2;

/** A number to drag, type or nudge, with its prefix and unit in the same field. */
export function ScrubField({ label, prefix, value, min, max, step = 1, unit, onChange, className }: ScrubFieldProps) {
  const decimals = decimalsOf(step);
  const shown = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(decimals)).toString() : '');
  const [typed, setTyped] = useState(shown(value));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; start: number } | null>(null);
  useEffect(() => { setTyped(shown(value)); }, [value, decimals]);
  const fit = (n: number) => Number(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)).toFixed(decimals));
  const factor = (event: { shiftKey: boolean }) => (event.shiftKey ? 10 : 1);
  return (
    <span
      data-tuning-scrub
      title={label}
      className={cn(
        'inline-flex h-7 min-w-0 items-center rounded-[var(--radius-control)] border bg-[var(--glass-bg-subtle)] text-xs transition-colors',
        dragging ? 'border-[var(--accent-primary)]' : 'border-transparent hover:border-[var(--border-primary)] focus-within:border-[var(--border-focus)]',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-full min-w-6 shrink-0 cursor-ew-resize select-none items-center justify-center px-1.5 text-[var(--text-muted)] touch-none hover:text-[var(--text-primary)]"
        onPointerDown={event => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, start: value };
          setDragging(true);
        }}
        onPointerMove={event => {
          if (!drag.current) return;
          const steps = Math.round((event.clientX - drag.current.x) / PIXELS_PER_STEP);
          const next = fit(drag.current.start + steps * step * factor(event));
          if (next !== value) onChange(next);
        }}
        onPointerUp={event => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => { drag.current = null; setDragging(false); }}
      >
        {prefix ?? label.slice(0, 1).toUpperCase()}
      </span>
      <input
        aria-label={label}
        inputMode="decimal"
        spellCheck={false}
        className="h-full w-full min-w-0 bg-transparent pr-1 text-left tabular-nums text-[var(--text-primary)] outline-none"
        value={typed}
        onChange={event => {
          setTyped(event.currentTarget.value);
          const n = Number.parseFloat(event.currentTarget.value);
          if (Number.isFinite(n)) onChange(fit(n));
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            onChange(fit(value + (event.key === 'ArrowUp' ? 1 : -1) * step * factor(event)));
          } else if (event.key === 'Enter') event.currentTarget.blur();
        }}
        onBlur={() => setTyped(shown(value))}
      />
      {unit ? <span aria-hidden="true" className="shrink-0 pr-2 text-[var(--text-muted)]">{unit}</span> : null}
    </span>
  );
}

/** A shadow: x and y, blur and spread as fields you drag, then its colour and how strong it is. No shadow yet draws one
 *  button that adds a soft one (Klaviyo's and Figma's "Drop shadow +"); a shadow can be taken away again. */
export function ShadowField({ label, value, unit = 'px', onChange }: {
  label: string; value: TuningShadow | null; unit?: string; onChange: (value: TuningShadow | null) => void;
}) {
  if (!value) {
    return (
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] border border-dashed border-[var(--border-primary)] px-2.5 text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--border-focus)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
        onClick={() => onChange(SOFT_SHADOW)}
      >
        <NamedIcon name="Plus" size="xs" aria-hidden="true" />
        Add {label.toLowerCase()}
      </button>
    );
  }
  const set = (patch: Partial<TuningShadow>) => onChange({ ...value, ...patch });
  return (
    <span className="grid w-full min-w-0 gap-1.5" data-tuning-shadow>
      <span className="grid grid-cols-2 gap-1.5">
        <ScrubField label={`${label} across`} prefix="X" value={value.x} min={-200} max={200} unit={unit} onChange={x => set({ x })} />
        <ScrubField label={`${label} down`} prefix="Y" value={value.y} min={-200} max={200} unit={unit} onChange={y => set({ y })} />
        <ScrubField label={`${label} blur`} prefix="Blur" value={value.blur} min={0} max={200} unit={unit} onChange={blur => set({ blur })} />
        <ScrubField label={`${label} spread`} prefix="Spread" value={value.spread} min={-100} max={200} unit={unit} onChange={spread => set({ spread })} />
      </span>
      <TuningColorField label={`${label} colour`} value={value.colour} onChange={colour => set({ colour })} />
      <span className="flex min-w-0 items-center gap-1.5">
        <ScrubField className="min-w-0 flex-1" label={`${label} opacity`} prefix="Opacity" value={Math.round(value.opacity * 100)} min={0} max={100} unit="%" onChange={percent => set({ opacity: percent / 100 })} />
        <button
          type="button"
          aria-label={`Remove ${label.toLowerCase()}`}
          title={`Remove ${label.toLowerCase()}`}
          className="grid size-7 shrink-0 place-items-center rounded-[var(--radius-control)] text-[var(--text-muted)] transition-colors hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]"
          onClick={() => onChange(null)}
        >
          <NamedIcon name="Minus" size="xs" aria-hidden="true" />
        </button>
      </span>
    </span>
  );
}

/** Where a curve's handles may go: across stays within the time, up and down may overshoot. */
const CURVE_BOX = { left: -0.1, top: -0.45, width: 1.2, height: 1.9 };

/** A timing curve drawn as itself: drag its two handles (or focus one and use the arrow keys), or start from a named curve. */
export function CurveField({ label, value, presets, onChange }: {
  label: string; value: TuningCurve; presets?: readonly { value: string; label: string }[]; onChange: (value: TuningCurve) => void;
}) {
  const svg = useRef<SVGSVGElement | null>(null);
  const dragging = useRef<0 | 1 | null>(null);
  const [x1, y1, x2, y2] = value;
  const round = (n: number) => Math.round(n * 100) / 100;
  const moveHandle = (handle: 0 | 1, x: number, y: number) => {
    const at: [number, number] = [round(Math.min(1, Math.max(0, x))), round(Math.min(1.45, Math.max(-0.45, y)))];
    onChange(handle === 0 ? [at[0], at[1], x2, y2] : [x1, y1, at[0], at[1]]);
  };
  const pointAt = (event: React.PointerEvent): [number, number] | null => {
    const box = svg.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return null;
    const x = CURVE_BOX.left + ((event.clientX - box.left) / box.width) * CURVE_BOX.width;
    const yDown = CURVE_BOX.top + ((event.clientY - box.top) / box.height) * CURVE_BOX.height;
    return [x, 1 - yDown];
  };
  const handle = (index: 0 | 1, hx: number, hy: number) => (
    <circle
      key={index}
      cx={hx}
      cy={1 - hy}
      r={0.07}
      role="slider"
      tabIndex={0}
      aria-label={`${label}, handle ${index + 1}`}
      aria-valuetext={`${hx}, ${hy}`}
      className="cursor-grab fill-[var(--bg-primary)] stroke-[var(--accent-primary)] outline-none focus-visible:fill-[var(--accent-primary)]"
      strokeWidth={0.03}
      onPointerDown={event => { event.preventDefault(); (event.currentTarget.ownerSVGElement ?? event.currentTarget).setPointerCapture?.(event.pointerId); dragging.current = index; }}
      onKeyDown={event => {
        const by = event.shiftKey ? 0.1 : 0.01;
        const moves: Record<string, [number, number]> = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, by], ArrowDown: [0, -by] };
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        moveHandle(index, hx + move[0], hy + move[1]);
      }}
    />
  );
  const chosen = presets?.find(option => curveOf(option.value)?.every((n, at) => n === value[at]));
  return (
    <span className="grid w-full min-w-0 gap-2" data-tuning-curve>
      <span className="flex min-w-0 items-start gap-2">
        <svg
          ref={svg}
          viewBox={`${CURVE_BOX.left} ${CURVE_BOX.top} ${CURVE_BOX.width} ${CURVE_BOX.height}`}
          className="h-[7.5rem] w-[4.75rem] shrink-0 touch-none overflow-visible rounded-[var(--radius-control)] bg-[var(--glass-bg-subtle)]"
          aria-label={label}
          role="group"
          onPointerMove={event => {
            if (dragging.current === null) return;
            const point = pointAt(event);
            if (point) moveHandle(dragging.current, point[0], point[1]);
          }}
          onPointerUp={() => { dragging.current = null; }}
          onPointerCancel={() => { dragging.current = null; }}
        >
          <rect x={0} y={0} width={1} height={1} className="fill-none stroke-[var(--border-primary)]" strokeWidth={0.015} />
          <line x1={0} y1={1} x2={1} y2={0} className="stroke-[var(--border-primary)]" strokeWidth={0.012} strokeDasharray="0.04 0.04" />
          <line x1={0} y1={1} x2={x1} y2={1 - y1} className="stroke-[var(--text-muted)]" strokeWidth={0.015} />
          <line x1={1} y1={0} x2={x2} y2={1 - y2} className="stroke-[var(--text-muted)]" strokeWidth={0.015} />
          <path d={`M0 1 C${x1} ${1 - y1} ${x2} ${1 - y2} 1 0`} className="fill-none stroke-[var(--accent-primary)]" strokeWidth={0.035} strokeLinecap="round" />
          {handle(0, x1, y1)}
          {handle(1, x2, y2)}
        </svg>
        {presets?.length ? (
          <span className="grid min-w-0 flex-1 content-start gap-1">
            {presets.map(option => {
              const curve = curveOf(option.value);
              if (!curve) return null;
              const on = option === chosen;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={on}
                  className={cn(
                    'h-7 truncate rounded-[var(--radius-control)] border px-2 text-left text-xs transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
                    on
                      ? 'border-[var(--accent-primary)] bg-[var(--glass-bg-active)] text-[var(--text-primary)]'
                      : 'border-transparent bg-[var(--glass-bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)]',
                  )}
                  onClick={() => onChange(curve)}
                >
                  {option.label}
                </button>
              );
            })}
          </span>
        ) : null}
      </span>
      <span className="grid min-w-0 grid-cols-2 gap-1.5">
        <ScrubField label={`${label}, first handle across`} prefix="X1" value={x1} min={0} max={1} step={0.01} onChange={n => onChange([n, y1, x2, y2])} />
        <ScrubField label={`${label}, first handle up`} prefix="Y1" value={y1} min={-1} max={2} step={0.01} onChange={n => onChange([x1, n, x2, y2])} />
        <ScrubField label={`${label}, second handle across`} prefix="X2" value={x2} min={0} max={1} step={0.01} onChange={n => onChange([x1, y1, n, y2])} />
        <ScrubField label={`${label}, second handle up`} prefix="Y2" value={y2} min={-1} max={2} step={0.01} onChange={n => onChange([x1, y1, x2, n])} />
      </span>
    </span>
  );
}

/** How each kind of setting reads and writes CSS text (a style property's value), by widget id; a widget not listed
 *  keeps the text as it is. A page editor draws a part's CSS with the same settings any record uses. */
const CSS_FORMS: Readonly<Record<string, { read: (text: string) => unknown; write: (value: unknown, unit: string) => string }>> = {
  number: { read: text => Number.parseFloat(text) || 0, write: (value, unit) => `${value}${unit}` },
  slider: { read: text => Number.parseFloat(text) || 0, write: (value, unit) => `${value}${unit}` },
  shadow: { read: text => readShadowCss(text), write: value => (value && typeof value === 'object' ? shadowCss(value as TuningShadow) : 'none') },
  curve: { read: text => readCurveCss(text), write: value => { const curve = curveOf(value); return curve ? curveCss(curve) : 'ease'; } },
};

/** A setting's value read from CSS text. */
export function settingFromCss(setting: { widget: string }, text: string): unknown {
  return CSS_FORMS[setting.widget] ? CSS_FORMS[setting.widget].read(text) : text;
}

/** A setting's value written as CSS text. */
export function settingToCss(setting: { widget: string; unit?: string }, value: unknown): string {
  return CSS_FORMS[setting.widget] ? CSS_FORMS[setting.widget].write(value, setting.unit ?? '') : String(value ?? '');
}
