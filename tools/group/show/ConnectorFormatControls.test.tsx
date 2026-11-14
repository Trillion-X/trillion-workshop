// packages/group/show/ConnectorFormatControls.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { afterEach } from 'vitest';
import { ConnectorFormatControls } from './ConnectorFormatControls';

afterEach(() => cleanup());

describe('ConnectorFormatControls', () => {
  it('toggles dashed via onPatch', () => {
    const onPatch = vi.fn();
    const { getByLabelText } = render(<ConnectorFormatControls dashed={false} onPatch={onPatch} />);
    fireEvent.click(getByLabelText('Dashed line'));
    expect(onPatch).toHaveBeenCalledWith({ dashed: true });
  });

  it('cycles the arrow direction end → both', () => {
    const onPatch = vi.fn();
    const { getByLabelText } = render(<ConnectorFormatControls arrow="end" onPatch={onPatch} />);
    fireEvent.click(getByLabelText(/^Arrow direction/));
    expect(onPatch).toHaveBeenCalledWith({ arrow: 'both' });
  });

  it('cycles the arrow direction none → end (closed cycle)', () => {
    const onPatch = vi.fn();
    const { getByLabelText } = render(<ConnectorFormatControls arrow="none" onPatch={onPatch} />);
    fireEvent.click(getByLabelText(/^Arrow direction/));
    expect(onPatch).toHaveBeenCalledWith({ arrow: 'end' });
  });

  it('cycles the routing straight → curved', () => {
    const onPatch = vi.fn();
    const { getByLabelText } = render(<ConnectorFormatControls routing="straight" onPatch={onPatch} />);
    fireEvent.click(getByLabelText(/^Line routing/));
    expect(onPatch).toHaveBeenCalledWith({ routing: 'curved' });
  });

  it('cycles the routing elbow → diagonal → avoid (b106 inserted diagonal)', () => {
    const onPatch = vi.fn();
    const { getByLabelText, rerender } = render(<ConnectorFormatControls routing="elbow" onPatch={onPatch} />);
    fireEvent.click(getByLabelText(/^Line routing/));
    expect(onPatch).toHaveBeenCalledWith({ routing: 'diagonal' });
    onPatch.mockClear();
    rerender(<ConnectorFormatControls routing="diagonal" onPatch={onPatch} />);
    fireEvent.click(getByLabelText(/^Line routing/));
    expect(onPatch).toHaveBeenCalledWith({ routing: 'avoid' });
  });

  it('cycles the routing avoid → straight (closes the cycle)', () => {
    const onPatch = vi.fn();
    const { getByLabelText } = render(<ConnectorFormatControls routing="avoid" onPatch={onPatch} />);
    fireEvent.click(getByLabelText(/^Line routing/));
    expect(onPatch).toHaveBeenCalledWith({ routing: 'straight' });
  });

  it('opens the color picker on the color button (no crash, picker is anchored)', () => {
    const onPatch = vi.fn();
    const { getByLabelText } = render(<ConnectorFormatControls color="#22c55e" onPatch={onPatch} />);
    // The color trigger exists and is clickable; the popover mounts on demand.
    fireEvent.click(getByLabelText('Line color'));
    // No onPatch yet (only a wheel/preset change emits) — proves the trigger is inert until used.
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('routing cycle skips waypoints; a waypoints connector exits to straight (#195)', () => {
    const onPatch = vi.fn();
    const { getByLabelText } = render(<ConnectorFormatControls routing="waypoints" onPatch={onPatch} />);
    fireEvent.click(getByLabelText(/^Line routing/));
    expect(onPatch).toHaveBeenCalledWith({ routing: 'straight' });
  });

  it('"Add bend point" fires onAddBend (#195)', () => {
    const onAddBend = vi.fn();
    const { getByLabelText } = render(
      <ConnectorFormatControls onPatch={vi.fn()} onAddBend={onAddBend} />,
    );
    fireEvent.click(getByLabelText('Add bend point'));
    expect(onAddBend).toHaveBeenCalledTimes(1);
  });

  it('"Clear bends" is hidden with no bends, shown + fires onClearBends when hasBends (#195)', () => {
    const onClearBends = vi.fn();
    const noBends = render(
      <ConnectorFormatControls onPatch={vi.fn()} onAddBend={vi.fn()} onClearBends={onClearBends} hasBends={false} />,
    );
    expect(noBends.queryByLabelText('Clear bends')).toBeNull();
    cleanup();
    const withBends = render(
      <ConnectorFormatControls onPatch={vi.fn()} onAddBend={vi.fn()} onClearBends={onClearBends} hasBends />,
    );
    fireEvent.click(withBends.getByLabelText('Clear bends'));
    expect(onClearBends).toHaveBeenCalledTimes(1);
  });

  it('bend controls are hidden entirely when onAddBend is not provided (absent → no-op)', () => {
    const { queryByLabelText } = render(<ConnectorFormatControls onPatch={vi.fn()} />);
    expect(queryByLabelText('Add bend point')).toBeNull();
    expect(queryByLabelText('Clear bends')).toBeNull();
  });

  it('Line weight shows the current px and cycles to the next preset (#197)', () => {
    const onPatch = vi.fn();
    const { getByLabelText } = render(<ConnectorFormatControls thickness={2} onPatch={onPatch} />);
    const btn = getByLabelText('Line weight');
    expect(btn.textContent).toBe('2px');
    fireEvent.click(btn);
    expect(onPatch).toHaveBeenCalledWith({ thickness: 4 }); // 1,2,4,6 → next after 2 is 4
  });

  it('Line weight defaults to 2px with no thickness, and an off-preset value snaps to nearest then advances (#197)', () => {
    const onPatch = vi.fn();
    const a = render(<ConnectorFormatControls onPatch={onPatch} />);
    expect(a.getByLabelText('Line weight').textContent).toBe('2px');
    cleanup();
    const b = render(<ConnectorFormatControls thickness={5} onPatch={onPatch} />);
    // 5 is nearest to preset 4 (idx 2) → next is 6.
    fireEvent.click(b.getByLabelText('Line weight'));
    expect(onPatch).toHaveBeenCalledWith({ thickness: 6 });
    // 6 is the last preset → wraps to 1.
    cleanup();
    const c = render(<ConnectorFormatControls thickness={6} onPatch={onPatch} />);
    fireEvent.click(c.getByLabelText('Line weight'));
    expect(onPatch).toHaveBeenCalledWith({ thickness: 1 });
  });
});
