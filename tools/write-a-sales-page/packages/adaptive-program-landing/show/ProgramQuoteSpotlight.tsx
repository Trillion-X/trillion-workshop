'use client';

// A single large customer-quote spotlight beat: one real player result, set
// centered on the paper canvas with a soft green wash behind it. Distinct from
// the moving marquee (this is one still, oversized voice). Anatomy grounded on
// Vizcom / Glide / Coda single-quote sections (Mobbin, 2026-08-27).

import React from 'react';
import { SectionShell } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { useProgramLandingData } from './ProgramLandingData';
import styles from '@/packages/screen-look/show/adaptive-program-landing/ProgramQuoteSpotlight.module.css';

type SpotlightQuote = {
  readonly quote: string;
  readonly name: string;
  readonly role: string;
};

export function ProgramQuoteSpotlight({ testimonial }: { testimonial?: SpotlightQuote }) {
  const data = useProgramLandingData();
  const visibleTestimonial = testimonial ?? data.proofDefaults.quoteSpotlight;
  return (
    <SectionShell size="wide" paddingY="default" id="program-result">
      <figure className={styles.root} data-testid="program-quote-spotlight">
        <span aria-hidden="true" className={styles.glow} />
        <span aria-hidden="true" className={styles.mark}>&ldquo;</span>
        <blockquote className={styles.quote}>{visibleTestimonial.quote}</blockquote>
        <figcaption className={styles.caption}>
          <span className={styles.name}>{visibleTestimonial.name}</span>
          <span className={styles.role}>{visibleTestimonial.role}</span>
        </figcaption>
      </figure>
    </SectionShell>
  );
}
