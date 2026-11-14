// packages/group/show/SnapGuideLayer.test.tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { SnapGuideLayer } from 'trillion-workshop/tools/organize-the-sidebar/show/SnapGuideLayer.tsx';
import type { SnapGuide } from './snap-guides';

afterEach(() => cleanup());

const guides: SnapGuide[] = [
  { orient: 'v', pos: 100, start: 50, end: 400 },
  { orient: 'h', pos: 250, start: 0, end: 600 },
];

describe('SnapGuideLayer', () => {
  it('renders one magenta line per guide, at 1/zoom stroke width (constant on screen)', () => {
    const { container } = render(<SnapGuideLayer guides={guides} zoom={2} />);
    const lines = [...container.querySelectorAll('line')];
    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(l.getAttribute('stroke')).toBe('#f24822');
      expect(l.getAttribute('stroke-width')).toBe('0.5'); // 1 / zoom(2)
    }
    // vertical guide: x1===x2===pos, spans start..end on y.
    const v = lines.find((l) => l.getAttribute('x1') === l.getAttribute('x2'))!;
    expect(v.getAttribute('x1')).toBe('100');
    expect(v.getAttribute('y1')).toBe('50');
    expect(v.getAttribute('y2')).toBe('400');
  });

  it('renders nothing when there are no guides (no svg, no lines)', () => {
    const { container } = render(<SnapGuideLayer guides={[]} zoom={1} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelectorAll('line').length).toBe(0);
  });
});
