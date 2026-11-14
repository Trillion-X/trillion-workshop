// packages/ui/show/notice/Notice.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Notice } from './Notice';

afterEach(cleanup);

describe('Notice', () => {
  it('renders nothing for null or empty text (absent → no-op)', () => {
    const { container: a } = render(<Notice text={null} />);
    expect(a.querySelector('[role="status"]')).toBeNull();
    cleanup();
    const { container: b } = render(<Notice text="" />);
    expect(b.querySelector('[role="status"]')).toBeNull();
  });

  it('renders the message in a polite live status region', () => {
    render(<Notice text="Copied to clipboard" tone="success" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Copied to clipboard');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('pins to the top by default and to the bottom when asked', () => {
    const { rerender } = render(<Notice text="x" />);
    expect(screen.getByRole('status').style.top).toBe('12px');
    rerender(<Notice text="x" placement="bottom-center" />);
    const s = screen.getByRole('status');
    expect(s.style.bottom).toBe('12px');
    expect(s.style.top).toBe('');
  });
});

describe('Notice action — the chip\'s ONE interactive control (2026-07-10)', () => {
  it('renders the action label and fires onAction on click', () => {
    const onAction = vi.fn();
    render(<Notice text="Removed." action={{ label: 'Undo', onAction }} />);
    const btn = screen.getByRole('button', { name: 'Undo' });
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('without an action the chip stays non-interactive (no button, byte-identical classic path)', () => {
    render(<Notice text="Copied." />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
