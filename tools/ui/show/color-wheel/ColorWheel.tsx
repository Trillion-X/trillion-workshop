// packages/ui/show/color-wheel/ColorWheel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A TRUE HSV color control: a circular hue ring (conic-gradient) wrapping an
// inner saturation/value square, plus an alpha bar and a preset swatch row
// (black + white always present). This is the shared primitive behind "pick a
// background color with a real wheel" — distinct from a grid of preset squares.
// It is value-in / hex-out: callers persist the emitted #rrggbb(aa) string as
// DATA; this component holds only transient pointer state.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Pure browser-local UI. No reads, writes, feeds, package behavior, I/O.
// 2. Color is caller-owned: `value` (hex) in, `onChange(hex)` out. No internal
//    source of truth beyond deriving HSVA for the pointer surfaces.
// 3. ZERO hardcoded palette policy — `presets` is caller DATA (defaults to a
//    neutral set). Black/white are affordances of the wheel, always offered.
// 4. Hue/Sat/Value math lives in color-math.ts (pure). This file is pointer +
//    paint only.
// =============================================================================
// NOTE: the documentation here is a design feature — do not
// remove or simplify it.
// =============================================================================

import React from 'react';
import { cn } from '../cn';
import {
  hexToHsva,
  hsvaToHex,
  hueBaseHex,
  type Hsva,
} from './color-math';

export interface ColorWheelProps {
  /** Current color as hex (#rgb/#rgba/#rrggbb/#rrggbbaa). */
  readonly value: string;
  /** Emitted on every change as #rrggbb or #rrggbbaa. */
  readonly onChange: (hex: string) => void;
  /** Outer diameter in px (the SV square scales with it). */
  readonly size?: number;
  /** Preset swatches (hex). Black + white are added automatically. */
  readonly presets?: readonly string[];
  /** Show the alpha bar. Default true. */
  readonly alpha?: boolean;
  readonly className?: string;
}

const DEFAULT_PRESETS: readonly string[] = [
  '#ef4444', '#f59e0b', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

const FALLBACK: Hsva = { h: 0, s: 0, v: 0, a: 1 };
const RING_THICKNESS = 0.16; // fraction of radius

/** Drag a value out of a pointer event against an element rect. */
function usePointerDrag(onMove: (clientX: number, clientY: number, rect: DOMRect) => void) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const onPointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const handle = (cx: number, cy: number) => onMove(cx, cy, el.getBoundingClientRect());
      handle(e.clientX, e.clientY);
      const move = (ev: PointerEvent) => handle(ev.clientX, ev.clientY);
      const up = (ev: PointerEvent) => {
        try { el.releasePointerCapture(ev.pointerId); } catch { /* released */ }
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    },
    [onMove],
  );
  return { ref, onPointerDown };
}

