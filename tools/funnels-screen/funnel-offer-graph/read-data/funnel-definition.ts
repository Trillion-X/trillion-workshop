// packages/funnel-offer-graph/read-data/funnel-definition.ts
//
// =============================================================================
// PURPOSE — the stage_address DATA contract (the funnel primitive)
// =============================================================================
//
// A funnel is NOT a UI widget. It is a VIEW of one generative primitive: the
// Observable Choice-Stage Workflow. A `funnel-definition` record is an ordered
// list of STAGES; each stage is keyed by a `stage_address` that REFERENCES
// (never re-owns) seven concerns that already have generic owners:
//
//   1. workflow_node_ref     → a `workflow-definition` node (the graph SSOT — the
//                              funnel stores NO second graph; the node IS the truth)
//   2. outcome_edges         → open outcome tokens → the next stage (state machine)
//   3. variant_surface_ref   → a `choose-per-observer` selection-surface (A/B)
//   4. offer_price_ref       → a `checkout` commercial-offer (price economics)
//   5. metric_selectors      → `progression-evaluator` measure refs (entered/converted)
//   6. detail_projection_ref → a `visual-database.view-descriptor` record (drill-in)
//   7. row_actions           → generic target dispatches OR placeable-surface DATA
//
// This module is the BLIND ref-resolver: it reads a `funnel-definition` record
// plus the candidate record arrays each owner already publishes, and joins them
// by `$ref` identity. It names NO domain, NO price, NO outcome, NO offer — every
// value comes from the referenced records (L090 self-describing data, generic
// handler). Delete the ethos funnel entirely, drop a completely different set of
// funnel-definition + owner records in, and this resolves them unchanged — that
// is the deletion test (CLAUDE.md "EXAMPLES ARE PRIMITIVE CONFIGURATIONS").
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Zero hardcoded ids, prices, outcome tokens, offer names, or funnel types.
//    A ref is an OPAQUE pointer; resolution is generic identity matching, never
//    a domain switch.
// 2. SSOT: the graph truth is the `workflow-definition` store. A stage's node
//    label/title is READ from the referenced workflow node — never stored twice.
// 3. Machine-readable refs: every reference is an explicit `{ $ref: string }`
//    object or an explicit `{ measure_ref, role }` / `{ outcome_token, to_stage }`
//    record — a dumb parser reads each piece with no string surgery (beyond the
//    generic `$ref` tail split, which is the one documented pointer convention).
// 4. Fail-soft: a missing funnel / missing stages yields null; a missing owner
//    record yields an unresolved-but-present stage (honest gap), never a throw.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

// ---------------------------------------------------------------------------
// DATA SHAPE (the funnel-definition record + its stage rows)
// ---------------------------------------------------------------------------

/** A machine-readable reference to a record owned by another generic package. */
export type Ref = { $ref: string };

/** One open outcome edge: any token advances the cursor to `to_stage`. */
export type StageOutcomeEdge = { outcome_token: string; to_stage: string };

/** A measure selector: which `progression-evaluator` measure, in which role. */
export type StageMetricSelector = {
  measure_ref: string;
  /** Open role string. The tornado reads `entered`/`converted`; others pass through. */
  role: string;
};

/** A generic row action: either a dispatch target or an existing placeable-
 *  surface payload the drill-in offers on the stage. */
export type StageRowAction = {
  action_ref: string;
  /** Data-label id for the human button copy (resolved by the render layer). */
  label_ref?: string;
  /** Explicit target/operation override; when absent, derived from action_ref. */
  target?: string;
  operation?: string;
  surface?: Record<string, unknown>;
};

/** One stage row keyed by its stage_address, referencing the seven concerns. */
export interface FunnelStageSpec {
  stage_address: string;
  workflow_node_ref?: Ref;
  outcome_edges?: StageOutcomeEdge[];
  variant_surface_ref?: Ref;
  offer_price_ref?: Ref;
  /**
   * WHICH price option of `offer_price_ref` this stage shows, by id. An offer with
   * one option needs none. An offer with several has no authored order, so without
   * this the stage renders whichever row a decoder happened to leave first, which
   * is how a $0 trial came to be shown for a paid product elsewhere.
   */
  price_option_ref?: string;
  metric_selectors?: StageMetricSelector[];
  detail_projection_ref?: Ref;
  row_actions?: StageRowAction[];
  /** Stage title override; when absent, read from the referenced workflow node. */
  title?: string;
}

