// packages/funnel-offer-graph/read-data/funnel-composition.ts
//
// =============================================================================
// PURPOSE — the pure wiring seams between the funnel primitive and the generic
// owners it composes (A/B, drill-in, in-UI variant edit). NO React, NO I/O —
// these are the pure functions the mount calls so the mount stays thin and the
// composition is unit-testable.
// =============================================================================
//
// Each seam RE-OWNS nothing:
//   - A/B live-variant map  ← `choose-per-observer` decisions (its DECIDE output)
//   - stage row actions      → generic target requests OR shared placeable-
//                              surface intents rendered by ui/OpenSurfaceAction
//   - in-UI variant edit     → a write-batch append/patch of ONE candidate row
//                              on the `choose-per-observer` selection-surface
//                              (there is NO `offer-record-change-form` package —
//                              editing a variant is a scoped additive DATA write)
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Pure + total. Same input → same output. No clock, no I/O, no globals.
// 2. Zero domain literals: no price, no offer name, no outcome token enumerated.
// 3. The funnel never rolls its own A/B RNG — it READS choose-per-observer's
//    decision. It never computes a metric — it READS the resolved measure.
// =============================================================================

import type { ResolvedStage } from './funnel-definition';
import {
  readPlaceableSurfacePayloadFromUnknown,
  type PlaceableSurfacePayload,
} from '../../../ui';

// ---------------------------------------------------------------------------
// A/B — read the live variant per surface from choose-per-observer decisions
// ---------------------------------------------------------------------------

/** One decision row as choose-per-observer's `scopeRecordsForObserver` emits it. */
export interface ObserverDecisionRow {
  surface_address: string;
  winner_id: string;
  hidden_ids?: string[];
}

/**
 * Fold choose-per-observer decisions into the `{ [surfaceId]: winnerCandidateId }`
 * map `resolveFunnelDefinition` reads to flag the live variant. Blind: the funnel
 * does not decide — it reports what the owner decided.
 */
export function liveVariantMapFromDecisions(
  decisions: readonly ObserverDecisionRow[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of decisions) {
    if (d && typeof d.surface_address === 'string' && typeof d.winner_id === 'string') {
      out[d.surface_address] = d.winner_id;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drill-in — map a stage's row_actions to generic target envelopes
// ---------------------------------------------------------------------------

export interface ProjectionActionSpec {
  id: string;
  label: string;
  target?: string;
  operation?: string;
  input?: Record<string, unknown>;
  definitionId?: string;
  disabledReason?: string;
  surface?: PlaceableSurfacePayload;
}

export type StageActionRequest = {
  target: string;
  operation: string;
  input: Record<string, unknown>;
  correlationId: string;
  disabledReason?: string;
};

/**
 * Translate a resolved stage's `row_actions` into projection-action specs
 * scoped to that stage. `target`/`operation` default to a workflow-slot
 * `execute_definition` dispatch when the action_ref names a definition; an
 * explicit `target`/`operation` on the DATA row overrides. The stage address is
 * threaded into `input` so the action runs against the stage's records. The
 * human `label` comes from `label_ref` (a data-label id resolved by the render
 * layer's label map) or falls back to a humanized action_ref.
 */
export function stageRowActionSpecs(
  stage: Pick<ResolvedStage, 'stage_address' | 'row_actions'>,
  labelFor: (labelRef: string | undefined, fallback: string) => string = (_ref, fb) => fb,
): ProjectionActionSpec[] {
  return (stage.row_actions ?? []).map((a) => {
    const surface = readPlaceableSurfacePayloadFromUnknown(a.surface);
    if (surface) {
      return {
        id: `${stage.stage_address}:${a.action_ref}`,
        label: labelFor(a.label_ref, surface.title ?? humanizeActionRef(a.action_ref)),
        surface,
      };
    }
    const isDefinition = a.action_ref.startsWith('action:') || a.action_ref.includes('workflow-definition');
    const target = a.target ?? 'slot::workflow';
    const operation = a.operation ?? (isDefinition ? 'execute_definition' : 'invoke');
    return {
      id: `${stage.stage_address}:${a.action_ref}`,
      label: labelFor(a.label_ref, humanizeActionRef(a.action_ref)),
      target,
      operation,
      input: { stage_address: stage.stage_address },
      ...(isDefinition ? { definitionId: a.action_ref } : {}),
    };
  });
}

/** Assemble a dispatch request for a non-surface row action. Surface intents do
 *  not become envelopes: the shared OpenSurfaceAction emits them to the active
 *  screen arrangement instead. */
export function buildStageActionRequest(args: {
  action: ProjectionActionSpec;
  projectionRevision: string;
  correlationId?: string;
}): StageActionRequest | null {
  if (args.action.surface || !args.action.target) return null;
  const operation = args.action.operation ?? (args.action.definitionId ? 'execute_definition' : 'invoke');
  const input: Record<string, unknown> = {
    ...(args.action.input ?? {}),
    projectionRevision: args.projectionRevision,
  };
  if (args.action.definitionId) input.definitionId = args.action.definitionId;
  return {
    target: args.action.target,
    operation,
    input,
    correlationId: args.correlationId ?? `${args.action.id}:${args.projectionRevision}`,
    disabledReason: args.action.disabledReason,
  };
}

/** "action:message-visitor" → "Message visitor" (plain, no engine words). */
export function humanizeActionRef(ref: string): string {
  const tail = ref.split(':').pop() ?? ref;
  const words = tail.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ref;
}

// ---------------------------------------------------------------------------
// In-UI variant edit — a scoped additive write of ONE candidate DATA row
// ---------------------------------------------------------------------------

/** A single variant a user adds/edits from the UI (price is the common lever). */
export interface VariantEdit {
  candidate_id: string;
  label?: string;
  amount_cents?: number;
  currency?: string;
}

/**
 * Build the write-batch entry that adds/updates ONE candidate on a
 * `choose-per-observer` selection-surface record (the "edit the funnel's A/B
 * from the UI" path — a scoped ADDITIVE write, never a whole-surface rebuild,
 * L121/L128). `surfaceRecord` is the current selection-surface payload; the
 * returned payload is that record with the one candidate upserted by
 * `candidate_id`. `address` is the surface record's live address.
 */
export function buildVariantUpsertWrite(
  address: string,
  surfaceRecord: Record<string, unknown>,
  edit: VariantEdit,
  pathLabels: string[] = ['current-item', 'published-record'],
): {
  target: string;
  payload: {
    operation_label: string;
    writes: Array<{ address_label: string; address_mode: string; path_labels: string[]; payload: Record<string, unknown> }>;
  };
} | null {
  if (!address || !edit.candidate_id) return null;
  const existing = Array.isArray(surfaceRecord.candidates)
    ? (surfaceRecord.candidates as unknown[]).filter(
        (c) => !(c && typeof c === 'object' && (c as { candidate_id?: string }).candidate_id === edit.candidate_id),
      )
    : [];
  const candidate: Record<string, unknown> = {
    candidate_id: edit.candidate_id,
    ...(edit.label ? { label: edit.label } : {}),
    ...(edit.amount_cents != null ? { amount_cents: edit.amount_cents } : {}),
    ...(edit.currency ? { currency: edit.currency } : {}),
  };
  return {
    target: 'engine.operation.label-addressed',
    payload: {
      operation_label: 'engine.operation.write-batch',
      writes: [
        {
          address_label: address,
          address_mode: 'identity_text',
          path_labels: pathLabels,
          payload: { ...surfaceRecord, candidates: [...existing, candidate] },
        },
      ],
    },
  };
}
