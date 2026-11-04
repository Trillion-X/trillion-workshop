// packages/media-composition/read-data/edit-capabilities.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The DATA that drives the `edit-timeline` surface, in one blind place.
//
// An "editing capability" is three self-describing DATA families the surface
// renders GENERICALLY — never a hardcoded button list:
//   - EDIT OPS       (`media-composition.edit-op` rows)      -> one action each
//   - EDIT MODALITIES(`media-composition.edit-modality` rows)-> one input mode
//   - EDIT RULESETS  (`media-composition.edit-ruleset` rows) -> one 1-click clean
//
// This module is the SOURCE MIRROR of those runtime DATA rows in
// `things-to-store-and-run.json` — exactly as `DEFAULT_EDIT_OP_SCHEMAS`
// (`do-work/edit-op-schemas.ts`) mirrors the `edit-op` rows. The surface reads
// these descriptors and lays out a control per row. Adding an op / modality /
// ruleset is a NEW DATA ROW (mirrored here), and a NEW control appears with
// ZERO surface-code change — the deletion test (see __tests__).
//
// The ops half is NOT duplicated here (SSOT / L043): it is re-exported from
// `edit-op-schemas.ts`. This module owns only the modality + ruleset mirrors
// and the pure, op-name-blind param resolver the surface uses to decide which
// ops are actionable from the current editor state.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. NO PER-OP / PER-MODALITY BRANCH. Nothing here names "trim" / "transcript"
//    in a `switch`/`if`. Descriptors are DATA; helpers walk their fields.
// 2. PURE DATA + PURE FUNCTIONS. No React, no Date.now(), no I/O.
// 3. MIRRORS THE RUNTIME ROWS 1:1. When a row changes in the things-file, this
//    mirror changes with it — it is a default/fallback, never a closed registry.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import {
  DEFAULT_EDIT_OP_SCHEMAS,
  type EditOpDescriptor,
  type EditOpSchemaMap,
} from '@/packages/media-composition/do-work/edit-op-schemas';
import type { EditRuleset } from '@/packages/media-composition/do-work/author-decisions-from-records';

export { DEFAULT_EDIT_OP_SCHEMAS };
export type { EditOpDescriptor, EditOpSchemaMap };

// ---------------------------------------------------------------------------
// MODALITY DESCRIPTORS (mirror of `media-composition.edit-modality` rows)
// ---------------------------------------------------------------------------

/** Where a record-driven modality reads its self-describing items from. The
 *  `fields` map is DATA: it declares which raw keys hold the item's text /
 *  timing, so the reader is blind to the producer's field names. */
export interface EditModalitySource {
  package: string;
  record_kind?: string;
  word_kind?: string;
  workflow_action?: string;
  fields?: Record<string, string>;
  hit_fields?: Record<string, string>;
}

/** One input MODALITY — a way to author edit decisions. Rendered as one entry
 *  in the surface's modality switch (label only; behavior is DATA). */
export interface EditModalityDescriptor {
  name: string;
  author_kind: string;
  label: string;
  offered_ops: readonly string[];
  ruleset_refs?: readonly string[];
  source?: EditModalitySource;
  dispatch?: Record<string, unknown>;
  instruction_block_ref?: string;
  notes?: string;
}

/** Source mirror of the admitted `edit-modality` rows. */
export const EDIT_MODALITIES: readonly EditModalityDescriptor[] = [
  {
    name: 'transcript',
    author_kind: 'transcript',
    label: 'Edit by transcript',
    offered_ops: ['remove-span'],
    ruleset_refs: [
      'media-composition.edit-ruleset:remove-filler-words',
      'media-composition.edit-ruleset:remove-silences',
    ],
    source: {
      package: 'audio-transcription',
      record_kind: 'audio-transcription.result',
      word_kind: 'word',
      fields: { text: 't', start: 'start', end: 'end' },
    },
  },
  {
    name: 'search-assembly',
    author_kind: 'search',
    label: 'Assemble from search',
    offered_ops: ['add-source'],
    ruleset_refs: ['media-composition.edit-ruleset:assemble-search-hits'],
    source: {
      package: 'meaning-search',
      workflow_action: 'action:find-similar',
      hit_fields: { address: 'address', score: 'score' },
    },
  },
  {
    name: 'ai-fix',
    author_kind: 'ai',
    label: 'Fix with AI',
    offered_ops: ['remove-span', 'trim', 'split', 'delete', 'move', 'add-source'],
    dispatch: {
      package: 'ai-records-producer',
      action: 'action:run-ai-records-production',
      guard: 'ai-action-guard',
    },
    instruction_block_ref: 'ai-instruction-block:media-editor-fix',
  },
  {
    name: 'adjustment-layer',
    author_kind: 'adjustment',
    label: 'Adjustment layers',
    offered_ops: ['editor.layers.adjustment'],
    notes: 'Add an effect over the selected clip range. The effect appears on its own timeline lane and can be edited later.',
  },
];

