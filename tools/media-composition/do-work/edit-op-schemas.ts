// packages/media-composition/do-work/edit-op-schemas.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The op-schema DATA for the media-composition edit-decision authoring layer.
//
// An "edit" is a self-describing decision row over a frame-addressed timeline
// (see write-media-composition-record.ts `buildMediaCompositionEditDecisionRecord`).
// EVERY editing modality — a drag-handle trim, a type-to-cut on a transcript,
// a search-to-assemble append, an AI "fix my video" pass, a caption attach —
// is merely a different AUTHOR that emits the SAME decision rows into the SAME
// append-only fold. The reducer (`read-data/compose-timeline.ts`) folds those
// rows through its `FOLD_ACTIONS` capability map; unknown actions are a no-op.
//
// This module holds the OTHER half of that self-describing contract: the DATA
// that says, for each op name, what its human label is and what parameters it
// carries. It is the SSOT the generic `authorEditDecision` validates against.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. NO NAMED-PER-OP FUNCTIONS, NO CLOSED DISCRIMINATED UNION. Adding a new
//    editing operation (transcript-cut, search-append, set-keyframe,
//    attach-caption, mirror, chapter-insert, ...) is a NEW DATA ROW in a schema
//    map — never a new exported builder function and never a new union arm.
//    This is `1000x-enum-dissolution.md` applied to the authoring layer:
//    the discriminant lives in DATA; the author dispatches through an injected
//    capability map.
// 2. SCHEMAS ARE INJECTABLE. `authorEditDecision` accepts an optional `schemas`
//    map so a new modality (or a package that reuses this author) supplies /
//    extends ops as DATA without editing this file. `DEFAULT_EDIT_OP_SCHEMAS`
//    is the source mirror of the package's own `contract::edit-op` DATA rows in
//    `things-to-store-and-run.json` (the runtime SSOT). It is a DEFAULT, not a
//    closed core registry.
// 3. PARAMETER KEYS ARE SNAKE_CASE. They land verbatim as the record's
//    `parameters` object, matching the log-record convention used by the
//    reducer (`params.clip_id`, `params.at_time`, `params.in_point`, ...).
// 4. PURE DATA + PURE VALIDATION. No React, no Date.now(), no I/O.
//
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/** The value kinds a decision parameter may carry. Physics, not Society —
 *  these are structural JSON shapes, closed by Physics (not user-extensible). */
export type EditOpParamKind =
  | 'clip_id'
  | 'time'
  | 'number'
  | 'string'
  | 'boolean'
  | 'object';

/** One parameter a decision op carries into its record's `parameters` map. */
export interface EditOpParamDescriptor {
  /** snake_case key written verbatim into `parameters`. */
  name: string;
  /** structural shape used for validation only. */
  kind: EditOpParamKind;
  /** when true, `authorEditDecision` rejects if the key is missing/undefined. */
  required?: boolean;
}

/** Self-describing descriptor for a single editing operation. */
export interface EditOpDescriptor {
  /** stable action string the reducer's FOLD_ACTIONS folds on. */
  action: string;
  /** human-facing label (translation boundary — never leaks `edl`/`decision`). */
  label: string;
  /** the parameters this op accepts, in DATA form. */
  params: readonly EditOpParamDescriptor[];
}

/** A capability map: op name -> descriptor. Injected into the author. */
export type EditOpSchemaMap = Readonly<Record<string, EditOpDescriptor>>;

