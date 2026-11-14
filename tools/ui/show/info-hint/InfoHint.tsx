// parts/ui/show/info-hint/InfoHint.tsx
//
// PURPOSE
//   The small "i" beside a heading that holds what used to be a line of explaining text under it. Hovering, focusing or
//   pressing it opens an animated popover with that text (and an optional title); moving away, Escape or pressing again
//   closes it. Replaces helper subtext everywhere, so a page shows its heading and its work, and the explanation is one
//   hover away. Anatomy after 21st.dev 403 "Popover" (originui, tooltip-like popover) and the workspace sidebar's hover
//   cards.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: every word is the caller's; nothing here names a page, product or feature.
//   2. Reachable without a mouse: the trigger is a real button named by `label`, focus and Enter open it, Escape closes.
//   3. Controls are the shared coss Popover and Button; appearance is the coss popover tokens (no colours here).

import React from 'react';
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle, PopoverTrigger } from '../coss/ui/popover';
import { Button } from '../coss/ui/button';
import { NamedIcon } from '../icon';

export interface InfoHintProps {
  /** What a screen reader says for the icon ("About spaces"). */
  label: string;
  /** The words the popover shows. */
  text: string;
  /** An optional short title above the words. */
  title?: string;
  /** Default above the icon: it opens on hover, so below would sit under the pointer. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
}

/** How long a hover rests before the popover opens, and before it closes after leaving. */
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 150;

export function InfoHint({ label, text, title, side = 'top', align = 'start' }: InfoHintProps) {
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={OPEN_DELAY_MS}
        closeDelay={CLOSE_DELAY_MS}
        data-slot="info-hint"
        aria-label={label}
        render={<Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" />}
      >
        <NamedIcon name="Info" size="sm" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup side={side} align={align} sideOffset={6} className="max-w-72" data-slot="info-hint-content">
        {title ? <PopoverTitle className="mb-1.5 text-sm">{title}</PopoverTitle> : null}
        <PopoverDescription className="text-sm leading-relaxed">{text}</PopoverDescription>
      </PopoverPopup>
    </Popover>
  );
}
