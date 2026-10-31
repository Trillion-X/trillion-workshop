// tools/funnels-and-offers/read-data/funnel-definition.mjs
//
// A funnel as one record, and the join that reads it. A funnel-definition is an ordered list of stages; each stage is
// keyed by a `stage_address` and POINTS at records other tools already own, never copying them:
//   workflow_node_ref   a node of a workflow (its label is the stage's title, read, never stored twice)
//   outcome_edges       open outcome tokens to the next stage
//   variant_surface_ref a selection surface (the versions being tried; the live one is whatever was decided)
//   offer_price_ref     an offer with price options, and `price_option_ref` says WHICH option this stage shows
//   metric_selectors    measure refs by role (`entered`, `converted`; other roles pass through)
//   title               a title of its own, when the stage names no node
// A ref is { $ref: "<owner-kind>:<id>[#<sub-id>]" }; the id is the tail after the last ":" (and before any "#"), and a
// record matches when its id equals or contains it. Nothing here names a domain, a price or an outcome: a sales ladder
// and a hiring pipeline resolve through the same code.
//
// Fail-soft: no funnel gives null; a ref with no record is a stage that is present and unresolved, never a throw.

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = value => (typeof value === 'string' && value.trim() ? value : undefined);
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A ref from { $ref } or a bare string. */
export function readRef(raw) {
  const ref = isRecord(raw) ? str(raw.$ref) : str(raw);
  return ref ? { $ref: ref } : undefined;
}

/** The id (and `#` sub-id) a ref points at. */
export function refIdentity(ref) {
  if (!ref) return null;
  const [head, sub] = ref.$ref.split('#', 2);
  const parts = head.split(':');
  const id = parts[parts.length - 1] || head;
  return sub ? { id, sub } : { id };
}

function matchesRef(candidate, ref) {
  const identity = refIdentity(ref);
  if (!identity) return false;
  const cid = str(candidate.id) ?? str(candidate.address) ?? '';
  if (!cid) return false;
  const targets = identity.sub ? [identity.sub, identity.id] : [identity.id];
  return targets.some(target => cid === target || cid.includes(target)) || ref.$ref.includes(cid);
}

const findByRef = (records, ref) => (ref ? records.find(record => isRecord(record) && matchesRef(record, ref)) : undefined);

function readStageSpec(raw) {
  if (!isRecord(raw)) return null;
  const stageAddress = str(raw.stage_address);
  if (!stageAddress) return null;
  const outcomeEdges = Array.isArray(raw.outcome_edges)
    ? raw.outcome_edges.flatMap(edge => {
      const token = isRecord(edge) ? str(edge.outcome_token) : undefined;
      const to = isRecord(edge) ? str(edge.to_stage) : undefined;
      return token && to ? [{ outcome_token: token, to_stage: to }] : [];
    })
    : [];
  const metricSelectors = Array.isArray(raw.metric_selectors)
    ? raw.metric_selectors.flatMap(selector => {
      const measureRef = isRecord(selector) ? str(selector.measure_ref) : undefined;
      return measureRef ? [{ measure_ref: measureRef, role: str(selector.role) ?? 'entered' }] : [];
    })
    : [];
  return {
    stage_address: stageAddress,
    ...(readRef(raw.workflow_node_ref) ? { workflow_node_ref: readRef(raw.workflow_node_ref) } : {}),
    outcome_edges: outcomeEdges,
    ...(readRef(raw.variant_surface_ref) ? { variant_surface_ref: readRef(raw.variant_surface_ref) } : {}),
    ...(readRef(raw.offer_price_ref) ? { offer_price_ref: readRef(raw.offer_price_ref) } : {}),
    metric_selectors: metricSelectors,
    // Read beside offer_price_ref: a reader that names only some fields would drop this one and price the stage by position.
    ...(str(raw.price_option_ref) ? { price_option_ref: str(raw.price_option_ref) } : {}),
    ...(str(raw.title) ? { title: str(raw.title) } : {}),
  };
}

/** A raw funnel-definition record, or null when it is not one or has no id. */
export function readFunnelDefinition(raw) {
  if (!isRecord(raw) || str(raw.kind) !== 'funnel-definition') return null;
  const id = str(raw.id);
  if (!id) return null;
  const stages = Array.isArray(raw.stages) ? raw.stages.map(readStageSpec).filter(spec => spec !== null) : [];
  return { kind: 'funnel-definition', id, ...(str(raw.title) ? { title: str(raw.title) } : {}), stages };
}

/**
 * The amount of the price option a stage NAMES on an offer. A sole option needs no name. With several options and no
 * name there is nothing to choose by (an option's position is a value nobody authored), so the offer's own flat amount
 * is used, and failing that no amount: an absent number is honest where a guessed one is not.
 */
function offerAmount(offer, namedOptionId) {
  if (!offer) return {};
  const options = (Array.isArray(offer.price_options) ? offer.price_options : []).filter(isRecord);
  const named = namedOptionId ? options.find(option => str(option.id) === namedOptionId) : (options.length === 1 ? options[0] : undefined);
  if (named) {
    const amount = num(named.amount_cents);
    if (amount !== undefined) return { amount, currency: str(named.currency) };
  }
  const flat = isRecord(offer.offer) ? num(offer.offer.amount_cents) : num(offer.amount_cents);
  return flat !== undefined ? { amount: flat } : {};
}

