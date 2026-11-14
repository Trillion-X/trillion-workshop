// packages/group/show/TimeLogPanel.test.tsx
//
// R54 proof: the running work-timer VISIBLY starts and ticks up each second (not a
// dead "Recording…" label), and Close fires. The live elapsed is the shared
// useElapsedSeconds primitive (SSOT with the in-flight producer card).

import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { TimeLogPanel } from './TimeLogPanel';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const noop = () => {};
const baseProps = {
  totalLabel: '0m', sessions: 0, onLogSession: noop, onQuickAdd: noop,
  onRemoveLast: noop, onClear: noop, onClose: noop,
};

describe('TimeLogPanel — running timer (R54)', () => {
  it('visibly starts at 0s and ticks up every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { getByLabelText, getByText, queryByText } = render(<TimeLogPanel {...baseProps} />);

    // Before start: the Start button, no recording label.
    getByLabelText('Start a work timer');
    expect(queryByText(/Recording/)).toBeNull();

    // Start → immediately shows the live "Recording 0s" label (the timer is visibly alive).
    act(() => { fireEvent.click(getByLabelText('Start a work timer')); });
    getByText('Recording 0s · tap to stop');

    // Three seconds pass → the label ticks (proof it is NOT a dead static label).
    // advanceTimersByTime advances the fake Date.now() AND fires the 1s interval.
    act(() => { vi.advanceTimersByTime(3000); });
    getByText('Recording 3s · tap to stop');

    // Past a minute (total 65s) → M:SS form.
    act(() => { vi.advanceTimersByTime(62000); });
    getByText('Recording 1:05 · tap to stop');
  });

  it('Stop logs the real elapsed session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const onLogSession = vi.fn();
    const { getByLabelText } = render(<TimeLogPanel {...baseProps} onLogSession={onLogSession} />);
    act(() => { fireEvent.click(getByLabelText('Start a work timer')); });
    act(() => { vi.setSystemTime(new Date('2026-01-01T00:00:10Z')); });
    act(() => { fireEvent.click(getByLabelText('Stop the work timer and log it')); });
    expect(onLogSession).toHaveBeenCalledTimes(1);
    const [startMs, durationMs] = onLogSession.mock.calls[0];
    expect(typeof startMs).toBe('number');
    expect(durationMs).toBe(10_000);
  });

  it('Close fires onClose (R42 sibling — the button is live)', () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(<TimeLogPanel {...baseProps} onClose={onClose} />);
    fireEvent.click(getByLabelText('Close time panel'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
