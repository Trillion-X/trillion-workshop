// packages/group/show/ItemStylePicker.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { ItemStylePicker } from './ItemStylePicker';
import { ITEM_APPEARANCE_CONTROLS } from './item-appearance';

afterEach(() => cleanup());

describe('ItemStylePicker — per-item appearance overrides via the shared descriptor primitive', () => {
  it('renders a "Note look" trigger; the controls are NOT in the DOM until it is opened', () => {
    render(<ItemStylePicker itemExtra={undefined} onSet={vi.fn()} />);
    expect(screen.getByLabelText('Note look — style, text size, density')).toBeTruthy();
    // Closed → the descriptor controls are not mounted yet.
    expect(screen.queryByLabelText('Note style')).toBeNull();
  });

  it('opening reveals a control for every ITEM_APPEARANCE_CONTROLS descriptor (Note style / Text size / Note density)', () => {
    render(<ItemStylePicker itemExtra={undefined} onSet={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Note look — style, text size, density'));
    for (const d of ITEM_APPEARANCE_CONTROLS) {
      expect(screen.getAllByLabelText(d.label).length).toBeGreaterThan(0);
    }
  });

  it('BATCH mode (R2c multi-select): a custom label/ariaLabel/scopeLabel drives the SAME controls — one blind component, two callers', () => {
    render(
      <ItemStylePicker
        itemExtra={undefined}
        onSet={vi.fn()}
        label="Note look"
        ariaLabel="Note look — style, text size, density for the selected notes"
        scopeLabel="These 4 notes"
      />,
    );
    const trigger = screen.getByLabelText('Note look — style, text size, density for the selected notes');
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    // The batch scope line renders, and the descriptor controls are the SAME as single-item.
    expect(screen.getByText('These 4 notes')).toBeTruthy();
    for (const d of ITEM_APPEARANCE_CONTROLS) {
      expect(screen.getAllByLabelText(d.label).length).toBeGreaterThan(0);
    }
    // A batch can't know each note's state → Reset is always offered.
    expect(screen.getByLabelText('Reset to board default')).toBeTruthy();
  });

  it('single-item Reset is HIDDEN when the note overrides nothing (no filler, L118)', () => {
    render(<ItemStylePicker itemExtra={{}} onSet={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Note look — style, text size, density'));
    expect(screen.queryByLabelText('Reset to board default')).toBeNull();
  });

  it('single-item Reset appears once the note overrides a key, and clears EVERY cascade key via onSet(key, undefined)', () => {
    const onSet = vi.fn();
    render(<ItemStylePicker itemExtra={{ containerVariant: 'elevated' }} onSet={onSet} />);
    fireEvent.click(screen.getByLabelText('Note look — style, text size, density'));
    fireEvent.click(screen.getByLabelText('Reset to board default'));
    // Every ITEM_APPEARANCE_CONTROLS key is cleared (undefined) — the note falls back to the board.
    for (const d of ITEM_APPEARANCE_CONTROLS) {
      expect(onSet).toHaveBeenCalledWith(d.key, undefined);
    }
    expect(onSet).toHaveBeenCalledTimes(ITEM_APPEARANCE_CONTROLS.length);
  });
});
