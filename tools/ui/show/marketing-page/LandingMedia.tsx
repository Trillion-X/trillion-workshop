// bitfield/packages/ui/show/marketing-page/LandingMedia.tsx
//
// Purpose
// -------
// The marketing page's media furniture: one media card, and one "featured item
// above a rail of the rest" showcase built from it.
//
// Non-negotiable invariants
// -------------------------
// - This file names no product, subject, person or industry. Every string is
//   the caller's.
// - Appearance is the CALLER's: every element takes a `className` the caller
//   supplies from its own appearance owner (screen-look). This file owns
//   STRUCTURE and BEHAVIOUR only, which is why a tenant can restyle the card
//   without a second component existing.
// - Raw media/layout tags are legal here and nowhere downstream: this is the
//   shared UI owner, so feature packages compose these instead of authoring
//   their own `<video>`/`<div>` (the same rule MediaFrame states).
//
// Key concepts
// ------------
// - A media item is SELF-DESCRIBING (`kind: 'video' | 'image'`). The renderer
//   never enumerates a tenant's media taxonomy; it dispatches on the item's own
//   declared kind, so a new media kind is a new leaf here, never a branch in
//   every caller.

'use client';

import React from 'react';
import { MediaCarousel } from '../media-carousel';

export type LandingMediaItem = {
  readonly alt: string;
  readonly id: string;
  readonly kind?: 'image' | 'video';
  readonly src: string;
};

export type LandingMediaClassNames = {
  readonly card?: string;
  readonly carousel?: string;
  readonly featuredCard?: string;
  readonly featuredSlot?: string;
  readonly media?: string;
};

export function LandingMediaCard({
  classNames = {},
  featured = false,
  item,
}: {
  classNames?: LandingMediaClassNames;
  featured?: boolean;
  item: LandingMediaItem;
}) {
  const cardClass = [classNames.card, featured ? classNames.featuredCard : undefined].filter(Boolean).join(' ');
  return (
    <div className={cardClass} data-featured={featured ? 'true' : 'false'} data-landing-media-card={item.id}>
      {item.kind === 'image' ? (
        <img alt={item.alt} className={classNames.media} decoding="async" loading="lazy" src={item.src} />
      ) : (
        <video
          aria-label={item.alt}
          autoPlay
          className={classNames.media}
          data-testid={`landing-media-${item.id}`}
          loop
          muted
          playsInline
          preload="auto"
          src={item.src}
        />
      )}
    </div>
  );
}

/**
 * One featured media item, with the remaining items on a manual carousel rail
 * beneath it. Which item is featured is the caller's decision, arriving as
 * `featured`; this composes, it does not choose.
 */
export function FeaturedMediaShowcase({
  carouselAriaLabel,
  classNames = {},
  featured,
  instanceId = 'showcase',
  rail,
}: {
  carouselAriaLabel?: string;
  classNames?: LandingMediaClassNames;
  featured: LandingMediaItem;
  instanceId?: string;
  rail: readonly LandingMediaItem[];
}) {
  return (
    <div
      data-landing-media-showcase={instanceId}
      data-testid="landing-media-showcase"
      style={{ display: 'grid', gap: 26, minWidth: 0 }}
    >
      <div className={classNames.featuredSlot} data-testid="landing-media-featured">
        <LandingMediaCard classNames={classNames} featured item={featured} />
      </div>
      {rail.length > 0 ? (
        <MediaCarousel
          ariaLabel={carouselAriaLabel}
          className={classNames.carousel}
          data-testid="landing-media-carousel"
          items={rail.map((item) => ({ alt: item.alt, id: item.id, kind: item.kind ?? 'video', src: item.src }))}
          renderItem={(_, index) => <LandingMediaCard classNames={classNames} item={rail[index]} />}
          showEdgeFade
          showLabels={false}
        />
      ) : null}
    </div>
  );
}
