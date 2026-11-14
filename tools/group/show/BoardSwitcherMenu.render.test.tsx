// packages/group/show/BoardSwitcherMenu.render.test.tsx
//
// Render proof (RTL/jsdom) that the switcher COLLAPSES the archive behind one
// "Archived (N)" row (user feedback: a dense archive of proof/debug boards must
// not stretch the menu). The archived board titles are NOT in the DOM until the
// parent row is opened; opening reveals them and a child click fires restore.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import React from 'react';
import { BoardSwitcherMenu } from './BoardSwitcherMenu';
import type { BoardEntry } from '../read-data/group-board-model';

afterEach(() => cleanup());

const boards: BoardEntry[] = [
  { boardId: 'b1', title: 'Vision Board' } as BoardEntry,
  { boardId: 'b2', title: 'Second Board' } as BoardEntry,
];
const archived: BoardEntry[] = [
  { boardId: 'a1', title: 'Proof137' } as BoardEntry,
  { boardId: 'a2', title: 'PasteImg' } as BoardEntry,
  { boardId: 'a3', title: 'CtxMenu' } as BoardEntry,
];

function mount(over: Partial<React.ComponentProps<typeof BoardSwitcherMenu>> = {}) {
  const noop = () => {};
  const props: React.ComponentProps<typeof BoardSwitcherMenu> = {
    boards,
    archivedBoards: archived,
    currentBoardId: 'b1',
    currentBoardTitle: 'Vision Board',
    onNewBoard: noop,
    onNewFromTemplate: noop,
    onRenameBoard: noop,
    onDuplicateBoard: noop,
    onExportSvg: noop,
    onExportPng: noop,
    onExportDeck: noop,
    onCopyPng: noop,
    onArchiveBoard: noop,
    onArchiveOthers: noop,
    onEmptyArchive: noop,
    onRestoreBoard: noop,
    onSwitchBoard: noop,
    ...over,
  };
  return render(<BoardSwitcherMenu {...props} />);
}

/** Open the switcher menu (Radix popover portals to body). */
function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Switch board' }));
}

describe('BoardSwitcherMenu — archive collapsed behind one "Archived (N)" row', () => {
  it('archived board titles are NOT rendered until the Archived row is opened', () => {
    mount();
    openMenu();
    // The collapsed parent row shows the count…
    expect(screen.getByText('Archived (3)')).toBeTruthy();
    // …and NO archived title or Empty-archive row is in the DOM yet.
    expect(screen.queryByText('Proof137')).toBeNull();
    expect(screen.queryByText('PasteImg')).toBeNull();
    expect(screen.queryByText('Empty archive')).toBeNull();
    // Live boards + actions still render flat.
    expect(screen.getByText('Second Board')).toBeTruthy();
    expect(screen.getByText('New board')).toBeTruthy();
  });

  it('opening the Archived row reveals the flyout; a child click restores that board', () => {
    const onRestoreBoard = vi.fn();
    mount({ onRestoreBoard });
    openMenu();
    fireEvent.click(screen.getByText('Archived (3)'));
    // Flyout now lists every archived board + the Empty-archive action.
    expect(screen.getByText('Proof137')).toBeTruthy();
    expect(screen.getByText('CtxMenu')).toBeTruthy();
    expect(screen.getByText('Empty archive')).toBeTruthy();
    fireEvent.click(screen.getByText('PasteImg'));
    expect(onRestoreBoard).toHaveBeenCalledWith('a2');
  });

  it('Empty archive routes through the flyout to onEmptyArchive', () => {
    const onEmptyArchive = vi.fn();
    mount({ onEmptyArchive });
    openMenu();
    fireEvent.click(screen.getByText('Archived (3)'));
    fireEvent.click(screen.getByText('Empty archive'));
    expect(onEmptyArchive).toHaveBeenCalledTimes(1);
  });

  it('no Archived row at all when the archive is empty', () => {
    mount({ archivedBoards: [] });
    openMenu();
    expect(screen.queryByText(/^Archived \(/)).toBeNull();
  });

  it('the "Export as slides" row is present and routes to onExportDeck', () => {
    const onExportDeck = vi.fn();
    mount({ onExportDeck });
    openMenu();
    const row = screen.getByText('Export as slides');
    expect(row).toBeTruthy();
    fireEvent.click(row);
    expect(onExportDeck).toHaveBeenCalledTimes(1);
  });
});
