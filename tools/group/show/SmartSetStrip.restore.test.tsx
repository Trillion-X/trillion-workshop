import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { SmartSetStrip } from './SmartSetStrip';
import { addMember, emptyGraph, ensureGroup } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { readActiveSmartSets, readUnavailableSmartSets, smartSetIndexRef } from '../read-data/saved-smart-set';
import type { StoredSmartSet } from '../read-data/saved-smart-set';
import type { BoardItem } from '../read-data/group-board-model';

afterEach(cleanup);

it('previews added and removed cards before saving and keeps a failed save visible', async () => {
  const saved: StoredSmartSet = { memberId: 'query', smartSetId: 'query', name: 'Work', archived: false, query: { selection: { tag: ['work'] } } };
  const items = [{ memberId: 'a', text: 'Current card', extra: { tags: ['work'] } }, { memberId: 'b', text: 'Replacement card', extra: { tags: ['next'] } }] as unknown as BoardItem[];
  let finish!: (error: string | null) => void;
  const onReplaceQuery = vi.fn(() => new Promise<string | null>(resolve => { finish = resolve; }));
  const onApply = vi.fn();
  const currentQuery = { selection: { tag: ['next'] } };
  const view = render(<SmartSetStrip sets={[saved]} items={items} extractors={{ tag: item => item.extra.tags as string[] }} currentQuery={currentQuery} onReplaceQuery={onReplaceQuery} onApply={onApply} />);
  fireEvent.click(view.getByRole('button', { name: 'Why it matches Work' }));
  fireEvent.click(view.getByRole('button', { name: 'Compare current board filters' }));
  expect(view.getByText('Added: 1')).toBeDefined();
  expect(view.getByText('Removed: 1')).toBeDefined();
  expect(view.getByText('Replacement card')).toBeDefined();
  expect(onReplaceQuery).not.toHaveBeenCalled();
  expect(onApply).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: 'Save these filters' }));
  expect(onReplaceQuery).toHaveBeenCalledWith('query', saved.query, currentQuery);
  expect((view.getByRole('button', { name: 'Saving filters…' }) as HTMLButtonElement).disabled).toBe(true);
  finish('Save failed');
  await waitFor(() => expect(view.getByText('Save failed')).toBeDefined());
  expect(view.queryByText('Filters saved.')).toBeNull();
  expect(view.getByRole('button', { name: 'Save these filters' })).toBeDefined();
});

it('explains current matches without selecting, then opens the exact matching identity', () => {
  const saved: StoredSmartSet = { memberId: 'work', smartSetId: 'work', name: 'Work', archived: false, query: { selection: { tag: ['work'] } } };
  const item = { memberId: 'card-a', text: 'Client brief', kind: 'note', extra: { tags: [' Work ', 'other'] } } as unknown as BoardItem;
  const onApply = vi.fn();
  const props = { sets: [saved], items: [item], extractors: { tag: (row: BoardItem) => row.extra.tags as string[] }, facetLabels: { tag: 'Tag' }, onApply };
  const view = render(<SmartSetStrip {...props} />);
  fireEvent.click(view.getByRole('button', { name: 'Why it matches Work' }));
  expect(view.getByText('Tag: Work', { exact: false })).toBeDefined();
  expect(onApply).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: 'Select matching card Client brief' }));
  expect(onApply).toHaveBeenCalledWith(['card-a']);
  view.rerender(<SmartSetStrip {...props} items={[{ ...item, extra: { tags: ['other'] } }]} />);
  expect(view.getByText('No cards match these filters right now.')).toBeDefined();
  expect(view.queryByRole('button', { name: 'Select matching card Client brief' })).toBeNull();
});

