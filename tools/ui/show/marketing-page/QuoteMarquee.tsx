// tools/ui/show/marketing-page/QuoteMarquee.tsx
//
// PURPOSE
//   The moving wall of quotes and clips as a page row names it: `ui/show/marketing-page/QuoteMarquee.tsx#QuoteMarquee`, with
//   props that are plain JSON values only (no function, no node), so the site tool can place it from a row. The items are
//   dealt into `rows` rails that slide in turn left then right at a stated speed; a hover pauses a rail and a person who asks
//   for less motion sees it still. It is QuoteWall with the row's own names for its props.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Props are plain JSON: `rows`, `pixels_per_second`, `label` and `items` ({kind:'quote', text, attribution?} or
//      {kind:'media', src, alt}). Nothing here takes a function or a React node.
//   2. The items keep the order they are given: they are dealt into the rails one after another, never sorted or woven again.
//   3. A media item is a muted, looping, inline video, drawn by the shared ProofMarquee.
//   4. Pure: no fetch and no window while it renders; the motion, the hover pause and the reduced-motion rule are the shared
//      MarqueeRail's.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { QuoteWall } from './QuoteWall.tsx';

export type QuoteMarqueeItem =
  | { kind: 'quote'; text: string; attribution?: string }
  | { kind: 'media'; src: string; alt: string; media_kind?: 'image' | 'video' };

export type QuoteMarqueeProps = {
  items: readonly QuoteMarqueeItem[];
  rows?: number;
  pixels_per_second?: number;
  label?: string;
};

export function QuoteMarquee({ items, rows = 2, pixels_per_second, label }: QuoteMarqueeProps) {
  const proof = items.map(item => (item.kind === 'quote'
    ? { kind: 'quote' as const, text: item.text, attribution: item.attribution }
    : { kind: 'media' as const, src: item.src, alt: item.alt, mediaKind: item.media_kind ?? 'video' as const }));
  return <QuoteWall items={proof} rows={rows} pixelsPerSecond={pixels_per_second} label={label} />;
}
