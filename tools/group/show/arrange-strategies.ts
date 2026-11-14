// Board arrangement strategies as DATA: a registry of pure (items -> placements)
// functions dispatched through an injected capability map. Adding a new layout is
// one map entry -- arrangeWith never enumerates strategy ids (L090).

import { circleLayoutRadius } from 'trillion-workshop/tools/organize-the-sidebar/do-work/circle-layout.ts';
import { ownValue } from 'trillion-workshop/tools/organize-the-sidebar/read-data/facet-filter.ts';
import { finiteCoord } from '../read-data/finite-coord';

export interface StrategyItem {
  readonly memberId: string;
  readonly w: number;
  readonly h: number;
}

export interface Placed {
  readonly memberId: string;
  readonly x: number;
  readonly y: number;
}

export interface StrategyOptions {
  readonly gap?: number;
  readonly originX?: number;
  readonly originY?: number;
  readonly cols?: number;
  readonly radius?: number;
}

export type ArrangeStrategy = (
  items: readonly StrategyItem[],
  opts?: StrategyOptions,
) => Placed[];

const DEFAULT_GAP = 24;

function resolve(opts?: StrategyOptions): {
  gap: number;
  originX: number;
  originY: number;
} {
  return {
    gap: opts?.gap ?? DEFAULT_GAP,
    originX: opts?.originX ?? 0,
    originY: opts?.originY ?? 0,
  };
}

function maxW(items: readonly StrategyItem[]): number {
  return items.reduce((m, it) => Math.max(m, it.w), 0);
}

function maxH(items: readonly StrategyItem[]): number {
  return items.reduce((m, it) => Math.max(m, it.h), 0);
}

const grid: ArrangeStrategy = (items, opts) => {
  if (items.length === 0) return [];
  const { gap, originX, originY } = resolve(opts);
  const n = items.length;
  const cols = opts?.cols ?? Math.ceil(Math.sqrt(n));
  const cellW = maxW(items) + gap;
  const cellH = maxH(items) + gap;
  return items.map((it, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      memberId: it.memberId,
      x: originX + col * cellW,
      y: originY + row * cellH,
    };
  });
};

const row: ArrangeStrategy = (items, opts) => {
  if (items.length === 0) return [];
  const { gap, originX, originY } = resolve(opts);
  let cursorX = originX;
  return items.map((it) => {
    const placed: Placed = { memberId: it.memberId, x: cursorX, y: originY };
    cursorX += it.w + gap;
    return placed;
  });
};

const column: ArrangeStrategy = (items, opts) => {
  if (items.length === 0) return [];
  const { gap, originX, originY } = resolve(opts);
  let cursorY = originY;
  return items.map((it) => {
    const placed: Placed = { memberId: it.memberId, x: originX, y: cursorY };
    cursorY += it.h + gap;
    return placed;
  });
};

const circle: ArrangeStrategy = (items, opts) => {
  if (items.length === 0) return [];
  const { gap, originX, originY } = resolve(opts);
  const n = items.length;
  // Pitch = largest box dimension + gap (the same pitch the bulk-bar radial layout uses), so the
  // radius comes from the ONE shared SSOT — the menu circle and the bulk-bar circle now AGREE
  // (Codex arrange-audit F6). An explicit `opts.radius` still wins.
  const pitch = Math.max(maxW(items), maxH(items)) + gap;
  const radius = opts?.radius ?? circleLayoutRadius(n, pitch);
  const start = -Math.PI / 2;
  return items.map((it, i) => {
    const angle = start + (2 * Math.PI * i) / n;
    const cx = originX + radius * Math.cos(angle);
    const cy = originY + radius * Math.sin(angle);
    return {
      memberId: it.memberId,
      x: cx - it.w / 2,
      y: cy - it.h / 2,
    };
  });
};

const diagonal: ArrangeStrategy = (items, opts) => {
  if (items.length === 0) return [];
  const { gap, originX, originY } = resolve(opts);
  const step = gap + 20;
  return items.map((it, i) => ({
    memberId: it.memberId,
    x: originX + i * step,
    y: originY + i * step,
  }));
};

const masonry: ArrangeStrategy = (items, opts) => {
  if (items.length === 0) return [];
  const { gap, originX, originY } = resolve(opts);
  const n = items.length;
  const cols = opts?.cols ?? Math.ceil(Math.sqrt(n));
  const colW = maxW(items) + gap;
  const heights = new Array<number>(cols).fill(0);
  return items.map((it) => {
    // Currently-shortest column; ties resolve to the leftmost (strict <).
    let target = 0;
    for (let c = 1; c < cols; c += 1) {
      if (heights[c] < heights[target]) target = c;
    }
    const placed: Placed = {
      memberId: it.memberId,
      x: originX + target * colW,
      y: originY + heights[target],
    };
    heights[target] += it.h + gap;
    return placed;
  });
};