it('renders a rejected stored query without an execution control in either mode', () => {
  const index = smartSetIndexRef();
  const graph = addMember(ensureGroup(emptyGraph(), index), index,
    { family: 'group.smart-set', parts: { 'smart-set': 'unreadable' } },
    { memberId: 'unreadable', presentation: { name: 'Unreadable work', record: { selection: { tag: 'work' } } } });
  const before = JSON.stringify(graph);
  const onApply = vi.fn(), onFocus = vi.fn();
  const view = render(<SmartSetStrip sets={readActiveSmartSets(graph, index)}
    unavailableSets={readUnavailableSmartSets(graph, index)} items={[]}
    extractors={{}} onApply={onApply} onFocus={onFocus} />);
  expect(view.getByText('Unreadable work — unavailable because its filters could not be read. Your cards are unchanged.')).toBeDefined();
  expect(view.queryByRole('button', { name: /(?:apply|focus) Unreadable work/i })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Clicking a smart set focuses the board on its cards' }));
  expect(view.queryByRole('button', { name: /(?:apply|focus) Unreadable work/i })).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
  expect(onFocus).not.toHaveBeenCalled();
  expect(JSON.stringify(graph)).toBe(before);
});

it('shows malformed saved queries without offering an execution path', () => {
  const onApply = vi.fn(), onFocus = vi.fn();
  const view = render(<SmartSetStrip sets={[]} unavailableSets={[{ memberId: 'bad', name: 'Unreadable filter' }]} items={[]} extractors={{}} onApply={onApply} onFocus={onFocus} />);
  expect(view.getByText(/Unreadable filter — unavailable because its filters could not be read/)).toBeDefined();
  expect(view.queryByRole('button', { name: /apply Unreadable/ })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Clicking a smart set focuses the board on its cards' }));
  expect(view.queryByRole('button', { name: /focus Unreadable/ })).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
  expect(onFocus).not.toHaveBeenCalled();
});

it('renames only the saved label and keeps live counts out of the editable value', () => {
  const query = { selection: { tag: ['work'] } };
  const saved: StoredSmartSet = { memberId: 'one', smartSetId: 'one', name: 'Work', archived: false, query };
  const onRename = vi.fn(), onApply = vi.fn();
  const view = render(<SmartSetStrip sets={[saved]} items={[]} extractors={{}} onSaveCurrent={vi.fn()} onApply={onApply} onRename={onRename} />);
  const field = view.getByRole('textbox', { name: 'Rename Work' });
  expect((field as HTMLInputElement).value).toBe('Work');
  fireEvent.change(field, { target: { value: 'Important work' } });
  fireEvent.blur(field);
  expect(onRename).toHaveBeenCalledWith('one', 'Important work');
  expect(onApply).not.toHaveBeenCalled();
  expect(saved.query).toEqual({ selection: { tag: ['work'] } });
  expect(view.getByText('0 matches')).toBeDefined();
});

it('restores an archived query without applying it and resolves current items after restoration', () => {
  const saved: StoredSmartSet = { memberId: 'query-one', smartSetId: 'query-one', name: 'Work', archived: true, query: { selection: { tag: ['work'] } } };
  const onRestore = vi.fn(), onApply = vi.fn();
  const props = { sets: [], items: [], extractors: { tag: (item: BoardItem) => item.extra.tags as string[] }, onSaveCurrent: vi.fn(), onApply, onRestore };
  const view = render(<SmartSetStrip {...props} archivedSets={[saved]} />);
  fireEvent.click(view.getByRole('button', { name: 'Restore Work' }));
  expect(onRestore).toHaveBeenCalledWith('query-one');
  expect(onApply).not.toHaveBeenCalled();
  const currentItem = { kind: 'note', memberId: 'new-match', x: 0, y: 0, w: 100, h: 40, extra: { tags: ['work'] } } as BoardItem;
  view.rerender(<SmartSetStrip {...props} archivedSets={[]} sets={[{ ...saved, archived: false }]} items={[currentItem]} />);
  expect(view.queryByRole('button', { name: 'Restore Work' })).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'apply Work · 1' }));
  expect(onApply).toHaveBeenCalledWith(['new-match']);
});
