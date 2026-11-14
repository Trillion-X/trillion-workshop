// Tests for the save-selection-as-collection button.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { CollectionSaveButton, collectionSaveLabel } from './CollectionSaveButton';

afterEach(() => cleanup());

describe('collectionSaveLabel', () => {
  it('reads count 0 as the bare prompt', () => {
    expect(collectionSaveLabel(0)).toBe('Save as collection');
  });
  it('reads count 1 in the singular', () => {
    expect(collectionSaveLabel(1)).toBe('Save 1 item as collection');
  });
  it('reads count 3 in the plural', () => {
    expect(collectionSaveLabel(3)).toBe('Save 3 items as collection');
  });
});

describe('CollectionSaveButton', () => {
  it('is disabled when nothing is selected', () => {
    const { getByRole } = render(<CollectionSaveButton count={0} onSave={() => {}} />);
    const button = getByRole('button', { name: 'Save selection as collection' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('is enabled and labelled with the count when items are selected', () => {
    const { getByRole } = render(<CollectionSaveButton count={2} onSave={() => {}} />);
    const button = getByRole('button', { name: 'Save selection as collection' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Save 2 items as collection');
  });

  it('calls onSave once when the enabled button is clicked', () => {
    const onSave = vi.fn();
    const { getByRole } = render(<CollectionSaveButton count={2} onSave={onSave} />);
    const button = getByRole('button', { name: 'Save selection as collection' });
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
