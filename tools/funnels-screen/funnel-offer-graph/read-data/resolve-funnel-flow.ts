// packages/funnel-offer-graph/read-data/resolve-funnel-flow.ts
//
// PURPOSE: The consumer for the rich funnel value-ladder. Reads the live
// `funnel-graph` + `funnel-node` + `experiment` (+ `experiment-variant`)
// records and resolves them into a rendered flow: the entry offer (at its
// A/B-decided price), and the full purchase/decline transition map. This is
// the SSOT reader that makes the funnel-offer-graph records NON-inert — the
// renderer calls it to drive the live sales funnel.
//
// Plan: notes/.../funnel-offer-graph/plans/2026-07-05-funnel-graph-live-consumer/
//
// NON-NEGOTIABLE INVARIANTS:
// 1. Zero hardcoded node ids, offer names, prices, or route literals. Every
//    value comes from the DATA records (L090 self-describing data, generic
//    handler). Drop in a different funnel graph → this resolves it unchanged.
// 2. The displayed front price is the GRADUATED A/B experiment winner when one
//    exists for the entry node; otherwise the node's own offer price.
// 3. Fail-soft: a missing graph / missing entry node yields null (the caller
//    renders nothing funnel-specific), never a throw that breaks the page.

export type FunnelOffer = {
  amount_cents: number;
  name: string;
  recurring?: string;
};

export type FunnelTransition = { on: string; to: string };

export type FunnelNode = {
  id: string;
  entry: boolean;
  offer: FunnelOffer;
  proof_gate?: string;
  transitions: FunnelTransition[];
  /** The route this node owns (supersedes commercial-offer.oto_route_path). */
  route_path?: string;
  /** The commercial-offer this node charges + grants access through. */
  offer_ref?: string;
};

export type ResolvedFunnelStep = FunnelNode & {
  /** The price to display for this node — A/B winner for the entry node, else the node's own offer price. */
  display_amount_cents: number;
  /** Provenance of the displayed price: which record decided it. */
  price_source: 'experiment-winner' | 'node-offer';
  price_source_ref?: string;
};