/** The funnel-definition record: an ordered list of stages. */
export interface FunnelDefinition {
  kind: 'funnel-definition';
  id: string;
  title?: string;
  stages: FunnelStageSpec[];
}

// ---------------------------------------------------------------------------
// SMALL DECODE HELPERS (shared shape with resolve-funnel-flow.ts, kept local
// so this module has zero cross-file coupling to another decoder's internals)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Read a machine-readable ref from either `{ $ref }` or a bare string. */
export function readRef(raw: unknown): Ref | undefined {
  if (isRecord(raw)) {
    const r = str(raw.$ref);
    return r ? { $ref: r } : undefined;
  }
  const s = str(raw);
  return s ? { $ref: s } : undefined;
}

/**
 * The identity tail of a `$ref`. `$ref` is the ONE pointer convention:
 * `"<owner-kind>:<id>[#<sub-id>]"`. The tail after the last `:` (and before any
 * `#`) is the id the owner's records carry. This is a generic pointer split —
 * NOT a domain parse; the owner-kind prefix is never enumerated or branched on.
 */
export function refIdentity(ref: Ref | undefined): { id: string; sub?: string } | null {
  if (!ref) return null;
  const [head, sub] = ref.$ref.split('#', 2);
  const parts = head.split(':');
  const id = parts[parts.length - 1] || head;
  return sub ? { id, sub } : { id };
}

/**
 * Generic match: does a candidate record identify the ref? True when the
 * candidate's `id` equals or contains the ref identity (mirrors the existing
 * resolver's tolerant `.includes` matching so run-id suffixes / addressing
 * schemes still resolve). Zero domain knowledge.
 */
function candidateMatchesRef(candidate: Record<string, unknown>, ref: Ref | undefined): boolean {
  const identity = refIdentity(ref);
  if (!identity) return false;
  const cid = str(candidate.id) ?? str(candidate.address) ?? '';
  if (!cid) return false;
  // A ref may point at a top-level record (matched by the head id) OR at a
  // sub-record such as a workflow-definition NODE (matched by the `#sub` id,
  // which is the id the node projection carries). Try the most specific first,
  // and tolerate ids that themselves contain colons via full-string
  // containment (mirrors the existing resolver's tolerant `.includes` join).
  const targets = identity.sub ? [identity.sub, identity.id] : [identity.id];
  if (targets.some((t) => cid === t || cid.includes(t))) return true;
  return ref!.$ref.includes(cid);
}

function findByRef(records: unknown[], ref: Ref | undefined): Record<string, unknown> | undefined {
  if (!ref) return undefined;
  for (const r of records) if (isRecord(r) && candidateMatchesRef(r, ref)) return r;
  return undefined;
}

// ---------------------------------------------------------------------------
// READ the funnel-definition record
// ---------------------------------------------------------------------------

