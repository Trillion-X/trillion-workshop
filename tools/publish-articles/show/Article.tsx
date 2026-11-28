// tools/publish-articles/show/Article.tsx
//
// One published article: category, title, description, picture, its sections in order, the short version, the sources, the
// articles to read next and the course it points to. Its props are the answer of tool:read-a-published-article. Pure:
// nothing is fetched, no window is read, and every word is drawn as text, never as markup. The links to the next articles and
// the course are Buttons given `wrap`: their labels are titles, which on a phone are wider than the screen, so the label
// wraps inside the button instead of making the page wider than the screen.
import React from 'react';
import { SectionShell, StatementText, Text, TextColumn } from '../../ui/show/marketing-page/MarketingPagePrimitives.tsx';
import { Button } from '../../ui/show/button/Button.tsx';
import type { ArticleAnswer } from '../do-work/articles.ts';
import { Inline } from './Inline.tsx';

export type ArticleProps = ArticleAnswer & { base_path?: string; course_path?: string; not_found?: string };

export function View({ article, base_path = '/articles', course_path = '/courses', not_found = '' }: ArticleProps) {
  if (!article) return <SectionShell paddingY="hero" size="narrow"><Text color="muted">{not_found}</Text></SectionShell>;
  const at = article.title.lastIndexOf(' ') + 1;
  return (
    <>
      <SectionShell paddingY="hero" size="narrow">
        <TextColumn align="center">
          <Text color="muted">{article.category}</Text>
          <Text as="h1"><StatementText align="center" lines={[[{ text: article.title.slice(0, at) }, { text: article.title.slice(at), solid: true }]]} size="footer" /></Text>
          <Text color="muted">{article.description}</Text>
          {article.published_at ? <Text as="time" dateTime={article.published_at}>{article.published_at.slice(0, 10)}</Text> : null}
        </TextColumn>
      </SectionShell>
      {article.image ? <SectionShell paddingY="compact" size="narrow"><Text as="img" alt="" loading="lazy" src={article.image} /></SectionShell> : null}
      <SectionShell paddingY="compact" size="narrow">
        <Text as="article">
          {article.sections.map((section, sectionIndex) => (
            <Text as="section" key={section.heading ?? `intro-${sectionIndex}`}>
              {section.heading ? <Text as="h2">{section.heading}</Text> : null}
              {section.paragraphs.map((paragraph, index) => ('items' in paragraph
                ? <Text as="ul" key={index}>{paragraph.items.map(item => <Text as="li" key={item}><Inline text={item} /></Text>)}</Text>
                : <Text key={index}><Inline text={paragraph.text} /></Text>))}
            </Text>
          ))}
          {article.short_version.length ? (
            <Text as="section"><Text as="h2">The short version</Text><Text as="ul">{article.short_version.map((line, index) => <Text as="li" key={index}>{line.text}</Text>)}</Text></Text>
          ) : null}
          {article.sources.length ? (
            <Text as="section">
              <Text as="h2">Sources</Text>
              <Text as="ol">
                {article.sources.map(source => (
                  <Text as="li" id={`source-${source.n}`} key={source.n}>
                    <Text as="strong">{source.title}</Text>, {source.label}. {source.excerpt ? `“${source.excerpt}” ` : null}
                    {/^https?:\/\/|^\//i.test(source.href) ? <Button href={source.href} variant="plain" size="xs">{source.href}</Button> : null}
                  </Text>
                ))}
              </Text>
            </Text>
          ) : null}
        </Text>
      </SectionShell>
      {article.related.length ? (
        <SectionShell paddingY="compact" size="narrow">
          <Text as="nav" aria-label="Other articles">
            <Text as="h2">Read next</Text>
            <Text as="ul">{article.related.map(other => (
              <Text as="li" key={other.slug}><Button href={`${base_path}/${encodeURIComponent(other.slug)}`} variant="secondary" size="lg" wrap>{other.title}</Button><Text color="muted">{other.description}</Text></Text>
            ))}</Text>
          </Text>
        </SectionShell>
      ) : null}
      {article.course ? (
        <SectionShell paddingY="default" size="narrow">
          <TextColumn align="center">
            {article.course_cta ? <Text color="muted">{article.course_cta}</Text> : null}
            <Button href={`${course_path}/${encodeURIComponent(article.course.slug)}`} size="lg" variant="primary" wrap>{article.course.title}</Button>
          </TextColumn>
        </SectionShell>
      ) : null}
    </>
  );
}
