'use client';

// A still masonry wall of short named pull-quotes from real players worldwide.
// Distinct from the moving marquee: same corpus, but a scannable static wall of
// punchy one-liners. Anatomy grounded on Lemon Squeezy / Clay wall-of-love /
// GitHub quote walls (Mobbin, 2026-08-27).

import React from 'react';
import { SectionShell, TextColumn } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { StatementText } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { PROGRAM_HERO_ENGRAVED_HEADING_STYLE } from './programHeroTypography';
import { useProgramLandingData } from './ProgramLandingData';
import type { ProgramTestimonial } from '../read-data/program-landing-data';
import styles from '@/packages/screen-look/show/adaptive-program-landing/ProgramNamedStrip.module.css';

export function ProgramNamedStrip({ quotes }: { quotes?: readonly ProgramTestimonial[] }) {
  const data = useProgramLandingData();
  const visibleQuotes = quotes ?? data.marqueeTestimonials
    .filter((testimonial) => testimonial.name.startsWith('@'))
    .slice(0, 9);
  return (
    <SectionShell size="wide" paddingY="default" id="program-quote-wall">
      <TextColumn measure="hero" align="center" className="gap-3">
        <StatementText
          lines={[data.presentation.testimonials.wallHeadline]}
          size="section"
          align="center"
          className="program-heading"
          style={PROGRAM_HERO_ENGRAVED_HEADING_STYLE}
        />
      </TextColumn>
      <div className={styles.wall} data-testid="program-named-strip">
        {visibleQuotes.map((testimonial) => (
          <figure className={styles.card} key={testimonial.name}>
            <blockquote className={styles.quote}>{testimonial.quote}</blockquote>
            <figcaption className={styles.handle}>{testimonial.name}</figcaption>
          </figure>
        ))}
      </div>
    </SectionShell>
  );
}
