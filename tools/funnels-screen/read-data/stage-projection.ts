// parts/funnel-offer-graph/read-data/stage-projection.ts
//
// PURPOSE
//   A funnel as stages with live measures, laid out as a tornado: each stage a bar whose width follows how many
//   entered it, stacked top to bottom and centred, so the shape narrows as people drop off. reduceStageMeasures and
//   layoutTornado are ported from bitfield-packages packages/funnel-offer-graph/read-data/stage-projection.ts;
//   funnelStages reads one funnel row (a graph with its nodes, price tests and measures) into the stages drawn.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No stage, outcome or field name is written here: which field of a fact names its stage and which holds its
//      amount are DATA on the funnel row (`measures.stage_field`, `measures.amount_field`).
//   2. A fact counts as a visit at its stage, and as a conversion when it says `converted: true` or carries an amount.
//      A fact that already counts many (a whole number `count`, as counted visitors do) counts that many.
//   3. An unmeasured funnel still reads as its steps: all-zero measures lay out as a uniform column.
//   4. Layout is pure and cycle-safe.

import { resolveFunnelFlow, type ResolvedFunnelStep } from './resolve-funnel-flow.ts';

export type StageFrame = { id: string; x: number; y: number; width: number; height: number };
export type StageMeasures = { visits: number; conversions: number; conversion_rate: number; revenue_cents: number };
export type FunnelStage = {
  id: string;
  title: string;
  offer: string;
  amount_cents: number;
  recurring?: string;
  /** Whether a settled price test decided the price shown. */
  tested_price: boolean;
  measures: StageMeasures;
  /** Of the people who entered the stage before it, the share that entered this one (0..100), when there is one. */
  from_previous: number | null;
  next: Array<{ on: string; to: string }>;
  facts: Record<string, unknown>[];
};
export type Funnel = { id: string; title: string; currency: string; stages: FunnelStage[]; measured: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const oneDecimal = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** Which stage a fact belongs to: its stage field equals, or names, one of the stage ids. */
const stageOfFact = (fact: Record<string, unknown>, stageIds: string[], stageField: string) => {
  const ref = fact[stageField];
  return typeof ref === 'string' ? stageIds.find(id => ref === id) ?? stageIds.find(id => ref.includes(id)) : undefined;
};

export function reduceStageMeasures(facts: unknown[], stageIds: string[], stageField: string, amountField: string): Record<string, StageMeasures> {
  const out: Record<string, StageMeasures> = Object.fromEntries(stageIds.map(id => [id, { visits: 0, conversions: 0, conversion_rate: 0, revenue_cents: 0 }]));
  for (const fact of facts) {
    if (!isRecord(fact)) continue;
    const stage = stageOfFact(fact, stageIds, stageField);
    if (!stage) continue;
    const m = out[stage];
    const many = Number.isInteger(fact.count) && (fact.count as number) >= 0 ? (fact.count as number) : 1;
    m.visits += many;
    const amount = fact[amountField];
    if (fact.converted === true || (typeof amount === 'number' && Number.isFinite(amount))) {
      m.conversions += many;
      if (typeof amount === 'number' && Number.isFinite(amount)) m.revenue_cents += amount;
    }
  }
  for (const id of stageIds) out[id].conversion_rate = oneDecimal(out[id].conversions, out[id].visits);
  return out;
}

/**
 * One funnel row as its stages. The row is `{ id, title, entry_node, nodes, experiments?, variants?,
 * offer_experiments?, measures?: { stage_field, amount_field, event_stage_map } }`; `facts` are the measure facts the caller read
 * (inline on the row or from a file the row names).
 */
export function funnelStages(row: unknown, facts: unknown[] = []): Funnel | null {
  if (!isRecord(row)) return null;
  const flow = resolveFunnelFlow([row], list(row.nodes), list(row.experiments), list(row.variants), list(row.offer_experiments));
  if (!flow) return null;
  const measures = isRecord(row.measures) ? row.measures : {};
  const stageField = typeof measures.stage_field === 'string' ? measures.stage_field : 'stage';
  const amountField = typeof measures.amount_field === 'string' ? measures.amount_field : 'amount_cents';
  const eventStageMap = isRecord(measures.event_stage_map) ? measures.event_stage_map : {};
  const projectedFacts = facts.map(fact => {
    if (!isRecord(fact) || stageOfFact(fact, flow.order, stageField)) return fact;
    const stage = typeof fact.event === 'string' ? eventStageMap[fact.event] : undefined;
    return typeof stage === 'string' && flow.order.includes(stage) ? { ...fact, [stageField]: stage } : fact;
  });
  const reduced = reduceStageMeasures(projectedFacts, flow.order, stageField, amountField);
  const factsAt = (id: string) => projectedFacts.filter((fact): fact is Record<string, unknown> => isRecord(fact) && stageOfFact(fact, flow.order, stageField) === id);
  const stages = flow.order.map((id, index): FunnelStage => {
    const step: ResolvedFunnelStep = flow.steps[id];
    const before = index > 0 ? reduced[flow.order[index - 1]].visits : 0;
    return {
      id,
      title: step.title ?? step.offer.name,
      offer: step.offer.name,
      amount_cents: step.display_amount_cents,
      ...(step.offer.recurring ? { recurring: step.offer.recurring } : {}),
      tested_price: step.price_source === 'experiment-winner',
      measures: reduced[id],
      from_previous: index > 0 && before > 0 ? oneDecimal(reduced[id].visits, before) : null,
      next: step.transitions,
      facts: factsAt(id),
    };
  });
  return { id: flow.graph_id, currency: typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : 'USD', title: typeof row.title === 'string' && row.title.trim() ? row.title : flow.entry.offer.name, stages, measured: stages.some(stage => stage.measures.visits > 0) };
}

export const TORNADO_ROW_HEIGHT = 104;
export const TORNADO_ROW_GAP = 48;
export const TORNADO_MAX_WIDTH = 720;
export const TORNADO_MIN_WIDTH = 260;
const TORNADO_CENTER_X = TORNADO_MAX_WIDTH / 2;

/** Stages as a centred, narrowing column of frames, and the edges between them (their transitions, else in order). */
export function layoutTornado(stages: FunnelStage[]): { frames: StageFrame[]; edges: Array<{ from: string; to: string; on: string }> } {
  const most = Math.max(0, ...stages.map(stage => stage.measures.visits));
  const widthFor = (entered: number) => (most <= 0 ? TORNADO_MAX_WIDTH : Math.round(TORNADO_MIN_WIDTH + Math.min(1, entered / most) * (TORNADO_MAX_WIDTH - TORNADO_MIN_WIDTH)));
  const frames = stages.map((stage, index) => {
    const width = widthFor(stage.measures.visits);
    return { id: stage.id, x: Math.round(TORNADO_CENTER_X - width / 2), y: index * (TORNADO_ROW_HEIGHT + TORNADO_ROW_GAP), width, height: TORNADO_ROW_HEIGHT };
  });
  const known = new Set(stages.map(stage => stage.id));
  const edges = stages.flatMap((stage, index) => (stage.next.length
    ? stage.next.filter(t => known.has(t.to)).map(t => ({ from: stage.id, to: t.to, on: t.on }))
    : stages[index + 1] ? [{ from: stage.id, to: stages[index + 1].id, on: '' }] : []));
  return { frames, edges };
}
