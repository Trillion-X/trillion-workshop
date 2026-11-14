// packages/ui/show/gradient-editor/GradientEditor.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The editor for the `gradient` visual-layer capability: pick a gradient TYPE
// (linear / radial / conic), an ANGLE (linear/conic), and a set of COLOR STOPS
// (color + position), and it composes the CSS `background-image` string the
// capability paints. It edits STRUCTURE (type/angle/stops) and emits both the
// structure and the composed `css` — so it never has to PARSE a css string back
// (the render capability reads the opaque `css`; this editor owns the structure).
//
// value-in / patch-out: reads the layer input, calls `onPatch` with the changed
// fields. Storage-blind — it has no idea where the layer persists.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. ui/ leaf — raw elements + className are legal here (this is a primitive).
// 2. The gradient TYPE list is closed by the CSS substrate (Physics), carried as
//    opaque data — adding a "type" is a CSS feature, not a product preference.
// 3. No magic palette — initial stops come from the layer input (caller DATA).
// =============================================================================

import React from 'react';
import { cn } from '../cn';
import { ColorWheel } from '../color-wheel/ColorWheel';
import { Slider } from '../slider/Slider';

// CSS-substrate gradient functions (Physics — closed by CSS, carried as data).
const GRADIENT_TYPES = ['linear', 'radial', 'conic'] as const;
type GradientType = (typeof GRADIENT_TYPES)[number];

export interface GradientStop {
  /** #rrggbb(aa). */
  readonly color: string;
  /** 0..100 percent along the gradient. */
  readonly pos: number;
}

export interface GradientValue {
  readonly gradientType: GradientType;
  /** Degrees (linear/conic). Ignored for radial. */
  readonly angle: number;
  readonly stops: readonly GradientStop[];
}

const DEFAULT_VALUE: GradientValue = {
  gradientType: 'linear',
  angle: 135,
  stops: [
    { color: '#3b82f6', pos: 0 },
    { color: '#8b5cf6', pos: 100 },
  ],
};

/** Compose the CSS `background-image` value for a gradient structure. */
export function composeGradientCss(value: GradientValue): string {
  const stops = [...value.stops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${s.color} ${s.pos}%`)
    .join(', ');
  switch (value.gradientType) {
    case 'radial':
      return `radial-gradient(circle, ${stops})`;
    case 'conic':
      return `conic-gradient(from ${value.angle}deg, ${stops})`;
    case 'linear':
    default:
      return `linear-gradient(${value.angle}deg, ${stops})`;
  }
}

/** Read a GradientValue out of a layer's opaque input (with safe defaults). */
export function readGradientValue(input: Record<string, unknown>): GradientValue {
  const type = GRADIENT_TYPES.includes(input.gradientType as GradientType)
    ? (input.gradientType as GradientType)
    : DEFAULT_VALUE.gradientType;
  const angle = typeof input.angle === 'number' ? input.angle : DEFAULT_VALUE.angle;
  const stops = Array.isArray(input.stops) && input.stops.length > 0
    ? (input.stops as GradientStop[]).filter((s) => typeof s?.color === 'string' && typeof s?.pos === 'number')
    : DEFAULT_VALUE.stops;
  return { gradientType: type, angle, stops: stops.length > 0 ? stops : DEFAULT_VALUE.stops };
}

export interface GradientEditorProps {
  readonly input: Record<string, unknown>;
  /** Emit the changed fields (structure + recomposed css) back to the layer. */
  readonly onPatch: (patch: Record<string, unknown>) => void;
}

export function GradientEditor({ input, onPatch }: GradientEditorProps) {
  const value = readGradientValue(input);
  const [selected, setSelected] = React.useState(0);

  const commit = (next: GradientValue) => {
    onPatch({ gradientType: next.gradientType, angle: next.angle, stops: next.stops, css: composeGradientCss(next) });
  };

  const setType = (gradientType: GradientType) => commit({ ...value, gradientType });
  const setAngle = (angle: number) => commit({ ...value, angle });
  const setStopColor = (hex: string) => {
    const stops = value.stops.map((s, i) => (i === selected ? { ...s, color: hex } : s));
    commit({ ...value, stops });
  };
  const setStopPos = (pos: number) => {
    const stops = value.stops.map((s, i) => (i === selected ? { ...s, pos } : s));
    commit({ ...value, stops });
  };
  const addStop = () => {
    const stops = [...value.stops, { color: '#ffffff', pos: 50 }];
    commit({ ...value, stops });
    setSelected(stops.length - 1);
  };
  const removeStop = (index: number) => {
    if (value.stops.length <= 2) return; // a gradient needs ≥2 stops
    const stops = value.stops.filter((_, i) => i !== index);
    commit({ ...value, stops });
    setSelected(Math.max(0, Math.min(selected, stops.length - 1)));
  };

  const current = value.stops[selected] ?? value.stops[0];

  return (
    <div className="flex w-56 flex-col gap-2">
      {/* live preview */}
      <div
        className="h-10 w-full rounded-lg border border-[var(--border-primary)]"
        style={{ backgroundImage: composeGradientCss(value) }}
        aria-hidden
      />

      {/* type segmented control */}
      <div className="flex gap-0.5 rounded-lg bg-[var(--glass-bg-subtle)] p-0.5">
        {GRADIENT_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            aria-pressed={value.gradientType === t}
            className={cn(
              'flex-1 rounded-md px-2 py-1 text-xs capitalize transition-colors',
              value.gradientType === t
                ? 'bg-[var(--glass-bg-active)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* angle (linear/conic only) */}
      {value.gradientType !== 'radial' && (
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <span className="w-10">Angle</span>
          <Slider value={value.angle} min={0} max={360} step={1} onValueChange={setAngle} />
          <span className="w-9 text-right tabular-nums">{Math.round(value.angle)}°</span>
        </label>
      )}

      {/* stops row */}
      <div className="flex items-center gap-1">
        {value.stops.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSelected(i)}
            onDoubleClick={() => removeStop(i)}
            aria-label={`Stop ${i + 1}${i === selected ? ' (selected)' : ''}`}
            title="Click to edit · double-click to remove"
            className={cn(
              'h-6 w-6 rounded-md border-2 transition-transform',
              i === selected ? 'border-[var(--accent-primary)] scale-110' : 'border-[var(--border-primary)]',
            )}
            style={{ background: s.color }}
          />
        ))}
        <button
          type="button"
          onClick={addStop}
          aria-label="Add stop"
          className="h-6 w-6 rounded-md border border-dashed border-[var(--border-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          +
        </button>
      </div>

      {/* selected stop position */}
      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <span className="w-10">Pos</span>
        <Slider value={current?.pos ?? 0} min={0} max={100} step={1} onValueChange={setStopPos} />
        <span className="w-9 text-right tabular-nums">{Math.round(current?.pos ?? 0)}%</span>
      </label>

      {/* selected stop color */}
      <ColorWheel value={current?.color ?? '#ffffff'} onChange={setStopColor} size={150} />
    </div>
  );
}
