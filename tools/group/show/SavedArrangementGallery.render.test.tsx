// packages/group/show/SavedArrangementGallery.render.test.tsx
//
// Render proof (RTL/jsdom) that the library gallery surfaces the exact controls the
// board panel wires — the anti-primitive-without-product check: a user can SEE and
// CLICK Use / Save this board / Rename / Duplicate, and each fires the right dispatch.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { SavedArrangementGallery } from './SavedArrangementGallery';
import { templateRow } from '../read-data/saved-arrangement';
import type { SavedArrangement } from '../read-data/saved-arrangement';

afterEach(() => cleanup());

const template = templateRow({
  id: 'starter',
  name: 'Starter board',
  items: [{ id: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 100, text: 'A' }],
});
const collection: SavedArrangement = {
  id: 'collection:c1',
  label: 'My saved layout',
  source: 'collection',
  memberId: 'm1',
  archived: false,
  capabilities: { apply: true, rename: true, archive: true, duplicate: true },
  payload: { id: 'c1', name: 'My saved layout', items: [{ id: 'b', kind: 'note', x: 0, y: 0, w: 100, h: 100, text: 'B' }] },
};

describe('SavedArrangementGallery — the user-facing library controls render + fire', () => {
  it('shows every arrangement label and the Save-this-board footer', () => {
    render(
      <SavedArrangementGallery open arrangements={[template, collection]} onAction={() => {}} onClose={() => {}} onSaveCurrent={() => {}} />,
    );
    expect(screen.getByText('Starter board')).toBeTruthy();
    expect(screen.getByText('My saved layout')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save this board' })).toBeTruthy();
  });

  it('Use fires apply with the row (any payload IS a BoardTemplate the panel applies)', () => {
    const onAction = vi.fn();
    render(<SavedArrangementGallery open arrangements={[collection]} onAction={onAction} onClose={() => {}} />);
    // The primary action button labelled "Use My saved layout".
    fireEvent.click(screen.getByRole('button', { name: 'Use My saved layout' }));
    expect(onAction).toHaveBeenCalledWith('apply', collection);
  });

  it('a store-backed row exposes Rename + Duplicate; a static template does not expose Rename', () => {
    const onAction = vi.fn();
    render(<SavedArrangementGallery open arrangements={[template, collection]} onAction={onAction} onClose={() => {}} />);
    // Collection is renamable + duplicable.
    fireEvent.click(screen.getByRole('button', { name: 'Rename My saved layout' }));
    expect(onAction).toHaveBeenLastCalledWith('rename', collection);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate My saved layout' }));
    expect(onAction).toHaveBeenLastCalledWith('duplicate', collection);
    // The static template has NO Rename control (immutable).
    expect(screen.queryByRole('button', { name: 'Rename Starter board' })).toBeNull();
  });

  it('Save this board fires onSaveCurrent', () => {
    const onSaveCurrent = vi.fn();
    render(<SavedArrangementGallery open arrangements={[template]} onAction={() => {}} onClose={() => {}} onSaveCurrent={onSaveCurrent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save this board' }));
    expect(onSaveCurrent).toHaveBeenCalledTimes(1);
  });

  it('empty library shows the start-your-library empty state (and still offers Save)', () => {
    render(<SavedArrangementGallery open arrangements={[]} onAction={() => {}} onClose={() => {}} onSaveCurrent={() => {}} />);
    expect(screen.getByText(/save this board to start your library/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save this board' })).toBeTruthy();
  });

  it('no footer button when onSaveCurrent is absent (read-only library)', () => {
    render(<SavedArrangementGallery open arrangements={[template]} onAction={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Save this board' })).toBeNull();
  });

  it('R4 — search box filters the library by keyword (label/category/source)', () => {
    const rows = [
      template, // 'Starter board'
      { ...collection, id: 'c1', label: 'Marketing plan' },
      { ...collection, id: 'c2', label: 'Sprint retro', category: 'Team' },
      { ...collection, id: 'c3', label: 'Roadmap 2026' },
    ] as SavedArrangement[];
    render(<SavedArrangementGallery open arrangements={rows} onAction={() => {}} onClose={() => {}} />);
    const box = screen.getByLabelText('Search layouts');
    expect(screen.getByText('Marketing plan')).toBeTruthy();
    expect(screen.getByText('Roadmap 2026')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'road' } });
    expect(screen.getByText('Roadmap 2026')).toBeTruthy();
    expect(screen.queryByText('Marketing plan')).toBeNull();
    expect(screen.queryByText('Starter board')).toBeNull();
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText(/No layouts match/i)).toBeTruthy();
  });

  it('R4 — search box hidden for small libraries (≤3 rows)', () => {
    render(<SavedArrangementGallery open arrangements={[template, collection]} onAction={() => {}} onClose={() => {}} />);
    expect(screen.queryByLabelText('Search layouts')).toBeNull();
  });

  it('R4 — a card shows its description and tag chips', () => {
    const rich: SavedArrangement = {
      ...collection,
      id: 'c-rich',
      label: 'Content calendar',
      category: 'Planning',
      description: 'Plan posts across the month',
      tags: ['content', 'schedule'],
    };
    render(<SavedArrangementGallery open arrangements={[rich]} onAction={() => {}} onClose={() => {}} />);
    expect(screen.getByText('Plan posts across the month')).toBeTruthy();
    expect(screen.getByText('content')).toBeTruthy();
    expect(screen.getByText('schedule')).toBeTruthy();
  });

  it('R4 — a category facet chip appears when >1 category and narrows the grid', () => {
    const rows = [
      { ...collection, id: 'a', label: 'Kanban', category: 'Planning' },
      { ...collection, id: 'b', label: 'Brainstorm', category: 'Ideation' },
      { ...collection, id: 'c', label: 'Weekly plan', category: 'Planning' },
    ] as SavedArrangement[];
    render(<SavedArrangementGallery open arrangements={rows} onAction={() => {}} onClose={() => {}} />);
    // All three visible with no facet active.
    expect(screen.getByText('Kanban')).toBeTruthy();
    expect(screen.getByText('Brainstorm')).toBeTruthy();
    // R52: facet values live in an anchored dropdown — open the "Category" trigger first.
    fireEvent.click(screen.getByRole('button', { name: /^Filter by Category/ }));
    // Each chip carries its conjunctive match count in the aria-label ("Category: Ideation (1 match)").
    fireEvent.click(screen.getByRole('button', { name: /^Category: Ideation \(1 match\)/ }));
    expect(screen.getByText('Brainstorm')).toBeTruthy();
    expect(screen.queryByText('Kanban')).toBeNull();
    expect(screen.queryByText('Weekly plan')).toBeNull();
    // Toggle it off → all three return (multi-select toggle, not a fixed radio).
    fireEvent.click(screen.getByRole('button', { name: /^Category: Ideation/ }));
    expect(screen.getByText('Kanban')).toBeTruthy();
  });

  it('R4 — a TAG facet chip filters the library (Sam: searchable by tags, not just keywords)', () => {
    const rows = [
      { ...collection, id: 'a', label: 'Kanban', tags: ['agile', 'tasks'] },
      { ...collection, id: 'b', label: 'Brainstorm', tags: ['ideas'] },
      { ...collection, id: 'c', label: 'Weekly plan', tags: ['agile', 'schedule'] },
    ] as SavedArrangement[];
    render(<SavedArrangementGallery open arrangements={rows} onAction={() => {}} onClose={() => {}} />);
    // R52: open the "Tags" facet dropdown first, then click a value.
    fireEvent.click(screen.getByRole('button', { name: /^Filter by Tags/ }));
    // The tag chip group renders each distinct tag as a filter with its match count
    // (aria "Tags: <tag> (<n> match…)") — agile is on Kanban + Weekly plan.
    fireEvent.click(screen.getByRole('button', { name: /^Tags: agile \(2 matches\)/ }));
    expect(screen.getByText('Kanban')).toBeTruthy();
    expect(screen.getByText('Weekly plan')).toBeTruthy();
    expect(screen.queryByText('Brainstorm')).toBeNull(); // not agile-tagged
    // Add a second tag (OR within the tag facet) → Brainstorm returns. `ideas` counts over the
    // OTHER facets only (a facet never filters itself), so it reads its own catalog count of 1.
    fireEvent.click(screen.getByRole('button', { name: /^Tags: ideas \(1 match\)/ }));
    expect(screen.getByText('Brainstorm')).toBeTruthy();
  });

  it('R4 — search matches a TAG, not just the label', () => {
    const rows = [
      { ...collection, id: 'a', label: 'Kanban', tags: ['agile', 'tasks'] },
      { ...collection, id: 'b', label: 'Brainstorm', tags: ['ideas'] },
      { ...collection, id: 'c', label: 'Weekly plan', tags: ['agile', 'schedule'] },
      { ...collection, id: 'd', label: 'Roadmap', tags: ['strategy'] },
    ] as SavedArrangement[];
    render(<SavedArrangementGallery open arrangements={rows} onAction={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Search layouts'), { target: { value: 'agile' } });
    expect(screen.getByText('Kanban')).toBeTruthy(); // tagged 'agile'
    expect(screen.getByText('Weekly plan')).toBeTruthy(); // tagged 'agile'
    expect(screen.queryByText('Brainstorm')).toBeNull();
    expect(screen.queryByText('Roadmap')).toBeNull();
  });
});
