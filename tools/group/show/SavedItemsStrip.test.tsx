// packages/group/show/SavedItemsStrip.test.tsx
//
// Proves the generic saved-items strip: the save button + chips render with the configured labels/verb, onSave
// and onOpen fire with the right id, and an empty list collapses to just the save button (L118).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { SavedItemsStrip } from './SavedItemsStrip';

afterEach(() => cleanup());

describe('SavedItemsStrip', () => {
  it('renders the section, save button, and a chip per item with the configured verb', () => {
    const { container } = render(
      <SavedItemsStrip title="Saved views" saveLabel="Save view" openVerb="jump to" items={[{ id: 'v1', name: 'View 1' }]} onSave={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(container.querySelector('[aria-label="Saved views"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Save view"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="jump to View 1"]')).not.toBeNull();
  });

  it('fires onSave and onOpen(id)', () => {
    const onSave = vi.fn();
    const onOpen = vi.fn();
    const { container } = render(
      <SavedItemsStrip title="Saved reports" saveLabel="Save report" openVerb="open" items={[{ id: 'r1', name: 'Report 1' }]} onSave={onSave} onOpen={onOpen} />,
    );
    fireEvent.click(container.querySelector('[aria-label="Save report"]') as HTMLElement);
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(container.querySelector('[aria-label="open Report 1"]') as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith('r1');
  });

  it('empty list → save button only, no chips', () => {
    const { container } = render(
      <SavedItemsStrip title="Saved views" saveLabel="Save view" openVerb="jump to" items={[]} onSave={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(container.querySelector('[aria-label="Save view"]')).not.toBeNull();
    expect(container.querySelector('[aria-label^="jump to"]')).toBeNull();
  });

  it('onRemove (b207): a remove affordance per chip that fires onRemove(id); still opens on the chip', () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    const { container } = render(
      <SavedItemsStrip
        title="Smart sets" saveLabel="Save smart set" openVerb="apply" removeVerb="remove"
        items={[{ id: 's1', name: 'Ideas' }, { id: 's2', name: 'Chores' }]}
        onSave={vi.fn()} onOpen={onOpen} onRemove={onRemove}
      />,
    );
    // one remove button per item, plus the open chip still works
    expect(container.querySelectorAll('[aria-label^="remove "]').length).toBe(2);
    fireEvent.click(container.querySelector('[aria-label="apply Ideas"]') as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith('s1');
    fireEvent.click(container.querySelector('[aria-label="remove Chores"]') as HTMLElement);
    expect(onRemove).toHaveBeenCalledWith('s2');
  });

  it('onRemove omitted → NO remove affordance (non-breaking for existing consumers)', () => {
    const { container } = render(
      <SavedItemsStrip title="Saved reports" saveLabel="Save report" openVerb="open" items={[{ id: 'r1', name: 'Report 1' }]} onSave={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(container.querySelector('[aria-label^="remove "]')).toBeNull();
    expect(container.querySelector('[aria-label="open Report 1"]')).not.toBeNull();
  });
});
