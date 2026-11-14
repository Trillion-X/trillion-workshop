// src/workspace/draw-design.tsx
//
// PURPOSE
//   The `draw` design (parts/ui/show/record-views/view-designs.ts): any list drawn on the real board through the one
//   way a workspace screen shows records there (./board-of.tsx BoardOf), where the person draws, writes, puts shapes,
//   sticky notes and pictures around the list's records. Each record is a card (records-on-a-board: its title, its
//   state as a live badge, its row actions as buttons, framed by its group) joined by the list's own lines and
//   nesting. The board keeps where each card sits and everything drawn around them per list (the board id is the
//   list's identity). Words changed on a card are written to the record's title through the list's own write; a
//   button pressed on a card runs that row action on the record, and Open opens the record where the list shows it; the board's Add offers what the list adds by kind
//   (its `adds`), or, for a list that keeps changes, a new record named by the words typed, landing where the person
//   was looking. When the records change the board reads them again and redraws only what changed.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field, product or screen is named here: the slots come from the row or the fields' roles, the height
//      and the Add words are the row's options.
//   2. One board per list: BoardOf opens it once per list identity; the list's changes reach it as new cards and lines.
//   3. Only a title the list may write (it keeps changes and the field is not worked out) is written back, and a new
//      record is added only to a list that keeps changes.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React, { useMemo, useRef } from 'react';
import { Container } from '../../parts/ui';
import { slotFields, writable, type ViewDesignProps } from '../../parts/ui/show/record-views/view-designs';
import { OPEN_ACTION, recordsOnABoard } from '../../parts/ui/show/record-views/designs/records-on-a-board';
import type { RecordAddRow } from '../../parts/ui/show/record-views/record-views';
import { BoardOf, type BoardOfSource } from './board-of';

type DrawOptions = { height?: string; add_label?: string; add_placeholder?: string; new_label?: string; open?: string };
type Edits = { edits?: { id: string; text: string }[] };
type Press = { id?: string; action?: string };
type Adding = { kind?: string; at?: { x: number; y: number } };

// The one row a list that keeps changes offers on the board's Add: a new record named by the words typed.
const NEW_RECORD = 'new-record';

export function DrawDesign({ context, row }: ViewDesignProps) {
  const options = (row.options ?? {}) as DrawOptions;
  const drawn = useMemo(() => recordsOnABoard(context, row),
    [context.records, context.fields, context.identify, context.rowActions, context.open, context.nesting, context.groupLevels, context.links, context.statusField, row]);
  // The board calls back long after it opened: it always reaches the list as it is now.
  const latest = useRef(context);
  latest.current = context;
  const typed = useRef('');
  const title = slotFields(row, context.fields, ['title']).title;
  const writes = writable(context, title);
  const acts = Boolean(context.rowActions?.length || (context.open && options.open));
  const adds = context.adds;
  const boardId = context.identity ?? context.label;
  const source = useMemo<BoardOfSource>(() => ({
    key: boardId,
    cards: drawn.cards,
    lines: drawn.lines,
    ...(writes ? {
      write: async ({ edits = [] }: Edits) => {
        const now = latest.current;
        const named = slotFields(row, now.fields, ['title']).title;
        if (!writable(now, named) || !edits.length) return;
        await now.write!(edits.map(edit => ({ id: edit.id, values: { [named.id]: edit.text } })));
      },
    } : {}),
    ...(acts ? {
      act: async ({ id, action }: Press) => {
        if (!id || !action) return;
        if (action === OPEN_ACTION) { latest.current.open?.(id); return; }
        await latest.current.rowActions?.find(one => one.id === action)?.run([id]);
      },
    } : {}),
    ...(adds ? {
      palette: (words: string) => latest.current.adds?.search(words) ?? [],
      add: async ({ kind, at }: Adding) => (kind ? latest.current.adds!.add(kind, at) : null),
      add_label: adds.label,
      ...(adds.placeholder ? { add_placeholder: adds.placeholder } : {}),
    } : writes && options.add_label ? {
      palette: (words: string): RecordAddRow[] => {
        typed.current = words.trim();
        return [{ id: NEW_RECORD, label: typed.current || options.new_label || options.add_label! }];
      },
      add: async () => {
        const now = latest.current;
        const named = slotFields(row, now.fields, ['title']).title;
        if (!writable(now, named)) return null;
        const id = crypto.randomUUID();
        await now.write!([{ id, create: true, values: { [named.id]: typed.current || options.new_label || options.add_label! } }]);
        return { id };
      },
      add_label: options.add_label,
      ...(options.add_placeholder ? { add_placeholder: options.add_placeholder } : {}),
    } : {}),
  }), [boardId, drawn, writes, acts, adds, row, options.add_label, options.add_placeholder, options.new_label]);
  return (
    <Container layout="vertical" heightPx={options.height ?? '480px'} minHeight="0" data-design={row.design} aria-label={context.label}>
      <BoardOf boardId={boardId} title={context.label} source={source} />
    </Container>
  );
}
