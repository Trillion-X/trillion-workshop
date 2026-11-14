'use client';

// bitfield/packages/adaptive-program-landing/show/ProgramProofMarquee.tsx
//
// Purpose
// -------
// Adapter: package-set DATA in, shared ProofMarquee out. It holds no markup,
// no copy and no field names — the weave descriptor in DATA says which arrays
// are read and which of their keys carry the generic fields.
//
// This replaced a package-local marquee that hand-rolled its own tracks and
// declared `92s` as its animation. A duration is not a speed: with four cards
// per lane that was roughly thirteen pixels a second, and it changed every
// time a row was added or removed. The rail now takes pixels per second and
// derives the duration from its own measured width.

import React from 'react';
import { ProofMarquee } from '@/packages/ui/show/marketing-page/ProofMarquee';
import type { ProofItem } from '@/packages/ui/show/marketing-page/ProofMarquee';
import styles from '@/packages/screen-look/show/adaptive-program-landing/ProgramTestimonialMarquee.module.css';
import { useProgramLandingData } from './ProgramLandingData';
import { weaveProofItems } from '../read-data/weave-proof-items';
import type { ProofWeaveDescriptor } from '../read-data/weave-proof-items';

const PROOF_MARQUEE_CLASS_NAMES = {
  attribution: styles.attribution,
  media: styles.media,
  mediaCard: styles.mediaCard,
  quoteCard: styles.card,
  quoteText: styles.quote,
  root: styles.root,
  row: styles.row,
};

export function ProgramProofMarquee({
  pixelsPerSecond,
  rows,
  weave,
}: {
  pixelsPerSecond?: number;
  rows?: number;
  weave: ProofWeaveDescriptor;
}) {
  const data = useProgramLandingData();
  const items = weaveProofItems(data as unknown as Record<string, unknown>, weave) as unknown as readonly ProofItem[];
  return (
    <ProofMarquee
      ariaLabel={data.presentation.testimonials.marqueeAriaLabel}
      classNames={PROOF_MARQUEE_CLASS_NAMES}
      items={items}
      pixelsPerSecond={pixelsPerSecond}
      rows={rows}
    />
  );
}
