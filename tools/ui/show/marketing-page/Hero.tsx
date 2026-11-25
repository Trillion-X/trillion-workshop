// tools/ui/show/marketing-page/Hero.tsx
//
// PURPOSE
//   The top of a marketing page: the page's one h1, whose last word (or the phrase `highlight` names) is drawn solid, a lead line under it, and one call to action with
//   an optional note. A page row's layout names it by file and export (`ui/show/marketing-page/Hero.tsx#Hero`) and gives it
//   these props, so a page and an AI app's screen draw the same hero.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no fetch, no window and no state while it renders. Every word is a prop; nothing is held here.
//   2. Built only from this folder's shared parts (SectionShell, TextColumn, StatementText, Text, CtaBlock); no raw HTML, and
//      the only style it sets is the lead's own type (LEAD) and the colour of the lead's highlighted words.
//   3. No call to action is drawn unless both its label and its address are given.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { CtaBlock, SectionShell, StatementText, Text, TextColumn } from './MarketingPagePrimitives.tsx';
import { statementLinesOf } from './Heading.tsx';

export type HeroProps = {
  /** The heading; its last word is drawn solid, or `highlight` when that is given. */
  heading: string;
  /** The words of the heading drawn solid (the last occurrence in it); left out, the last word. */
  highlight?: string;
  /** The line under the heading. */
  lead?: string;
  /** The words of the lead drawn solid, as the heading's are. */
  lead_highlight?: string;
  /** The most the hero's section is wide (px, with its side padding); the narrow section's 1024 when left out. */
  width?: number;
  /** The space above and below the hero: `hero` when left out, `none` for a hero that sits right under the page's header. */
  padding?: 'none' | 'compact' | 'hero';
  /** The one action: its words and where it goes. */
  cta?: { label: string; href: string };
  /** A short line under the action. */
  note?: string;
};

const LEAD = { color: 'rgba(15,23,42,.74)', fontSize: 'clamp(1.12rem,2vw,1.55rem)', fontWeight: 500, lineHeight: 1.45, margin: '18px auto 0', maxWidth: 820 } as const;

export function Hero({ heading, highlight, lead, lead_highlight, width, padding = 'hero', cta, note }: HeroProps) {
  const parts = lead && lead_highlight && lead.includes(lead_highlight) ? lead.split(lead_highlight) : null;
  return (
    <SectionShell paddingY={padding} size="narrow" style={width ? { maxWidth: width } : undefined}>
      <TextColumn align="center">
        <Text as="h1"><StatementText align="center" size="page" lines={statementLinesOf(heading, highlight, true)} /></Text>
        {lead ? <Text style={LEAD}>{parts ? <>{parts.slice(0, -1).map((part, index) => <React.Fragment key={index}>{part}<span style={{ color: '#008652' }}>{lead_highlight}</span></React.Fragment>)}{parts[parts.length - 1]}</> : lead}</Text> : null}
        {cta && cta.label !== '' && cta.href !== '' ? <CtaBlock id="hero-cta" href={cta.href} label={cta.label} note={note} /> : null}
      </TextColumn>
    </SectionShell>
  );
}
