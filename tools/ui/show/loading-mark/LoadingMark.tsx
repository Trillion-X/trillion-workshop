// parts/ui/show/loading-mark/LoadingMark.tsx
//
// PURPOSE
//   The one loading animation: a needle stitching a thread across the space, pulling it through, and starting again.
//   Every loading state draws it: the screen-state loading rows (large, over the skeleton), and every spinner (small,
//   in a pressed button, a file opening, a notification at work), so the whole product waits the same way.
//
// NON-NEGOTIABLE INVARIANTS
//   1. CSS and SVG only; no script runs per frame. The motion is screen-look's loading-mark.css.
//   2. It never flashes: it appears only once the wait has lasted about 300 ms.
//   3. Reduced motion shows the stitched thread and the needle standing still.
//   4. Its colours are the look's roles: the thread is the accent (the logo's red on the Trillion look), the needle is
//      the text colour, so it reads on paper and on midnight alike.
//
// PROVENANCE
//   Motion anatomy from 21st.dev "Logo Trace Loader" (id 16834, a dashed segment travelling one contour) and
//   "Skeleton Loader" (id 19999, a moving highlight across placeholders); drawn from scratch here, no code copied.

import React from 'react';
import { NEEDLE_BODY, NEEDLE_EYE, STITCH_PATH } from './stitch';

export { STITCH_PATH };
export type LoadingMarkSize = 'sm' | 'md' | 'lg';

export type LoadingMarkProps = {
  size?: LoadingMarkSize;
  /** What is being waited for, for a screen reader. Without it the mark is decoration beside words that say so. */
  label?: string;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children' | 'role'>;

/** The needle and thread, stitching while something loads. */
export function LoadingMark({ size = 'md', label, className, ...rest }: LoadingMarkProps) {
  return (
    <span
      {...rest}
      className={['loading-mark', className].filter(Boolean).join(' ')}
      data-loading-mark={size}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <svg className="loading-mark-art" viewBox="0 0 64 24" fill="none" aria-hidden="true" focusable="false">
        <path className="loading-mark-guide" d={STITCH_PATH} pathLength={100} />
        <path className="loading-mark-thread" d={STITCH_PATH} pathLength={100} />
        <g className="loading-mark-needle" style={{ offsetPath: `path('${STITCH_PATH}')` } as React.CSSProperties}>
          <path className="loading-mark-needle-body" d={NEEDLE_BODY} />
          <ellipse className="loading-mark-needle-eye" {...NEEDLE_EYE} />
        </g>
      </svg>
    </span>
  );
}
