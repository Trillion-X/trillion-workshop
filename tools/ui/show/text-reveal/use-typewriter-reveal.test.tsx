/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useTypewriterReveal, useRevealedLength, runRevealSchedule } from './use-typewriter-reveal';

// Deterministic rAF pump: capture scheduled frame callbacks and step them by hand
// so the reveal animation is exercised frame-by-frame without real timers.
let rafQueue: FrameRequestCallback[] = [];
beforeEach(() => {
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const pump = (n = 200) => { for (let i = 0; i < n && rafQueue.length; i += 1) rafQueue.shift()!(0); };

function Probe({ text, active, onProgress }: { text: string; active: boolean; onProgress?: (el: HTMLElement) => void }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  useTypewriterReveal({ ref, text, active, onProgress, frames: 5 });
  return <div ref={ref} data-testid="node" />;
}

describe('useTypewriterReveal', () => {
  it('empties then reveals progressively, settling on the full text', () => {
    const { getByTestId } = render(<Probe text="Hello world" active />);
    const node = getByTestId('node');
    expect(node.textContent).toBe(''); // the effect claimed the node + scheduled frame 1
    rafQueue.shift()!(0); // one frame → a partial prefix
    expect(node.textContent!.length).toBeGreaterThan(0);
    expect(node.textContent!.length).toBeLessThan('Hello world'.length);
    pump(); // remaining frames → whole text
    expect(node.textContent).toBe('Hello world');
  });

  it('does nothing when inactive (the hook never touches the node)', () => {
    const { getByTestId } = render(<Probe text="unrevealed" active={false} />);
    expect(getByTestId('node').textContent).toBe('');
    expect(rafQueue.length).toBe(0); // no animation scheduled
  });

  it('reports progress each frame so an auto-height box can reflow', () => {
    const onProgress = vi.fn();
    render(<Probe text="abcdefghij" active onProgress={onProgress} />);
    pump();
    expect(onProgress).toHaveBeenCalled();
  });

  it('empty text is a no-op (no crash, no frame)', () => {
    const { getByTestId } = render(<Probe text="" active />);
    expect(getByTestId('node').textContent).toBe('');
    expect(rafQueue.length).toBe(0);
  });
});

function LengthProbe({ text, active }: { text: string; active: boolean }) {
  const count = useRevealedLength(text.length, active, 5);
  return <div data-testid="len">{text.slice(0, count)}</div>;
}

describe('useRevealedLength (React reveal for React-owned DOM)', () => {
  it('renders the substring progressively, settling on the full text', () => {
    const { getByTestId } = render(<LengthProbe text="Hello world" active />);
    const el = getByTestId('len');
    expect(el.textContent).toBe(''); // count starts at 0
    act(() => { rafQueue.shift()!(0); }); // one frame → partial (act flushes the setState)
    expect(el.textContent!.length).toBeGreaterThan(0);
    expect(el.textContent!.length).toBeLessThan('Hello world'.length);
    act(() => pump());
    expect(el.textContent).toBe('Hello world');
  });

  it('shows the full text immediately when inactive (no animation)', () => {
    const { getByTestId } = render(<LengthProbe text="whole" active={false} />);
    expect(getByTestId('len').textContent).toBe('whole');
    expect(rafQueue.length).toBe(0);
  });
});

describe('runRevealSchedule (pure scheduler SSOT)', () => {
  it('steps 0→total across frames and fires onDone once', () => {
    const steps: number[] = [];
    let done = 0;
    runRevealSchedule(10, 5, (n) => steps.push(n), () => { done += 1; });
    pump();
    expect(steps[steps.length - 1]).toBe(10);
    expect(steps.every((n, i) => i === 0 || n >= steps[i - 1]!)).toBe(true); // monotonic
    expect(done).toBe(1);
  });

  it('total<=0 is a no-op that still fires onDone (no frame scheduled)', () => {
    let done = 0;
    const cancel = runRevealSchedule(0, 5, () => {}, () => { done += 1; });
    expect(done).toBe(1);
    expect(rafQueue.length).toBe(0);
    cancel();
  });
});
