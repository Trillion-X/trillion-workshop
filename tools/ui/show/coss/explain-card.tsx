// parts/ui/show/coss/explain-card.tsx
//
// PURPOSE
//   "Learn more" that opens in place, drawn from a guide section's `explain` DATA: a quiet outline button labelled by
//   the caller, and, once pressed, a bordered card in the flow of the page (never a modal, never an overlay) with a
//   title, a line under it, a close button, the steps as numbered tiles in a grid that wraps to the pane's width, and a
//   ladder of named rungs with the reader's own rung lit in the accent colour. Anatomy follows the Promethee "How
//   ranking works" card a user captured: the title and its line,
//   the round close button at the top right, three numbered tiles, and "The ladder" strip with its note at the right
//   and the current rung in the accent. Dropped from it: the dimmed page behind it (it opens in place instead), the
//   rung pictures, and the dark palette.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file knows no product words: the button's label, the title, steps, ladder and its note are the caller's
//      DATA; the close button's name is the card's own title ("Close <title>").
//   2. It opens in place: no portal, no backdrop, no focus trap; the page keeps scrolling and every other control
//      stays reachable. Escape inside the card closes it and gives focus back to the button that opened it.
//   3. Controls are the licensed Coss Button; appearance lives in screen-look/show/guide.css (`.explain-*`).

import * as React from 'react';
import { StepMark } from '../step-mark';
import { X } from 'lucide-react';
import { Button } from './ui/button';
import type { GuideExplain } from './guide';

/** The quiet button that opens and closes an explanation; the caller places it (beside a banner, or on its own line). */
export function ExplainToggle({ explain, open, onToggle, controls }: { explain: GuideExplain; open: boolean; onToggle: () => void; controls: string }) {
  return (
    <Button type="button" size="sm" variant="outline" className="explain-toggle" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      {explain.label}
    </Button>
  );
}

/** The explanation itself, drawn where it is placed. */
export function ExplainPanel({ explain, id, onClose }: { explain: GuideExplain; id: string; onClose: () => void }) {
  const titleId = `${id}-title`;
  return (
    <div className="explain-card" id={id} role="region" aria-labelledby={titleId} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <div className="explain-top">
        <div className="explain-heading">
          <p className="explain-title" id={titleId}>{explain.title}</p>
          {explain.lead ? <p className="explain-lead">{explain.lead}</p> : null}
        </div>
        <Button type="button" size="icon-sm" variant="outline" className="explain-close" aria-label={`Close ${explain.title}`} title={`Close ${explain.title}`} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      {explain.steps?.length ? (
        <ol className="explain-steps">
          {explain.steps.map((step, index) => (
            <li key={`${index}:${step.title}`} className="explain-step">
              <StepMark className="explain-step-mark" state="todo" n={index + 1} />
              <p className="explain-step-title">{step.title}</p>
              {step.body ? <p className="explain-step-body">{step.body}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {explain.ladder ? (
        <div className="explain-ladder">
          <div className="explain-ladder-top">
            <p className="explain-ladder-label">{explain.ladder.label}</p>
            {explain.ladder.note ? <p className="explain-ladder-note">{explain.ladder.note}</p> : null}
          </div>
          <ol className="explain-rungs">
            {explain.ladder.rungs.map(rung => (
              <li key={rung.name} className="explain-rung" data-current={rung.current ? '' : undefined} aria-current={rung.current ? 'step' : undefined}>
                <span className="explain-rung-mark" aria-hidden />
                <span className="explain-rung-name">{rung.name}</span>
                {rung.detail ? <span className="explain-rung-detail">{rung.detail}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/** Open state for one explanation, so a host can put the button in one place (a banner's end) and the card in another.
 *  Closing gives focus back to the button. */
export function useExplain() {
  const [open, setOpen] = React.useState(false);
  const id = `explain-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const toggleRef = React.useRef<HTMLSpanElement>(null);
  const close = React.useCallback(() => {
    setOpen(false);
    toggleRef.current?.querySelector<HTMLElement>('.explain-toggle')?.focus();
  }, []);
  return { open, id, toggle: () => setOpen(current => !current), close, toggleRef };
}

/** The button and, when open, the card under it: for a section with no banner to hold the button. */
export function Explain({ explain }: { explain: GuideExplain }) {
  const state = useExplain();
  return (
    <div className="explain">
      <span className="explain-toggle-host" ref={state.toggleRef}><ExplainToggle explain={explain} open={state.open} onToggle={state.toggle} controls={state.id} /></span>
      {state.open ? <ExplainPanel explain={explain} id={state.id} onClose={state.close} /> : null}
    </div>
  );
}