export type ResolvedFunnelFlow = {
  graph_id: string;
  entry: ResolvedFunnelStep;
  /** Every node keyed by id, each with its resolved display price + transitions. */
  steps: Record<string, ResolvedFunnelStep>;
  /** Breadth-first visit order from the entry node following transitions. */
  order: string[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Normalize a raw `kind:funnel-node` record into a typed FunnelNode (or null). */
export function readFunnelNode(raw: unknown): FunnelNode | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const offerRaw = isRecord(raw.offer) ? raw.offer : undefined;
  const amount = offerRaw ? num(offerRaw.amount_cents) : undefined;
  const name = offerRaw ? str(offerRaw.name) : undefined;
  if (!id || amount == null || !name) return null;
  const transitions = Array.isArray(raw.transitions)
    ? raw.transitions.flatMap((t) => {
        if (!isRecord(t)) return [];
        const on = str(t.on);
        const to = str(t.to);
        return on && to ? [{ on, to }] : [];
      })
    : [];
  const recurring = offerRaw ? str(offerRaw.recurring) : undefined;
  return {
    id,
    entry: raw.entry === true,
    offer: { amount_cents: amount, name, ...(recurring ? { recurring } : {}) },
    ...(str(raw.proof_gate) ? { proof_gate: str(raw.proof_gate) } : {}),
    transitions,
    ...(str(raw.route_path) ? { route_path: str(raw.route_path) } : {}),
    ...(str(raw.offer_ref) ? { offer_ref: str(raw.offer_ref) } : {}),
  };
}

/**
 * From the graduated experiments, find the winning front price (amount_cents)
 * that applies to a given node. The node→experiment link is DATA-chained:
 *   funnel-node.id  ⟵ offer-experiment.node_ref  →  offer-experiment.outcome_links.outcome
 *   (an "idea-ref:<addr>")  →  experiment.idea_ref  →  experiment.result.winner.
 * The winner key ("47") resolves to an amount via a variant record, else a
 * bare number is dollars→cents. Falls back to a direct node/id/node_ref match
 * on the experiment when no offer-experiment link exists. Only graduated/settled
 * experiments decide a live price. Generic: zero hardcoded ids.
 */
export function resolveExperimentWinnerAmount(
  nodeId: string,
  experiments: unknown[],
  variants: unknown[],
  offerExperiments: unknown[] = [],
): { amount_cents: number; ref: string } | null {
  const settled = new Set(['graduated', 'settled', 'concluded']);
  // 1. idea-refs linked to this node via offer-experiment records.
  const linkedIdeaRefs = new Set<string>();
  for (const oe of offerExperiments) {
    if (!isRecord(oe)) continue;
    if (!(str(oe.node_ref) ?? '').includes(nodeId)) continue;
    const links = isRecord(oe.outcome_links) ? oe.outcome_links : undefined;
    const outcome = links ? str(links.outcome) : undefined; // "idea-ref:package::experiment::idea::front-price-47"
    if (outcome) linkedIdeaRefs.add(outcome.replace(/^idea-ref:/, ''));
  }
  const winnerAmount = (winnerKey: string): number | undefined => {
    const winningVariant = variants.find(
      (v) => isRecord(v) && (str(v.variant_key) === winnerKey || (str(v.id) ?? '').includes(winnerKey)) && v.status !== 'inactive',
    );
    if (isRecord(winningVariant)) { const a = num(winningVariant.amount_cents); if (a != null) return a; }
    if (/^\d+$/.test(winnerKey)) return Number(winnerKey) * 100; // "47" → $47 → 4700
    return undefined;
  };
  for (const raw of experiments) {
    if (!isRecord(raw)) continue;
    const state = str(raw.state);
    if (state && !settled.has(state)) continue;
    const result = isRecord(raw.result) ? raw.result : undefined;
    const winnerKey = result ? str(result.winner) : undefined;
    if (!winnerKey) continue;
    const ideaRef = str(raw.idea_ref);
    const linkedByIdea = ideaRef ? linkedIdeaRefs.has(ideaRef) : false;
    const directMatch =
      (str(raw.node_ref) ?? '').includes(nodeId) ||
      (str(raw.id) ?? '').includes(nodeId) ||
      (str(raw.node) ?? '') === nodeId;
    if (!linkedByIdea && !directMatch) continue;
    const amount = winnerAmount(winnerKey);
    if (amount != null) return { amount_cents: amount, ref: str(raw.id) ?? 'experiment' };
  }
  return null;
}

/**
 * Resolve the live funnel flow from the raw records. `graphs`, `nodes`,
 * `experiments`, `variants` are the raw payload arrays read from the log by
 * kind. If a `graphId` is given, that graph is used; otherwise the first graph.
 */
export function resolveFunnelFlow(
  graphs: unknown[],
  nodes: unknown[],
  experiments: unknown[] = [],
  variants: unknown[] = [],
  offerExperiments: unknown[] = [],
  graphId?: string,
): ResolvedFunnelFlow | null {
  const graph = (graphId
    ? graphs.find((g) => isRecord(g) && (str(g.id) === graphId || (str(g.id) ?? '').includes(graphId)))
    : graphs.find(isRecord)) as Record<string, unknown> | undefined;
  if (!graph) return null;

  const entryNodeId = str(graph.entry_node);
  const parsedNodes = nodes.map(readFunnelNode).filter((n): n is FunnelNode => n !== null);
  const byId: Record<string, FunnelNode> = {};
  for (const n of parsedNodes) byId[n.id] = n;

  const entryNode = (entryNodeId ? byId[entryNodeId] : undefined) ?? parsedNodes.find((n) => n.entry);
  if (!entryNode) return null;

  const experimentWin = resolveExperimentWinnerAmount(entryNode.id, experiments, variants, offerExperiments);

  const withPrice = (n: FunnelNode): ResolvedFunnelStep => {
    if (n.id === entryNode.id && experimentWin) {
      return {
        ...n,
        display_amount_cents: experimentWin.amount_cents,
        price_source: 'experiment-winner',
        price_source_ref: experimentWin.ref,
      };
    }
    return { ...n, display_amount_cents: n.offer.amount_cents, price_source: 'node-offer' };
  };

  const steps: Record<string, ResolvedFunnelStep> = {};
  for (const n of parsedNodes) steps[n.id] = withPrice(n);

  // BFS visit order from the entry node following transitions.
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [entryNode.id];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id) || !steps[id]) continue;
    seen.add(id);
    order.push(id);
    for (const t of steps[id].transitions) if (!seen.has(t.to)) queue.push(t.to);
  }

  return { graph_id: str(graph.id) ?? 'funnel', entry: steps[entryNode.id], steps, order };
}

