// parts/ui/show/border-beam/BorderBeam.tsx
//
// PURPOSE
//   A light travelling round the border of the box it sits in while that box is at work: the look's thread runs the
//   edge, as the loading mark's needle runs its stitch, so a box that is answering shows it without a spinner of its own.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Decoration only: aria-hidden, no pointer events, no layout of its own. The words that say what is happening
//      stay with the caller (the composer's busy line).
//   2. CSS only; no script runs per frame. The motion is screen-look's border-beam.css.
//   3. It never flashes: it shows only once the work has lasted about 300 ms, and fades out when it ends.
//   4. Reduced motion holds a still, faint ring.
//
// PROVENANCE
//   Motion anatomy from Libraries.dev "Border beam" (border-beam, MIT, Jakub Antalik; a conic beam on an animated
//   angle, masked to the border ring, with a blurred bloom). Written from scratch here, no code copied.

import React from 'react';
import { Container } from '../container';

export type BorderBeamProps = {
  /** Whether the box is at work now. Off fades the beam out. */
  on: boolean;
  className?: string;
};

/** The beam: put it as a direct child of the positioned box whose border it travels; the box keeps its own corners. */
export function BorderBeam({ on, className }: BorderBeamProps) {
  return (
    <Container as="span" className={['border-beam', className].filter(Boolean).join(' ')}
      data-border-beam={on ? 'on' : 'off'} aria-hidden="true">
      <Container as="span" className="border-beam-bloom">
        <Container as="span" className="border-beam-ring" />
      </Container>
      <Container as="span" className="border-beam-ring" />
    </Container>
  );
}
