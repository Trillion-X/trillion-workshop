// packages/documents/read-data/cursor-commands.ts
//
// The cursor-command DATA table (enum-dissolution) — the gesture→(direction, caret-edge) bindings
// that drive spatial nav are DATA ROWS, not an `if (key === 'ArrowDown')` chain in the handler. Each
// row says: this key, fired at this caret edge of the block, moves along this DATA direction vector
// and lands the caret at this edge of the target block. Adding a binding (a Vim h/j/k/l, a diagonal,
// a page-down) is a new ROW here — ZERO change to the blind resolver or the keydown handler (L090).
// The handler reads the caret geometry, asks resolveCursorCommand for the matching row, and hands the
// row's direction/edge to resolveInDirection. It never names a key or a direction itself.

import type { Direction } from './cursor-nav';
import { flattenProjectedRows, isRecord } from './documents.ts';

/** Which visual edge of the block the caret must be on for a command to CROSS into a neighbor. */
export type CaretEdge = 'top' | 'bottom' | 'start' | 'end';

/** The four caret-edge flags the handler reads off the live caret (from readCaretGeometry). */
export type CaretEdges = { atTop: boolean; atBottom: boolean; atStart: boolean; atEnd: boolean };

/** One DATA binding: key + required caret edge → move `direction`, land at target `landEdge`. */
export type CursorCommand = {
  key: string;
  /** The caret edge that must be active for this command to fire (else the browser moves in-block). */
  requires: CaretEdge;
  direction: Direction;
  /** Where in the target block the caret lands (goal-column preserved for top/bottom). */
  landEdge: CaretEdge;
};

// The shipped bindings. Down/Up preserve the goal column across blocks; Left-at-start wraps to the
// END of the previous block (up ray) and Right-at-end wraps to the START of the next (down ray) —
// the Notion caret flow. Every one is a pure DATA row; the resolver below is blind to their meaning.
export const CURSOR_COMMANDS: readonly CursorCommand[] = [
  { key: 'ArrowDown', requires: 'bottom', direction: { dx: 0, dy: 1 }, landEdge: 'top' },
  { key: 'ArrowUp', requires: 'top', direction: { dx: 0, dy: -1 }, landEdge: 'bottom' },
  { key: 'ArrowLeft', requires: 'start', direction: { dx: 0, dy: -1 }, landEdge: 'end' },
  { key: 'ArrowRight', requires: 'end', direction: { dx: 0, dy: 1 }, landEdge: 'start' },
];

const EDGE_ACTIVE: Record<CaretEdge, (e: CaretEdges) => boolean> = {
  top: (e) => e.atTop,
  bottom: (e) => e.atBottom,
  start: (e) => e.atStart,
  end: (e) => e.atEnd,
};

/**
 * Resolve the cursor command for a key press given the live caret edges — or null when no row matches
 * (unbound key, or the caret isn't at the required edge, so the browser handles it in-block). Pure.
 */
export function resolveCursorCommand(
  key: string,
  edges: CaretEdges,
  commands: readonly CursorCommand[] = CURSOR_COMMANDS,
): { direction: Direction; landEdge: CaretEdge } | null {
  for (const cmd of commands) {
    if (cmd.key === key && EDGE_ACTIVE[cmd.requires](edges)) {
      return { direction: cmd.direction, landEdge: cmd.landEdge };
    }
  }
  return null;
}

/** THE cursor-command registry reader — the live gesture→(direction, land-edge) table. Reads BY KIND
 *  across the whole published-records feed: a row is a binding if its payload is `{kind:"cursor-command",
 *  …}` (an individual binding any package ships) OR `{kind:"cursor-command-set", rows:[…]}` (the compact
 *  seed), OR a bare array of bindings. Seeds from the CURSOR_COMMANDS const (the maximally-capable Society
 *  default, L083) so nav is NEVER empty even before any DATA row loads; a DATA row with the same `key`
 *  OVERRIDES the seed (a package can rebind ArrowDown), a new key EXTENDS it — mirroring the "seed + live
 *  rows" pattern the format/connection/spacing readers already use in this package. Pure; never throws. */
export function readCursorCommands(raw: unknown): CursorCommand[] {
  // Dedup by the (key, requires-edge) COMPOSITE, not the key alone: the same gesture legitimately binds
  // to DIFFERENT behavior at different caret edges (e.g. ArrowLeft@start wraps to the prev block's end
  // while ArrowLeft elsewhere is in-block), and the blind resolver matches on key AND edge. Keying by
  // `key` alone would let one edge's row silently overwrite another's — collapsing the table the resolver
  // is built to fan over. The composite is the binding's true identity (a package overrides ArrowDown@bottom
  // by shipping that exact pair; it EXTENDS by shipping a new pair).
  const idOf = (c: CursorCommand) => `${c.key}\u0000${c.requires}`;
  const byId = new Map<string, CursorCommand>();
  for (const seed of CURSOR_COMMANDS) byId.set(idOf(seed), seed);
  const add = (value: unknown) => {
    const cmd = toCursorCommand(value);
    if (cmd) byId.set(idOf(cmd), cmd);
  };
  for (const row of flattenProjectedRows(raw)) {
    const payload = isRecord(row) && 'payload' in row ? (row as { payload: unknown }).payload : row;
    if (isRecord(payload) && payload.kind === 'cursor-command') add(payload);
    else if (isRecord(payload) && payload.kind === 'cursor-command-set' && Array.isArray(payload.rows)) {
      for (const r of payload.rows) add(r);
    } else if (Array.isArray(payload)) {
      for (const r of payload) add(r);
    }
  }
  return [...byId.values()];
}

const CARET_EDGES: ReadonlySet<string> = new Set(['top', 'bottom', 'start', 'end']);

/** Map a self-describing DATA row to a runtime cursor-command. Requires `key`, a `direction` with numeric
 *  dx/dy, and `requires`/`landEdge` that are valid caret edges. Returns null (skipped) for a malformed row
 *  — a bad DATA row never poisons the nav table (the const seed remains). */
function toCursorCommand(value: unknown): CursorCommand | null {
  if (!isRecord(value)) return null;
  const key = typeof value.key === 'string' && value.key ? value.key : null;
  const requires = typeof value.requires === 'string' && CARET_EDGES.has(value.requires)
    ? (value.requires as CaretEdge) : null;
  const landEdge = typeof value.landEdge === 'string' && CARET_EDGES.has(value.landEdge)
    ? (value.landEdge as CaretEdge) : null;
  const dir = value.direction;
  if (!key || !requires || !landEdge || !isRecord(dir)) return null;
  if (typeof dir.dx !== 'number' || typeof dir.dy !== 'number') return null;
  return { key, requires, direction: { dx: dir.dx, dy: dir.dy }, landEdge };
}