function resolveVariants(surface, offers, liveCandidateId) {
  if (!surface) return { variants: [] };
  const surfaceId = str(surface.id) ?? str(surface.address);
  const variants = [];
  for (const candidate of Array.isArray(surface.candidates) ? surface.candidates : []) {
    if (!isRecord(candidate)) continue;
    const candidateId = str(candidate.candidate_id) ?? str(candidate.id);
    if (!candidateId) continue;
    const inline = num(candidate.amount_cents);
    const priced = inline !== undefined
      ? { amount: inline, currency: str(candidate.currency) }
      : offerAmount(findByRef(offers, readRef(candidate.material_ref ?? candidate.offer_ref)), str(candidate.price_option_ref));
    variants.push({
      candidate_id: candidateId,
      ...(str(candidate.label) ? { label: str(candidate.label) } : {}),
      ...(priced.amount !== undefined ? { amount_cents: priced.amount } : {}),
      ...(priced.currency ? { currency: priced.currency } : {}),
      ...(liveCandidateId ? { live: candidateId === liveCandidateId } : {}),
    });
  }
  return { variants, ...(surfaceId ? { surfaceId } : {}) };
}

function resolveMeasures(selectors, measures) {
  return selectors.map(selector => {
    const record = findByRef(measures, { $ref: selector.measure_ref });
    const value = record ? (num(record.value) ?? num(isRecord(record.measure) ? record.measure.value : undefined)) : undefined;
    return {
      role: selector.role,
      value: value ?? 0,
      ...(record && str(record.provenance) ? { provenance: str(record.provenance) } : {}),
      ...(record && num(record.confidence) !== undefined ? { confidence: num(record.confidence) } : {}),
    };
  });
}

/**
 * Join a funnel-definition to the records its refs name.
 * `owners`: { workflowNodes, variantSurfaces, offers, measures, liveVariantBySurface } (each absent by default).
 * Each stage gets its title (own title, else the workflow node's label/title/name, else the address), its versions with
 * the live one flagged, its price, its measures by role and, from `entered` and `converted`, a conversion percent with
 * one decimal (0 when nothing entered). With `funnelId` that funnel is used, else the first.
 */
export function resolveFunnelDefinition(definitions, owners = {}, funnelId) {
  const defs = definitions.map(readFunnelDefinition).filter(def => def !== null);
  const def = funnelId ? defs.find(item => item.id === funnelId || item.id.includes(funnelId)) : defs[0];
  if (!def) return null;
  const { workflowNodes = [], variantSurfaces = [], offers = [], measures = [], liveVariantBySurface = {} } = owners;
  const stages = def.stages.map(spec => {
    const node = findByRef(workflowNodes, spec.workflow_node_ref);
    const surface = findByRef(variantSurfaces, spec.variant_surface_ref);
    const surfaceKey = surface ? (str(surface.id) ?? str(surface.address)) : undefined;
    const { variants, surfaceId } = resolveVariants(surface, offers, surfaceKey ? liveVariantBySurface[surfaceKey] : undefined);
    const offer = findByRef(offers, spec.offer_price_ref);
    const { amount } = offerAmount(offer, str(spec.price_option_ref));
    const results = resolveMeasures(spec.metric_selectors, measures);
    const entered = results.find(measure => measure.role === 'entered')?.value ?? 0;
    const converted = results.find(measure => measure.role === 'converted')?.value ?? 0;
    return {
      stage_address: spec.stage_address,
      title: spec.title ?? (node ? (str(node.label) ?? str(node.title) ?? str(node.name)) : undefined) ?? spec.stage_address,
      ...(node && str(node.id) ? { workflow_node_id: str(node.id) } : {}),
      outcome_edges: spec.outcome_edges,
      variants,
      ...(surfaceId ? { variant_surface_id: surfaceId } : {}),
      ...(offer && str(offer.id) ? { offer_id: str(offer.id) } : {}),
      ...(amount !== undefined ? { offer_amount_cents: amount } : {}),
      measures: results,
      entered,
      converted,
      conversion_rate: entered > 0 ? Math.round((converted / entered) * 1000) / 10 : 0,
    };
  });
  return { id: def.id, title: def.title ?? def.id, stages };
}

/** Fold decisions ({ surface_address, winner_id }) into { surface: winning candidate } for `liveVariantBySurface`. The funnel reports what was decided; it decides nothing. */
export function liveVariantMapFromDecisions(decisions) {
  const out = {};
  for (const decision of decisions) {
    if (isRecord(decision) && typeof decision.surface_address === 'string' && typeof decision.winner_id === 'string') out[decision.surface_address] = decision.winner_id;
  }
  return out;
}

/** Lowercase, hyphenated, [a-z0-9-] only; blank text gives "". */
export function slugify(text) {
  return (typeof text === 'string' ? text : '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const slugOf = funnelId => (typeof funnelId === 'string' ? funnelId.split(':').at(-1) || funnelId : '');

/** A new, honestly empty funnel-definition: a title and no stages. `entropy` keeps two funnels with one title apart. */
export function buildNewFunnelDefinition(title, entropy) {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  const base = slugify(trimmed);
  const tail = slugify(entropy) || 'funnel';
  return { kind: 'funnel-definition', id: `funnel:${base ? `${base}-${tail}` : tail}`, ...(trimmed ? { title: trimmed } : {}), stages: [] };
}

/** A new definition with one title-only stage appended; its address is the next free `stage:<funnel>:s<n>`. Wiring it to a node, offer or measure is adding a ref to that row. */
export function appendStage(definition, stageTitle) {
  const slug = slugOf(definition.id);
  const title = typeof stageTitle === 'string' ? stageTitle.trim() : '';
  const taken = new Set((definition.stages ?? []).map(stage => stage.stage_address));
  let ordinal = (definition.stages?.length ?? 0) + 1;
  while (taken.has(`stage:${slug}:s${ordinal}`)) ordinal += 1;
  return { ...definition, stages: [...(definition.stages ?? []), { stage_address: `stage:${slug}:s${ordinal}`, ...(title ? { title } : {}) }] };
}
