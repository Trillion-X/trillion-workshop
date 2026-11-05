// packages/group/read-data/arrangement-artifact.ts
//
// §9.2 — The Arrangement Artifact primitive. A reusable board arrangement is NOT a
// fixed BoardTemplate; it is a SELF-DESCRIBING producer descriptor that RESOLVES to a
// concrete BoardTemplate at apply time, given the target board's current items. A static
// snapshot (today's saved template/collection) and a live lens ("re-cluster whatever is
// on the board now, by tag") are the SAME shape — only `producer.capability` differs.
//
// This dissolves the snapshot-vs-live-recipe distinction into DATA (L090 / enum-
// dissolution): the resolver NEVER branches on `if kind === 'snapshot'`; it looks the
// capability up in an injected producer map and invokes it. Adding a new arrangement
// kind (a time-sort lens, an owner-swimlane lens, a saved custom layout) = one more
// producer registered by the owner, ZERO change to the resolver or any consumer.
// Codex GPT-5.5 converged this contract 2026-07-04 (Q2 verdict: enum-dissolved shape is
// correct; snapshot = the constant producer, live-recipe = the arrange producer, one
// `resolve(artifact, targetItems) -> BoardTemplate` before the existing applyTemplate).

import type { BoardTemplate, TemplateItem } from './board-template-apply.ts';
import { arrangeByField } from '../show/arrange-by-field.ts';
import { arrangeByAxis, arrangeTimelineLanes } from '../show/arrange-by-axis.ts';

/** The context a producer resolves against: the target board's CURRENT items as portable
 *  TemplateItems, so a live lens can re-cluster them. A snapshot producer ignores this. */
export interface ArrangementContext {
  readonly targetItems: readonly TemplateItem[];
}

/** A producer turns its own opaque `input` DATA + the target board context into the
 *  concrete BoardTemplate the applyTemplate engine places. It is blind to WHICH producer
 *  it is — the registry key already selected it. */
export type ArrangementProducer = (input: unknown, ctx: ArrangementContext) => BoardTemplate;

/** A reusable arrangement as self-describing DATA. `producer.capability` names which
 *  registered producer resolves it; `producer.input` is that producer's opaque config.
 *  Snapshot and live-lens artifacts share this shape — the capability is the only
 *  difference, and it is DATA, never a code branch. */
export interface ArrangementArtifact {
  readonly id: string;
  readonly name: string;
  readonly category?: string;
  readonly producer: {
    readonly capability: string;
    readonly input: unknown;
    readonly version?: string;
  };
}

// ── The two built-in producers (owner-provided capabilities, not core branches) ──

/** Capability key for a static snapshot artifact (the constant producer). */
export const SNAPSHOT_CAPABILITY = 'snapshot';
/** Capability key for a live facet lens (re-cluster the target board by a named facet). */
export const FACET_LENS_CAPABILITY = 'facet-lens';

/** The SNAPSHOT producer — the constant function. Ignores the target board entirely and
 *  returns the stored BoardTemplate verbatim. This is exactly today's static template /
 *  saved-collection behaviour, now expressed as one producer among many. */
export const snapshotProducer: ArrangementProducer = (input) => input as BoardTemplate;

/** Config DATA for a live facet lens: the facet key names WHICH extractor to cluster by
 *  (resolved through the injected facet map — the same L090 pattern one level down), and
 *  the grid gap. Both are serialisable DATA, so a live lens is a persistable library row. */
export interface FacetLensInput {
  readonly facet: string;
  readonly gap?: number;
  /** Name/category for the produced template (defaults derived from the facet). */
  readonly name?: string;
  readonly category?: string;
}

/** First non-empty key of a possibly-multi-key facet (multi-tag items cluster under their
 *  first tag; keyless items share the '' pile). Identical contract to `arrangeByFacet`. */
function firstKey(k: string | readonly string[]): string {
  return Array.isArray(k) ? (k.find((s) => typeof s === 'string' && s.length > 0) ?? '') : typeof k === 'string' ? k : '';
}

