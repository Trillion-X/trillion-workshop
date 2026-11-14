// packages/group/show/WalkthroughOverlay.render.test.tsx
//
// R34 render proof for the walkthrough overlay:
//  (a) the spotlight uses the injected RENDERED rect (the drawn card), not the member
//      frame, when both are provided — and falls back to the frame when unmeasured;
//  (b) the step panel shows the progress counter exactly ONCE, even for a generated
//      tour whose step body carries the same "N of M" string (readingTour).
// Plus the renderedTargetRect measurer's fallback contract (unmeasurable → the frame).

import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import {
  WalkthroughOverlay,
  renderedTargetRect,
  type TargetRect,
} from './WalkthroughOverlay';
import type { Tour } from '../read-data/walkthrough';

afterEach(() => cleanup());

const frame: TargetRect = { x: 100, y: 200, w: 300, h: 400 };
const rendered: TargetRect = { x: 100, y: 200, w: 300, h: 96 };

const tour: Tour = {
  id: 'reading-order',
  name: 'Read in order',
  steps: [
    // A generated reading-tour step: the body IS the counter string (the R34b dupe).
    { id: 'reading:a', target: 'a', title: 'Top left', body: '1 of 1' },
  ],
};

function spotlightOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[data-testid="walkthrough-spotlight"]');
  expect(el).toBeTruthy();
  return el as HTMLElement;
}

describe('WalkthroughOverlay — R34 render fixes', () => {
  it('sizes the spotlight to the injected rendered rect, not the member frame', () => {
    const { container } = render(
      <WalkthroughOverlay
        tour={tour}
        index={0}
        targetRect={frame}
        renderedRect={rendered}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={() => {}}
      />,
    );
    const ring = spotlightOf(container);
    // rect ± the 4px ring inset
    expect(ring.style.height).toBe(`${rendered.h + 8}px`);
    expect(ring.style.width).toBe(`${rendered.w + 8}px`);
    expect(ring.style.top).toBe(`${rendered.y - 4}px`);
    expect(ring.style.left).toBe(`${rendered.x - 4}px`);
  });

  it('falls back to the member frame when no rendered rect is provided', () => {
    const { container } = render(
      <WalkthroughOverlay
        tour={tour}
        index={0}
        targetRect={frame}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={() => {}}
      />,
    );
    const ring = spotlightOf(container);
    expect(ring.style.height).toBe(`${frame.h + 8}px`);
  });

  it('renders the step counter exactly once when the step body repeats it', () => {
    const view = render(
      <WalkthroughOverlay
        tour={tour}
        index={0}
        targetRect={frame}
        renderedRect={rendered}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={() => {}}
      />,
    );
    expect(view.getAllByText('1 of 1')).toHaveLength(1);
    expect(view.getByText('Top left')).toBeTruthy();
    expect(view.getByText('Done')).toBeTruthy(); // single step → last → Done
  });

  it('still renders a distinct step body alongside the counter (authored tours)', () => {
    const authored: Tour = {
      id: 'board-basics',
      name: 'Board basics',
      steps: [
        { id: 's1', target: 'a', title: 'Your cards', body: 'Every card is an idea.' },
        { id: 's2', target: 'b', title: 'Share', body: 'Share the board as a link.' },
      ],
    };
    const view = render(
      <WalkthroughOverlay
        tour={authored}
        index={0}
        targetRect={frame}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={() => {}}
      />,
    );
    expect(view.getByText('1 of 2')).toBeTruthy();
    expect(view.getByText('Every card is an idea.')).toBeTruthy();
  });
});

describe('renderedTargetRect — the drawn-card measurer', () => {
  const NODE_REF = '{"family":"board-item","parts":{"member":"a"}}';

  function stageWith(nodeHtml: string): HTMLElement {
    const stage = document.createElement('div');
    stage.innerHTML = nodeHtml;
    document.body.appendChild(stage);
    return stage;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the frame when the stage or node element is absent (jsdom-safe fallback)', () => {
    expect(renderedTargetRect(null, NODE_REF, frame)).toEqual(frame);
    const stage = stageWith('<div></div>');
    expect(renderedTargetRect(stage, NODE_REF, frame)).toEqual(frame);
  });

  it('returns the frame when children have no measurable size (jsdom offsets are 0)', () => {
    const stage = stageWith(
      `<div data-node-ref='${NODE_REF}'><div><div>card</div></div></div>`,
    );
    // jsdom: offsetWidth/offsetHeight are 0 → unmeasurable → the frame, not a 0-rect.
    expect(renderedTargetRect(stage, NODE_REF, frame)).toEqual(frame);
  });

  it('tightens the extent to the drawn content when offsets are measurable', () => {
    const stage = stageWith(
      `<div data-node-ref='${NODE_REF}'><div><div id="card">card</div></div></div>`,
    );
    const card = stage.querySelector('#card') as HTMLElement;
    // jsdom has no layout: inject the offset geometry a browser would report.
    Object.defineProperties(card, {
      offsetLeft: { value: 0 },
      offsetTop: { value: 0 },
      offsetWidth: { value: 300 },
      offsetHeight: { value: 96 },
    });
    expect(renderedTargetRect(stage, NODE_REF, frame)).toEqual({ x: 100, y: 200, w: 300, h: 96 });
  });
});