function readStageSpec(raw: unknown): FunnelStageSpec | null {
  if (!isRecord(raw)) return null;
  const stageAddress = str(raw.stage_address);
  if (!stageAddress) return null;
  const outcomeEdges = Array.isArray(raw.outcome_edges)
    ? raw.outcome_edges.flatMap((e) => {
        if (!isRecord(e)) return [];
        const token = str(e.outcome_token);
        const to = str(e.to_stage);
        return token && to ? [{ outcome_token: token, to_stage: to }] : [];
      })
    : [];
  const metricSelectors = Array.isArray(raw.metric_selectors)
    ? raw.metric_selectors.flatMap((m) => {
        if (!isRecord(m)) return [];
        const measureRef = str(m.measure_ref);
        const role = str(m.role) ?? 'entered';
        return measureRef ? [{ measure_ref: measureRef, role }] : [];
      })
    : [];
  const rowActions = Array.isArray(raw.row_actions)
    ? raw.row_actions.flatMap((a) => {
        if (!isRecord(a)) return [];
        const surface = isRecord(a.surface)
          ? a.surface
          : isRecord(a.placeable_surface) ? a.placeable_surface : undefined;
        const actionRef = str(a.action_ref) ?? str(a.target) ?? (surface ? str(surface.id) : undefined);
        if (!actionRef) return [];
        return [{
          action_ref: actionRef,
          ...(str(a.label_ref) ? { label_ref: str(a.label_ref) } : {}),
          ...(str(a.target) ? { target: str(a.target) } : {}),
          ...(str(a.operation) ? { operation: str(a.operation) } : {}),
          ...(surface ? { surface } : {}),
        }];
      })
    : [];
  return {
    stage_address: stageAddress,
    ...(readRef(raw.workflow_node_ref) ? { workflow_node_ref: readRef(raw.workflow_node_ref) } : {}),
    outcome_edges: outcomeEdges,
    ...(readRef(raw.variant_surface_ref) ? { variant_surface_ref: readRef(raw.variant_surface_ref) } : {}),
    ...(readRef(raw.offer_price_ref) ? { offer_price_ref: readRef(raw.offer_price_ref) } : {}),
    metric_selectors: metricSelectors,
    ...(readRef(raw.detail_projection_ref) ? { detail_projection_ref: readRef(raw.detail_projection_ref) } : {}),
    // Read beside offer_price_ref, because a whitelist reader drops what it does
    // not name and a stage naming its option would then still be priced by position.
    ...(str(raw.price_option_ref) ? { price_option_ref: str(raw.price_option_ref) } : {}),
    row_actions: rowActions,
    ...(str(raw.title) ? { title: str(raw.title) } : {}),
  };
}

/** Normalize a raw `kind:funnel-definition` record (or null). */
export function readFunnelDefinition(raw: unknown): FunnelDefinition | null {
  if (!isRecord(raw)) return null;
  if (str(raw.kind) !== 'funnel-definition') return null;
  const id = str(raw.id);
  if (!id) return null;
  const stages = Array.isArray(raw.stages)
    ? raw.stages.map(readStageSpec).filter((s): s is FunnelStageSpec => s !== null)
    : [];
  return { kind: 'funnel-definition', id, ...(str(raw.title) ? { title: str(raw.title) } : {}), stages };
}

// ---------------------------------------------------------------------------
// RESOLVE (blind ref-join against the owner record arrays)
// ---------------------------------------------------------------------------

/** One resolved A/B candidate on a stage (from a choose-per-observer surface). */
export interface ResolvedVariant {
  candidate_id: string;
  label?: string;
  /** Display price in cents if the candidate resolves an offer/price. */
  amount_cents?: number;
  currency?: string;
  /** True for the candidate currently decided/live for the reading observer. */
  live?: boolean;
}

/** One resolved measure value with provenance carried through. */
export interface ResolvedMeasure {
  role: string;
  value: number;
  /** Provenance ref of the measure that produced the value (from the owner). */
  provenance?: string;
  /** 0..1 confidence carried from progression-evaluator; undefined = unknown. */
  confidence?: number;
}

/** A fully resolved stage: the stage_address joined to its seven concerns. */
export interface ResolvedStage {
  stage_address: string;
  /** Human title — from the stage override, else the workflow node, else the id. */
  title: string;
  workflow_node_id?: string;
  outcome_edges: StageOutcomeEdge[];
  variants: ResolvedVariant[];
  variant_surface_id?: string;
  offer_id?: string;
  offer_amount_cents?: number;
  measures: ResolvedMeasure[];
  entered: number;
  converted: number;
  /** entered→converted rate, 0..100 one decimal; 0 when entered is 0. */
  conversion_rate: number;
  detail_projection_id?: string;
  row_actions: StageRowAction[];
}

export interface ResolvedFunnel {
  id: string;
  title: string;
  stages: ResolvedStage[];
}

/**
 * The owner record arrays the resolver joins against. Each is the generic list
 * the owning package already publishes; the funnel never re-owns any of them.
 * All absent-by-default — a funnel that uses only some concerns resolves the
 * rest empty.
 */