const spiral: ArrangeStrategy = (items, opts) => {
  if (items.length === 0) return [];
  const { gap, originX, originY } = resolve(opts);
  // Golden-angle PHYLLOTAXIS (the sunflower-seed packing): item i sits at angle i·θ and radius c·√i, which
  // spreads ANY count evenly with roughly constant neighbour spacing — an organic even-scatter that a plain
  // circle (one ring) and grid (uniform cells) can't produce. The golden angle θ ≈ 137.5° is what makes the
  // seeds interleave without radial gaps. `c` ties the spacing to the box pitch (min neighbour distance
  // ≈ c·√π), so boxes don't overlap; item 0 (r=0) sits at the centre.
  const pitch = Math.max(maxW(items), maxH(items)) + gap;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const c = pitch * 0.6;
  return items.map((it, i) => {
    const r = c * Math.sqrt(i);
    const angle = i * golden;
    return {
      memberId: it.memberId,
      x: originX + r * Math.cos(angle) - it.w / 2,
      y: originY + r * Math.sin(angle) - it.h / 2,
    };
  });
};

const pack: ArrangeStrategy = (items, opts) => {
  if (items.length === 0) return [];
  const { gap, originX, originY } = resolve(opts);
  // SHELF bin-packing (the width dual of `masonry`'s columns): items flow left-to-right onto a shelf until
  // the row would exceed a square-ish target width, then wrap to a new shelf whose top sits below the
  // TALLEST item of the previous row. Unlike `grid` (uniform maxW×maxH cells that waste space for varied
  // sizes) it packs a wide item beside several narrow ones and lets each row be exactly as tall as it needs.
  // Order-preserving + deterministic. Target width ≈ √(total padded area) so the result reads roughly square.
  let totalArea = 0;
  let widest = 0;
  for (const it of items) {
    totalArea += (it.w + gap) * (it.h + gap);
    widest = Math.max(widest, it.w);
  }
  const targetW = Math.max(widest, Math.sqrt(totalArea)); // never narrower than the widest single item
  const placed: Placed[] = [];
  let x = 0;
  let y = 0;
  let shelfH = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > targetW) { y += shelfH + gap; x = 0; shelfH = 0; } // wrap to the next shelf
    placed.push({ memberId: it.memberId, x: originX + x, y: originY + y });
    x += it.w + gap;
    shelfH = Math.max(shelfH, it.h);
  }
  return placed;
};

const concentric: ArrangeStrategy = (items, opts) => {
  if (items.length === 0) return [];
  const { gap, originX, originY } = resolve(opts);
  // CONCENTRIC RINGS (a "solar system" burst): item 0 sits at the centre, the rest fill DISCRETE rings
  // outward. Ring k has radius `k·pitch` and capacity ⌊2π·k⌋ (6, 12, 18, …) — the number of `pitch`-wide
  // slots that fit on that ring's circumference (2π·k·pitch ÷ pitch), so items never overlap. Distinct from
  // `circle` (ALL items on ONE ring) and `spiral` (a CONTINUOUS phyllotaxis curve): here the structure is
  // quantised rings around a hub, ideal for a central idea with satellites. Order-preserving + deterministic.
  const pitch = Math.max(maxW(items), maxH(items)) + gap;
  const placed: Placed[] = [];
  const first = items[0];
  placed.push({ memberId: first.memberId, x: originX - first.w / 2, y: originY - first.h / 2 });
  const start = -Math.PI / 2; // first slot of each ring points straight up
  let idx = 1;
  let ring = 1;
  while (idx < items.length) {
    const radius = ring * pitch;
    const capacity = Math.max(1, Math.floor(2 * Math.PI * ring)); // slots that fit on this ring
    const countThisRing = Math.min(capacity, items.length - idx);
    for (let j = 0; j < countThisRing; j += 1) {
      const it = items[idx];
      idx += 1;
      const angle = start + (2 * Math.PI * j) / countThisRing;
      placed.push({
        memberId: it.memberId,
        x: originX + radius * Math.cos(angle) - it.w / 2,
        y: originY + radius * Math.sin(angle) - it.h / 2,
      });
    }
    ring += 1;
  }
  return placed;
};

export const ARRANGE_STRATEGIES: Readonly<Record<string, ArrangeStrategy>> =
  Object.freeze({
    grid,
    row,
    column,
    circle,
    diagonal,
    masonry,
    spiral,
    pack,
    concentric,
  });

export function arrangeWith(
  strategyId: string,
  items: readonly StrategyItem[],
  opts?: StrategyOptions,
  strategies: Readonly<Record<string, ArrangeStrategy>> = ARRANGE_STRATEGIES,
): Placed[] {
  if (items.length === 0) return [];
  // `strategyId` is UNTRUSTED DATA (a saved arrangement / lens id). A raw `strategies[strategyId]`
  // resolves a prototype key: `'__proto__'` -> Object.prototype (truthy, NOT callable) -> a TypeError
  // crash on `strategy(...)`; `'constructor'`/`'toString'` -> an inherited function returning garbage.
  // `ownValue` (own-key SSOT) + a function check fail closed to the empty layout.
  const strategy = ownValue<ArrangeStrategy>(strategies, strategyId);
  if (typeof strategy !== 'function') return [];
  // Item geometry (`w`/`h`) and `opts` numbers are UNTRUSTED — a NaN/MAX_VALUE poisons a strategy's
  // positions (cursor/cell math). Clamp EVERY emitted x/y through the finiteCoord SSOT at the ONE
  // dispatch boundary (L063), so any strategy (built-in or injected) yields renderable coordinates.
  return strategy(items, opts).map((p) => ({ memberId: p.memberId, x: finiteCoord(p.x), y: finiteCoord(p.y) }));
}
