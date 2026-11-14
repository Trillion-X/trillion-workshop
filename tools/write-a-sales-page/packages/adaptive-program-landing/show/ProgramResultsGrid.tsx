'use client';

// A three-up grid of named-student result cards: each card leads with the
// outcome (green result chip), then the real quote, then name + role. Distinct
// from the marquee (still, scannable, outcome-first). Anatomy grounded on
// Programa / Contractbook / Campsite result-card grids (Mobbin, 2026-08-27).

import React from 'react';
import { SectionShell, TextColumn } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { StatementText } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { PROGRAM_HERO_ENGRAVED_HEADING_STYLE } from './programHeroTypography';
import { useProgramLandingData } from './ProgramLandingData';
import styles from '@/packages/screen-look/show/adaptive-program-landing/ProgramResultsGrid.module.css';

type ResultCard = {
  readonly quote: string;
  readonly name: string;
  readonly role: string;
};

export function ProgramResultsGrid({ cards }: { cards?: readonly ResultCard[] }) {
  const data = useProgramLandingData();
  const visibleCards = cards ?? data.proofDefaults.resultCards;
  return (
    <SectionShell size="wide" paddingY="default" id="program-results">
      <TextColumn measure="hero" align="center" className="gap-3">
        <StatementText
          lines={[data.presentation.testimonials.resultsHeadline]}
          size="section"
          align="center"
          className="program-heading"
          style={PROGRAM_HERO_ENGRAVED_HEADING_STYLE}
        />
      </TextColumn>
      <div className={styles.grid} data-testid="program-results-grid">
        {visibleCards.map((card: ResultCard) => (
          <figure className={styles.card} key={card.name}>
            <blockquote className={styles.quote}>{card.quote}</blockquote>
            <figcaption className={styles.caption}>
              <span className={styles.name}>{card.name}</span>
              <span className={styles.role}>{card.role}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </SectionShell>
  );
}
