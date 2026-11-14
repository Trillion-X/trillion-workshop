'use client';

// bitfield/packages/adaptive-program-landing/show/ProgramComparisonShowcase.tsx
//
// Purpose
// -------
// Adapter: the package set's side-by-side comparison rows in, the shared
// featured-media showcase out. Appearance comes from this package set's own
// appearance owner; structure and behaviour come from packages/ui.
//
// Why it is its own file: the page shows this pair in more than one place —
// once high, right under the first call to action, and again inside the
// library section. Two copies would be two things to keep in step, so there is
// one adapter and the page's DATA decides where it appears.

import React from 'react';
import { FeaturedMediaShowcase } from '@/packages/ui/show/marketing-page/LandingMedia';
import type { LandingMediaItem } from '@/packages/ui/show/marketing-page/LandingMedia';
import styles from '@/packages/screen-look/show/adaptive-program-landing/ComparisonLibrarySection.module.css';
import { useProgramLandingData } from './ProgramLandingData';

export type MediaComparison = {
  readonly detail: string;
  readonly featured?: boolean;
  readonly id: string;
  readonly reference: string;
  readonly src: string;
  readonly subject: string;
};

const SHOWCASE_CLASS_NAMES = {
  card: styles.comparisonCard,
  carousel: styles.comparisonCarousel,
  featuredCard: styles.featuredCard,
  featuredSlot: styles.featuredComparison,
  media: styles.comparisonVideo,
};

export function comparisonLabel(template: string, comparison: MediaComparison) {
  return template.replace('{subject}', comparison.subject).replace('{reference}', comparison.reference);
}

/** Which row is featured is DATA's call (`featured: true`); the first row is
 *  the fallback so a set that names none still renders rather than failing. */
export function useComparisonSplit() {
  const data = useProgramLandingData();
  const copy = data.comparisonLibrary;
  const comparisons = data.comparisons as readonly MediaComparison[];
  const featuredRow = comparisons.find((comparison) => comparison.featured) ?? comparisons[0];
  const toItem = (comparison: MediaComparison): LandingMediaItem => ({
    alt: comparisonLabel(copy.comparisonAriaTemplate, comparison),
    id: comparison.id,
    kind: 'video',
    src: comparison.src,
  });
  return {
    featured: toItem(featuredRow),
    rail: comparisons.filter((comparison) => comparison.id !== featuredRow.id).map(toItem),
  };
}

export function ProgramComparisonShowcase({ instanceId = 'showcase' }: { instanceId?: string }) {
  const data = useProgramLandingData();
  const { featured, rail } = useComparisonSplit();
  return (
    <FeaturedMediaShowcase
      carouselAriaLabel={data.comparisonLibrary.carouselAriaLabel}
      classNames={SHOWCASE_CLASS_NAMES}
      featured={featured}
      instanceId={instanceId}
      rail={rail}
    />
  );
}