export function ColorWheel({
  value,
  onChange,
  size = 220,
  presets = DEFAULT_PRESETS,
  alpha = true,
  className,
}: ColorWheelProps) {
  const hsva = hexToHsva(value) ?? FALLBACK;
  const emit = React.useCallback((next: Hsva) => onChange(hsvaToHex(next)), [onChange]);

  // ---- Hue ring: angle of pointer about centre -> hue ------------------------
  const hueDrag = usePointerDrag((cx, cy, rect) => {
    const dx = cx - (rect.left + rect.width / 2);
    const dy = cy - (rect.top + rect.height / 2);
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 = +x
    emit({ ...hsva, h: (deg + 360) % 360 });
  });

  // ---- SV square: x -> saturation, y -> value (top = bright) ------------------
  const svDrag = usePointerDrag((cx, cy, rect) => {
    const s = (cx - rect.left) / rect.width;
    const v = 1 - (cy - rect.top) / rect.height;
    emit({ ...hsva, s: Math.max(0, Math.min(1, s)), v: Math.max(0, Math.min(1, v)) });
  });

  // ---- Alpha bar: x -> alpha -------------------------------------------------
  const alphaDrag = usePointerDrag((cx, _cy, rect) => {
    const a = (cx - rect.left) / rect.width;
    emit({ ...hsva, a: Math.max(0, Math.min(1, a)) });
  });

  const radius = size / 2;
  const ringInner = radius * (1 - RING_THICKNESS);
  // SV square inscribed in the inner circle (square side = inner-diameter / √2).
  const svSide = Math.floor((ringInner * 2) / Math.SQRT2);
  const svInset = (size - svSide) / 2;

  // Hue handle position on the ring centreline.
  const ringMid = (radius + ringInner) / 2;
  const hueRad = (hsva.h * Math.PI) / 180;
  const hueHandle = {
    left: radius + Math.cos(hueRad) * ringMid,
    top: radius + Math.sin(hueRad) * ringMid,
  };

  const currentHex = hsvaToHex(hsva);
  const allPresets = ['#000000', '#ffffff', ...presets];

  return (
    <div className={cn('flex flex-col gap-3 select-none', className)} style={{ width: size }}>
      {/* Wheel: hue ring + inner SV square */}
      <div className="relative" style={{ width: size, height: size }}>
        {/* Hue ring (conic gradient masked to a ring) */}
        <div
          ref={hueDrag.ref}
          onPointerDown={hueDrag.onPointerDown}
          role="slider"
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsva.h)}
          className="absolute inset-0 rounded-full cursor-crosshair touch-none"
          style={{
            background:
              'conic-gradient(from 90deg, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
            WebkitMaskImage: `radial-gradient(circle, transparent ${ringInner - 1}px, #000 ${ringInner}px)`,
            maskImage: `radial-gradient(circle, transparent ${ringInner - 1}px, #000 ${ringInner}px)`,
          }}
        />
        {/* Hue handle */}
        <div
          aria-hidden
          className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow pointer-events-none"
          style={{ left: hueHandle.left, top: hueHandle.top, background: hueBaseHex(hsva.h) }}
        />

        {/* SV square */}
        <div
          ref={svDrag.ref}
          onPointerDown={svDrag.onPointerDown}
          role="slider"
          aria-label="Saturation and brightness"
          aria-valuetext={`s ${Math.round(hsva.s * 100)}% v ${Math.round(hsva.v * 100)}%`}
          className="absolute rounded-md cursor-crosshair touch-none overflow-hidden"
          style={{ left: svInset, top: svInset, width: svSide, height: svSide, background: hueBaseHex(hsva.h) }}
        >
          {/* white -> transparent (saturation), then transparent -> black (value) */}
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, #fff, rgba(255,255,255,0))' }} />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(to top, #000, rgba(0,0,0,0))' }} />
          {/* SV handle */}
          <div
            aria-hidden
            className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow pointer-events-none"
            style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%`, background: hueBaseHex(hsva.h) }}
          />
        </div>
      </div>

      {/* Alpha bar */}
      {alpha && (
        <div
          ref={alphaDrag.ref}
          onPointerDown={alphaDrag.onPointerDown}
          role="slider"
          aria-label="Opacity"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsva.a * 100)}
          className="relative h-4 w-full rounded-full cursor-pointer touch-none"
          style={{
            backgroundImage:
              `linear-gradient(to right, transparent, ${hueBaseHex(hsva.h)}), ` +
              'repeating-conic-gradient(#bbb 0% 25%, #fff 0% 50%)',
            backgroundSize: '100% 100%, 12px 12px',
          }}
        >
          <div
            aria-hidden
            className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow pointer-events-none"
            style={{ left: `${hsva.a * 100}%`, background: currentHex }}
          />
        </div>
      )}

      {/* Presets (black + white + caller DATA) */}
      <div className="flex flex-wrap gap-1.5">
        {allPresets.map((hex) => (
          <button
            key={hex}
            type="button"
            aria-label={hex}
            onClick={() => onChange(hex)}
            className={cn(
              'h-6 w-6 rounded-md border transition-transform hover:scale-110',
              currentHex.toLowerCase() === hex.toLowerCase()
                ? 'border-white ring-2 ring-white/60'
                : 'border-[var(--border-primary)]',
            )}
            style={{ background: hex }}
          />
        ))}
      </div>
    </div>
  );
}
