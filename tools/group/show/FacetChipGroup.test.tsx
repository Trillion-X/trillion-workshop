// packages/group/show/FacetChipGroup.test.tsx
// R52: the facet filter is a compact anchored-overlay dropdown ("Type ▾"), not a sprawling
// inline chip cluster. The trigger names the facet + active count; values live in the popover.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { FacetChipGroup } from './FacetChipGroup';

afterEach(() => cleanup());

describe('FacetChipGroup — R52 anchored dropdown', () => {
  it('renders a single compact trigger, not the values inline', () => {
    render(<FacetChipGroup facetKey="kind" label="Type" values={['note', 'image', 'link']} selected={[]} onToggle={() => {}} />);
    // The facet trigger is present...
    expect(screen.getByRole('button', { name: /^Filter by Type/ })).toBeTruthy();
    // ...but the individual values are NOT in the DOM until the dropdown opens.
    expect(screen.queryByRole('button', { name: 'Type: note' })).toBeNull();
  });

  it('opens the value chips on click and toggles a value', () => {
    const onToggle = vi.fn();
    render(<FacetChipGroup facetKey="kind" label="Type" values={['note', 'image']} selected={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /^Filter by Type/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Type: image' }));
    expect(onToggle).toHaveBeenCalledWith('kind', 'image');
  });

  it('the trigger shows the active-selection count (self-describing)', () => {
    render(<FacetChipGroup facetKey="kind" label="Type" values={['note', 'image']} selected={['note']} onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: /^Filter by Type — 1 selected/ }).textContent).toMatch(/Type · 1/);
  });

  it('hides entirely below the minValues threshold', () => {
    const { container } = render(<FacetChipGroup facetKey="kind" label="Type" values={['note']} selected={[]} onToggle={() => {}} minValues={2} />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('a "Clear" in the open dropdown toggles every selected value off', () => {
    const onToggle = vi.fn();
    render(<FacetChipGroup facetKey="kind" label="Type" values={['note', 'image']} selected={['note', 'image']} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /^Filter by Type/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear Type filter' }));
    expect(onToggle).toHaveBeenCalledWith('kind', 'note');
    expect(onToggle).toHaveBeenCalledWith('kind', 'image');
  });
});