// ── State-machine step (post-purchase transition) ───────────────────────────
//
// The funnel is a directed state machine over offer nodes. A buyer occupies ONE
// node at a time (the cursor). An OUTCOME ("purchase" | "decline" | any DATA
// token) advances the cursor along the matching transition. This is the whole
// post-purchase flow: the NEXT offer a buyer sees is `node.transitions[outcome]`
// — decided by the funnel-node record, NOT by a route path. Terminal targets
// (a node id absent from `steps`, e.g. "thank-you"/"exit") end the flow.

export type FunnelAdvance = {
  /** The node the buyer moves to; null when the transition terminates the funnel. */
  next: ResolvedFunnelStep | null;
  /** The raw transition target id (may be a terminal token not in `steps`). */
  target: string | null;
  /** True when `target` is a terminal (no such node in the graph). */
  terminal: boolean;
};

/**
 * Advance the funnel cursor from `currentNodeId` along the transition whose
 * `on` equals `outcome`. Generic: the outcome token and the target are pure
 * DATA from the funnel-node record. Unknown node / no matching transition →
 * `{next:null, target:null, terminal:true}` (fail-soft, ends the flow).
 */
export function advanceFunnel(
  flow: ResolvedFunnelFlow,
  currentNodeId: string,
  outcome: string,
): FunnelAdvance {
  const node = flow.steps[currentNodeId];
  if (!node) return { next: null, target: null, terminal: true };
  const t = node.transitions.find((tr) => tr.on === outcome);
  if (!t) return { next: null, target: null, terminal: true };
  const next = flow.steps[t.to] ?? null;
  return { next, target: t.to, terminal: next === null };
}

/**
 * Resolve the buyer's current step from a cursor node id. Missing/unknown cursor
 * falls back to the entry node — a buyer with no session starts at the top of
 * the ladder. Pure lookup; the caller owns where the cursor is persisted.
 */
export function funnelStepAtCursor(
  flow: ResolvedFunnelFlow,
  cursorNodeId: string | undefined,
): ResolvedFunnelStep {
  if (cursorNodeId && flow.steps[cursorNodeId]) return flow.steps[cursorNodeId];
  return flow.entry;
}

// ── CTA links (on-page call-to-action buttons, DATA-driven) ─────────────────
//
// The `cta-link` records carry the page's call-to-action buttons: {page, label,
// role, href, attribution_key(utm)}. The renderer stops hardcoding CTA copy and
// reads these instead. Generic: any number of CTAs, any roles — the reader never
// enumerates label/role values.

export type ResolvedCtaLink = {
  id: string;
  label: string;
  role: string;
  href: string;
  /** utm/attribution query string (no leading `?`), or undefined. */
  attribution?: string;
};

/** Normalize a raw `kind:cta-link` record (or null). */
function readCtaLink(raw: unknown): ResolvedCtaLink | null {
  if (!isRecord(raw)) return null;
  const label = str(raw.label);
  const href = str(raw.href);
  if (!label || !href) return null;
  return {
    id: str(raw.id) ?? `${str(raw.page) ?? 'page'}:${label}`,
    label,
    role: str(raw.role) ?? 'primary',
    href,
    ...(str(raw.attribution_key) ? { attribution: str(raw.attribution_key) } : {}),
  };
}

/**
 * Resolve the CTA links for a given page id, in a stable order (records flagged
 * `role:"primary"` first, then the rest in record order). `pageId` matches the
 * cta-link record's `page` field (e.g. "public-sales-page:home"). Generic: the
 * primary/secondary distinction is DATA, never a hardcoded list.
 */
export function resolveCtaLinks(ctaRecords: unknown[], pageId: string | undefined): ResolvedCtaLink[] {
  const links = ctaRecords
    .filter((r) => isRecord(r) && (!pageId || str(r.page) === pageId))
    .map(readCtaLink)
    .filter((c): c is ResolvedCtaLink => c !== null);
  return links.sort((a, b) => (a.role === 'primary' ? 0 : 1) - (b.role === 'primary' ? 0 : 1));
}
