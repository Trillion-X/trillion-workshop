// tools/ui/show/marketing-page/Hero.tsx
//
// PURPOSE
//   The top of a marketing page: the page's one h1, whose last word (or the phrase `highlight` names) is drawn solid, a lead line under it, and one call to action with
//   an optional note. A page row's layout names it by file and export (`ui/show/marketing-page/Hero.tsx#Hero`) and gives it
//   these props, so a page and an AI app's screen draw the same hero.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no fetch, no window and no state while it renders. Every word is a prop; nothing is held here.
//   2. Built only from this folder's shared parts (SectionShell, TextColumn, StatementText, Text, CtaBlock); no raw HTML, no
//      inline styling of its own.
//   3. No call to action is drawn unless both its label and its address are given.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { CtaBlock, SectionShell, StatementText, Text, TextColumn } from './MarketingPagePrimitives.tsx';

export type HeroProps = {
  /** The heading; its last word is drawn solid, or `highlight` when that is given. */
  heading: string;
  /** The words of the heading drawn solid (the last occurrence in it); left out, the last word. */
  highlight?: string;
  /** The line under the heading. */
  lead?: string;
  /** The one action: its words and where it goes. */
  cta?: { label: string; href: string };
  /** A short line under the action. */
  note?: string;
};

export function Hero({ heading, highlight, lead, cta, note }: HeroProps) {
  const found = highlight ? heading.lastIndexOf(highlight) : -1;
  const at = found >= 0 ? found : heading.lastIndexOf(' ') + 1;
  const end = found >= 0 ? found + (highlight as string).length : heading.length;
  return (
    <SectionShell paddingY="hero" size="narrow">
      <TextColumn align="center">
        <Text as="h1"><StatementText align="center" lines={[[{ text: heading.slice(0, at) }, { text: heading.slice(at, end), solid: true }, { text: heading.slice(end) }].filter(part => part.text !== '')]} /></Text>
        {lead ? <Text color="muted">{lead}</Text> : null}
        {cta && cta.label !== '' && cta.href !== '' ? <CtaBlock id="hero-cta" href={cta.href} label={cta.label} note={note} /> : null}
      </TextColumn>
    </SectionShell>
  );
}
