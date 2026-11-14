// parts/ui/show/colour-strip/ColourStrip.tsx
//
// NO PRIOR: searched parts/ui show for gradient bar, timeline colour, day strip (color-dot, heat-grid, gradient-editor:
//   a dot, a grid of cells and an editor; none draws colours along a line), and Mobbin 'night shift schedule timeline'
//   (Opal Easy Evening's From/To rail, f.lux's day graph)
//
// PURPOSE
//   A bar of colours along a line: colours at places from 0 (start) to 1 (end), blended between them, with an optional
//   mark at one place (now) and labels under it. What a day of colours, a range of tones or any run of colours over
//   something looks like at a glance. Composed from Container and Text.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: it draws the colours it is handed; it never knows what they stand for.
//   2. A style is written only for the colours and the places, which are data (the ColorDot exception to L065).
//   3. Stops out of order or outside 0..1 are put in order and kept to 0..1; no stops draws an empty bar.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';
import { Container } from '../container';
import { Text } from '../text/Text';

export type ColourStop = { at: number; colour: string };
export type ColourStripProps = {
  stops: readonly ColourStop[];
  /** Where to draw the mark, 0..1; left out, none. */
  mark?: number | null;
  /** Words under the bar, each at its place 0..1. */
  labels?: ReadonlyArray<{ at: number; text: string }>;
  label?: string;
};

const place = (at: number) => `${(Math.min(1, Math.max(0, at)) * 100).toFixed(2)}%`;

/** A bar of the colours in `stops`, blended between them, with `mark` drawn on it and `labels` under it. */
export function ColourStrip({ stops, mark, labels = [], label }: ColourStripProps) {
  const ordered = [...stops].sort((a, b) => a.at - b.at);
  const background = ordered.length ? `linear-gradient(to right, ${ordered.map(stop => `${stop.colour} ${place(stop.at)}`).join(', ')})` : undefined;
  return (
    <Container layout="vertical" gap="xs" role="img" aria-label={label}>
      <Container position="relative" overflow="hidden" className="h-8 w-full rounded-lg border border-[var(--border-primary)]" style={{ background }}>
        {mark == null ? null : (
          <Container position="absolute" className="inset-y-0 w-0.5 -translate-x-1/2 bg-[var(--accent-purple)] shadow-[0_0_0_1px_var(--bg-primary)]" style={{ left: place(mark) }} />
        )}
      </Container>
      {labels.length ? (
        <Container position="relative" className="h-4 w-full">
          {labels.map((entry, index) => (
            <Container key={`${entry.at}:${entry.text}`} position="absolute" className={index === 0 ? '' : index === labels.length - 1 ? '-translate-x-full' : '-translate-x-1/2'} style={{ left: place(entry.at) }}>
              <Text variant="caption" color="muted" className="whitespace-nowrap">{entry.text}</Text>
            </Container>
          ))}
        </Container>
      ) : null}
    </Container>
  );
}
