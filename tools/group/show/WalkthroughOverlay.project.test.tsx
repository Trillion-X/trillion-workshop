// packages/group/show/WalkthroughOverlay.project.test.tsx
//
// R42b: the walkthrough overlay is lifted into the HUD layer (above the minimap) and
// given a world->screen `project`. These tests pin the projection contract: with a
// projector the spotlight ring (and thus the card anchor derived from it) render at
// projected SCREEN coords; without one the world rect is used verbatim (the legacy /
// test path). This is what keeps the Next/Skip buttons clickable over the bottom-right
// minimap zone — they no longer live in the world layer the minimap paints over.
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { WalkthroughOverlay, type TargetRect } from './WalkthroughOverlay';
import type { Tour } from '../read-data/walkthrough';

const TOUR: Tour = {
  id: 'test-tour',
  steps: [
    { target: 'm1', title: 'Step one', body: 'Body one' },
    { target: 'm2', title: 'Step two', body: 'Body two' },
  ],
};

const FRAME: TargetRect = { x: 100, y: 100, w: 50, h: 50 };

function spotlightRect(container: HTMLElement): { left: number; top: number; width: number; height: number } {
  const el = container.querySelector('[data-testid="walkthrough-spotlight"]') as HTMLElement;
  const s = el.style;
  return {
    left: parseFloat(s.left),
    top: parseFloat(s.top),
    width: parseFloat(s.width),
    height: parseFloat(s.height),
  };
}

afterEach(() => cleanup());

describe('WalkthroughOverlay world->screen projection (R42b)', () => {
  it('without a projector, the spotlight uses the world rect verbatim (legacy path)', () => {
    const { container } = render(
      <WalkthroughOverlay
        tour={TOUR}
        index={0}
        targetRect={FRAME}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={() => {}}
      />,
    );
    // Spotlight is inset by 4px around the rect: left = x - 4, width = w + 8.
    expect(spotlightRect(container)).toEqual({ left: 96, top: 96, width: 58, height: 58 });
  });

  it('with a projector, the spotlight renders at PROJECTED screen coords', () => {
    // zoom 2x, pan (30,40): world (100,100,50,50) -> screen (230,240,100,100).
    const project = (r: TargetRect): TargetRect => ({
      x: r.x * 2 + 30,
      y: r.y * 2 + 40,
      w: r.w * 2,
      h: r.h * 2,
    });
    const { container } = render(
      <WalkthroughOverlay
        tour={TOUR}
        index={0}
        targetRect={FRAME}
        project={project}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={() => {}}
      />,
    );
    // Projected rect {x:230,y:240,w:100,h:100}; spotlight inset by 4 / +8.
    expect(spotlightRect(container)).toEqual({ left: 226, top: 236, width: 108, height: 108 });
  });

  it('the projector wins over the raw rect for the card anchor too (card sits below the projected note)', () => {
    const project = (r: TargetRect): TargetRect => ({ x: r.x * 2, y: r.y * 2, w: r.w * 2, h: r.h * 2 });
    const { container } = render(
      <WalkthroughOverlay
        tour={TOUR}
        index={0}
        targetRect={FRAME}
        project={project}
        onNext={() => {}}
        onPrev={() => {}}
        onClose={() => {}}
      />,
    );
    // Card is positioned at top = projected(y) + projected(h) + 12 = 200 + 100 + 12 = 312.
    // Find the Next button, walk up to the positioned card wrapper, read its top.
    const next = container.querySelector('[aria-label="Next step"]') as HTMLElement;
    expect(next).toBeTruthy();
    const cardWrapper = next.closest('[data-stage-chrome]') as HTMLElement;
    expect(cardWrapper).toBeTruthy();
    expect(parseFloat(cardWrapper.style.top)).toBe(312);
    expect(parseFloat(cardWrapper.style.left)).toBe(200);
  });
});
