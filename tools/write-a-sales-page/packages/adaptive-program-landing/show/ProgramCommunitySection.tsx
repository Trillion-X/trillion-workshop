'use client';

import React from 'react';
import { SectionShell, TextColumn } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { StatementText } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { PROGRAM_HERO_ENGRAVED_HEADING_STYLE } from './programHeroTypography';
import styles from '@/packages/screen-look/show/adaptive-program-landing/ProgramCommunitySection.module.css';
import { useProgramLandingData } from './ProgramLandingData';

export function ProgramCommunitySection() {
  const data = useProgramLandingData();
  const journeySections = data.community.journeySections as readonly any[];
  const communityFeed = data.community.feed as readonly any[];
  const [activePost, setActivePost] = React.useState(0);
  const feedRailRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setActivePost((current) => (current + 1) % communityFeed.length), 4200);
    return () => window.clearInterval(timer);
  }, []);

  React.useEffect(() => {
    const rail = feedRailRef.current;
    if (!rail || !window.matchMedia('(max-width: 760px)').matches) return;
    const card = rail.querySelector<HTMLElement>(`[data-community-post="${activePost}"]`);
    if (!card) return;
    rail.scrollTo({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      left: card.offsetLeft - rail.offsetLeft,
    });
  }, [activePost]);

  return (
    <SectionShell size="wide" paddingY="default" id="community">
      <TextColumn measure="hero" align="center" className="gap-3">
        <p className={styles.mechanism}>{data.community.mechanism}</p>
        <StatementText
          lines={[data.presentation.community.headline]}
          size="section"
          align="center"
          className="program-heading"
          style={PROGRAM_HERO_ENGRAVED_HEADING_STYLE}
        />
        <p className={styles.copy}>{data.community.copy}</p>
      </TextColumn>

      <div className={styles.app} data-testid="program-community-section" data-active-post={activePost} data-theme="midnight">
        <aside className={styles.sidebar} aria-label={data.community.ariaLabel}>
          {journeySections.map((section) => (
            <div className={styles.collection} key={section.id}>
              <strong>{section.title}</strong>
              <div className={styles.collectionItems}>
                {section.items.map((item: any) => (
                  <span className={styles.journeyItem} data-active={item.id === data.presentation.community.currentSelectionId ? 'true' : undefined} key={item.id}>
                    <i aria-hidden="true" className={styles.itemMark} />
                    {item.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </aside>

        <div className={styles.workspace}>
          <div className={styles.workspaceBar}><span>{data.presentation.community.workspaceLabel}</span><span aria-hidden="true">＋⌄</span></div>
          <div className={styles.feedHeader}>
            <div><span>{data.presentation.community.sectionLabel}</span><h3>{data.presentation.community.workspaceLabel}</h3></div>
            <span>{data.presentation.community.countTemplate.replace('{count}', String(communityFeed.length))}</span>
          </div>
          <div className={styles.feedGrid}>
            <div className={styles.feedRail} ref={feedRailRef}>
              {communityFeed.map((post, index) => (
                <button className={styles.postCard} data-active={activePost === index ? 'true' : undefined} data-community-post={index} key={post.title} onClick={() => setActivePost(index)} type="button">
                  <span>{post.kind}</span>
                  <strong>{post.title}</strong>
                  <p>{post.summary}</p>
                </button>
              ))}
            </div>
            <article className={styles.discussion} key={communityFeed[activePost].title}>
              <span className={styles.discussionLabel}>{data.presentation.community.discussionLabel}</span>
              <h4>{communityFeed[activePost].title}</h4>
              <p>{communityFeed[activePost].discussion}</p>
              <div className={styles.reply}>
                <span>{data.presentation.community.promptLabel}</span>
                <p>{data.presentation.community.prompt}</p>
              </div>
              <div className={styles.composer}><span>{data.presentation.community.composerPlaceholder}</span><strong>{data.presentation.community.submitLabel}</strong></div>
            </article>
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
