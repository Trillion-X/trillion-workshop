import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { CollectionBasketBar, basketSummaryLabel } from './CollectionBasketBar';

afterEach(() => cleanup());

describe('basketSummaryLabel', () => {
  it('is singular-aware for items and boards', () => {
    expect(basketSummaryLabel(1, 1)).toBe('1 item from 1 board');
    expect(basketSummaryLabel(5, 2)).toBe('5 items from 2 boards');
    expect(basketSummaryLabel(3, 1)).toBe('3 items from 1 board');
  });
});

describe('CollectionBasketBar', () => {
  it('renders nothing when the basket is empty (no filler)', () => {
    const { container } = render(<CollectionBasketBar itemCount={0} boardCount={0} onSave={() => {}} onClear={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the summary and fires Save + Clear', () => {
    const onSave = vi.fn();
    const onClear = vi.fn();
    render(<CollectionBasketBar itemCount={5} boardCount={2} onSave={onSave} onClear={onClear} />);
    expect(screen.getByText('5 items from 2 boards')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save collection from basket' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear collection basket' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
