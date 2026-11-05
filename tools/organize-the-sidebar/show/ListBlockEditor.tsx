// packages/group/show/ListBlockEditor.tsx
//
// R3 product surface: a note as a nested OUTLINE. Given the note's lines as outline rows
// (outline-text bridge), the author restructures them with the KEYBOARD (Tab/Shift+Tab/Enter/
// Backspace — the Workflowy/Notion grammar, via the pure outline-keys leaf) OR the buttons —
// indent, outdent, move up/down, add, delete. Every STRUCTURE op runs through the pure
// list-block-model leaf (the sole owner of the "no skipped levels, first row at 0" invariant);
// text/add/remove are local array edits followed by normalizeIndents so the list is always
// well-formed. Engine-free and fully self-contained. Chrome is ui components (L065); the indent
// guide is the one data-driven inline style (positional, per row depth).

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, GripVertical, Search, X } from 'lucide-react';
import { Button, Container, ExpandableTabs, Icon, Input, Text } from '../../ui/index.ts';
import {
  indentItem,
  normalizeIndents,
  outdentItem,
  type ListItem,
} from '../read-data/list-block-model.ts';
import { handleOutlineKey } from '../read-data/outline-keys.ts';
import { hasChildren, visibleRows } from '../read-data/outline-fold.ts';
import { moveSubtree, moveSubtreeDir } from '../read-data/outline-move.ts';
import { visibleUnderFilter } from '../read-data/outline-filter.ts';

export interface ListBlockEditorProps {
  readonly items: readonly ListItem[];
  readonly onChange: (items: ListItem[]) => void;
}

const INDENT_PX = 20;

let seq = 0;
const freshId = (): string => `n${(seq += 1)}`;

export function ListBlockEditor({ items, onChange }: ListBlockEditorProps): JSX.Element {
  const inputRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  // After a keyboard command re-renders the rows, focus the row the grammar chose (the new
  // Enter row, or the previous row after a Backspace-delete). Runs post-commit so the node exists.
  useEffect(() => {
    if (!pendingFocus) return;
    inputRefs.current.get(pendingFocus)?.focus();
    setPendingFocus(null);
  }, [pendingFocus, items]);

  const setText = (id: string, text: string) =>
    onChange(items.map((it) => (it.id === id ? { ...it, text } : it)));
  const addRow = () => onChange([...items, { id: freshId(), text: '', indent: 0 }]);
  const removeRow = (id: string) => onChange(normalizeIndents(items.filter((it) => it.id !== id)));
  const onKeyDown = (id: string, text: string) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    const result = handleOutlineKey(items, id, e.key, e.shiftKey, text.trim().length === 0, freshId());
    if (!result) return; // normal typing / caret motion
    e.preventDefault();
    onChange(result.items);
    setPendingFocus(result.focusId);
  };
  // Fold state (edit-session local): a collapsed parent hides its subtree via the pure
  // outline-fold leaf. Structure ops still run on the FULL items array — folding only changes
  // what is drawn, never the data.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFold = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  // Filter/search (Workflowy/Notion "type to narrow"): a non-empty query shows only matching rows
  // + their ancestor context via the pure outline-filter leaf, superseding the fold view. Empty
  // query → the normal fold view (zero change). A VIEW reducer only — the data is never touched.
  const [query, setQuery] = useState('');
  const filtering = query.trim().length > 0;
  const visible = filtering ? visibleUnderFilter(items, query) : visibleRows(items, collapsed);

  // Drag-to-reorder (Workflowy/Notion): the grip is the drag source; the row is the drop target.
  // Dropping row A onto row B moves A's WHOLE subtree to before B via the pure `moveSubtree` leaf
  // (fresh well-formed outline, no manual index math). A ref (not state) holds the dragged id so
  // dragging never re-renders the list mid-gesture.
  const draggingId = useRef<string | null>(null);

  return (
    <Container layout="vertical" gap="xs">
      {/* Filter row — appears once the outline is long enough to be worth narrowing. Typing shows
          only matching rows + their ancestor context; the ✕ clears back to the full fold view. */}
      {items.length >= 5 ? (
        <Container layout="horizontal" gap="xs" alignItems="center">
          <Icon icon={Search} size="xs" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter outline"
            placeholder="Filter…"
          />
          {filtering ? (
            <Button variant="ghost" size="icon" aria-label="Clear filter" onClick={() => setQuery('')}>
              <Icon icon={X} size="xs" />
            </Button>
          ) : null}
        </Container>
      ) : null}
      {filtering && visible.length === 0 ? (
        <Text variant="body-sm" tone="muted">No rows match “{query.trim()}”.</Text>
      ) : null}
      {visible.map((it) => {
        const idx = items.findIndex((r) => r.id === it.id);
        const parent = hasChildren(items, idx);
        const folded = collapsed.has(it.id);
        return (
        <Container
          key={it.id}
          data-row={it.id}
          layout="horizontal"
          gap="xs"
          alignItems="center"
          style={{ paddingLeft: it.indent * INDENT_PX }}
          onDragOver={(e) => { if (draggingId.current && draggingId.current !== it.id) e.preventDefault(); }}
          onDrop={(e) => {
            e.preventDefault();
            const from = draggingId.current;
            draggingId.current = null;
            if (from && from !== it.id) onChange(moveSubtree(items, from, it.id));
          }}
        >
          <Container
            data-grip={it.id}
            draggable
            onDragStart={() => { draggingId.current = it.id; }}
            onDragEnd={() => { draggingId.current = null; }}
            aria-label="Drag to reorder"
            style={{ cursor: 'grab', display: 'flex', alignItems: 'center' }}
          >
            <Icon icon={GripVertical} size="xs" />
          </Container>
          {parent && !filtering ? (
            <Button variant="ghost" size="icon" aria-label={folded ? 'Expand row' : 'Collapse row'} aria-expanded={!folded} onClick={() => toggleFold(it.id)}>
              <Icon icon={folded ? ChevronRight : ChevronDown} size="xs" />
            </Button>
          ) : (
            <Container minWidth="18px" />
          )}
          <Input
            ref={(el) => inputRefs.current.set(it.id, el)}
            value={it.text}
            onChange={(e) => setText(it.id, e.target.value)}
            onKeyDown={onKeyDown(it.id, it.text)}
            aria-label={`Outline row: ${it.text || 'empty'}`}
            placeholder="List item…"
          />
          <ExpandableTabs
            mode="action"
            size="sm"
            ariaLabel="Row"
            items={[
              { id: 'outdent', label: 'Outdent row', icon: 'ChevronLeft' },
              { id: 'indent', label: 'Indent row', icon: 'ChevronRight' },
              { id: 'up', label: 'Move row up', icon: 'ChevronUp' },
              { id: 'down', label: 'Move row down', icon: 'ChevronDown' },
              { id: 'delete', label: 'Delete row', icon: 'Trash2' },
            ]}
            onSelect={(id) => {
              if (id === 'outdent') onChange(normalizeIndents(outdentItem(items, it.id)));
              else if (id === 'indent') onChange(indentItem(items, it.id));
              else if (id === 'up') onChange(moveSubtreeDir(items, it.id, 'up'));
              else if (id === 'down') onChange(moveSubtreeDir(items, it.id, 'down'));
              else if (id === 'delete') removeRow(it.id);
            }}
          />
        </Container>
        );
      })}
      <Button variant="ghost" size="sm" aria-label="Add outline row" onClick={addRow}>
        + Add row
      </Button>
    </Container>
  );
}
