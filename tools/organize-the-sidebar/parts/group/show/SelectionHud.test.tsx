// packages/group/show/SelectionHud.test.tsx
import { describe, it, expect, afterEach } from '../../../../../test-helpers/vitest-shim.mjs';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { SelectionHud, type HudBounds } from '../../../show/SelectionHud.tsx';

afterEach(() => cleanup());

const bounds: HudBounds = { x: 100, y: 100, w: 200, h: 80 };

describe('SelectionHud', () => {
  it('renders a pill with the label, positioned below the bounds', () => {
    const { container, queryByText } = render(<SelectionHud bounds={bounds} label="200 × 80" zoom={1} />);
    expect(queryByText('200 × 80')).not.toBeNull();
    const rect = container.querySelector('rect')!;
    // The pill sits below the bounds bottom (y=180) plus the gap.
    expect(Number(rect.getAttribute('y'))).toBeGreaterThanOrEqual(180);
    // Centred horizontally on the bounds centre (x=200).
    const x = Number(rect.getAttribute('x'));
    const w = Number(rect.getAttribute('width'));
    expect(x + w / 2).toBeCloseTo(200, 5);
  });

  it('counter-scales font + padding by 1/zoom (constant on screen)', () => {
    const { container } = render(<SelectionHud bounds={bounds} label="2 selected" zoom={2} />);
    const text = container.querySelector('text')!;
    expect(Number(text.getAttribute('font-size'))).toBeCloseTo(6, 5); // 12 / zoom(2)
  });

  it('renders nothing when bounds is null', () => {
    const { container } = render(<SelectionHud bounds={null} label="x" zoom={1} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders nothing when the label is empty', () => {
    const { container } = render(<SelectionHud bounds={bounds} label="" zoom={1} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
