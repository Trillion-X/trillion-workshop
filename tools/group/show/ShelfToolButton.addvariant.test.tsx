// packages/group/show/ShelfToolButton.addvariant.test.tsx
// R44 add-your-own: the variants flyout shows an "add" row when the tool declares a
// variantCreator + a writer is injected, and a typed value is handed to the writer with
// the creator descriptor. Also: no add row when either is absent (blind, back-compat).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { Sticker } from 'lucide-react';
import { ShelfToolButton, type ShelfEntry, type ShelfVariantCreator } from './item-renderers';

const CREATOR: ShelfVariantCreator = {
  inputKind: 'emoji',
  placeholder: 'Paste any emoji',
  addLabel: 'Add a stamp',
  valueField: 'emoji',
  catalogKind: 'stamp-catalog',
  arrayKey: 'stamps',
  addressPrefix: 'package::group::published-record::stamp::',
};

const STAMP_TOOL: ShelfEntry = {
  kind: 'stamp',
  label: 'Stamp',
  icon: Sticker,
  addStrategy: 'empty',
  defaultText: '🔥',
  variants: [{ id: 'fire', label: 'Fire', emoji: '🔥', defaultExtra: {} }],
  variantCreator: CREATOR,
};

afterEach(() => cleanup());

function openFlyout(getByLabelText: (t: RegExp | string) => HTMLElement) {
  // The main button opens the flyout (R22: whole surface opens it).
  fireEvent.click(getByLabelText(/Stamp/));
}

describe('ShelfToolButton — R44 add-your-own', () => {
  it('shows the add-your-own input + button and hands the typed value to the writer', () => {
    const onCreateVariant = vi.fn();
    const { getAllByLabelText, getByPlaceholderText, container } = render(
      <ShelfToolButton tool={STAMP_TOOL} onAdd={() => {}} onCreateVariant={onCreateVariant} />,
    );
    // The trigger is the first button; clicking it opens the flyout.
    fireEvent.click(container.querySelector('button')!);
    const input = getByPlaceholderText('Paste any emoji') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '🦄' } });
    // Click the "Add a stamp" action (aria-label on the button).
    fireEvent.click(getAllByLabelText('Add a stamp').find((el) => el.tagName === 'BUTTON')!);
    expect(onCreateVariant).toHaveBeenCalledWith(CREATOR, '🦄');
  });

  it('renders NO add row when onCreateVariant is not injected (blind/back-compat)', () => {
    const { queryByPlaceholderText, container } = render(
      <ShelfToolButton tool={STAMP_TOOL} onAdd={() => {}} />,
    );
    // Open the flyout.
    fireEvent.click(container.querySelector('button')!);
    expect(queryByPlaceholderText('Paste any emoji')).toBeNull();
  });

  it('renders NO add row for a tool without a variantCreator', () => {
    const plain: ShelfEntry = { ...STAMP_TOOL, variantCreator: undefined };
    const { queryByPlaceholderText, container } = render(
      <ShelfToolButton tool={plain} onAdd={() => {}} onCreateVariant={() => {}} />,
    );
    fireEvent.click(container.querySelector('button')!);
    expect(queryByPlaceholderText('Paste any emoji')).toBeNull();
  });
});