/**
 * OWN-property lookup of an UNTRUSTED string key into an owner-injected capability map. The
 * KEY here (a producer capability, a facet name, a numeric-field name) is untrusted DATA — it
 * flows from a persisted/imported arrangement artifact's `producer.capability` / `producer.input.*`
 * (via `lensRowFromSpec`, whose `spec` is parsed from the `arrangement-lens-catalog` published
 * records). A plain `map[key]` INHERITS from Object.prototype, so `key === 'constructor'` resolves
 * to the Object constructor — a truthy value that SKIPS the caller's fail-closed "no X registered"
 * named error and becomes a PHANTOM producer/extractor (it mis-clusters every item into the ''/
 * no-value pile instead of failing), and `key === '__proto__'` resolves to a non-callable object
 * that crashes on invocation. Restricting to OWN properties makes every prototype-named key ABSENT
 * (→ the intended hard, named, fail-closed error), while a real own entry literally named
 * '__proto__'/'constructor' would still resolve — machine-readable dispatch, no inherited surprise.
 */
function ownCapability<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/**
 * Build the LIVE-LENS producer over an injected facet-extractor map. The producer reads
 * the target board's current items, clusters them by the named facet via the pure
 * `arrangeByField` leaf (the SAME geometry the board's "Group by tag/kind/color" ops use),
 * and returns a BoardTemplate whose items are the same items at their re-clustered
 * positions. The facet map is INJECTED (owner-provided), so the producer never enumerates
 * facets — a new facet is one map entry, zero producer change (L090). A facet the map does
 * not know is a hard, named failure (no silent mis-placement).
 */
export function facetLensProducer(
  facets: Readonly<Record<string, (item: TemplateItem) => string | readonly string[]>>,
): ArrangementProducer {
  return (input, ctx) => {
    const cfg = (input ?? {}) as FacetLensInput;
    const keyOf = ownCapability(facets, cfg.facet);
    if (!keyOf) {
      throw new Error(`no facet extractor registered for facet "${cfg.facet}"`);
    }
    // `cfg` is untrusted DATA (a saved-lens producer config, typed `unknown`): a malformed `gap`
    // (NaN, or a string that isn't a number) must not poison every placed position. `?? 24` only
    // catches null/undefined, so guard finiteness explicitly and fail closed to the default.
    const gap = Number.isFinite(cfg.gap) && (cfg.gap as number) >= 0 ? (cfg.gap as number) : 24;
    const positions = arrangeByField(
      ctx.targetItems.map((i) => ({ memberId: i.id, w: i.w, h: i.h, groupKey: firstKey(keyOf(i)) })),
      { colGap: gap, rowGap: gap, clusterGap: gap * 3 },
    );
    const at = new Map(positions.map((p) => [p.memberId, p]));
    const items: TemplateItem[] = ctx.targetItems.map((item) => {
      const p = at.get(item.id);
      return p ? { ...item, x: p.x, y: p.y } : item;
    });
    return {
      id: `facet-lens:${cfg.facet}`,
      name: cfg.name ?? `Grouped by ${cfg.facet}`,
      category: cfg.category,
      items,
    };
  };
}

/**
 * Resolve an artifact to a concrete BoardTemplate by dispatching through the injected
 * producer map — OPEN dispatch, the resolver never branches on the capability (L090). A
 * capability with no registered producer is a hard, named error, never a silent empty
 * placement (fail-closed).
 */
export function resolveArtifact(
  artifact: ArrangementArtifact,
  ctx: ArrangementContext,
  producers: Readonly<Record<string, ArrangementProducer>>,
): BoardTemplate {
  const produce = ownCapability(producers, artifact.producer.capability);
  if (!produce) {
    throw new Error(`no arrangement producer registered for capability "${artifact.producer.capability}"`);
  }
  return produce(artifact.producer.input, ctx);
}

/** Wrap a concrete BoardTemplate as a snapshot artifact — the bridge that lets every
 *  existing static template/collection row flow through the SAME resolve path as a live
 *  lens (so there is ONE apply chokepoint, not a snapshot branch beside a lens branch). */
export function snapshotArtifact(template: BoardTemplate): ArrangementArtifact {
  return {
    id: template.id,
    name: template.name,
    category: template.category,
    producer: { capability: SNAPSHOT_CAPABILITY, input: template },
  };
}

