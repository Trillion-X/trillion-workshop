// bitfield/packages/ui/show/marketing-page/ProofMarquee.tsx
//
// Purpose
// -------
// Continuously moving rows of proof. A proof item is whatever the caller says
// it is — a quote, a clip, a still — and the rows keep moving at a stated
// speed regardless of how many there are.
//
// Non-negotiable invariants
// -------------------------
// - SPEED IS STATED, NEVER INFERRED. See MarqueeRail: a duration is not a
//   speed, and every "it animates but looks frozen" rail is that confusion.
// - ITEMS ARE SELF-DESCRIBING. Each carries its own `kind`; this file holds a
//   renderer map keyed by that kind, so a new proof kind is one entry here and
//   zero edits in any caller (L090). No caller branches on kind.
// - Appearance is the CALLER's, supplied as class names from its own
//   appearance owner. This file owns structure and motion only.
// - `rows` is a number, not a pair of named lanes: asking for three rows is a
//   number change, not a new component.

'use client';

import React from 'react';
import { MarqueeRail } from '../marquee-rail';

export type ProofQuoteItem = {
  readonly attribution?: string;
  readonly id?: string;
  readonly kind: 'quote';
  readonly text: string;
};

export type ProofMediaItem = {
  readonly alt: string;
  readonly id?: string;
  readonly kind: 'media';
  readonly mediaKind?: 'image' | 'video';
  readonly src: string;
};

export type ProofItem = ProofMediaItem | ProofQuoteItem;

export type ProofMarqueeClassNames = {
  readonly attribution?: string;
  readonly media?: string;
  readonly mediaCard?: string;
  readonly quoteCard?: string;
  readonly quoteText?: string;
  readonly root?: string;
  readonly row?: string;
};

function QuoteCard({ classNames, item }: { classNames: ProofMarqueeClassNames; item: ProofQuoteItem }) {
  return (
    <figure className={classNames.quoteCard} data-proof-kind="quote">
      <blockquote className={classNames.quoteText}>{item.text}</blockquote>
      {item.attribution ? <figcaption className={classNames.attribution}>{item.attribution}</figcaption> : null}
    </figure>
  );
}

function MediaCard({ classNames, item }: { classNames: ProofMarqueeClassNames; item: ProofMediaItem }) {
  return (
    <div className={classNames.mediaCard} data-proof-kind="media">
      {item.mediaKind === 'image' ? (
        <img alt={item.alt} className={classNames.media} decoding="async" loading="lazy" src={item.src} />
      ) : (
        <video aria-label={item.alt} autoPlay className={classNames.media} loop muted playsInline preload="auto" src={item.src} />
      )}
    </div>
  );
}

// The one place a proof kind becomes a rendered thing. A caller adds proof by
// adding DATA; a new KIND of proof is one entry in this map.
const PROOF_CARD_RENDERERS: Record<ProofItem['kind'], (props: { classNames: ProofMarqueeClassNames; item: never }) => React.ReactElement> = {
  media: MediaCard as never,
  quote: QuoteCard as never,
};

function proofKey(item: ProofItem, index: number) {
  if (item.id) return item.id;
  return item.kind === 'quote' ? `q-${index}-${item.text.slice(0, 24)}` : `m-${index}-${item.src}`;
}

/**
 * Deal one flat list into `rows` lanes, keeping the caller's order across the
 * lanes rather than slicing it into blocks. Slicing puts every clip in one
 * lane whenever the weave is regular; dealing keeps each lane mixed.
 */
export function dealIntoRows<Item>(items: readonly Item[], rows: number): Item[][] {
  const lanes: Item[][] = Array.from({ length: Math.max(1, rows) }, () => []);
  items.forEach((item, index) => lanes[index % lanes.length].push(item));
  return lanes;
}

export function ProofMarquee({
  ariaLabel,
  classNames = {},
  gap = 14,
  items,
  pixelsPerSecond = 46,
  rows = 2,
}: {
  ariaLabel?: string;
  classNames?: ProofMarqueeClassNames;
  gap?: number;
  items: readonly ProofItem[];
  pixelsPerSecond?: number;
  rows?: number;
}) {
  const lanes = dealIntoRows(items, rows).filter((lane) => lane.length > 0);
  return (
    <section aria-label={ariaLabel} className={classNames.root} data-testid="landing-proof-marquee">
      {lanes.map((lane, laneIndex) => (
        <MarqueeRail
          className={classNames.row}
          direction={laneIndex % 2 === 0 ? 'left' : 'right'}
          gap={gap}
          items={lane}
          key={laneIndex}
          keyOf={proofKey}
          pixelsPerSecond={pixelsPerSecond}
          renderItem={(item) => {
            const Card = PROOF_CARD_RENDERERS[item.kind];
            return Card ? <Card classNames={classNames} item={item as never} /> : null;
          }}
        />
      ))}
    </section>
  );
}
