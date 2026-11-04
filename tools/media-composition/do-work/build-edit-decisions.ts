// packages/media-composition/do-work/build-edit-decisions.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// ONE generic, self-describing edit-decision author for the media-composition
// timeline.
//
// An "edit" is a self-describing decision row over a frame-addressed timeline.
// Every editing MODALITY — a drag-handle trim, a type-to-cut on a transcript,
// a search-to-assemble append, an AI "fix my video" pass, a caption attach —
// is merely a different CALLER of `authorEditDecision`, emitting the SAME
// decision rows into the SAME append-only fold. The reducer folds them through
// its `FOLD_ACTIONS` capability map; the compositor renders them blind.
//
// This file used to hold FIVE named builder functions (buildSplitDecision,
// buildTrimDecision, buildMoveDecision, buildDeleteDecision,
// buildSetTransformDecision) plus a closed `MediaEditDecisionParams`
// discriminated union. That was `1000x-enum-dissolution.md` in the flesh:
// adding a new editing operation meant adding a new function AND a new union
// arm — O(features). It is DELETED. The discriminant now lives in DATA
// (`edit-op-schemas.ts` / the package's `contract::edit-op` rows) and this
// author dispatches through the injected schema capability map. Adding an op
// is a DATA row; this file never grows.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. PURE FUNCTION: no Date.now(), no crypto.randomUUID() internally. Callers
//    pass `createdAt` (ISO string). IDs default via the canonical builder.
// 2. WRAPS THE CANONICAL BUILDER: delegates to
//    buildMediaCompositionEditDecisionRecord — no direct payload construction.
// 3. VALIDATES AGAINST DATA: the op name + parameter shape are checked against
//    the injected op-schema map (SSOT), never against a hardcoded op list.
// 4. PARAMETERS ARE SNAKE_CASE and land verbatim in the record's `parameters`.
// 5. NO REACT, NO DESIGN TOKENS: pure TypeScript.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import {
  buildMediaCompositionEditDecisionRecord,
  type MediaCompositionRecord,
} from '@/packages/media-composition/do-work/write-media-composition-record';
import type { ContentMediaSourceRef } from '@/packages/content-media-evidence/do-work/content-media-work-loop';
import {
  DEFAULT_EDIT_OP_SCHEMAS,
  validateEditOp,
  type EditOpSchemaMap,
} from '@/packages/media-composition/do-work/edit-op-schemas';

/**
 * Visual transform applied to a clip (crop, picture-in-picture sizing, ...).
 * Carried opaquely inside a `set-transform` op's `transform` parameter — the
 * author does not interpret it; the reducer merges it.
 */
export interface ClipTransform {
  aspectRatio?: string;
  framePreset?: string;
  position?: { x: number; y: number };
  width?: number;
  height?: number;
  padding?: number;
  inset?: number;
  corners?: number;
  stroke?: number;
  shadow?: number;
  keepAspectRatio?: boolean;
}

/** Context shared by every authored decision (who/when/over-what). */
export interface EditDecisionContext {
  /** the media source the edit is scoped to (or an opaque ref record). */
  sourceRef?: ContentMediaSourceRef | Record<string, unknown>;
  /** ISO timestamp — callers own the clock (invariant #1). */
  createdAt: string;
  /** optional frame/time span the edit applies over. */
  span?: { start?: number; end?: number };
  /** optional stable id; defaults to a generated one. */
  decisionId?: string;
  /** optional label override; defaults to the op descriptor's label. */
  label?: string;
}

/**
 * Author ONE edit-decision record for ANY operation defined in the op-schema
 * DATA. This is the single door every editing modality goes through.
 *
 * @param action     the op name (must exist in `schemas`).
 * @param parameters snake_case params, validated against the op descriptor.
 * @param ctx        source/time/id/label context.
 * @param schemas    injected capability map (defaults to the package's DATA).
 *
 * @example  // drag-handle trim
 * authorEditDecision('trim',
 *   { clip_id: 'clip-1', in_point: 2, out_point: 10 },
 *   { sourceRef, createdAt: now });
 *
 * @example  // transcript-driven cut (a DIFFERENT modality, SAME author)
 * authorEditDecision('delete',
 *   { clip_id: wordClipId },
 *   { sourceRef, createdAt: now, span: { start: word.start, end: word.end } });
 */
export function authorEditDecision(
  action: string,
  parameters: Record<string, unknown>,
  ctx: EditDecisionContext,
  schemas: EditOpSchemaMap = DEFAULT_EDIT_OP_SCHEMAS,
): MediaCompositionRecord {
  const descriptor = validateEditOp(action, parameters, schemas);
  return buildMediaCompositionEditDecisionRecord({
    decisionId: ctx.decisionId,
    action: descriptor.action,
    label: ctx.label ?? descriptor.label,
    sourceRef: ctx.sourceRef,
    span: ctx.span,
    parameters,
    createdAt: ctx.createdAt,
  });
}
