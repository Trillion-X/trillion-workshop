// packages/ui/show/node-editors/NodeEditorPanels.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The generic, presentational editor panels hosted inside the NodeContextMenu's
// glass popover: rename a thing, pick a background file, choose a background
// color (true HSV wheel), set a grain amount. They are PURE shells —
// value-in / callback-out — and know nothing about nodes, regions, layers, or
// the screen-arrangement. A surface wires its own services to value+onChange.
//
// They live in ui/ (not feature code) precisely so feature packs compose them
// without hand-rolling panel chrome (L065/L066): the screen-arrangement's
// node-action pack instantiates these and passes service-backed callbacks.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Pure browser-local UI. No reads/writes/feeds/package behavior/I/O.
// 2. Zero domain vocabulary — "thing", "background", "grain" are generic.
// 3. Value is caller-owned; these panels hold only transient draft state.
// =============================================================================

import React from 'react';
import { Button } from '../button';
import { ColorWheel } from '../color-wheel/ColorWheel';
import { FileWorkAction } from '../file-work-action/FileWorkAction';
import { Icon } from '../icon';

interface RenamePanelProps {
  readonly value: string;
  readonly onCommit: (name: string) => void;
  readonly onCancel: () => void;
}

/** A focused text field that commits on Enter / button, cancels on Escape. */
export function RenamePanel({ value, onCommit, onCancel }: RenamePanelProps) {
  const [draft, setDraft] = React.useState(value);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed) onCommit(trimmed);
    else onCancel();
  };
  return (
    <div className="flex flex-col gap-2 w-56">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') onCancel();
        }}
        aria-label="Name"
        className="h-8 rounded-lg bg-[var(--glass-bg-subtle)] border border-[var(--border-primary)] px-2.5 text-sm text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-accent-purple/50"
      />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="secondary" size="sm" onClick={commit}>Rename</Button>
      </div>
    </div>
  );
}

interface ColorPanelProps {
  readonly value: string;
  readonly onChange: (hex: string) => void;
  readonly onClear: () => void;
  readonly onDone: () => void;
}

/** A true HSV color wheel + Clear/Done. */
export function ColorPanel({ value, onChange, onClear, onDone }: ColorPanelProps) {
  return (
    <div className="flex flex-col gap-2">
      <ColorWheel value={value} onChange={onChange} size={200} />
      <div className="flex justify-between">
        <Button variant="ghost" size="sm" onClick={onClear}>Clear</Button>
        <Button variant="secondary" size="sm" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

interface GrainPanelProps {
  readonly label: string;
  readonly value: number; // 0..1
  readonly onChange: (amount: number) => void;
  readonly onDone: () => void;
}

/** A 0..100% slider for a single scalar effect (grain, blur, …). */
export function GrainPanel({ label, value, onChange, onDone }: GrainPanelProps) {
  return (
    <div className="flex flex-col gap-2 w-56">
      <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
        <span>{label}</span>
        <span className="tabular-nums text-[var(--text-muted)]">{Math.round(value * 100)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        aria-label={label}
        className="w-full accent-[var(--accent-purple,#8b5cf6)]"
      />
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BookmarksPanel — a generic saved-pointer list. Knows nothing about nodes,
// regions, tabs, or the screen-arrangement: it renders rows the caller supplies
// (id + label + folder + icon glyph name), groups them by folder, and emits
// open/remove by id. The surface owns what "open" means.
// ---------------------------------------------------------------------------

export interface BookmarkRowInfo {
  readonly id: string;
  readonly label: string;
  /** Folder grouping when present; absent rows fall under the default group. */
  readonly folder?: string;
  /** Glyph name passed straight to <Icon> when present. */
  readonly icon?: string;
}

interface BookmarksPanelProps {
  readonly bookmarks: readonly BookmarkRowInfo[];
  readonly onOpen: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onDone?: () => void;
  /** Heading for the ungrouped bucket. Pure label, caller-owned. */
  readonly defaultFolderLabel?: string;
}

/** Group rows by folder, preserving first-seen folder order and row order. */
function groupBookmarksByFolder(
  bookmarks: readonly BookmarkRowInfo[],
  defaultLabel: string,
): Array<{ folder: string; rows: BookmarkRowInfo[] }> {
  const order: string[] = [];
  const buckets = new Map<string, BookmarkRowInfo[]>();
  for (const row of bookmarks) {
    const folder = row.folder && row.folder.trim() ? row.folder : defaultLabel;
    if (!buckets.has(folder)) {
      buckets.set(folder, []);
      order.push(folder);
    }
    buckets.get(folder)!.push(row);
  }
  return order.map((folder) => ({ folder, rows: buckets.get(folder)! }));
}

/** A folder-grouped list of saved pointers; click a row to open, × to remove. */
export function BookmarksPanel({
  bookmarks,
  onOpen,
  onRemove,
  onDone,
  defaultFolderLabel = 'Bookmarks',
}: BookmarksPanelProps) {
  const groups = groupBookmarksByFolder(bookmarks, defaultFolderLabel);
  return (
    <div className="flex flex-col gap-2 w-64 max-h-80 overflow-y-auto">
      {groups.length === 0 ? (
        <div className="px-1 py-6 text-center text-xs text-[var(--text-muted)]">
          No bookmarks yet
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.folder} className="flex flex-col gap-1">
            {groups.length > 1 || group.folder !== defaultFolderLabel ? (
              <div className="px-1 text-[length:var(--font-size-caption)] font-medium text-[var(--text-muted)]">
                {group.folder}
              </div>
            ) : null}
            {group.rows.map((row) => (
              <div
                key={row.id}
                className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--glass-bg-hover)]"
              >
                <button
                  type="button"
                  onClick={() => onOpen(row.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm text-[var(--text-primary)]"
                >
                  {row.icon ? <Icon name={row.icon} size="sm" className="text-[var(--text-secondary)]" /> : null}
                  <span className="truncate">{row.label}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(row.id)}
                  aria-label="Remove bookmark"
                  className="rounded-md px-1.5 py-0.5 text-xs text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-status-error/10 hover:text-status-error group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ))
      )}
      {onDone ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onDone}>Done</Button>
        </div>
      ) : null}
    </div>
  );
}

interface BackgroundPickerPanelProps {
  readonly onPick: (file: File) => void;
  readonly onClear: () => void;
  readonly onDone: () => void;
  readonly accept?: string;
  /** Override the file chooser — e.g. a native OS picker via compute.process.
   *  When omitted, FileWorkAction falls back to the browser file input (which
   *  does NOT reliably open Finder inside the WebKit shell). */
  readonly pickFiles?: () => Promise<readonly File[]> | readonly File[];
}

/** A drop/choose surface for picking a background file (image/video/pdf). */
export function BackgroundPickerPanel({ onPick, onClear, onDone, pickFiles, accept = 'image/*,video/*,application/pdf' }: BackgroundPickerPanelProps) {
  return (
    <div className="w-72">
      <FileWorkAction
        accept={accept}
        emptyTitle="Set a background"
        emptyDetail="Drop or choose an image, video, or PDF."
        pickLabel="Choose file…"
        startLabel="Set background"
        rejectMessage="That file type can't be a background."
        startWhenFilesAccepted
        showStartAction={false}
        pickFiles={pickFiles}
        onStart={(file) => onPick(file)}
      />
      <div className="flex justify-between mt-2">
        <Button variant="ghost" size="sm" onClick={onClear}>Clear</Button>
        <Button variant="ghost" size="sm" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