// ---------------------------------------------------------------------------
// RULESET DESCRIPTORS (mirror of `media-composition.edit-ruleset` rows)
// ---------------------------------------------------------------------------

/** A named, human-labeled ruleset — the payload `authorDecisionsFromRecords`
 *  folds a transcript/search item stream through. `select`/`emit` are the
 *  machine-readable predicate + template (see author-decisions-from-records). */
export interface EditRulesetDescriptor extends EditRuleset {
  name: string;
  label: string;
}

/** Source mirror of the three admitted `edit-ruleset` rows. */
export const EDIT_RULESETS: readonly EditRulesetDescriptor[] = [
  {
    name: 'remove-filler-words',
    label: 'Remove filler words',
    select: [
      { field: 'kind', op: 'eq', value: 'word' },
      {
        field: 'text',
        op: 'text_in_tokens',
        value: ['um', 'uh', 'er', 'ah', 'hmm', 'like', 'so', 'actually', 'basically', 'literally', 'you know', 'i mean', 'kind of', 'sort of'],
      },
    ],
    emit: {
      op: 'remove-span',
      label: 'Remove filler word',
      span: { start_from: 'start', end_from: 'end' },
      bindings: [{ param: 'start', from: 'start' }, { param: 'end', from: 'end' }],
    },
  },
  {
    name: 'remove-silences',
    label: 'Remove long silences',
    select: [
      { field: 'kind', op: 'eq', value: 'gap' },
      { field: 'duration', op: 'gt', value: 0.6 },
    ],
    emit: {
      op: 'remove-span',
      label: 'Remove silence',
      bindings: [{ param: 'start', from: 'start' }, { param: 'end', from: 'end' }],
    },
  },
  {
    name: 'assemble-search-hits',
    label: 'Add search results to timeline',
    select: [{ field: 'score', op: 'gte', value: 0.5 }],
    emit: {
      op: 'add-source',
      label: 'Add from search',
      params: { lane_role: 'b-roll' },
      bindings: [{ param: 'in_point', from: 'in_point' }, { param: 'out_point', from: 'out_point' }],
    },
    limit: 20,
  },
];

/** The full DATA bundle the surface consumes. */
export interface EditCapabilities {
  ops: EditOpSchemaMap;
  modalities: readonly EditModalityDescriptor[];
  rulesets: readonly EditRulesetDescriptor[];
}

/** The default capabilities = the source mirrors of the admitted rows. */
export const DEFAULT_EDIT_CAPABILITIES: EditCapabilities = {
  ops: DEFAULT_EDIT_OP_SCHEMAS,
  modalities: EDIT_MODALITIES,
  rulesets: EDIT_RULESETS,
};

// ---------------------------------------------------------------------------
// GENERIC PARAM RESOLUTION (op-name-blind — the deletion-test seam)
// ---------------------------------------------------------------------------

/**
 * A param source is the current editor state keyed by the SAME snake_case param
 * names ops declare (`clip_id`, `at_time`, `in_point`, `lane_role`, ...). Keys
 * whose value is `undefined` count as "not available".
 */
export type EditParamSource = Record<string, unknown>;

/**
 * Pick the parameters an op declares that are present (non-undefined) in the
 * param source. Never names a param — walks the descriptor's DATA. The result
 * is passed straight to `authorEditDecision`, which re-validates required keys.
 */
export function resolveOpParams(
  descriptor: EditOpDescriptor,
  source: EditParamSource,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const param of descriptor.params) {
    const value = source[param.name];
    if (value !== undefined) params[param.name] = value;
  }
  return params;
}

/** True when every REQUIRED param the op declares is available in the source. */
export function opIsActionable(descriptor: EditOpDescriptor, source: EditParamSource): boolean {
  return descriptor.params.every((param) => !param.required || source[param.name] !== undefined);
}

/**
 * The ops a surface can offer RIGHT NOW: every op whose required params are all
 * satisfiable from the current editor state. Optionally restrict to a modality's
 * `offered_ops` allow-list (also DATA). Zero op names appear here — add a
 * `contract::edit-op` row and it flows through automatically (deletion test).
 */
export function actionableOps(
  ops: EditOpSchemaMap,
  source: EditParamSource,
  offeredOps?: readonly string[],
): EditOpDescriptor[] {
  const allow = offeredOps ? new Set(offeredOps) : null;
  return Object.entries(ops)
    .filter(([name]) => !allow || allow.has(name))
    .map(([, descriptor]) => descriptor)
    .filter((descriptor) => opIsActionable(descriptor, source));
}
