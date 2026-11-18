'use client';

import { SectionShell } from '../../../../ui/show/marketing-page/MarketingPagePrimitives';
import { EditorialLinkCard } from '../../../../ui/show/editorial-link-card/EditorialLinkCard';
import { useProgramLandingData } from './ProgramLandingData';
import styles from '../../../../screen-look/show/adaptive-program-landing/ProgramArticlesSection.module.css';
import cardStyles from '../../../../screen-look/show/editorial-link-card/EditorialLinkCard.module.css';

export function ProgramArticlesSection() {
  const data = useProgramLandingData();
  const section = data.featuredArticles;
  if (!section?.items.length) return null;

  return (
    <SectionShell className={styles.section} id="articles" size="wide" paddingY="default">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>{section.eyebrow}</p>
          <h2 className={styles.title}>{section.title}</h2>
          <p className={styles.intro}>{section.intro}</p>
        </div>
        <a className={styles.allLink} href={section.allHref}>{section.allLabel}<span aria-hidden="true"> ↗</span></a>
      </div>
      <div className={styles.grid}>
        {section.items.map((article) => (
          <EditorialLinkCard
            actionClassName={cardStyles.action}
            actionLabel={section.readLabel}
            className={cardStyles.card}
            description={article.summary}
            descriptionClassName={cardStyles.description}
            eyebrow={article.category}
            eyebrowClassName={cardStyles.eyebrow}
            href={article.href}
            key={article.href}
            thumbnailAlt={article.thumbnailAlt}
            thumbnailUrl={article.thumbnailUrl}
            title={article.title}
            titleClassName={cardStyles.title}
          />
        ))}
      </div>
    </SectionShell>
  );
}