/** Build a live facet-lens artifact — the emergent §9.2 capability: a persistable library
 *  row that, on apply, re-clusters the target board by `facet` instead of placing fixed
 *  items. Feeds the Saved Arrangement Library with live-lens rows (the plan's §9.2 goal). */
export function facetLensArtifact(facet: string, opts: { id?: string; name?: string; category?: string; gap?: number } = {}): ArrangementArtifact {
  return {
    id: opts.id ?? `facet-lens:${facet}`,
    name: opts.name ?? `Grouped by ${facet}`,
    category: opts.category,
    producer: {
      capability: FACET_LENS_CAPABILITY,
      input: { facet, gap: opts.gap, name: opts.name, category: opts.category } satisfies FacetLensInput,
    },
  };
}

// ── The CONTINUOUS-lens producers (§9.4/§9.5 saved as reusable lenses) ──
//
// The axis/scatter/timeline/roadmap arrangers were surfaced as bulk-bar actions but were not yet
// SAVEABLE library lenses like "Group by tag" is. These producers close that gap the SAME way the
// facet lens did: the numeric/lane field is a serialisable KEY resolved through an injected map
// (numeric-field map for the continuous axes, the SAME facet map for lanes), so a live "Plot by X"
// or "Roadmap by lane" is a persistable DATA row, re-resolved against whatever is on the board now.
// The map is owner-injected → a new field is one map entry, zero producer change (L090); an unknown
// field is a hard, named error (fail-closed), never a silent mis-placement.

/** A numeric-field extractor map: field key → the item's raw number on that axis (null = no value).
 *  The continuous analog of the facet map — one entry per plottable number (size, length, …). */
export type NumericFields = Readonly<Record<string, (item: TemplateItem) => number | null>>;

/** Capability key for a continuous AXIS lens (1-D number-line / timeline or 2-D scatter). */
export const AXIS_LENS_CAPABILITY = 'axis-lens';
/** Capability key for a ROADMAP lens (continuous X × discrete swimlanes). */
export const TIMELINE_LENS_CAPABILITY = 'timeline-lens';

/** Config DATA for an axis lens: the X (and optional Y) NUMERIC field keys + pixel spans. Omit
 *  `yField` → a 1-D timeline/number-line; give it → a 2-D scatter. All serialisable. */
export interface AxisLensInput {
  readonly xField: string;
  readonly yField?: string;
  readonly spanX?: number;
  readonly spanY?: number;
  readonly name?: string;
  readonly category?: string;
}

/** Config DATA for a roadmap lens: the continuous X NUMERIC field key + the discrete LANE facet key. */
export interface TimelineLensInput {
  readonly xField: string;
  readonly laneField: string;
  readonly spanX?: number;
  readonly laneHeight?: number;
  readonly name?: string;
  readonly category?: string;
}

/** Re-position `targetItems` at `placed` (by id), returning the same items at new coords — the
 *  shared tail every continuous lens uses (an item the placer didn't touch keeps its position). */
function placedTemplate(ctx: ArrangementContext, placed: readonly { memberId: string; x: number; y: number }[], meta: { id: string; name: string; category?: string }): BoardTemplate {
  const at = new Map(placed.map((p) => [p.memberId, p]));
  const items: TemplateItem[] = ctx.targetItems.map((item) => {
    const p = at.get(item.id);
    return p ? { ...item, x: p.x, y: p.y } : item;
  });
  return { id: meta.id, name: meta.name, category: meta.category, items };
}

/**
 * Build the AXIS-lens producer over an injected numeric-field map. Resolves the target board's
 * current items onto a continuous axis (1-D by `xField`, or 2-D scatter when `yField` is given) via
 * the pure {@link arrangeByAxis} leaf — the SAME geometry the board's "Line up by length" / "Plot
 * size vs length" ops use — and returns a BoardTemplate at the plotted positions. Blind to which
 * field (L090); unknown field → hard named error (fail-closed).
 */
