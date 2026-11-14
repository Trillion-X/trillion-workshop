// The Program hero is the visual source of truth for every long-form landing
// heading. Keep the exact hero treatment here so statement, bridge, comparison,
// recalculation, and closing-question headings cannot drift independently.

import type { CSSProperties } from 'react';
import { ENGRAVED_HEADING_FILTER } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';

export const PROGRAM_HERO_HEADING_STYLE = {
  color: '#0f172a',
  fontFamily: 'var(--font-body, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)',
  fontSize: 'clamp(2.1rem, 4.7vw + 0.85rem, 4rem)',
  fontWeight: 700,
  letterSpacing: '-0.02em',
  lineHeight: 1.05,
} as const satisfies CSSProperties;

export const PROGRAM_HERO_ENGRAVED_HEADING_STYLE = {
  ...PROGRAM_HERO_HEADING_STYLE,
  filter: ENGRAVED_HEADING_FILTER,
} as const satisfies CSSProperties;

/** Red ink is reserved for full-viewport bridge emphasis on the paper canvas. */
export const PROGRAM_BRIDGE_SOLID_HIGHLIGHT_COLOR = 'var(--bf-red)';
