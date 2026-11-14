'use client';

// A single featured-story beat on a dark panel: an oversized outcome on the
// left, the real quote + attribution on the right. Distinct from the light
// cards and marquee (this is the one big anchor story, echoing the dark
// community app for brand cohesion). Anatomy grounded on Charma / Apollo
// featured-quote sections (Mobbin, 2026-08-27).

import React from 'react';
import { SectionShell } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { useProgramLandingData } from './ProgramLandingData';
import styles from '@/packages/screen-look/show/adaptive-program-landing/ProgramStoryBlock.module.css';

type Story = {
  readonly outcome: string;
  readonly quote: string;
  readonly name: string;
  readonly role: string;
};

export function ProgramStoryBlock({ story }: { story?: Story }) {
  const data = useProgramLandingData();
  const visibleStory = story ?? data.proofDefaults.story;
  return (
    <SectionShell size="wide" paddingY="default" id="program-story">
      <figure className={styles.panel} data-testid="program-story-block">
        <div className={styles.outcomeColumn}>
          <p className={styles.outcome}>{visibleStory.outcome}</p>
        </div>
        <div className={styles.quoteColumn}>
          <span aria-hidden="true" className={styles.mark}>&ldquo;</span>
          <blockquote className={styles.quote}>{visibleStory.quote}</blockquote>
          <figcaption className={styles.caption}>
            <span className={styles.name}>{visibleStory.name}</span>
            <span className={styles.role}>{visibleStory.role}</span>
          </figcaption>
        </div>
      </figure>
    </SectionShell>
  );
}