export function axisLensProducer(numericFields: NumericFields): ArrangementProducer {
  return (input, ctx) => {
    const cfg = (input ?? {}) as AxisLensInput;
    const xOf = ownCapability(numericFields, cfg.xField);
    if (!xOf) throw new Error(`no numeric field registered for "${cfg.xField}"`);
    const yOf = cfg.yField ? ownCapability(numericFields, cfg.yField) : undefined;
    if (cfg.yField && !yOf) throw new Error(`no numeric field registered for "${cfg.yField}"`);
    const placed = arrangeByAxis(
      ctx.targetItems.map((i) => ({ memberId: i.id, w: i.w, h: i.h, valueX: xOf(i), valueY: yOf ? yOf(i) : undefined })),
      { spanX: cfg.spanX ?? 800, spanY: cfg.spanY ?? 400 },
    );
    return placedTemplate(ctx, placed, {
      id: `axis-lens:${cfg.xField}${cfg.yField ? `x${cfg.yField}` : ''}`,
      name: cfg.name ?? (cfg.yField ? `${cfg.xField} vs ${cfg.yField}` : `Lined up by ${cfg.xField}`),
      category: cfg.category,
    });
  };
}

/**
 * Build the ROADMAP-lens producer over an injected numeric-field map (for X) + facet map (for
 * lanes). Resolves the target board's current items onto a timeline via the pure
 * {@link arrangeTimelineLanes} leaf — continuous X by `xField` × discrete swimlanes by `laneField`.
 * Both fields are DATA keys resolved through the injected maps (L090); unknown → hard named error.
 */
export function timelineLensProducer(
  numericFields: NumericFields,
  facets: Readonly<Record<string, (item: TemplateItem) => string | readonly string[]>>,
): ArrangementProducer {
  return (input, ctx) => {
    const cfg = (input ?? {}) as TimelineLensInput;
    const xOf = ownCapability(numericFields, cfg.xField);
    if (!xOf) throw new Error(`no numeric field registered for "${cfg.xField}"`);
    const laneOf = ownCapability(facets, cfg.laneField);
    if (!laneOf) throw new Error(`no facet extractor registered for lane field "${cfg.laneField}"`);
    const layout = arrangeTimelineLanes(
      ctx.targetItems.map((i) => ({ memberId: i.id, w: i.w, h: i.h, valueX: xOf(i), laneKey: firstKey(laneOf(i)) })),
      { spanX: cfg.spanX ?? 800, laneHeight: cfg.laneHeight ?? 100 },
    );
    return placedTemplate(ctx, layout.positions, {
      id: `timeline-lens:${cfg.xField}:${cfg.laneField}`,
      name: cfg.name ?? `Roadmap by ${cfg.laneField}`,
      category: cfg.category,
    });
  };
}

/** Build a live AXIS-lens artifact — a persistable library row that re-plots the target board by a
 *  numeric field (1-D) or two (2-D scatter) on apply. */
export function axisLensArtifact(xField: string, opts: { yField?: string; id?: string; name?: string; category?: string } = {}): ArrangementArtifact {
  return {
    id: opts.id ?? `axis-lens:${xField}${opts.yField ? `x${opts.yField}` : ''}`,
    name: opts.name ?? (opts.yField ? `${xField} vs ${opts.yField}` : `Lined up by ${xField}`),
    category: opts.category,
    producer: {
      capability: AXIS_LENS_CAPABILITY,
      input: { xField, yField: opts.yField, name: opts.name, category: opts.category } satisfies AxisLensInput,
    },
  };
}

/** Build a live ROADMAP-lens artifact — a persistable library row that re-lays the target board as a
 *  timeline (continuous X × discrete swimlanes) on apply. */
export function timelineLensArtifact(xField: string, laneField: string, opts: { id?: string; name?: string; category?: string } = {}): ArrangementArtifact {
  return {
    id: opts.id ?? `timeline-lens:${xField}:${laneField}`,
    name: opts.name ?? `Roadmap by ${laneField}`,
    category: opts.category,
    producer: {
      capability: TIMELINE_LENS_CAPABILITY,
      input: { xField, laneField, name: opts.name, category: opts.category } satisfies TimelineLensInput,
    },
  };
}
