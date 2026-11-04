// parts/funnel-offer-graph/read-data/resolve-funnel-flow.ts
//
// PURPOSE
//   Resolves a funnel graph and its offer nodes (and any price tests) into one flow: the entry offer at its decided
//   price, every node with the price to show and its outcome transitions, and the order a buyer meets them (breadth
//   first from the entry). Ported from bitfield-packages packages/funnel-offer-graph/read-data/resolve-funnel-flow.ts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No node id, offer name, price or outcome word is written here; every value comes from the records.
//   2. The entry's shown price is a settled price test's winner when one exists for it, else the node's own price.
//   3. Fail-soft: a missing graph or entry node gives null (the caller shows nothing funnel-specific), never a throw.

export type FunnelOffer = { amount_cents: number; name: string; recurring?: string };
export type FunnelTransition = { on: string; to: string };
export type FunnelNode = {
  id: string;
  entry: boolean;
  /** The stage's own name when it is not its offer's. */
  title?: string;
  offer: FunnelOffer;
  transitions: FunnelTransition[];
  route_path?: string;
};
export type ResolvedFunnelStep = FunnelNode & {
  display_amount_cents: number;
  price_source: 'experiment-winner' | 'node-offer';
  price_source_ref?: string;
};
export type ResolvedFunnelFlow = {
  graph_id: string;
  entry: ResolvedFunnelStep;
  steps: Record<string, ResolvedFunnelStep>;
  /** Breadth-first order from the entry node, following transitions. */
  order: string[];
};

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** One funnel node record as a typed node, or null when it has no id or no priced offer. */
export function readFunnelNode(raw: unknown): FunnelNode | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const offer = isRecord(raw.offer) ? raw.offer : undefined;
  const amount = offer ? num(offer.amount_cents) : undefined;
  const name = offer ? str(offer.name) : undefined;
  if (!id || amount == null || !name) return null;
  const transitions = Array.isArray(raw.transitions)
    ? raw.transitions.flatMap(t => (isRecord(t) && str(t.on) && str(t.to) ? [{ on: str(t.on)!, to: str(t.to)! }] : []))
    : [];
  const recurring = offer ? str(offer.recurring) : undefined;
  return {
    id,
    entry: raw.entry === true,
    ...(str(raw.title) ? { title: str(raw.title) } : {}),
    offer: { amount_cents: amount, name, ...(recurring ? { recurring } : {}) },
    transitions,
    ...(str(raw.route_path) ? { route_path: str(raw.route_path) } : {}),
  };
}

/**
 * The winning price of a settled price test for one node: an experiment naming the node (node_ref, node, or an
 * offer-experiment linking the node to the experiment's idea), whose result names a winner. The winner resolves to the
 * experiment's own arm of that id (a price experiment's arms carry their amounts), else a
 * variant's amount, else a bare number of dollars.
 */
export function resolveExperimentWinnerAmount(nodeId: string, experiments: unknown[], variants: unknown[], offerExperiments: unknown[] = []): { amount_cents: number; ref: string } | null {
  const settled = new Set(['graduated', 'settled', 'concluded']);
  const linked = new Set<string>();
  for (const oe of offerExperiments) {
    if (!isRecord(oe) || !(str(oe.node_ref) ?? '').includes(nodeId)) continue;
    const outcome = isRecord(oe.outcome_links) ? str(oe.outcome_links.outcome) : undefined;
    if (outcome) linked.add(outcome.replace(/^idea-ref:/, ''));
  }
  const amountOf = (key: string): number | undefined => {
    const variant = variants.find(v => isRecord(v) && (str(v.variant_key) === key || (str(v.id) ?? '').includes(key)) && v.status !== 'inactive');
    if (isRecord(variant) && num(variant.amount_cents) != null) return num(variant.amount_cents);
    return /^\d+$/.test(key) ? Number(key) * 100 : undefined;
  };
  for (const raw of experiments) {
    if (!isRecord(raw)) continue;
    const state = str(raw.state);
    if (state && !settled.has(state)) continue;
    const winner = isRecord(raw.result) ? str(raw.result.winner) : undefined;
    if (!winner) continue;
    const idea = str(raw.idea_ref);
    const direct = (str(raw.node_ref) ?? '').includes(nodeId) || (str(raw.id) ?? '').includes(nodeId) || str(raw.node) === nodeId;
    if (!(idea && linked.has(idea)) && !direct) continue;
    // A price experiment (src/price-experiments.mjs) carries its arms with their prices; any other test names variants.
    const ownArm = Array.isArray(raw.arms) ? raw.arms.find(arm => isRecord(arm) && str(arm.id) === winner) : undefined;
    const amount = (isRecord(ownArm) ? num(ownArm.amount_cents) : undefined) ?? amountOf(winner);
    if (amount != null) return { amount_cents: amount, ref: str(raw.id) ?? 'experiment' };
  }
  return null;
}

/** The flow of one graph (`graphId`, else the first) over its nodes and price tests. */
export function resolveFunnelFlow(graphs: unknown[], nodes: unknown[], experiments: unknown[] = [], variants: unknown[] = [], offerExperiments: unknown[] = [], graphId?: string): ResolvedFunnelFlow | null {
  const graph = (graphId ? graphs.find(g => isRecord(g) && str(g.id) === graphId) : graphs.find(isRecord)) as Record<string, unknown> | undefined;
  if (!graph) return null;
  const parsed = nodes.map(readFunnelNode).filter((n): n is FunnelNode => n !== null);
  const byId = new Map(parsed.map(n => [n.id, n]));
  const entryId = str(graph.entry_node);
  const entry = (entryId ? byId.get(entryId) : undefined) ?? parsed.find(n => n.entry);
  if (!entry) return null;
  const win = resolveExperimentWinnerAmount(entry.id, experiments, variants, offerExperiments);
  const steps: Record<string, ResolvedFunnelStep> = {};
  for (const n of parsed) {
    steps[n.id] = n.id === entry.id && win
      ? { ...n, display_amount_cents: win.amount_cents, price_source: 'experiment-winner', price_source_ref: win.ref }
      : { ...n, display_amount_cents: n.offer.amount_cents, price_source: 'node-offer' };
  }
  const order: string[] = [];
  const seen = new Set<string>();
  for (const queue = [entry.id]; queue.length;) {
    const id = queue.shift()!;
    if (seen.has(id) || !steps[id]) continue;
    seen.add(id);
    order.push(id);
    for (const t of steps[id].transitions) if (!seen.has(t.to)) queue.push(t.to);
  }
  return { graph_id: str(graph.id) ?? 'funnel', entry: steps[entry.id], steps, order };
}
