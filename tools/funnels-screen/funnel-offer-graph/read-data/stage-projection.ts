// packages/funnel-offer-graph/read-data/stage-projection.ts
//
// PURPOSE: Pure stage-projection helpers — map a resolved funnel flow into the
// generic graph-canvas frame types (nodes positioned left-to-right by BFS
// depth) and reduce append-only measure facts into per-stage counts. Zero
// domain literals: stage ids, outcome tokens, group-by field names, and amount
// field names all arrive as DATA (the surface_input / descriptor records).
//
// NON-NEGOTIABLE INVARIANTS:
// 1. No outcome/stage token is enumerated here (open set — enum dissolution).
// 2. Layout is a pure function of the flow's BFS order + transitions; cyclic
//    graphs terminate (depth map is computed once per node).
// 3. Measure reduction is generic: ANY record array + ANY group-by field +
//    ANY numeric amount field. Empty inputs yield zero-valued measures.

import type { ResolvedFunnelFlow } from './resolve-funnel-flow';

export type StageFrame = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StageEdge = {
  edge_id: string;
  from: string;
  to: string;
  on: string;
  points: Array<{ x: number; y: number }>;
};

export type StageMeasures = {
  visits: number;
  conversions: number;
  /** 0..100, one decimal; 0 when visits is 0. */
  conversion_rate: number;
  revenue_cents: number;
};

export const STAGE_NODE_WIDTH = 300;
export const STAGE_NODE_HEIGHT = 130;
const COLUMN_GAP = 120;
const ROW_GAP = 60;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Left-to-right stage layout: column = BFS depth from the entry node, row =
 * arrival order within that column. Nodes unreachable from the entry (still in
 * `steps`) are appended in a final column so nothing silently disappears.
 */
export function layoutStages(flow: ResolvedFunnelFlow): { frames: StageFrame[]; edges: StageEdge[] } {
  const depth = new Map<string, number>();
  depth.set(flow.entry.id, 0);
  for (const id of flow.order) {
    const d = depth.get(id) ?? 0;
    for (const t of flow.steps[id]?.transitions ?? []) {
      if (flow.steps[t.to] && !depth.has(t.to)) depth.set(t.to, d + 1);
    }
  }
  const unreachable = Object.keys(flow.steps).filter((id) => !depth.has(id));
  const maxDepth = Math.max(0, ...Array.from(depth.values()));
  for (const id of unreachable) depth.set(id, maxDepth + 1);

  const rowsAtDepth = new Map<number, number>();
  const frames: StageFrame[] = [];
  const at = new Map<string, StageFrame>();
  for (const id of [...flow.order, ...unreachable]) {
    const d = depth.get(id) as number;
    const row = rowsAtDepth.get(d) ?? 0;
    rowsAtDepth.set(d, row + 1);
    const frame: StageFrame = {
      id,
      x: d * (STAGE_NODE_WIDTH + COLUMN_GAP),
      y: row * (STAGE_NODE_HEIGHT + ROW_GAP),
      width: STAGE_NODE_WIDTH,
      height: STAGE_NODE_HEIGHT,
    };
    frames.push(frame);
    at.set(id, frame);
  }

  const edges: StageEdge[] = [];
  for (const id of [...flow.order, ...unreachable]) {
    for (const t of flow.steps[id]?.transitions ?? []) {
      const from = at.get(id);
      const to = at.get(t.to);
      if (!from || !to) continue; // terminal target — no drawn edge
      edges.push({
        edge_id: `${id}->${t.to}:${t.on}`,
        from: id,
        to: t.to,
        on: t.on,
        points: [
          { x: from.x + from.width, y: from.y + from.height / 2 },
          { x: to.x, y: to.y + to.height / 2 },
        ],
      });
    }
  }
  return { frames, edges };
}

/**
 * Reduce append-only measure facts into per-stage counts. `groupBy` names the
 * field on each fact that references a stage id; `amountField` names the
 * numeric revenue field (optional per fact). A fact counts as a visit always
 * and as a conversion when it carries a truthy `converted` field OR any value
 * at `amountField` — both purely structural, no token names.
 */
