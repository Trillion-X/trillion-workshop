// tools/compare-two-movements-side-by-side/show/PairShowcase.tsx
//
// PURPOSE
//   The comparisons as a landing page shows them: one featured movement large, and every other pair in a sideways carousel
//   under it, with the carousel's arrows and dots. The featured pair is the row marked `featured`, else the first. Nothing
//   is left out: the featured pair and the carousel together hold every pair of the answer.
//
// NON-NEGOTIABLE INVARIANTS
//   1. View is pure: no fetch and no window while it renders. The carousel's own state (which item is in view) is the shared
//      MediaCarousel's; this file passes it items and classes only.
//   2. Every pair is drawn once. A pair that is one video (`video`) plays that video; a pair of two clips plays its left
//      clip here, and show/SideBySide.tsx is the screen that plays both at once.
//   3. Built from the shared FeaturedMediaShowcase (ui/show/marketing-page/LandingMedia.tsx) and the screen look's classes;
//      no raw HTML and no inline styling here.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { FeaturedMediaShowcase, type LandingMediaItem } from '../../ui/show/marketing-page/LandingMedia.tsx';
import styles from '../../screen-look/show/adaptive-program-landing/ComparisonLibrarySection.module.css';
import type { Pair, Pairs } from '../do-work/pair.ts';
import { videoAddress } from './video-address.ts';

export type PairShowcaseProps = Pairs & {
  /** Put in front of a video value that is a storage key. */
  filesBase?: string;
  /** The words a screen reader says of the carousel. */
  carouselLabel?: string;
  /** The words a screen reader says of each video; {title} is the pair's title. */
  videoLabel?: string;
  /** Which pair is featured: its id; else the one marked featured, else the first. */
  featuredId?: string;
};

const CLASS_NAMES = {
  card: styles.comparisonCard,
  carousel: styles.comparisonCarousel,
  featuredCard: styles.featuredCard,
  featuredSlot: styles.featuredComparison,
  media: styles.comparisonVideo,
};

function itemOf(pair: Pair, filesBase: string | undefined, videoLabel: string): LandingMediaItem {
  const side = pair.video ?? pair.left!;
  return { id: pair.id, kind: 'video', src: videoAddress(side.video, filesBase), alt: videoLabel.replace('{title}', pair.title) };
}

export function View({ pairs, filesBase, carouselLabel = '', videoLabel = '{title}', featuredId }: PairShowcaseProps) {
  if (pairs.length === 0) return null;
  const featured = pairs.find(pair => pair.id === featuredId) ?? pairs.find(pair => pair.featured) ?? pairs[0];
  const rest = pairs.filter(pair => pair.id !== featured.id);
  return (
    <FeaturedMediaShowcase
      carouselAriaLabel={carouselLabel}
      classNames={CLASS_NAMES}
      featured={itemOf(featured, filesBase, videoLabel)}
      instanceId="pairs"
      rail={rest.map(pair => itemOf(pair, filesBase, videoLabel))}
    />
  );
}