export interface FunnelOwnerRecords {
  /** `workflow-definition` node projections: `{ id, label|title, ... }`. */
  workflowNodes?: unknown[];
  /** `choose-per-observer` selection-surface records: `{ id|address, candidates[] }`. */
  variantSurfaces?: unknown[];
  /** `checkout` commercial-offer records: `{ id, price_options[] }`. */
  offers?: unknown[];
  /** progression-evaluator measure results keyed by measure id → value/provenance/confidence. */
  measures?: unknown[];
  /** visual-database stage-detail descriptor records: `{ id, fields, views }`. */
  detailViews?: unknown[];
  /** candidate_id currently decided per surface id (from choose-per-observer scope). */
  liveVariantBySurface?: Record<string, string>;
}

/**
 * Read the amount of the price option a record NAMES on a commercial-offer.
 *
 * This used to take the first option carrying a finite `amount_cents`, including
 * zero, under a docstring calling that "generic, no tier logic". Calling a
 * positional pick generic does not make it one: `CommercialPriceOption` has no
 * `sort_order` while `CheckoutOffer` has one and is sorted by it, and
 * `readPriceOptions` drops label-less options and assigns `price:${index}` when an
 * id is absent, so array position is a value nobody authored and an unrelated DATA
 * edit silently changes the amount rendered here.
 *
 * The failure it produced elsewhere is on record: a paid offer whose first option
 * is a $0 trial rendered a green "Create free access" CTA on a paid product
 * (`checkout/show/CheckoutFlow.tsx:592-598`). This is the same expression in a
 * third package, which is how one offer came to render three different prices.
 *
 * So the option is named, exactly as the offer already is. A sole option needs no
 * name because there is nothing to choose between. Anything else falls through to
 * the offer's own flat amount, and failing that returns no amount at all, because
 * the callers spread `amount_cents` conditionally and an absent number is honest
 * where a guessed one is not.
 */
function offerAmount(
  offer: Record<string, unknown> | undefined,
  namedOptionId?: string,
): { amount?: number; currency?: string } {
  if (!offer) return {};
  const options = (Array.isArray(offer.price_options) ? offer.price_options : []).filter(isRecord);
  const named = namedOptionId
    ? options.find((o) => str(o.id) === namedOptionId)
    : (options.length === 1 ? options[0] : undefined);
  if (named) {
    const a = num(named.amount_cents);
    if (a != null) return { amount: a, currency: str(named.currency) };
  }
  const flat = isRecord(offer.offer) ? num(offer.offer.amount_cents) : num(offer.amount_cents);
  return flat != null ? { amount: flat } : {};
}

/** Resolve the candidate variants of a selection-surface into display rows. */
function resolveVariants(
  surface: Record<string, unknown> | undefined,
  offers: unknown[],
  liveCandidateId: string | undefined,
): { variants: ResolvedVariant[]; surfaceId?: string } {
  if (!surface) return { variants: [] };
  const surfaceId = str(surface.id) ?? str(surface.address);
  const raw = Array.isArray(surface.candidates) ? surface.candidates : [];
  const variants: ResolvedVariant[] = [];
  for (const c of raw) {
    if (!isRecord(c)) continue;
    const candidateId = str(c.candidate_id) ?? str(c.id);
    if (!candidateId) continue;
    // A candidate may carry its price inline OR point at an offer via material_ref.
    const inlineAmount = num(c.amount_cents);
    const linkedOffer = inlineAmount == null
      ? findByRef(offers, readRef(c.material_ref ?? c.offer_ref))
      : undefined;
    const { amount, currency } = inlineAmount != null
      ? { amount: inlineAmount, currency: str(c.currency) }
      : offerAmount(linkedOffer, str(c.price_option_ref));
    variants.push({
      candidate_id: candidateId,
      ...(str(c.label) ? { label: str(c.label) } : {}),
      ...(amount != null ? { amount_cents: amount } : {}),
      ...(currency ? { currency } : {}),
      ...(liveCandidateId ? { live: candidateId === liveCandidateId } : {}),
    });
  }
  return { variants, ...(surfaceId ? { surfaceId } : {}) };
}

