// bitfield/packages/ui/show/marquee-rail/MarqueeRail.tsx
//
// Purpose
// -------
// One continuously moving horizontal rail. The caller supplies the items and a
// renderer; this owns the loop.
//
// Non-negotiable invariant: SPEED IS STATED, NEVER INFERRED.
// A marquee written as `animation: slide 92s linear infinite` does not have a
// speed. It has a duration, and the speed that results is whatever the content
// width happens to make it: add two cards and everything silently accelerates,
// remove two and it crawls so slowly a reader calls it broken. Every rail that
// "animates but looks static" is that bug. Here the caller states
// `pixelsPerSecond`, the rail measures its own set width, and the duration is
// derived (`width / pixelsPerSecond`). Content changes cannot change the speed.
//
// Key concepts
// ------------
// - The track holds the set twice: the original, and an aria-hidden duplicate.
//   Translating by exactly -50% therefore lands on a frame identical to the
//   start, which is what makes the loop seamless with no jump.
// - Measurement is live (ResizeObserver): images and videos that load late
//   widen the set, and the duration follows them.
// - Reduced motion stops the animation and gives the reader a scrollable rail
//   instead, so the content is never unreachable.

'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Measure BEFORE paint. `useLayoutEffect` runs after the DOM is mutated and
// before the browser paints, and `getBoundingClientRect` forces layout at that
// moment, so the width is real on the first read instead of depending on a
// later callback to correct a zero. `useEffect` is the server-render fallback
// only, where there is no layout to force and nothing to animate anyway.
const useMeasureBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export type MarqueeRailProps<Item> = {
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly direction?: 'left' | 'right';
  readonly gap?: number;
  readonly items: readonly Item[];
  readonly keyOf?: (item: Item, index: number) => string;
  readonly pauseOnHover?: boolean;
  readonly pixelsPerSecond?: number;
  readonly renderItem: (item: Item, index: number) => React.ReactNode;
};

const MARQUEE_RAIL_CSS = `
.bf-marquee-rail { min-width: 0; overflow: hidden; width: 100%;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent); }
.bf-marquee-rail__track { display: flex; width: max-content; will-change: transform; }
.bf-marquee-rail__set { display: flex; }
.bf-marquee-rail[data-moving="true"] .bf-marquee-rail__track {
  animation-duration: var(--bf-marquee-duration);
  animation-iteration-count: infinite;
  animation-name: var(--bf-marquee-keyframes);
  animation-timing-function: linear; }
.bf-marquee-rail[data-pause-on-hover="true"]:hover .bf-marquee-rail__track { animation-play-state: paused; }
@keyframes bf-marquee-rail-left { from { transform: translate3d(0,0,0); } to { transform: translate3d(-50%,0,0); } }
@keyframes bf-marquee-rail-right { from { transform: translate3d(-50%,0,0); } to { transform: translate3d(0,0,0); } }
@media (prefers-reduced-motion: reduce) {
  .bf-marquee-rail .bf-marquee-rail__track { animation: none !important; }
  .bf-marquee-rail { overflow-x: auto; }
}
`;

export function MarqueeRail<Item>({
  ariaLabel,
  className = '',
  direction = 'left',
  gap = 12,
  items,
  keyOf,
  pauseOnHover = true,
  pixelsPerSecond = 46,
  renderItem,
}: MarqueeRailProps<Item>) {
  const setRef = useRef<HTMLDivElement>(null);
  const [setWidth, setSetWidth] = useState(0);

  // Measuring is a RETRY, not a single read.
  //
  // The first version measured once inside the effect and handed the rest to a
  // ResizeObserver. At commit time the set often has no layout yet — fonts and
  // videos are still arriving — so the read returned 0, and 0 was ACCEPTED as
  // the width. The rail then sat at `0s` forever and rendered as a deliberate
  // static row. Caught in a real DOM with `data-moving="false"`, which is the
  // only reason this is not shipping frozen: it is the exact defect this
  // component exists to remove, wearing a different costume.
  //
  // The root is that "not measured yet" and "measured as zero" were the same
  // state, and the failure of that ambiguity is SILENCE. So a zero is now a
  // state the rail keeps trying to leave: it re-reads on animation frames
  // until a real width appears, and keeps the observer for later changes.
  useMeasureBeforePaint(() => {
    const element = setRef.current;
    if (!element) return;
    let frame = 0;
    let attemptsLeft = 120;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setSetWidth(width);
      return width > 0;
    };
    const keepTrying = () => {
      if (measure() || attemptsLeft <= 0) return;
      attemptsLeft -= 1;
      frame = requestAnimationFrame(keepTrying);
    };
    keepTrying();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null;
    observer?.observe(element);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
    // Depends on the COUNT, never on the array's identity. Callers build this
    // list inline, so a fresh array arrives on every render; with `[items]`
    // here, measuring set state, the re-render produced a new array, the
    // effect re-ran, and the page spun until the browser gave up — a 45s hard
    // timeout in the render proof. A ResizeObserver already covers content
    // that changes without changing the count, so the count is the only
    // dependency that carries information.
  }, [items.length]);

  // Duration is derived from the measured set and the stated speed. Until the
  // set has a width there is nothing truthful to derive, so the rail holds
  // still rather than animating at a made-up rate.
  const speed = pixelsPerSecond > 0 ? pixelsPerSecond : 1;
  const moving = setWidth > 0;
  const duration = moving ? `${(setWidth / speed).toFixed(2)}s` : '0s';

  return (
    <div
      aria-label={ariaLabel}
      className={`bf-marquee-rail ${className}`.trim()}
      data-marquee-direction={direction}
      data-marquee-pixels-per-second={String(speed)}
      data-moving={moving ? 'true' : 'false'}
      data-pause-on-hover={pauseOnHover ? 'true' : 'false'}
      style={{
        '--bf-marquee-duration': duration,
        '--bf-marquee-keyframes': `bf-marquee-rail-${direction}`,
      } as React.CSSProperties}
    >
      <style>{MARQUEE_RAIL_CSS}</style>
      <div className="bf-marquee-rail__track">
        {[false, true].map((duplicate) => (
          <div
            aria-hidden={duplicate ? 'true' : undefined}
            className="bf-marquee-rail__set"
            key={duplicate ? 'duplicate' : 'original'}
            ref={duplicate ? undefined : setRef}
            style={{ gap, paddingRight: gap }}
          >
            {items.map((item, index) => (
              <React.Fragment key={`${duplicate ? 'd' : 'o'}-${keyOf ? keyOf(item, index) : index}`}>
                {renderItem(item, index)}
              </React.Fragment>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
