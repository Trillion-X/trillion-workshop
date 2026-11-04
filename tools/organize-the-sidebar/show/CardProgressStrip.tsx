// packages/group/show/CardProgressStrip.tsx
//
// A thin progress strip pinned to a card's BOTTOM EDGE (the Trello/Asana card-progress pattern):
// an absolute overlay that shows how done the card is at a glance, WITHOUT consuming content height
// (so it never clips the note's text or fights the #217 auto-height measure). Blind: it renders the
// {percent, complete} it's handed — the derivation (metric vs checklist) lives in `cardProgressView`
// (L090). Built on the `ui` Container primitive; the track sits on the card's lower border radius.

import * as React from 'react';
import { Container } from '../../ui';

export interface CardProgressStripProps {
  /** Whole-percent completion 0..100. */
  readonly percent: number;
  /** 100% reached → the fill turns success-green; otherwise the accent colour. */
  readonly complete: boolean;
}

/** The bottom-edge fill bar. `percent` is clamped defensively so a bad value can't overflow the card. */
export function CardProgressStrip({ percent, complete }: CardProgressStripProps): React.ReactElement {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <Container
      position="absolute"
      aria-hidden
      style={{ left: 0, right: 0, bottom: 0, height: 3, background: 'var(--surface-muted, rgba(0,0,0,0.08))', borderBottomLeftRadius: 'inherit', borderBottomRightRadius: 'inherit', overflow: 'hidden', pointerEvents: 'none' }}
    >
      <Container
        position="absolute"
        style={{ left: 0, top: 0, bottom: 0, width: `${width}%`, background: complete ? 'var(--color-success, #16a34a)' : 'var(--accent-primary, #3b6fe0)' }}
      />
    </Container>
  );
}
