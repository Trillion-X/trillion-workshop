// tools/ui/show/marketing-page/Heading.tsx
//
// PURPOSE
//   A heading of a marketing page as the program's pages draw it: a page's heading size, with the words `highlight` names drawn
//   solid (the heading's last word when `highlight` is left out and `solid_last` is true; nothing when neither). The page's one
//   h1 is the Hero's; a section's heading is this part as an h2. A page row names it as `ui/show/marketing-page/Heading.tsx#Heading`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no fetch, no window and no state while it renders. Every word is a prop.
//   2. The heading is one element of the level `as` names (h2 by default); the solid words are inside it, in order, with the
//      words before and after them drawn plain.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { SectionShell, StatementText, Text } from './MarketingPagePrimitives.tsx';

/** The heading split into plain and solid parts: the last occurrence of `highlight`, else (solid_last) the last word. */
export function statementLinesOf(heading: string, highlight?: string, solidLast = false) {
  const found = highlight ? heading.lastIndexOf(highlight) : -1;
  if (found < 0 && !solidLast) return [[{ text: heading }]];
  const at = found >= 0 ? found : heading.lastIndexOf(' ') + 1;
  const end = found >= 0 ? found + (highlight as string).length : heading.length;
  return [[{ text: heading.slice(0, at) }, { text: heading.slice(at, end), solid: true }, { text: heading.slice(end) }].filter(part => part.text !== '')];
}

export type HeadingProps = {
  text: string;
  highlight?: string;
  solid_last?: boolean;
  as?: 'h1' | 'h2' | 'h3';
  /** Room above and below the heading, easing in with the width (53px each at 1280, 28px on a phone). */
  spaced?: boolean;
};

const SPACED = { margin: 'clamp(1.743rem,4.15vw,3.32rem) 0' } as const;

export function Heading({ text, highlight, solid_last = false, as = 'h2', spaced = false }: HeadingProps) {
  return <Text as={as} style={spaced ? SPACED : undefined}><StatementText align="center" size="page" lines={statementLinesOf(text, highlight, solid_last)} /></Text>;
}

export type SectionProps = {
  children?: React.ReactNode;
  /** The widest the section is: narrow (1024), default (1152) or wide (1280). */
  size?: 'narrow' | 'default' | 'wide';
  /** The space above and below the section. */
  padding?: 'none' | 'compact' | 'default' | 'hero';
};

/** A page section as the marketing pages draw one: a centred column of its size with its side margins and its own padding. */
export function Section({ children, size = 'default', padding = 'default' }: SectionProps) {
  return <SectionShell size={size} paddingY={padding}>{children}</SectionShell>;
}
