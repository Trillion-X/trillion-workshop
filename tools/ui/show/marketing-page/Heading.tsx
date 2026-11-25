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
import { StatementText, Text } from './MarketingPagePrimitives.tsx';

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
};

export function Heading({ text, highlight, solid_last = false, as = 'h2' }: HeadingProps) {
  return <Text as={as}><StatementText align="center" size="page" lines={statementLinesOf(text, highlight, solid_last)} /></Text>;
}
