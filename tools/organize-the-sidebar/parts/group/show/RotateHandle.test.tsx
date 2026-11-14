// packages/group/show/RotateHandle.test.tsx
import { describe, it, expect, afterEach, vi } from '../../../../../test-helpers/vitest-shim.mjs';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { RotateHandle, type RotateHandleRect } from '../../../show/RotateHandle.tsx';

afterEach(() => cleanup());

const rect: RotateHandleRect = { x: 100, y: 100, w: 200, h: 80 };

describe('RotateHandle', () => {
  it('renders nothing when rect is null', () => {
    const { container } = render(<RotateHandle rect={null} rotation={0} zoom={1} onRotateStart={() => {}} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('places the grip directly above the top-center at θ=0', () => {
    const { container } = render(<RotateHandle rect={rect} rotation={0} zoom={1} onRotateStart={() => {}} />);
    const circle = container.querySelector('circle')!;
    const line = container.querySelector('line')!;
    // top-center = (200, 100); grip floats 22px above it; stem starts at the edge.
    expect(Number(circle.getAttribute('cx'))).toBeCloseTo(200, 5);
    expect(Number(circle.getAttribute('cy'))).toBeCloseTo(100 - 22, 5);
    expect(Number(line.getAttribute('x1'))).toBeCloseTo(200, 5);
    expect(Number(line.getAttribute('y1'))).toBeCloseTo(100, 5); // top edge mid
  });

  it('rotates the grip offset WITH the item (θ=90 puts it left of center)', () => {
    // At θ=90 the local "up" (0,-1) rotates to world (+1·... ) → for [cos -sin; sin cos]
    // with θ=+90: (0,-d) → (d, 0); so the grip moves to +x of the top-center pivot.
    const { container } = render(<RotateHandle rect={rect} rotation={90} zoom={1} onRotateStart={() => {}} />);
    const circle = container.querySelector('circle')!;
    const cx = Number(circle.getAttribute('cx'));
    const cy = Number(circle.getAttribute('cy'));
    // Center is (200,140). Knob local (0, -h/2-stem)=(0,-62) → rotate 90° → (62,0).
    expect(cx).toBeCloseTo(200 + 62, 4);
    expect(cy).toBeCloseTo(140, 4);
  });

  it('counter-scales stroke by 1/zoom', () => {
    const { container } = render(<RotateHandle rect={rect} rotation={0} zoom={2} onRotateStart={() => {}} />);
    const circle = container.querySelector('circle')!;
    expect(Number(circle.getAttribute('r'))).toBeCloseTo(3, 5); // 6 / zoom(2)
  });

  it('calls onReset on a double-click of the grip', () => {
    const onReset = vi.fn();
    const { container } = render(<RotateHandle rect={rect} rotation={40} zoom={1} onRotateStart={() => {}} onReset={onReset} />);
    fireEvent.doubleClick(container.querySelector('circle')!);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('does not throw on a double-click when onReset is absent', () => {
    const { container } = render(<RotateHandle rect={rect} rotation={40} zoom={1} onRotateStart={() => {}} />);
    expect(() => fireEvent.doubleClick(container.querySelector('circle')!)).not.toThrow();
  });

  it('forwards a pointer-down on the grip to onRotateStart (with the grip element as target)', () => {
    // jsdom's PointerEvent does not carry clientX/clientY/pointerId, so we assert
    // the wiring fires and hands back the grip element (the capture target); the
    // real pointer coordinates are exercised by the live Playwright proof.
    const onRotateStart = vi.fn();
    const { container } = render(<RotateHandle rect={rect} rotation={0} zoom={1} onRotateStart={onRotateStart} />);
    const circle = container.querySelector('circle')!;
    fireEvent.pointerDown(circle);
    expect(onRotateStart).toHaveBeenCalledTimes(1);
    expect(onRotateStart.mock.calls[0][3]).toBe(circle); // the grip element is forwarded for setPointerCapture
  });
});
