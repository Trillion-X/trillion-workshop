// packages/local-files/show/LocalFileTree.test.tsx
//
// Proves the name-filter search input added to FileTree's header (replacing
// the prior decorative Search icon) genuinely narrows the rendered entry list
// by case-insensitive substring match, and that the empty-vs-no-matches
// states are distinct honest states, not the same placeholder reused.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileTree } from '@/packages/local-files/show/LocalFileTree';

vi.mock('@/packages/local-files/read-data/read-local-file-roots', () => ({
  listLocalRootShortcuts: vi.fn().mockResolvedValue([
    { label: 'Home', path: '/workspace' },
  ]),
}));

vi.mock('@/packages/local-files/read-data/read-local-directory', () => ({
  listLocalDirectory: vi.fn().mockResolvedValue([
    { path: '/workspace/report.pdf', name: 'report.pdf', isDir: false },
    { path: '/workspace/receipts', name: 'receipts', isDir: true },
    { path: '/workspace/notes.txt', name: 'notes.txt', isDir: false },
  ]),
}));

vi.mock('@/packages/local-files/do-work/ask-local-file-display', () => ({
  askLocalFileDisplay: vi.fn().mockResolvedValue({ icon: 'File' }),
}));

afterEach(cleanup);

describe('FileTree search filter', () => {
  it('shows all entries when the filter is empty', async () => {
    render(<FileTree onFileSelect={() => {}} />);

    expect(await screen.findByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('receipts')).toBeTruthy();
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(screen.getByText('3 items')).toBeTruthy();
  });

  it('narrows entries to a case-insensitive substring match on name', async () => {
    render(<FileTree onFileSelect={() => {}} />);
    await screen.findByText('report.pdf');

    const filterInput = screen.getByPlaceholderText('Filter files by name');
    fireEvent.change(filterInput, { target: { value: 'REC' } });

    expect(screen.getByText('receipts')).toBeTruthy();
    expect(screen.queryByText('report.pdf')).toBeNull();
    expect(screen.queryByText('notes.txt')).toBeNull();
    expect(screen.getByText('1 items')).toBeTruthy();
  });

  it('renders a distinct no-matches state when the filter matches nothing', async () => {
    render(<FileTree onFileSelect={() => {}} />);
    await screen.findByText('report.pdf');

    const filterInput = screen.getByPlaceholderText('Filter files by name');
    fireEvent.change(filterInput, { target: { value: 'zzz-nonexistent' } });

    expect(screen.getByText('No files match your search.')).toBeTruthy();
    expect(screen.queryByText('This folder is empty.')).toBeNull();
  });

  it('clearing the filter restores the full entry list', async () => {
    render(<FileTree onFileSelect={() => {}} />);
    await screen.findByText('report.pdf');

    const filterInput = screen.getByPlaceholderText('Filter files by name');
    fireEvent.change(filterInput, { target: { value: 'rec' } });
    expect(screen.queryByText('report.pdf')).toBeNull();

    fireEvent.change(filterInput, { target: { value: '' } });
    expect(await screen.findByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('notes.txt')).toBeTruthy();
  });
});
