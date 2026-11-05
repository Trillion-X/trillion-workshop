// packages/group/show/SelectedItemToolbar.tsx
// The header's per-selection action buttons: View, Style, Link, Link board,
// Text size, Arrange, Edit card, Open as a document, Tag, Move out, Rename, Ungroup.

import React from 'react';
import { Button, Dropdown, Icon } from '../../ui/index.ts';
import { DatePicker } from '../../ui/show/date-picker/DatePicker';
import { AppWindow, FileText, FolderOutput, Flame, Layers, Link2, ListChecks, Maximize2, MessageSquare, Pencil, Tag, Target, Timer, Ungroup } from 'lucide-react';
import type { BoardItem, BoardEntry } from '../read-data/group-board-model.ts';
import { threadFromRaw } from '../read-data/board-comments.ts';
import { checklistFromRaw, checklistProgress } from '../read-data/board-checklist.ts';
import { dueDateFromRaw, dueMsToDateLabel } from '../read-data/board-due-date.ts';
import { habitBadgeOf } from '../do-work/board-habit-actions.ts';
import { metricFromRaw, progressPct } from '../read-data/board-metric.ts';
import { formatDuration, timeLogFromRaw, totalDurationMs } from '../read-data/board-time-log.ts';
import { itemHref } from './item-link.ts';
import { itemBoardLink } from './item-board-link.ts';
import { itemTags } from './item-tags.ts';
import { ItemStylePicker } from './ItemStylePicker.tsx';
import type { AppearanceProfile } from './item-appearance.ts';
import { ArrangeMenu } from './ArrangeMenu.tsx';
import { MarkerPicker } from './MarkerPicker.tsx';
import { type BoardMarker } from './board-marker-catalog.ts';

/** Item board-link picker sentinel: clear the item's `extra.boardLink` (#218 Unlink). */
const UNLINK_BOARD_VALUE = '__unlink-board__';

export interface SelectedItemToolbarProps {
  selectedItem: BoardItem | null;
  boards: readonly BoardEntry[];
  currentBoardId: string;
  multipleNodesSelected: boolean;
  /** Move-out is parent-nav specific: only inside a section with a selection. */
  showMoveOut: boolean;
  onView: (memberId: string) => void;
  onOpenStyle: (memberId: string, point: { x: number; y: number }) => void;
  onSetLink: (memberId: string, current: string | undefined) => void;
  onSetBoardLink: (memberId: string, boardId: string | null) => void;
  /** R2b — set/clear ONE per-item appearance override (`extra.<key>`); `undefined` clears the key
   *  (the note falls back to the board default). Drives the ItemStylePicker's descriptor controls. */
  onSetItemAppearance: (memberId: string, key: string, value: unknown) => void;
  /** R3/P2 — set/clear this item's list marker (`extra.marker`). '' clears. */
  onSetMarker: (memberId: string, markerId: string) => void;
  /** R3/P2 — the effective marker catalog (built-ins + DATA rows) shown in the picker.
   *  Absent → built-in catalog only. */
  markerCatalog?: readonly BoardMarker[];
  onArrange: (strategyId: string) => void;
  /** Open the anchored comment thread for this item (R-comments). */
  onComment: (memberId: string) => void;
  /** Open the checklist (break this item into steps). */
  onChecklist: (memberId: string) => void;
  /** Set/clear this item's due date (ms timestamp, or null to clear). */
  onSetDueDate: (memberId: string, dueMs: number | null) => void;
  /** Toggle "logged today" on this item's habit streak. */
  onLogHabitToday: (memberId: string) => void;
  /** Open the numeric-progress editor for this item (seeds a starter metric if none). */
  onSetMetric: (memberId: string) => void;
  /** Open the time-log editor for this item. */
  onLogTime: (memberId: string) => void;
  onEditLinkCard: (memberId: string) => void;
  onSetTags: (memberId: string, current: readonly string[]) => void;
  onMoveOut: () => void;
  onRenameSection: (memberId: string, current: string) => void;
  onUngroupSection: (memberId: string) => void;
  /** Show this note as a document (its words become a document the card then shows); absent, not offered. The
   *  returned promise is the work the button shows in itself. */
  openAsDocument?: { label: string; run: (memberId: string) => Promise<void> };
}