/** Resolve a workflow node's human title (SSOT — read, never store twice). */
function nodeTitle(node: Record<string, unknown> | undefined): string | undefined {
  if (!node) return undefined;
  return str(node.label) ?? str(node.title) ?? str(node.name);
}

/**
 * Resolve the measure values for a stage from the owner's measure results. Each
 * `metric_selector` names a measure_ref + role; the value/provenance/confidence
 * come from the referenced measure result (progression-evaluator carries all
 * three). No metric math happens here — the reducer is the owner's job.
 */
function resolveMeasures(
  selectors: StageMetricSelector[],
  measures: unknown[],
): ResolvedMeasure[] {
  return selectors.flatMap((sel) => {
    const rec = findByRef(measures, { $ref: sel.measure_ref });
    const value = rec ? (num(rec.value) ?? num((isRecord(rec.measure) ? rec.measure.value : undefined))) : undefined;
    return [{
      role: sel.role,
      value: value ?? 0,
      ...(rec && str(rec.provenance) ? { provenance: str(rec.provenance) } : {}),
      ...(rec && num(rec.confidence) != null ? { confidence: num(rec.confidence) } : {}),
    }];
  });
}

/**
 * Resolve a funnel-definition + its owner records into a rendered funnel. The
 * ONLY join is `$ref` identity; the resolver is blind to every domain. When a
 * `funnelId` is given, that funnel is resolved; otherwise the first one.
 */
export function resolveFunnelDefinition(
  defRecords: unknown[],
  owners: FunnelOwnerRecords = {},
  funnelId?: string,
): ResolvedFunnel | null {
  const defs = defRecords
    .map(readFunnelDefinition)
    .filter((d): d is FunnelDefinition => d !== null);
  const def = funnelId
    ? defs.find((d) => d.id === funnelId || d.id.includes(funnelId))
    : defs[0];
  if (!def) return null;

  const workflowNodes = owners.workflowNodes ?? [];
  const variantSurfaces = owners.variantSurfaces ?? [];
  const offers = owners.offers ?? [];
  const measures = owners.measures ?? [];
  const detailViews = owners.detailViews ?? [];
  const live = owners.liveVariantBySurface ?? {};

  const stages: ResolvedStage[] = def.stages.map((spec) => {
    const node = findByRef(workflowNodes, spec.workflow_node_ref);
    const surface = findByRef(variantSurfaces, spec.variant_surface_ref);
    const surfaceIdForLive = surface
      ? (str(surface.id) ?? str(surface.address))
      : undefined;
    const { variants, surfaceId } = resolveVariants(
      surface,
      offers,
      surfaceIdForLive ? live[surfaceIdForLive] : undefined,
    );
    const offer = findByRef(offers, spec.offer_price_ref);
    const { amount } = offerAmount(offer, str(spec.price_option_ref));
    const measureResults = resolveMeasures(spec.metric_selectors ?? [], measures);
    const entered = measureResults.find((m) => m.role === 'entered')?.value ?? 0;
    const converted = measureResults.find((m) => m.role === 'converted')?.value ?? 0;
    const detailView = findByRef(detailViews, spec.detail_projection_ref);
    return {
      stage_address: spec.stage_address,
      title: spec.title ?? nodeTitle(node) ?? spec.stage_address,
      ...(node && str(node.id) ? { workflow_node_id: str(node.id) } : {}),
      outcome_edges: spec.outcome_edges ?? [],
      variants,
      ...(surfaceId ? { variant_surface_id: surfaceId } : {}),
      ...(offer && str(offer.id) ? { offer_id: str(offer.id) } : {}),
      ...(amount != null ? { offer_amount_cents: amount } : {}),
      measures: measureResults,
      entered,
      converted,
      conversion_rate: entered > 0 ? Math.round((converted / entered) * 1000) / 10 : 0,
      ...(detailView && str(detailView.id) ? { detail_projection_id: str(detailView.id) } : {}),
      row_actions: spec.row_actions ?? [],
    };
  });

  return { id: def.id, title: def.title ?? def.id, stages };
}
