// packages/group/show/BoardSwitcherMenu.tsx
// The board-switcher title dropdown: pick a board or run a board-level action.

import React from 'react';
import { Button, Dropdown, Icon, Text } from '../../ui';
import { ChevronDown } from 'lucide-react';
import type { BoardEntry } from '../read-data/group-board-model';

/** Switcher sentinels: these rows act instead of opening a board. */
const NEW_BOARD_VALUE = '__new-board__';
const DUPLICATE_BOARD_VALUE = '__duplicate-board__';
const RENAME_BOARD_VALUE = '__rename-board__';
const ARCHIVE_BOARD_VALUE = '__archive-board__';
const ARCHIVE_OTHERS_VALUE = '__archive-other-boards__';
const EMPTY_ARCHIVE_VALUE = '__empty-archive__';
/** Switcher sentinel: export the current board to a downloadable SVG (#142). */
const EXPORT_SVG_VALUE = '__export-svg__';
/** Switcher sentinel: export the current board to a downloadable PNG (#143). */
const EXPORT_PNG_VALUE = '__export-png__';
/** Switcher sentinel: export the board's presentation frames as a slide deck (one printable HTML doc). */
const EXPORT_DECK_VALUE = '__export-deck__';
/** Switcher sentinel: copy the current board to the clipboard as a PNG (#146). */
const COPY_PNG_VALUE = '__copy-png__';
/** Switcher sentinel: open the Templates & saved-layouts library gallery. */
const TEMPLATE_BOARD_VALUE = '__new-from-template__';
/** An archived-board row's value: this prefix + the archived board's id (restore). */
const RESTORE_PREFIX = '__restore__';
/** The collapsed "Archived (N)" parent row — opens the archive flyout, never selects. */
const ARCHIVED_MENU_VALUE = '__archived-menu__';

export interface BoardSwitcherMenuProps {
  boards: readonly BoardEntry[];
  archivedBoards: readonly BoardEntry[];
  currentBoardId: string;
  currentBoardTitle: string;
  onNewBoard: () => void;
  onNewFromTemplate: () => void;
  onRenameBoard: () => void;
  onDuplicateBoard: () => void;
  onExportSvg: () => void;
  onExportPng: () => void;
  onExportDeck: () => void;
  onCopyPng: () => void;
  onArchiveBoard: () => void;
  onArchiveOthers: () => void;
  onEmptyArchive: () => void;
  onRestoreBoard: (boardId: string) => void;
  onSwitchBoard: (boardId: string) => void;
}

export function BoardSwitcherMenu({
  boards,
  archivedBoards,
  currentBoardId,
  currentBoardTitle,
  onNewBoard,
  onNewFromTemplate,
  onRenameBoard,
  onDuplicateBoard,
  onExportSvg,
  onExportPng,
  onExportDeck,
  onCopyPng,
  onArchiveBoard,
  onArchiveOthers,
  onEmptyArchive,
  onRestoreBoard,
  onSwitchBoard,
}: BoardSwitcherMenuProps) {
  return (
    <Dropdown
      items={[
        ...boards.map((boardEntry) => ({ value: boardEntry.boardId, label: boardEntry.title, icon: 'LayoutGrid' })),
        { value: NEW_BOARD_VALUE, label: 'New board', icon: 'Plus' },
        { value: TEMPLATE_BOARD_VALUE, label: 'Templates & layouts', icon: 'LayoutTemplate' },
        { value: RENAME_BOARD_VALUE, label: 'Rename board', icon: 'Pencil' },
        { value: DUPLICATE_BOARD_VALUE, label: 'Duplicate board', icon: 'Copy' },
        { value: EXPORT_SVG_VALUE, label: 'Export as SVG', icon: 'Download' },
        { value: EXPORT_PNG_VALUE, label: 'Export as PNG', icon: 'Image' },
        { value: EXPORT_DECK_VALUE, label: 'Export as slides', icon: 'Presentation' },
        { value: COPY_PNG_VALUE, label: 'Copy as PNG', icon: 'ClipboardCopy' },
        ...(boards.length > 1 ? [{ value: ARCHIVE_BOARD_VALUE, label: 'Archive this board', icon: 'Archive' }] : []),
        ...(boards.length > 1
          ? [{ value: ARCHIVE_OTHERS_VALUE, label: 'Archive all other boards', icon: 'Archive' }]
          : []),
        // The archive is COLLAPSED behind one "Archived (N)" row (user feedback:
        // a dense archive of proof/debug boards must not stretch the switcher).
        // The Dropdown's own nested-`children` anatomy renders the flyout on
        // demand, and a child selection fires the parent onValueChange with the
        // CHILD's value — so the existing restore/empty routing works unchanged.
        ...(archivedBoards.length > 0
          ? [{
              value: ARCHIVED_MENU_VALUE,
              label: `Archived (${archivedBoards.length})`,
              icon: 'Archive',
              children: [
                ...archivedBoards.map((boardEntry) => ({
                  value: `${RESTORE_PREFIX}${boardEntry.boardId}`,
                  label: boardEntry.title,
                  icon: 'ArchiveRestore',
                })),
                { value: EMPTY_ARCHIVE_VALUE, label: 'Empty archive', icon: 'Trash2' },
              ],
            }]
          : []),
      ]}
      value={currentBoardId}
      onValueChange={(v) =>
        v === NEW_BOARD_VALUE
          ? onNewBoard()
          : v === TEMPLATE_BOARD_VALUE
            ? onNewFromTemplate()
          : v === RENAME_BOARD_VALUE
            ? onRenameBoard()
          : v === DUPLICATE_BOARD_VALUE
            ? onDuplicateBoard()
          : v === EXPORT_SVG_VALUE
            ? onExportSvg()
          : v === EXPORT_PNG_VALUE
            ? onExportPng()
          : v === EXPORT_DECK_VALUE
            ? onExportDeck()
          : v === COPY_PNG_VALUE
            ? onCopyPng()
          : v === ARCHIVE_BOARD_VALUE
            ? onArchiveBoard()
            : v === ARCHIVE_OTHERS_VALUE
              ? onArchiveOthers()
            : v === EMPTY_ARCHIVE_VALUE
              ? onEmptyArchive()
              : v.startsWith(RESTORE_PREFIX)
                ? onRestoreBoard(v.slice(RESTORE_PREFIX.length))
                : onSwitchBoard(v)
      }
      align="start"
      aria-label="Switch board"
      customTrigger={
        <Button variant="ghost" size="sm" aria-label="Switch board">
          <Text variant="heading-lg">{currentBoardTitle}</Text>
          <Icon icon={ChevronDown} size="sm" />
        </Button>
      }
    />
  );
}
