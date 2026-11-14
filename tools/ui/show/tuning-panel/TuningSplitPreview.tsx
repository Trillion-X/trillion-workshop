// parts/ui/show/tuning-panel/TuningSplitPreview.tsx
//
// NO PRIOR: searched 'split preview|snap preview|divider preview' in bitfield-packages/packages/*/show; searched 'resizable panels with snap points' on the 21st.dev MCP; searched 'layout settings with panel sizes and snapping preview' on Mobbin
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A small window with two panes and one edge to drag, drawn to the scale of a
// real stage, so a person tuning how edges move feels the setting instead of
// reading it: the marks show where the edge snaps, the shaded ends show how
// narrow a side may get, and the edge settles into a mark with the softness
// being tuned. It is the TuningPanel `preview` for anything split in two.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Where the edge lands is the caller's `snap`, the same function the real
//    thing uses; this file never decides a snap.
// 2. Sizes are in the real stage's pixels (`stagePx`); the drawing only scales.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react';

import { cn } from '../cn';

export interface TuningSplitPreviewProps {
  /** The width, in pixels, of the real thing this window stands for. */
  stagePx: number;
  /** Narrowest a side may be, in real pixels. */
  minPx: number;
  /** Where the edge snaps, as percentages of the stage. Empty draws no marks. */
  marksPercent: readonly number[];
  /** How long the edge takes to settle into a mark. */
  easeMs: number;
  /** Where a dragged edge lands, in real pixels. */
  snap: (requestedPx: number, stagePx: number) => { px: number; snapped: boolean };
  /** Where the edge starts, as a share of the stage (0-1). */
  startShare?: number;
  className?: string;
}

export function TuningSplitPreview({
  stagePx,
  minPx,
  marksPercent,
  easeMs,
  snap,
  startShare = 0.5,
  className,
}: TuningSplitPreviewProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(320);
  const [share, setShare] = useState(startShare);
  const [snapped, setSnapped] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { setShare(startShare); }, [startShare]);

  const stage = Math.max(1, stagePx);
  const scale = width / stage;
  const shadePx = Math.min(minPx * scale, width / 2);
  const edgePx = Math.min(width - shadePx, Math.max(shadePx, share * width));
  const settle = snapped && easeMs > 0 ? `${easeMs}ms cubic-bezier(0.22, 1, 0.36, 1)` : '';

  const moveTo = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const result = snap(((clientX - rect.left) / rect.width) * stage, stage);
    setSnapped(result.snapped);
    setShare(result.px / stage);
  };

  return (
    <div className={cn('grid gap-2', className)} data-tuning-split-preview>
      <div
        ref={box}
        className="relative h-36 w-full touch-none select-none overflow-hidden rounded-[var(--radius-card,12px)] border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)]"
        onPointerMove={(event) => { if (dragging) moveTo(event.clientX); }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        {marksPercent.map((mark) => (
          <span
            key={mark}
            aria-hidden="true"
            className="absolute top-0 h-full w-px bg-[var(--accent-primary)] opacity-30"
            style={{ left: `${mark}%` }}
          />
        ))}
        <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-[var(--glass-bg-hover)]" style={{ width: shadePx }} />
        <span aria-hidden="true" className="absolute inset-y-0 right-0 bg-[var(--glass-bg-hover)]" style={{ width: shadePx }} />
        <span
          aria-hidden="true"
          className="absolute inset-y-2 left-2 rounded-[var(--radius-control,8px)] border border-[var(--border-primary)] bg-[var(--bg-surface)] shadow-sm"
          style={{ width: Math.max(0, edgePx - 12), transition: settle && `width ${settle}` }}
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-2 right-2 rounded-[var(--radius-control,8px)] border border-[var(--border-primary)] bg-[var(--bg-surface)] shadow-sm"
          style={{ left: edgePx + 4, transition: settle && `left ${settle}` }}
        />
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label="Drag to try it"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
          tabIndex={0}
          className="absolute inset-y-0 z-10 flex w-5 -translate-x-1/2 cursor-col-resize items-center justify-center outline-none"
          style={{ left: edgePx - 2, transition: settle && `left ${settle}` }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
            moveTo(event.clientX);
          }}
          onPointerMove={(event) => { if (dragging) moveTo(event.clientX); }}
          onPointerUp={() => setDragging(false)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const rect = box.current?.getBoundingClientRect();
            if (!rect) return;
            moveTo(rect.left + edgePx + (event.key === 'ArrowRight' ? 1 : -1) * rect.width * 0.02);
          }}
        >
          <span className={cn('h-10 w-1 rounded-full transition-colors', snapped ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-secondary,var(--border-primary))]')} />
        </span>
      </div>
      <div className="flex justify-between text-[length:var(--font-size-caption,12px)] tabular-nums text-[var(--text-muted)]">
        <span>{Math.round(share * stage)} px</span>
        <span>{snapped ? 'Snapped' : 'Free'}</span>
        <span>{Math.round((1 - share) * stage)} px</span>
      </div>
    </div>
  );
}
