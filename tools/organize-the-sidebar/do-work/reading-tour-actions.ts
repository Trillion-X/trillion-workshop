// packages/group/do-work/reading-tour-actions.ts
//
// "Read in order" — a guided tour of a board GENERATED from its spatial reading order, instead of authored. The
// walkthrough overlay + navigation (walkthrough.ts + WalkthroughOverlay) already step through any Tour and frame
// each step's target card; and board-reading-order already linearizes a freeform board (row band by row band,
// left→right) with ZERO connectors or frames needed. This joins them: readingTour(items, label) turns the
// reading order into a Tour whose steps target each card in sequence — so the SAME overlay presents ANY board
// card-by-card, no authoring, no frames (the L069 payoff — reading-order × tour-nav, both already shipped). Owns
// NO ordering logic (readingOrder SSOT) and NO navigation (walkthrough's stepAt/nextIndex) — pure composition
// (L069/L093). `label` injected so it stays blind to how a card titles itself (L098). Pure, deterministic.

import type { BoardItem } from '../read-data/group-board-model';
import type { Tour, TourStep } from '../read-data/walkthrough';
import { readingOrder, type ReadingOrderOptions } from '../read-data/board-reading-order';

/**
 * A Tour that walks the board in spatial reading order — one step per content card, each targeting that card so
 * the walkthrough overlay frames it. `label` resolves a card's display title; a card with no text falls back to
 * its position. `opts` passes through to readingOrder (e.g. a column read). An empty board → a zero-step tour.
 */
export function readingTour(items: readonly BoardItem[], label: (memberId: string) => string, opts?: ReadingOrderOptions): Tour {
  const order = readingOrder(items, opts);
  const total = order.length;
  const steps: TourStep[] = order.map((memberId, i) => ({
    id: `reading:${memberId}`,
    target: memberId,
    title: label(memberId).trim() || `Card ${i + 1}`,
    body: `${i + 1} of ${total}`,
  }));
  return { id: 'reading-order', name: 'Read in order', steps };
}