export function SelectedItemToolbar({
  selectedItem,
  boards,
  currentBoardId,
  multipleNodesSelected,
  showMoveOut,
  onView,
  onOpenStyle,
  onSetLink,
  onSetBoardLink,
  onSetItemAppearance,
  onSetMarker,
  markerCatalog,
  onArrange,
  onComment,
  onChecklist,
  onSetDueDate,
  onLogHabitToday,
  onSetMetric,
  onLogTime,
  onEditLinkCard,
  onSetTags,
  onMoveOut,
  onRenameSection,
  onUngroupSection,
  openAsDocument,
}: SelectedItemToolbarProps) {
  return (
    <>
      {selectedItem?.src ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onView(selectedItem.memberId)}
          aria-label="View full screen"
        >
          <Icon icon={Maximize2} size="sm" /> View
        </Button>
      ) : null}
      {selectedItem && !selectedItem.isSection ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => onOpenStyle(selectedItem.memberId, { x: e.clientX, y: e.clientY })}
          aria-label="Style this item — background, edge, and layers"
        >
          <Icon icon={Layers} size="sm" /> Style
        </Button>
      ) : null}
      {selectedItem && !selectedItem.isSection ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSetLink(selectedItem.memberId, itemHref(selectedItem))}
          aria-label="Link this item to a source URL"
        >
          <Icon icon={Link2} size="sm" /> Link
        </Button>
      ) : null}
      {/* #218 — link this item to ANOTHER board (Miro/FigJam "board of boards"). A
          Dropdown of the OTHER boards (you can't link a board to itself) + Unlink when
          already linked; the pick writes `extra.boardLink`. The blind chip in the node
          corner navigates on click. Hidden with no other board. */}
      {selectedItem && !selectedItem.isSection && boards.some((b) => b.boardId !== currentBoardId) ? (
        <Dropdown
          items={[
            ...boards
              .filter((b) => b.boardId !== currentBoardId)
              .map((b) => ({ value: b.boardId, label: b.title, icon: 'LayoutGrid' })),
            ...(itemBoardLink(selectedItem)
              ? [{ value: UNLINK_BOARD_VALUE, label: 'Unlink board', icon: 'X' }]
              : []),
          ]}
          value={itemBoardLink(selectedItem) ?? ''}
          onValueChange={(v) => onSetBoardLink(selectedItem.memberId, v === UNLINK_BOARD_VALUE ? null : v)}
          align="start"
          aria-label="Link this item to another board"
          customTrigger={
            <Button variant="ghost" size="sm" aria-label="Link this item to another board">
              <Icon icon={AppWindow} size="sm" /> Link board
            </Button>
          }
        />
      ) : null}
      {/* #225 (P1 / R2b) — PER-ITEM appearance overrides (Note style / Text size / Note density),
          the cascade's third tier: this note's own look, winning over the board default. Rendered
          from ITEM_APPEARANCE_CONTROLS through the SAME blind BoardDefaultControl the board-default
          popover uses (writes `extra.<key>`; "Default" clears → inherit the board). Dissolves the
          former one-off text-size Dropdown into the descriptor primitive (L030/L063). */}
      {selectedItem && !selectedItem.isSection ? (
        <ItemStylePicker
          itemExtra={selectedItem.extra as AppearanceProfile | undefined}
          onSet={(key, value) => onSetItemAppearance(selectedItem.memberId, key, value)}
        />
      ) : null}
      {/* R3/P2 — the note's list MARKER (circle / number / roman / dash / star / emoji /
          cycle / …) as self-describing DATA. The catalog is DATA and the char is produced by
          an injected capability map (zero enum), so a new marker is one DATA row — a user's
          "why does a bullet have to be a circle?" dissolved. Pick writes `extra.marker`; the
          blind NoteItem renderer prepends the resolved glyph. "No marker" clears it. */}
      {selectedItem && !selectedItem.isSection ? (
        <MarkerPicker
          value={typeof selectedItem.extra?.marker === 'string' ? (selectedItem.extra.marker as string) : ''}
          onPick={(id) => onSetMarker(selectedItem.memberId, id)}
          markers={markerCatalog}
          includeNone
        />
      ) : null}
      {/* R8 — arrange the multi-selection with a layout strategy (grid/row/circle…).
          Only shown when 2+ nodes are selected (arranging one item is meaningless).
          The strategy catalog is DATA; picking one lays the selection out in place. */}
      {multipleNodesSelected ? (
        <ArrangeMenu onArrange={onArrange} />
      ) : null}
      {selectedItem?.kind === 'link' ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onEditLinkCard(selectedItem.memberId)}
          aria-label="Edit this link card's title and description"
        >
          <Icon icon={Pencil} size="sm" /> Edit card
        </Button>
      ) : null}
      {openAsDocument && selectedItem?.kind === 'note' && !selectedItem.isSection ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openAsDocument.run(selectedItem.memberId)}
          aria-label={openAsDocument.label}
        >
          <Icon icon={FileText} size="sm" /> {openAsDocument.label}
        </Button>
      ) : null}
      {selectedItem ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSetTags(selectedItem.memberId, itemTags(selectedItem))}
          aria-label="Tag this item"
        >
          <Icon icon={Tag} size="sm" /> {itemTags(selectedItem).length ? `Tags · ${itemTags(selectedItem).length}` : 'Tag'}
        </Button>
      ) : null}
      {/* Anchored comment thread — open the discussion pinned to this item. The count
          badge shows existing entries; the pin + popover live in BoardCommentsLayer. */}
      {selectedItem && !selectedItem.isSection ? (
        (() => {
          const count = threadFromRaw(selectedItem.extra?.commentThread)?.entries.length ?? 0;
          return (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onComment(selectedItem.memberId)}
              aria-label="Comment on this item"
            >
              <Icon icon={MessageSquare} size="sm" /> {count > 0 ? `Comments · ${count}` : 'Comment'}
            </Button>
          );
        })()
      ) : null}
      {/* Checklist — break this item into steps. The label shows done/total when a checklist exists. */}
      {selectedItem && !selectedItem.isSection ? (
        (() => {
          const p = checklistProgress(checklistFromRaw(selectedItem.extra?.checklist));
          return (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChecklist(selectedItem.memberId)}
              aria-label="Checklist for this item"
            >
              <Icon icon={ListChecks} size="sm" /> {p.total > 0 ? `Steps · ${p.done}/${p.total}` : 'Checklist'}
            </Button>
          );
        })()
      ) : null}
      {/* Due date — give this item a deadline. The DatePicker speaks 'YYYY-MM-DD'; this converts to/from
          the stored ms timestamp. Clearing (null) removes the deadline. */}
      {selectedItem && !selectedItem.isSection ? (
        <DatePicker
          value={(() => { const d = dueDateFromRaw(selectedItem.extra?.dueDate); return d === null ? null : dueMsToDateLabel(d); })()}
          onChange={(dateStr) => onSetDueDate(selectedItem.memberId, dateStr ? Date.parse(dateStr) : null)}
          placeholder="Due date"
          aria-label="Set a due date for this item"
        />
      ) : null}
      {/* Habit — track how consistently this item gets done. The button IS the "log today" toggle:
          it shows the current streak (🔥 N) and fills when today is already logged. */}
      {selectedItem && !selectedItem.isSection ? (
        (() => {
          const now = Date.now();
          // Cadence-aware (shared habitBadgeOf): a 3x/week habit shows "2/3" this period, never a false 0.
          const badge = habitBadgeOf(selectedItem, now);
          const done = badge?.loggedToday ?? false;
          const text = badge?.cadence
            ? `${badge.cadence.done}/${badge.cadence.target}`
            : badge && badge.streak > 0
              ? `Streak · ${badge.streak}`
              : done
                ? 'Logged'
                : 'Log today';
          return (
            <Button
              variant={done ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => onLogHabitToday(selectedItem.memberId)}
              aria-label={done ? 'Un-log today for this habit' : 'Log today for this habit'}
            >
              <Icon icon={Flame} size="sm" /> {text}
            </Button>
          );
        })()
      ) : null}
      {/* Metric — track a number toward a target (save 5000, read 12 books, clear debt). The label shows
          the current completion percent when a metric exists; the editor lives in the item's MetricPanel. */}
      {selectedItem && !selectedItem.isSection ? (
        (() => {
          const metric = metricFromRaw(selectedItem.extra?.metric);
          return (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSetMetric(selectedItem.memberId)}
              aria-label="Track numeric progress for this item"
            >
              <Icon icon={Target} size="sm" /> {metric ? `Progress · ${progressPct(metric)}%` : 'Progress'}
            </Button>
          );
        })()
      ) : null}
      {/* Time — log effort on this item (timer or quick-add). The label shows the total once any time is
          logged; the editor lives in the item's TimeLogPanel. */}
      {selectedItem && !selectedItem.isSection ? (
        (() => {
          const total = totalDurationMs(timeLogFromRaw(selectedItem.extra?.timeLog));
          return (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onLogTime(selectedItem.memberId)}
              aria-label="Log time on this item"
            >
              <Icon icon={Timer} size="sm" /> {total > 0 ? `Time · ${formatDuration(total)}` : 'Time'}
            </Button>
          );
        })()
      ) : null}
      {/* Group / Delete live in the floating BulkSelectBar (the generic multi-edit
          surface). Move-out stays here — it is parent-nav specific and not part of
          the batch pack. */}
      {showMoveOut ? (
        <Button variant="ghost" size="sm" onClick={onMoveOut} aria-label="Move selected out to the parent">
          <Icon icon={FolderOutput} size="sm" /> Move out
        </Button>
      ) : null}
      {selectedItem?.isSection ? (
        <Button variant="ghost" size="sm" onClick={() => onRenameSection(selectedItem.memberId, selectedItem.text ?? 'Section')} aria-label="Rename this section">
          <Icon icon={Pencil} size="sm" /> Rename
        </Button>
      ) : null}
      {selectedItem?.isSection ? (
        <Button variant="ghost" size="sm" onClick={() => onUngroupSection(selectedItem.memberId)} aria-label="Ungroup this section">
          <Icon icon={Ungroup} size="sm" /> Ungroup
        </Button>
      ) : null}
    </>
  );
}