export function reduceStageMeasures(
  facts: unknown[],
  stageIds: string[],
  groupBy: string,
  amountField: string,
): Record<string, StageMeasures> {
  const out: Record<string, StageMeasures> = {};
  for (const id of stageIds) out[id] = { visits: 0, conversions: 0, conversion_rate: 0, revenue_cents: 0 };
  for (const raw of Array.isArray(facts) ? facts : []) {
    if (!isRecord(raw)) continue;
    const ref = raw[groupBy];
    if (typeof ref !== 'string') continue;
    const stage = stageIds.find((id) => ref === id || ref.includes(id));
    if (!stage) continue;
    const m = out[stage];
    m.visits += 1;
    const amount = raw[amountField];
    const converted = raw.converted === true || (typeof amount === 'number' && Number.isFinite(amount));
    if (converted) {
      m.conversions += 1;
      if (typeof amount === 'number' && Number.isFinite(amount)) m.revenue_cents += amount;
    }
  }
  for (const id of stageIds) {
    const m = out[id];
    m.conversion_rate = m.visits > 0 ? Math.round((m.conversions / m.visits) * 1000) / 10 : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// TORNADO LAYOUT (the funnel silhouette — a DATA-selected projection)
// ---------------------------------------------------------------------------
//
// A funnel/tornado chart is a LAYOUT PROJECTION, not a second canvas: each
// stage is a horizontal bar whose WIDTH is proportional to the number that
// ENTERED it, stacked top-to-bottom and centered on a common axis, so the shape
// literally narrows as observers drop off (Amplitude/Mixpanel/ClickFunnels
// anatomy). The frames this emits are the exact `StageFrame` shape the shared
// graph-canvas renders — the funnel adds a layout MODE, never a new renderer.
// The bar's fill split (converted vs dropped) is a RENDER concern the node card
// draws from the same measures; this function owns only geometry.
//
// Generic: the input is any ordered list of stages carrying an `entered` and
// `converted` count plus open outcome edges. Stage ids, outcome tokens, and the
// domain are all DATA — zero enumeration (works for a sales ladder, a hiring
// pipeline, an agent-task lifecycle, identically).

/** The minimal per-stage shape the tornado layout needs (a projection of a
 *  ResolvedStage, but structurally decoupled so any measured stage list fits). */
export interface TornadoStageInput {
  stage_address: string;
  entered: number;
  converted: number;
  /** Open outcome edges → next stage. When empty, stages chain sequentially. */
  outcome_edges?: Array<{ outcome_token: string; to_stage: string }>;
}

export const TORNADO_ROW_HEIGHT = 96;
export const TORNADO_ROW_GAP = 40;
export const TORNADO_MAX_WIDTH = 720;
export const TORNADO_MIN_WIDTH = 160;
const TORNADO_CENTER_X = TORNADO_MAX_WIDTH / 2;

/**
 * Project an ordered stage list into a centered, narrowing tornado of frames +
 * edges. Bar width scales linearly between TORNADO_MIN_WIDTH and
 * TORNADO_MAX_WIDTH by `entered / maxEntered` (all-zero measures fall back to a
 * uniform full-width column so an un-instrumented funnel still reads as steps).
 * Edges follow `outcome_edges` when present, else the sequential order.
 */
export function layoutTornado(
  stages: TornadoStageInput[],
): { frames: StageFrame[]; edges: StageEdge[]; maxEntered: number } {
  const maxEntered = Math.max(0, ...stages.map((s) => (Number.isFinite(s.entered) ? s.entered : 0)));
  const widthFor = (entered: number): number => {
    if (maxEntered <= 0) return TORNADO_MAX_WIDTH; // un-instrumented: uniform steps
    const ratio = Math.max(0, Math.min(1, entered / maxEntered));
    return Math.round(TORNADO_MIN_WIDTH + ratio * (TORNADO_MAX_WIDTH - TORNADO_MIN_WIDTH));
  };

  const frames: StageFrame[] = [];
  const at = new Map<string, StageFrame>();
  stages.forEach((stage, index) => {
    const width = widthFor(Number.isFinite(stage.entered) ? stage.entered : 0);
    const frame: StageFrame = {
      id: stage.stage_address,
      x: Math.round(TORNADO_CENTER_X - width / 2),
      y: index * (TORNADO_ROW_HEIGHT + TORNADO_ROW_GAP),
      width,
      height: TORNADO_ROW_HEIGHT,
    };
    frames.push(frame);
    at.set(stage.stage_address, frame);
  });

  const edges: StageEdge[] = [];
  const pushEdge = (fromId: string, toId: string, token: string) => {
    const from = at.get(fromId);
    const to = at.get(toId);
    if (!from || !to) return; // terminal / unknown target → no drawn edge
    edges.push({
      edge_id: `${fromId}->${toId}:${token}`,
      from: fromId,
      to: toId,
      on: token,
      points: [
        { x: from.x + from.width / 2, y: from.y + from.height },
        { x: to.x + to.width / 2, y: to.y },
      ],
    });
  };
  stages.forEach((stage, index) => {
    const explicit = stage.outcome_edges ?? [];
    if (explicit.length > 0) {
      for (const edge of explicit) pushEdge(stage.stage_address, edge.to_stage, edge.outcome_token);
    } else {
      const next = stages[index + 1];
      if (next) pushEdge(stage.stage_address, next.stage_address, 'next');
    }
  });

  return { frames, edges, maxEntered };
}
