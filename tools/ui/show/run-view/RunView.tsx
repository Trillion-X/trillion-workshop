// parts/ui/show/run-view/RunView.tsx
//
// PURPOSE
//   One piece of work as someone watches it: the work itself on top (its state as a tinted tile, its words as the
//   title, when it was asked, the faces of whoever is on it, and the one or two things the reader can do), then every
//   step taken for it, one row each, oldest at the top and the newest at the foot like a chat, then the current holders
//   below the step history. A step row opens into its details. Every row is the shared glance part (listing-card), so
//   the run reads like every other list in the app and never as a paragraph.
//
// SOURCES
//   21st.dev 29318 "Agent Activity" by starc007 (beui.dev, https://21st.dev/@starc007/components/agent-activity): the
//   live stream of steps under the work that stays at the newest step, each step a row with its own state, a capped
//   height whose overflow scrolls. 21st.dev 23789 "AI Tool Call" (educalvolpz): a step that opens into its details.
//   Anatomy only, rebuilt on Trillion's listing-card; no code copied.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: names no kind of work, actor, tool or state; every word, icon, tone and face comes from the caller.
//   2. Steps are drawn in the order given; a new step keeps the reader at the newest only when they were already there.
//   3. A step opens into exactly the details the caller gave for it; a step with none does not open.
//   4. Nothing here spins: a step still going is told by its own icon and tone (the glance shape's running step); the
//      one loading animation is parts/ui/show/spinner.

import React from 'react';
import { Container } from '../container';
import { ListingCard, type Listing } from '../listing-card';

export type RunViewProps = {
  /** The work itself, drawn as one card. */
  run: Listing;
  /** Each step taken for it, oldest first, drawn as rows. */
  steps: Listing[];
  /** What a step opens into, by the step's id. */
  details?: Record<string, Listing>;
  /** One row per part of the work that someone currently holds. */
  working?: Listing[];
  /** Read aloud for the list of steps. */
  stepsLabel: string;
  /** The run's own buttons (its listing's actions) and each detail's buttons. */
  onAction?: (id: string, action: string) => void;
  /** Opens the run as a whole, when it has no buttons of its own. */
  onOpen?: (id: string) => void;
};

const NEAR_BOTTOM_PX = 48;

export function RunView({ run, steps, details = {}, working = [], stepsLabel, onAction, onOpen }: RunViewProps) {
  const [opened, setOpened] = React.useState<string | null>(null);
  const list = React.useRef<HTMLElement | null>(null);
  const atBottom = React.useRef(true);
  const count = steps.length;
  // Follow the newest step only for a reader who was already looking at it.
  React.useLayoutEffect(() => {
    const element = list.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [count]);
  const toggle = (id: string) => setOpened(now => (now === id || !details[id] ? null : id));
  return (
    <Container as="section" layout="vertical" gap="sm" minWidth="0" data-slot="run-view">
      <ListingCard listing={run} onAction={onAction} onOpen={onOpen} />
      {steps.length ? (
        <Container
          as="ul"
          ref={list as React.Ref<HTMLDivElement>}
          layout="vertical"
          maxHeight="20rem"
          minWidth="0"
          aria-label={stepsLabel}
          aria-live="polite"
          data-slot="run-view-steps"
          onScroll={(event: React.UIEvent<HTMLElement>) => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX; }}
          className="list-none gap-1.5 overflow-y-auto overscroll-contain p-0"
        >
          {steps.map(step => (
            <Container as="li" key={step.id} layout="vertical" minWidth="0" className="gap-1.5">
              <ListingCard listing={{ ...step, form: 'row' }} onOpen={details[step.id] ? toggle : undefined} />
              {opened === step.id ? <ListingCard listing={{ ...details[step.id], form: 'card' }} onAction={onAction} /> : null}
            </Container>
          ))}
        </Container>
      ) : null}
      {working.length ? (
        <Container as="ul" layout="vertical" gap="xs" minWidth="0" aria-label={stepsLabel} aria-live="polite" data-slot="run-view-working-list" className="list-none p-0">
          {working.map(item => (
            <Container as="li" key={item.id} minWidth="0" data-slot="run-view-working">
              <ListingCard listing={{ ...item, form: 'row' }} onAction={onAction} />
            </Container>
          ))}
        </Container>
      ) : null}
    </Container>
  );
}
