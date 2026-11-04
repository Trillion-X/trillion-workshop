// parts/workflow-canvas/read-data/layered-layout.ts
//
// PURPOSE
//   A deterministic layered layout for any directed graph, ported from the workflow canvas's computeFrames
//   (bitfield-packages packages/workflow-canvas/read-data/read-workflow-canvas-layout.ts): connected pieces stand side
//   by side, and inside each the flow runs DOWN, a node one layer below the deepest node that leads to it, siblings
//   spread across and centred on the widest layer. Nodes with no edge at all sit in a compact grid below the flows.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure and deterministic: the same ids, edges and order give the same frames.
//   2. A cycle never loops forever: a node's layer is capped at the size of its piece.
//   3. Nothing here knows what a node is; `order` (the caller's own reading order) breaks every tie.

import type { CanvasNodeFrame } from '../../graph-canvas/show/types';

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 76;
const LAYER_GAP_Y = 150;
const SIBLING_GAP_X = 290;
const ORIGIN_X = 80;
const ORIGIN_Y = 80;
const PIECE_GAP_X = 140;

export type LayoutEdge = { from: string; to: string };

export function layeredFrames(ids: string[], edges: LayoutEdge[], size = { width: NODE_WIDTH, height: NODE_HEIGHT }): CanvasNodeFrame[] {
  const known = new Set(ids);
  const rank = new Map(ids.map((id, index) => [id, index]));
  const byOrder = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  const outgoing = new Map(ids.map(id => [id, [] as string[]]));
  const incoming = new Map(ids.map(id => [id, [] as string[]]));
  const neighbours = new Map(ids.map(id => [id, [] as string[]]));
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue;
    outgoing.get(edge.from)!.push(edge.to);
    incoming.get(edge.to)!.push(edge.from);
    neighbours.get(edge.from)!.push(edge.to);
    neighbours.get(edge.to)!.push(edge.from);
  }

  const seen = new Set<string>();
  const pieces: string[][] = [];
  const singles: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!neighbours.get(id)!.length) { singles.push(id); continue; }
    const piece = [id];
    for (let at = 0; at < piece.length; at += 1) for (const next of neighbours.get(piece[at])!) if (!seen.has(next)) { seen.add(next); piece.push(next); }
    pieces.push(piece);
  }

  const out = new Map<string, CanvasNodeFrame>();
  let cursorX = ORIGIN_X;
  let bottom = ORIGIN_Y;
  for (const piece of pieces) {
    const members = new Set(piece);
    const layer = new Map<string, number>();
    const roots = piece.filter(id => incoming.get(id)!.every(parent => !members.has(parent)));
    const starts = roots.length ? roots : [[...piece].sort(byOrder)[0]];
    for (const root of starts) layer.set(root, 0);
    const cap = piece.length + 1;
    for (let frontier = [...starts], depth = 0; frontier.length && depth < cap; depth += 1) {
      const next: string[] = [];
      for (const id of frontier) for (const target of outgoing.get(id)!) {
        const proposed = (layer.get(id) ?? 0) + 1;
        if (members.has(target) && proposed > (layer.get(target) ?? -1) && proposed < cap) { layer.set(target, proposed); next.push(target); }
      }
      frontier = next;
    }
    const byLayer = new Map<number, string[]>();
    for (const id of piece) {
      const at = layer.get(id) ?? 0;
      byLayer.set(at, [...(byLayer.get(at) ?? []), id]);
    }
    const width = Math.max(...[...byLayer.values()].map(row => row.length * SIBLING_GAP_X), SIBLING_GAP_X);
    for (const [at, row] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
      row.sort(byOrder);
      const startX = cursorX + (width - row.length * SIBLING_GAP_X) / 2;
      row.forEach((id, index) => out.set(id, { id, x: Math.round(startX + index * SIBLING_GAP_X), y: ORIGIN_Y + at * LAYER_GAP_Y, width: size.width, height: size.height }));
      bottom = Math.max(bottom, ORIGIN_Y + at * LAYER_GAP_Y + size.height);
    }
    cursorX += width + PIECE_GAP_X;
  }
  const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(singles.length))));
  const top = pieces.length ? bottom + LAYER_GAP_Y : ORIGIN_Y;
  singles.forEach((id, index) => out.set(id, { id, x: ORIGIN_X + (index % columns) * SIBLING_GAP_X, y: top + Math.floor(index / columns) * LAYER_GAP_Y, width: size.width, height: size.height }));
  return ids.map(id => out.get(id)!);
}
