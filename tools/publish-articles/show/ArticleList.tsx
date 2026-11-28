// tools/publish-articles/show/ArticleList.tsx
//
// The list of published articles, newest first. Its props are the answer of tool:read-published-articles; the heading, the
// lede and the empty words are the person's own, handed in with it. Pure: nothing is fetched and no window is read.
import React from 'react';
import { SectionShell, StatementText, Text, TextColumn } from '../../ui/show/marketing-page/MarketingPagePrimitives.tsx';
import { Button } from '../../ui/show/button/Button.tsx';
import type { ArticleListAnswer } from '../do-work/articles.ts';

export type ArticleListProps = ArticleListAnswer & { heading: string; lede?: string; empty?: string; base_path?: string };

export function View({ articles, heading, lede, empty, base_path = '/articles' }: ArticleListProps) {
  const at = heading.lastIndexOf(' ') + 1;
  return (
    <>
      <SectionShell paddingY="hero" size="narrow">
        <TextColumn align="center">
          <Text as="h1"><StatementText align="center" lines={[[{ text: heading.slice(0, at) }, { text: heading.slice(at), solid: true }]]} size="footer" /></Text>
          {lede ? <Text color="muted">{lede}</Text> : null}
        </TextColumn>
      </SectionShell>
      <SectionShell paddingY="default" size="narrow">
        {articles.length ? (
          <Text as="ul" aria-label={heading}>
            {articles.map(article => (
              <Text as="li" key={article.slug}>
                <Button href={`${base_path}/${encodeURIComponent(article.slug)}`} variant="secondary" size="lg" wrap>{article.title}</Button>
                <Text color="muted">{article.description}</Text>
              </Text>
            ))}
          </Text>
        ) : <Text color="muted">{empty ?? ''}</Text>}
      </SectionShell>
    </>
  );
}