// ---------------------------------------------------------------------------
// DEFAULT SCHEMAS (source mirror of the `contract::edit-op` DATA rows)
// ---------------------------------------------------------------------------
//
// These reproduce, one-for-one, the five operations the timeline UI authored
// via the (now dissolved) named builders — plus they are the seed the emergent
// modalities extend as DATA:
//   - transcript-cut   -> emits 'trim'/'delete' over a word's [start,end]
//   - search-append    -> emits 'move' of a found source onto a lane
//   - set-keyframe     -> a future 'set-keyframe' DATA row (property-agnostic)
//   - attach-caption   -> a future 'attach-caption' DATA row
// None of those require a new function here — only a new descriptor row.
//
export const DEFAULT_EDIT_OP_SCHEMAS: EditOpSchemaMap = {
  split: {
    action: 'split',
    label: 'Split',
    params: [
      { name: 'clip_id', kind: 'clip_id', required: true },
      { name: 'at_time', kind: 'time', required: true },
    ],
  },
  trim: {
    action: 'trim',
    label: 'Trim',
    params: [
      { name: 'clip_id', kind: 'clip_id', required: true },
      { name: 'in_point', kind: 'time', required: true },
      { name: 'out_point', kind: 'time', required: true },
    ],
  },
  move: {
    action: 'move',
    label: 'Move',
    params: [
      { name: 'clip_id', kind: 'clip_id', required: true },
      { name: 'lane_start', kind: 'time', required: true },
      { name: 'lane_role', kind: 'string', required: true },
    ],
  },
  delete: {
    action: 'delete',
    label: 'Delete',
    params: [{ name: 'clip_id', kind: 'clip_id', required: true }],
  },
  'set-transform': {
    action: 'set-transform',
    label: 'Set transform',
    params: [
      { name: 'clip_id', kind: 'clip_id', required: true },
      { name: 'transform', kind: 'object', required: true },
    ],
  },
  // Appends a source (or a search hit) as a new clip on a lane. The
  // search-assembly modality emits this per find-similar hit.
  'add-source': {
    action: 'add-source',
    label: 'Add source',
    params: [
      { name: 'lane_role', kind: 'string', required: false },
      { name: 'in_point', kind: 'time', required: false },
      { name: 'out_point', kind: 'time', required: false },
    ],
  },
  'editor.layers.adjustment': {
    action: 'editor.layers.adjustment',
    label: 'Add adjustment layer',
    params: [
      { name: 'start', kind: 'time', required: true },
      { name: 'end', kind: 'time', required: true },
      { name: 'grade', kind: 'string', required: true },
    ],
  },
  'editor.captions.position': {
    action: 'editor.captions.position',
    label: 'Position caption',
    params: [
      { name: 'caption_id', kind: 'string', required: true },
      { name: 'x', kind: 'number', required: true },
      { name: 'y', kind: 'number', required: true },
    ],
  },
  // Commits the inspector params as the global transform.
  'save-edit': {
    action: 'save-edit',
    label: 'Save edit',
    params: [],
  },
  // Cuts a time RANGE out of whatever clip covers it on a lane and ripples the
  // rest left. This is the atomic unit of TRANSCRIPT editing: removing a filler
  // word or shortening a silent gap is a remove-span over that word/gap's
  // [start,end]. clip_id is optional — the fold locates the covering clip by
  // time when omitted (transcript words are addressed by time, not clip id).
  'remove-span': {
    action: 'remove-span',
    label: 'Remove range',
    params: [
      { name: 'start', kind: 'time', required: true },
      { name: 'end', kind: 'time', required: true },
      { name: 'lane_role', kind: 'string', required: false },
      { name: 'clip_id', kind: 'clip_id', required: false },
    ],
  },
};

// ---------------------------------------------------------------------------
// VALIDATION (structural, capability-map-driven — no per-op branch)
// ---------------------------------------------------------------------------

function paramKindMatches(kind: EditOpParamKind, value: unknown): boolean {
  switch (kind) {
    case 'clip_id':
    case 'string':
      return typeof value === 'string';
    case 'time':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null;
    default:
      return false;
  }
}

/** Thrown when an op name is unknown or its parameters violate the schema. */
export class EditOpValidationError extends Error {}

/**
 * Validate `parameters` for `action` against `schemas`. Returns the descriptor
 * on success; throws `EditOpValidationError` otherwise. Generic — it never
 * names an operation; it walks the descriptor's `params` DATA.
 */
export function validateEditOp(
  action: string,
  parameters: Record<string, unknown>,
  schemas: EditOpSchemaMap = DEFAULT_EDIT_OP_SCHEMAS,
): EditOpDescriptor {
  const descriptor = schemas[action];
  if (!descriptor) {
    throw new EditOpValidationError(
      `Unknown edit operation "${action}". Add a contract::edit-op DATA row (do not add a builder function).`,
    );
  }
  for (const param of descriptor.params) {
    const present = Object.prototype.hasOwnProperty.call(parameters, param.name)
      && parameters[param.name] !== undefined;
    if (!present) {
      if (param.required) {
        throw new EditOpValidationError(
          `Edit operation "${action}" is missing required parameter "${param.name}".`,
        );
      }
      continue;
    }
    if (!paramKindMatches(param.kind, parameters[param.name])) {
      throw new EditOpValidationError(
        `Edit operation "${action}" parameter "${param.name}" must be a ${param.kind}.`,
      );
    }
  }
  return descriptor;
}
