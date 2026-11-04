// packages/media-composition/do-work/author-decisions-from-records.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The GENERIC record-driven decision author: the one seam through which every
// non-pointer editing modality (transcript editing, search-assembly, and any
// future record-producing surface) writes timeline edits.
//
// Primitive: `stream of self-describing items  +  ruleset DATA (select
// predicates + emit template)  →  edit-decision records via authorEditDecision`.
//
// The two W6 modalities are CONFIGURATIONS of this one function:
//   - TRANSCRIPT (Descript-class): items = word/gap spans derived from
//     audio-transcription word records ({t,start,end,confidence,...}).
//     "Remove filler words"  = select {kind:word, text in tokens} → emit delete.
//     "Shorten word gaps"    = select {kind:gap, duration ≥ x}    → emit trim.
//   - SEARCH-ASSEMBLY (W5): items = meaning-search find-similar hits
//     ({address, score}). "Assemble found clips" = select {score ≥ min}
//     → emit add-source onto a lane.
//
// The AI-fix modality does NOT go through this module — an agent authors
// decision rows directly via ai-records-producer (dispatch by address), gated
// by ai-action-guard. This module is for DETERMINISTIC rule-driven authoring.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. THE AUTHOR IS BLIND. It never names an operation, a modality, a filler
//    word, a threshold, or a record kind. Predicates, emitted ops, parameter
//    bindings, and limits all arrive as ruleset DATA
//    (`media-composition.edit-ruleset` records). Deleting every shipped
//    ruleset and injecting a completely different domain (pose faults →
//    splits; scored thumbnails → add-source) works with ZERO source change.
// 2. EVERY EMISSION GOES THROUGH `authorEditDecision` — the single validated
//    door. This module cannot construct a decision payload directly, so an
//    invalid op or parameter shape is structurally rejected before any write.
// 3. PURE FUNCTIONS. No Date.now(), no randomness, no I/O. Callers pass
//    `createdAt` and perform all reads/writes.
// 4. MACHINE-READABLE RULESETS. Predicates and bindings are explicit
//    structured fields ({field, op, value} / {param, from}) — never encoded
//    strings a parser must split (see 1000x-machine-readable rule).
// 5. NO REACT, NO DESIGN TOKENS.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { authorEditDecision, type EditDecisionContext } from '@/packages/media-composition/do-work/build-edit-decisions';
import type { MediaCompositionRecord } from '@/packages/media-composition/do-work/write-media-composition-record';
import { DEFAULT_EDIT_OP_SCHEMAS, type EditOpSchemaMap } from '@/packages/media-composition/do-work/edit-op-schemas';

// ---------------------------------------------------------------------------
// RULESET DATA SHAPES (mirror of `media-composition.edit-ruleset` records)
// ---------------------------------------------------------------------------

/** Structural comparison operators. Closed by Physics (JSON value algebra),
 *  not by Society — a new comparison is a new Physics capability, not a
 *  user-extensible variant. */
export type PredicateOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'not_in'
  | 'exists'
  | 'text_in_tokens'; // case-insensitive membership after punctuation strip

/** One field predicate. ALL predicates in `select` must pass (AND). */
export interface FieldPredicate {
  field: string;
  op: PredicateOp;
  value?: unknown;
}

/** Binds an item's field value into an emitted decision parameter. */
export interface ParamBinding {
  param: string;
  from: string;
}

/** How to emit a decision for each selected item. */
export interface EmitTemplate {
  /** op name resolved against the (injected) op-schema map. */
  op: string;
  /** static parameters merged first (lowest precedence). */
  params?: Record<string, unknown>;
  /** per-item field → param bindings (middle precedence). */
  bindings?: readonly ParamBinding[];
  /** item fields providing the decision's span (ctx.span override). */
  span?: { start_from: string; end_from: string };
  /** optional label override for the emitted decisions. */
  label?: string;
}

