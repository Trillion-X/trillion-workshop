// packages/group/show/live-production-render.test.tsx
//
// Real-DOM proof (jsdom + @testing-library/react) that the live piece-by-piece
// progress actually RENDERS — not just that the data is shaped right:
//   1. A pending producer item renders the Mobbin-grounded live-production state:
//      a status line (owner workingLabel/message) + N skeleton-ahead rows (total_hint).
//   2. CanvasNode fires a one-time entrance animation when given appearDelayMs, with
//      the staggered delay — and does NOT animate without it.

import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { rendererForKind } from './item-renderers';
import { CanvasNode } from '../../ui/show/canvas-node';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(() => cleanup());

describe('live-production render — pending state', () => {
  it('renders the owner status line + total_hint skeleton-ahead rows', () => {
    const Pending = rendererForKind('pending');
    const item = {
      kind: 'pending',
      memberId: 'm1',
      x: 0, y: 0, w: 240, h: 120,
      text: 'launch a pottery academy',
      extra: { status: 'pending', total_hint: 6, message: 'Breaking this down…' },
    } as unknown as BoardItem;

    const { getByText, container } = render(<Pending item={item} selected={false} />);

    // Jasper-style live status line (owner copy) + the user's instruction echoed.
    getByText('Breaking this down…');
    getByText('· launch a pottery academy');
    // Gamma-style skeleton-ahead: one pulsing row per expected item (total_hint = 6).
    expect(container.querySelectorAll('.animate-pulse').length).toBe(6);
  });

  it('total_hint:0 → a COMPACT status chip with NO skeleton-ahead rows (a reconcile/reorganize edits existing notes in place, so "N new things coming" would be a lie)', () => {
    const Pending = rendererForKind('pending');
    const item = {
      kind: 'pending', memberId: 'm0', x: 0, y: 0, w: 240, h: 120,
      extra: { status: 'pending', total_hint: 0, message: 'Thinking…' },
    } as unknown as BoardItem;
    const { getByText, container } = render(<Pending item={item} selected={false} />);
    getByText('Thinking…'); // status line still shows
    expect(container.querySelectorAll('.animate-pulse').length).toBe(0); // no skeleton pile
  });

  it('clamps a single-artifact producer to one skeleton row (total_hint absent → 1)', () => {
    const Pending = rendererForKind('pending');
    const item = {
      kind: 'pending', memberId: 'm2', x: 0, y: 0, w: 240, h: 120,
      extra: { status: 'pending', message: 'Working…' },
    } as unknown as BoardItem;
    const { container } = render(<Pending item={item} selected={false} />);
    expect(container.querySelectorAll('.animate-pulse').length).toBe(1);
  });

  it('shows a REAL elapsed timer when started_at is present (honest observability, L117)', () => {
    const Pending = rendererForKind('pending');
    const item = {
      kind: 'pending', memberId: 'm3', x: 0, y: 0, w: 240, h: 120,
      // started 12 seconds ago
      extra: { status: 'pending', message: 'Working…', started_at: Date.now() - 12_000 },
    } as unknown as BoardItem;
    const { getByText } = render(<Pending item={item} selected={false} />);
    // The card shows the live wall-clock elapsed ("· 12s") — proof the job is alive.
    getByText('· 12s');
  });

  it('shows NO timer when there is no started_at (never fakes elapsed)', () => {
    const Pending = rendererForKind('pending');
    const item = {
      kind: 'pending', memberId: 'm4', x: 0, y: 0, w: 240, h: 120,
      extra: { status: 'pending', message: 'Working…' },
    } as unknown as BoardItem;
    const { queryByText } = render(<Pending item={item} selected={false} />);
    expect(queryByText(/^· \d+s$/)).toBeNull();
  });
});

describe('CanvasNode — entrance stagger', () => {
  let animateSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    animateSpy = vi.fn(() => ({ cancel: vi.fn() }));
    // jsdom has no Web Animations API — install a spy so we can prove the call.
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = animateSpy;
  });
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  });

  it('plays a one-time entrance with the given stagger delay', () => {
    render(
      <CanvasNode x={10} y={20} width={100} height={50} appearDelayMs={140}>
        <div>hi</div>
      </CanvasNode>,
    );
    expect(animateSpy).toHaveBeenCalledTimes(1);
    const [frames, opts] = animateSpy.mock.calls[0];
    // A hidden webview may keep this animation at time zero indefinitely.
    // Neither its first frame nor its delayed fill may hide saved content.
    for (const frame of frames as Keyframe[]) {
      expect(frame).not.toHaveProperty('opacity');
      expect(frame).not.toHaveProperty('visibility');
      expect(frame).not.toHaveProperty('display');
    }
    expect((opts as KeyframeAnimationOptions).delay).toBe(140);
    expect((opts as KeyframeAnimationOptions).fill).toBe('backwards');
  });

  it('does NOT animate when no appearDelayMs is given (already-present item = instant)', () => {
    render(
      <CanvasNode x={0} y={0} width={100} height={50}>
        <div>hi</div>
      </CanvasNode>,
    );
    expect(animateSpy).not.toHaveBeenCalled();
  });
});
