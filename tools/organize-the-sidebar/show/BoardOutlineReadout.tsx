// packages/group/show/BoardOutlineReadout.tsx
//
// BOARD OUTLINE READOUT — the surface for the `board-outline` leaf (b122): a jump-to table of contents for a
// big board. Each presentation frame (in story order) is a caption row with its card count; a "Loose cards"
// row gathers anything outside a frame. Clicking a section selects its cards (jump-to); clicking the count of a
// section with an `onPickCard` handler is left to callers that want per-card nav — the default is section-level.
//
// `ui`-only chrome (Container/Text — L065-safe). BLIND to what a section holds (L090) — it renders whatever
// `boardOutline` returns, so a new frame appears in the list with zero readout code.

import React from 'react';
import { Container, Text } from '../../ui/index.ts';
import type { BoardItem } from '../read-data/group-board-model.ts';
import { boardOutline, outlineCardTotal, type OutlineEntry } from '../do-work/board-outline.ts';
import { stripHtml } from './note-metrics.ts';

/** Run the outline over the board's items. */
export function boardOutlineEntries(items: readonly BoardItem[]): OutlineEntry[] {
  return boardOutline(items);
}

/** A short display label for a card row: the first non-empty line of its text (or stripped html), capped;
 *  falls back to "Untitled card". Presentation-only (the leaf carries no titles). */
export function cardLabel(item: BoardItem | undefined): string {
  const raw = item?.text ?? (item?.html ? stripHtml(item.html) : '');
  const firstLine = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (!firstLine) return 'Untitled card';
  return firstLine.length > 44 ? `${firstLine.slice(0, 44).trimEnd()}…` : firstLine;
}

export interface BoardOutlineReadoutProps {
  readonly items: readonly BoardItem[];
  /** Select the cards of a section (jump-to) — also toggles the section open to reveal its cards. */
  readonly onPickSection?: (memberIds: readonly string[]) => void;
  /** Jump to ONE card (clicking a card row inside an expanded section). */
  readonly onPickCard?: (memberId: string) => void;
  /** Reorder a FRAME section earlier (-1) or later (+1) in the story path (the ▲▼ controls). */
  readonly onReorderSection?: (frameId: string, dir: -1 | 1) => void;
  /** Max sections to list (default 24). */
  readonly maxSections?: number;
  /** Max card rows shown inside an expanded section (default 20). */
  readonly maxCardsPerSection?: number;
}

/** The table-of-contents panel — one row per section (caption + card count); a section opens to list its cards,
 *  and a card row jumps to that single card. Card labels are derived here (the leaf carries only ids). */
export function BoardOutlineReadout({ items, onPickSection, onPickCard, onReorderSection, maxSections = 24, maxCardsPerSection = 20 }: BoardOutlineReadoutProps) {
  const entries = boardOutlineEntries(items);
  const total = outlineCardTotal(entries);
  const frameIds = entries.filter((e) => e.frameId !== null).map((e) => e.frameId as string);
  const frameCount = frameIds.length;
  const byId = React.useMemo(() => new Map(items.map((i) => [i.memberId, i])), [items]);
  const [openKey, setOpenKey] = React.useState<string | null>(null);

  return (
    <Container layout="vertical" gap="sm" style={{ padding: 14, background: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0', minWidth: 240 }} data-board-outline>
      <Container style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <Text variant="body" style={{ fontWeight: 700, color: '#0f172a' }}>Outline</Text>
        <Text variant="body-xs" color="muted">{frameCount} {frameCount === 1 ? 'section' : 'sections'} · {total} {total === 1 ? 'card' : 'cards'}</Text>
      </Container>

      {entries.length === 0 ? (
        <Text variant="body-xs" color="muted">Nothing on the board yet — add cards or wrap them in a frame to build sections.</Text>
      ) : (
        <Container layout="vertical" gap="xs">
          {entries.slice(0, maxSections).map((e, i) => {
            const key = e.frameId ?? `loose-${i}`;
            const isOpen = openKey === key && e.cardCount > 0;
            return (
              <Container key={key} layout="vertical" gap="xs">
                <Container
                  role="button"
                  onClick={e.cardCount > 0 ? () => {
                    setOpenKey((cur) => (cur === key ? null : key));
                    onPickSection?.(e.memberIds);
                  } : undefined}
                  data-outline-section={e.frameId ?? 'loose'}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 8, background: e.frameId === null ? '#f8fafc' : '#f1f5f9', cursor: e.cardCount > 0 ? 'pointer' : 'default' }}
                >
                  <Text variant="body-sm" style={{ color: e.frameId === null ? '#64748b' : '#334155', fontWeight: e.frameId === null ? 400 : 600, fontStyle: e.frameId === null ? 'italic' : 'normal' }}>{isOpen ? '▾ ' : '▸ '}{e.caption}</Text>
                  <Container style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {onReorderSection && e.frameId !== null ? (() => {
                      const fi = frameIds.indexOf(e.frameId);
                      const fid = e.frameId;
                      return (
                        <Container style={{ display: 'flex', gap: 2 }} data-outline-reorder={fid}>
                          {fi > 0 ? (
                            <Container role="button" data-outline-up={fid} onClick={(ev: React.MouseEvent) => { ev.stopPropagation(); onReorderSection(fid, -1); }} style={{ padding: '0 4px', borderRadius: 4, cursor: 'pointer' }}>
                              <Text variant="body-xs" color="muted">▲</Text>
                            </Container>
                          ) : null}
                          {fi < frameIds.length - 1 ? (
                            <Container role="button" data-outline-down={fid} onClick={(ev: React.MouseEvent) => { ev.stopPropagation(); onReorderSection(fid, 1); }} style={{ padding: '0 4px', borderRadius: 4, cursor: 'pointer' }}>
                              <Text variant="body-xs" color="muted">▼</Text>
                            </Container>
                          ) : null}
                        </Container>
                      );
                    })() : null}
                    <Container style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 999, padding: '0 8px', minWidth: 22, textAlign: 'center' }}>
                      <Text variant="body-xs" color="muted">{e.cardCount}</Text>
                    </Container>
                  </Container>
                </Container>
                {isOpen ? (
                  <Container layout="vertical" gap="xs" style={{ paddingLeft: 12 }} data-outline-cards={e.frameId ?? 'loose'}>
                    {e.memberIds.slice(0, maxCardsPerSection).map((mid) => (
                      <Container
                        key={mid}
                        role="button"
                        onClick={onPickCard ? () => onPickCard(mid) : undefined}
                        data-outline-card={mid}
                        style={{ padding: '3px 10px', borderRadius: 6, cursor: onPickCard ? 'pointer' : 'default' }}
                      >
                        <Text variant="body-xs" style={{ color: '#475569' }}>{cardLabel(byId.get(mid))}</Text>
                      </Container>
                    ))}
                  </Container>
                ) : null}
              </Container>
            );
          })}
        </Container>
      )}
    </Container>
  );
}
