// tools/ui/show/marketing-page/QuoteWall.tsx
//
// PURPOSE
//   A wall of proof that keeps moving: quote cards and clip stills woven into rows that slide in turn left and right. A page
//   row names it as `ui/show/marketing-page/QuoteWall.tsx#QuoteWall` and gives it the items; the rows and their speed are
//   props too, so three rows instead of two is a number, not a new part.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no fetch, no window while it renders. The motion is the shared MarqueeRail's, with the speed stated in pixels per
//      second, never a duration.
//   2. Every item is self-describing (`kind: 'quote'` with text and an optional attribution, or `kind: 'media'` with a still
//      or a video and the words that describe it); this file branches on none of them (ProofMarquee does, in one table).
//   3. The look is the screen look's (ProgramTestimonialMarquee.module.css); no inline styling here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import styles from '../../../screen-look/show/adaptive-program-landing/ProgramTestimonialMarquee.module.css';
import { ProofMarquee, type ProofItem } from './ProofMarquee.tsx';

export type QuoteWallProps = {
  items: readonly ProofItem[];
  /** The wall's name for a screen reader. */
  label?: string;
  rows?: number;
  pixelsPerSecond?: number;
};

const CLASS_NAMES = {
  attribution: styles.attribution,
  media: styles.media,
  mediaCard: styles.mediaCard,
  quoteCard: styles.card,
  quoteText: styles.quote,
  root: styles.root,
  row: styles.row,
};

export function QuoteWall({ items, label, rows = 2, pixelsPerSecond }: QuoteWallProps) {
  if (items.length === 0) return null;
  return <ProofMarquee ariaLabel={label} classNames={CLASS_NAMES} items={items} pixelsPerSecond={pixelsPerSecond} rows={rows} />;
}
