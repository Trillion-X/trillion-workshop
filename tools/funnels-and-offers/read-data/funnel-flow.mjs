// tools/funnels-and-offers/read-data/funnel-flow.mjs
//
// A sales funnel as a directed state machine over offer nodes, resolved from the person's own records.
// Records read (all open sets, nothing here names an id, an offer, a price or an outcome):
//   funnel-graph        { id, entry_node }
//   funnel-node         { id, entry?, offer: { amount_cents, name, recurring? }, transitions: [{ on, to }], proof_gate?, route_path?, offer_ref? }
//   experiment          { id, state, result: { winner }, idea_ref?, node_ref? | node? }
//   experiment-variant  { variant_key | id, amount_cents, status? }
//   offer-experiment    { node_ref, outcome_links: { outcome: "idea-ref:<idea_ref>" } }
//   cta-link            { page, label, href, role?, attribution_key? }
//
// A buyer occupies one node. An outcome token (purchase, decline, anything the node names) advances the buyer along the
// node's transition with that `on`. A target that is not a node of the graph ends the flow.
// The front price shown is the settled experiment's winning variant when one applies to the entry node, else the
// node's own offer price. Every answer is fail-soft: nothing found gives null, never a throw.

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = value => (typeof value === 'string' && value.trim() ? value : undefined);
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A raw funnel-node record as a FunnelNode, or null when it has no id, whole offer amount or offer name. */
export function readFunnelNode(raw) {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const offer = isRecord(raw.offer) ? raw.offer : undefined;
  const amount = offer ? num(offer.amount_cents) : undefined;
  const name = offer ? str(offer.name) : undefined;
  if (!id || amount === undefined || !name) return null;
  const transitions = Array.isArray(raw.transitions)
    ? raw.transitions.flatMap(transition => {
      if (!isRecord(transition)) return [];
      const on = str(transition.on);
      const to = str(transition.to);
      return on && to ? [{ on, to }] : [];
    })
    : [];
  const recurring = offer ? str(offer.recurring) : undefined;
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

const SETTLED = new Set(['graduated', 'settled', 'concluded']);

/**
 * The winning front price that applies to a node, from settled experiments only (a running one never decides a live
 * price). The experiment applies when an offer-experiment links it to the node through its idea ref, or when the
 * experiment itself names the node. The winner key resolves to an amount through a variant record's `amount_cents`;
 * a winner with no such variant decides nothing (the key is never guessed to be an amount).
 */
export function resolveExperimentWinnerAmount(nodeId, experiments, variants, offerExperiments = []) {
  const linkedIdeaRefs = new Set();
  for (const link of offerExperiments) {
    if (!isRecord(link) || !(str(link.node_ref) ?? '').includes(nodeId)) continue;
    const outcome = isRecord(link.outcome_links) ? str(link.outcome_links.outcome) : undefined;
    if (outcome) linkedIdeaRefs.add(outcome.replace(/^idea-ref:/, ''));
  }
  const winnerAmount = key => {
    const variant = variants.find(item => isRecord(item) && (str(item.variant_key) === key || (str(item.id) ?? '').includes(key)) && item.status !== 'inactive');
    return isRecord(variant) ? num(variant.amount_cents) : undefined;
  };
  for (const raw of experiments) {
    if (!isRecord(raw)) continue;
    const state = str(raw.state);
    if (state && !SETTLED.has(state)) continue;
    const winnerKey = isRecord(raw.result) ? str(raw.result.winner) : undefined;
    if (!winnerKey) continue;
    const ideaRef = str(raw.idea_ref);
    const linked = ideaRef ? linkedIdeaRefs.has(ideaRef) : false;
    const direct = (str(raw.node_ref) ?? '').includes(nodeId) || (str(raw.id) ?? '').includes(nodeId) || (str(raw.node) ?? '') === nodeId;
    if (!linked && !direct) continue;
    const amount = winnerAmount(winnerKey);
    if (amount !== undefined) return { amount_cents: amount, ref: str(raw.id) ?? 'experiment' };
  }
  return null;
}

/**
 * The flow of one graph: the entry step at its decided price, every step keyed by id, and the breadth-first visit order
 * from the entry (a cycle ends where it comes back). With `graphId` that graph is used, else the first.
 */
export function resolveFunnelFlow(graphs, nodes, experiments = [], variants = [], offerExperiments = [], graphId) {
  const graph = graphId
    ? graphs.find(item => isRecord(item) && (str(item.id) === graphId || (str(item.id) ?? '').includes(graphId)))
    : graphs.find(isRecord);
  if (!graph) return null;
  const parsed = nodes.map(readFunnelNode).filter(node => node !== null);
  const byId = Object.fromEntries(parsed.map(node => [node.id, node]));
  const entryId = str(graph.entry_node);
  const entryNode = (entryId ? byId[entryId] : undefined) ?? parsed.find(node => node.entry);
  if (!entryNode) return null;
  const win = resolveExperimentWinnerAmount(entryNode.id, experiments, variants, offerExperiments);
  const steps = {};
  for (const node of parsed) {
    steps[node.id] = node.id === entryNode.id && win
      ? { ...node, display_amount_cents: win.amount_cents, price_source: 'experiment-winner', price_source_ref: win.ref }
      : { ...node, display_amount_cents: node.offer.amount_cents, price_source: 'node-offer' };
  }
  const order = [];
  const seen = new Set();
  const queue = [entryNode.id];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || !steps[id]) continue;
    seen.add(id);
    order.push(id);
    for (const transition of steps[id].transitions) if (!seen.has(transition.to)) queue.push(transition.to);
  }
  return { graph_id: str(graph.id) ?? 'funnel', entry: steps[entryNode.id], steps, order };
}

/**
 * Move a buyer from `currentNodeId` along the transition whose `on` equals `outcome`. An unknown node or outcome ends
 * the flow; a target that is not a node of the graph is terminal (`target` still names it).
 */
export function advanceFunnel(flow, currentNodeId, outcome) {
  const node = flow.steps[currentNodeId];
  if (!node) return { next: null, target: null, terminal: true };
  const transition = node.transitions.find(item => item.on === outcome);
  if (!transition) return { next: null, target: null, terminal: true };
  const next = flow.steps[transition.to] ?? null;
  return { next, target: transition.to, terminal: next === null };
}

/** The buyer's current step from a cursor node id; a missing or unknown cursor is the top of the ladder. */
export function funnelStepAtCursor(flow, cursorNodeId) {
  return cursorNodeId && flow.steps[cursorNodeId] ? flow.steps[cursorNodeId] : flow.entry;
}

/** The call-to-action links of one page (or all), primary first, then in record order; a link needs a label and a href. */
export function resolveCtaLinks(records, pageId) {
  const links = records
    .filter(record => isRecord(record) && (!pageId || str(record.page) === pageId))
    .flatMap(record => {
      const label = str(record.label);
      const href = str(record.href);
      if (!label || !href) return [];
      return [{
        id: str(record.id) ?? `${str(record.page) ?? 'page'}:${label}`,
        label,
        role: str(record.role) ?? 'primary',
        href,
        ...(str(record.attribution_key) ? { attribution: str(record.attribution_key) } : {}),
      }];
    });
  return links.sort((a, b) => (a.role === 'primary' ? 0 : 1) - (b.role === 'primary' ? 0 : 1));
}