/** A complete ruleset: which items to select, what to emit, how many at most. */
export interface EditRuleset {
  select: readonly FieldPredicate[];
  emit: EmitTemplate;
  /** optional cap on emitted decisions (e.g. top-N search hits). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// PREDICATE EVALUATION (structural — no field/value is ever named here)
// ---------------------------------------------------------------------------

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
}

function predicatePasses(item: Record<string, unknown>, p: FieldPredicate): boolean {
  const actual = item[p.field];
  switch (p.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === p.value;
    case 'ne':
      return actual !== p.value;
    case 'lt':
      return typeof actual === 'number' && typeof p.value === 'number' && actual < p.value;
    case 'lte':
      return typeof actual === 'number' && typeof p.value === 'number' && actual <= p.value;
    case 'gt':
      return typeof actual === 'number' && typeof p.value === 'number' && actual > p.value;
    case 'gte':
      return typeof actual === 'number' && typeof p.value === 'number' && actual >= p.value;
    case 'in':
      return Array.isArray(p.value) && p.value.includes(actual);
    case 'not_in':
      return Array.isArray(p.value) && !p.value.includes(actual);
    case 'text_in_tokens': {
      if (typeof actual !== 'string' || !Array.isArray(p.value)) return false;
      const needle = normalizeToken(actual);
      return needle.length > 0
        && p.value.some((t) => typeof t === 'string' && normalizeToken(t) === needle);
    }
    default:
      return false;
  }
}

export function itemMatches(item: Record<string, unknown>, select: readonly FieldPredicate[]): boolean {
  return select.every((p) => predicatePasses(item, p));
}

// ---------------------------------------------------------------------------
// THE GENERIC AUTHOR
// ---------------------------------------------------------------------------

export interface AuthorFromRecordsInput {
  /** self-describing items (word spans, gap spans, search hits, anything). */
  items: readonly Record<string, unknown>[];
  /** the ruleset DATA row driving selection + emission. */
  ruleset: EditRuleset;
  /** shared decision context (sourceRef, createdAt, ...). */
  ctx: EditDecisionContext;
  /** injected op-schema capability map (defaults to the package DATA mirror). */
  schemas?: EditOpSchemaMap;
}

/**
 * Fold `items` through `ruleset` into validated edit-decision records.
 * Selection = AND of the ruleset's field predicates. Emission = static params
 * ⊕ per-item bindings, validated by `authorEditDecision` against the op-schema.
 * Item span fields (when declared) ride as the decision's `span`.
 *
 * Returns the records — the CALLER writes them (pure function, invariant #3).
 */
export function authorDecisionsFromRecords(input: AuthorFromRecordsInput): MediaCompositionRecord[] {
  const { items, ruleset, ctx } = input;
  const schemas = input.schemas ?? DEFAULT_EDIT_OP_SCHEMAS;
  const out: MediaCompositionRecord[] = [];
  const limit = ruleset.limit ?? Number.POSITIVE_INFINITY;

  for (const item of items) {
    if (out.length >= limit) break;
    if (!itemMatches(item, ruleset.select)) continue;

    const parameters: Record<string, unknown> = { ...(ruleset.emit.params ?? {}) };
    for (const binding of ruleset.emit.bindings ?? []) {
      if (item[binding.from] !== undefined) parameters[binding.param] = item[binding.from];
    }

    let span = ctx.span;
    if (ruleset.emit.span) {
      const start = item[ruleset.emit.span.start_from];
      const end = item[ruleset.emit.span.end_from];
      if (typeof start === 'number' && typeof end === 'number') span = { start, end };
    }

    out.push(authorEditDecision(ruleset.emit.op, parameters, {
      ...ctx,
      span,
      label: ruleset.emit.label ?? ctx.label,
    }, schemas));
  }
  return out;
}

// ---------------------------------------------------------------------------
// SPAN DERIVATION (pure adapter: timed items → word/gap span stream)
// ---------------------------------------------------------------------------

export interface DeriveSpansOptions {
  /** field carrying the item's display text (default 't', the
   *  audio-transcription word-record convention). */
  textField?: string;
}

/**
 * Derive a self-describing span stream from a list of TIMED items (anything
 * carrying numeric `start`/`end` — audio-transcription word records are the
 * canonical producer, but the adapter never assumes their kind). Output:
 *   - one `{kind:'word'}` span per item (all original fields passed through,
 *     plus `text`, `duration`, `index`),
 *   - one `{kind:'gap'}` span BETWEEN consecutive items when end < next.start
 *     (`duration` = the silence length).
 * Gap spans are what "shorten word gaps" rulesets select on; word spans are
 * what filler-word rulesets select on. The derivation is blind to both uses.
 */
export function deriveWordAndGapSpans(
  items: readonly Record<string, unknown>[],
  options: DeriveSpansOptions = {},
): Record<string, unknown>[] {
  const textField = options.textField ?? 't';
  const timed = items
    .filter((i) => typeof i['start'] === 'number' && typeof i['end'] === 'number')
    .slice()
    .sort((a, b) => (a['start'] as number) - (b['start'] as number));

  const spans: Record<string, unknown>[] = [];
  for (let index = 0; index < timed.length; index++) {
    const item = timed[index];
    const start = item['start'] as number;
    const end = item['end'] as number;
    spans.push({
      ...item,
      kind: 'word',
      text: typeof item[textField] === 'string' ? item[textField] : '',
      start,
      end,
      duration: Math.max(0, end - start),
      index,
    });
    const next = timed[index + 1];
    if (next) {
      const nextStart = next['start'] as number;
      if (nextStart > end) {
        spans.push({
          kind: 'gap',
          start: end,
          end: nextStart,
          duration: nextStart - end,
          index,
        });
      }
    }
  }
  return spans;
}
