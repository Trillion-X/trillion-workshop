// packages/group/show/BoardToolsPanel.test.tsx
//
// Proves the single selection inspector progressively discloses its analysis
// subsystem and keeps every selection driver on one shared onSelect path.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import type { BoardItem } from '../read-data/group-board-model';
import { BoardToolsPanel } from './BoardToolsPanel';

afterEach(() => cleanup());

const note = (memberId: string, tags: string[] = []): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, extra: { tags } } as unknown as BoardItem);
const conn = (memberId: string, from: string, to: string): BoardItem =>
  ({ kind: 'connector', memberId, x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: from, toMemberId: to } } as unknown as BoardItem);

const items = [note('a', ['work']), note('b', ['work']), conn('ab', 'a', 'b')];

function renderPanel(sel: string[], onSelect = vi.fn()) {
  return {
    onSelect,
    ...render(
      <BoardToolsPanel items={items} selectedIds={sel} pinnedIds={null} onSelect={onSelect} onPin={vi.fn()} onUnpin={vi.fn()} onCombine={vi.fn()} />,
    ),
  };
}

describe('BoardToolsPanel', () => {
  it('opens saved-query recovery when explicitly mounted without selected cards', () => {
    const restore = vi.fn();
    const view = render(<BoardToolsPanel items={[]} selectedIds={[]} pinnedIds={null}
      onSelect={vi.fn()} onPin={vi.fn()} onUnpin={vi.fn()} onCombine={vi.fn()}
      smartSets={[]} smartSetExtractors={{}} onApplySmartSet={vi.fn()}
      archivedSmartSets={[{ memberId: 'saved', smartSetId: 'saved', name: 'Work', archived: true, query: { selection: { tag: ['work'] } } }]}
      onRestoreSmartSet={restore} />);
    expect(view.queryByRole('button', { name: 'Save smart set' })).toBeNull();
    expect(view.getByText('Add cards to filter and save a query.')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Restore Work' }));
    expect(restore).toHaveBeenCalledWith('saved');
  });
  const openAnalyze = (container: HTMLElement): void => {
    const trigger = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Analyze'));
    expect(trigger).toBeDefined();
    fireEvent.click(trigger as HTMLElement);
  };

  it('keeps analysis hidden until the person asks for it', () => {
    const { container } = renderPanel(['a']);
    expect(container.querySelector('[aria-label="Board report"]')).toBeNull();
    openAnalyze(container);
    expect(container.querySelector('[aria-label="Board report"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Selection actions"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Combine selections"]')).not.toBeNull();
  });

  it('a REPORT row click flows through the shared onSelect (report → selection)', () => {
    const { container, onSelect } = renderPanel(['a']);
    openAnalyze(container);
    // default census × kind → a "Note" row grouping a,b. Click it → onSelect([a,b]).
    const noteRow = container.querySelector('[aria-label="row Note"]') as HTMLElement;
    expect(noteRow).not.toBeNull();
    fireEvent.click(noteRow);
    expect(onSelect).toHaveBeenCalledWith(['a', 'b']);
  });

  it('a SELECTION-menu click flows through the same onSelect', () => {
    const { container, onSelect } = renderPanel(['a']);
    openAnalyze(container);
    const grow = container.querySelector('[aria-label="Grow selection"]') as HTMLElement;
    expect(grow).not.toBeNull(); // enabled: has selection + board has a connector
    fireEvent.click(grow);
    expect(onSelect).toHaveBeenCalledWith(['a', 'b']); // grow a → its connected neighbour b
  });
});
