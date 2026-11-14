// packages/funnel-offer-graph/do-work/create-funnel.ts
//
// =============================================================================
// PURPOSE — the "make a funnel" authoring seam (pure builders, NO React, NO I/O)
// =============================================================================
//
// A funnel is a `funnel-definition` DATA record (the stage_address primitive, see
// read-data/funnel-definition.ts). This module builds the DATA for the two
// authoring gestures a user makes from the Funnels surface:
//
//   1. CREATE  — author a brand-new, HONESTLY EMPTY funnel-definition (a title +
//                an empty `stages` array the user then fills). No fake/demo
//                stages, no invented numbers (L117) — an empty funnel a real user
//                just made is an honest artifact, not sample content.
//   2. ADD STEP — append ONE stage row to an existing funnel-definition. Each
//                stage is title-only here (the schema's `title?` lets a stage
//                self-name without a workflow node); wiring the stage to a
//                workflow node / offer / measure is a later, purely-DATA edit
//                (add a `$ref` field to the same row — zero surface-code change,
//                Generic/Data-Driven Gate). A new step = ONE appended row.
//
// Both gestures produce the SAME write: the whole funnel-definition record
// upserted to its own name-stable published-record address. The scoped feed
// `funnel::funnel-definition-list` (things-to-store-and-run.json) matches
// `kind:"funnel-definition"` at path `current-item/published-record`, so a
// funnel authored here appears in the surface the instant it is written (live
// runtime — no refresh).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. Pure + total. Same input → same output. No clock, no I/O, no globals, no
//    randomness inside — entropy for unique ids is INJECTED by the caller so the
//    functions stay deterministic and unit-testable.
// 2. Zero domain literals: no offer, price, outcome token, or funnel type is
//    named. The only literals are the package's own address namespace + the
//    `funnel-definition` kind (this package's one owned schema).
// 3. Additive-only write shape: a scoped `write-batch` of ONE record to ONE
//    name-stable address (L121/L128) — never a whole-segment rebuild.
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { FunnelDefinition, FunnelStageSpec } from '../read-data/funnel-definition';

/** This package's own address namespace for its authored funnel-definition rows. */
const FUNNEL_DEFINITION_ADDRESS_PREFIX = 'package::funnel-offer-graph::published-record::funnel-definition';

/** The one write target + operation used for every additive live write here. */
const LABEL_ADDRESSED_TARGET = 'engine.operation.label-addressed';
const WRITE_BATCH_OPERATION = 'engine.operation.write-batch';

// ---------------------------------------------------------------------------
// SLUG — a stable, url-safe identity fragment derived from human text
// ---------------------------------------------------------------------------

/**
 * Lowercase, hyphenate, strip to `[a-z0-9-]`. Pure. Empty/blank text yields ''
 * so callers can fall back to injected entropy for the id. NOT a domain parse —
 * a generic text→identity normalizer.
 */
export function slugify(text: string): string {
  return (typeof text === 'string' ? text : '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The identity fragment of a `funnel:<slug>` id (the tail after the last `:`). */
export function funnelSlug(funnelId: string): string {
  const parts = (typeof funnelId === 'string' ? funnelId : '').split(':');
  return parts[parts.length - 1] || (typeof funnelId === 'string' ? funnelId : '');
}

/** The name-stable published-record address a funnel-definition is written to. */
export function funnelDefinitionAddress(funnelId: string): string {
  return `${FUNNEL_DEFINITION_ADDRESS_PREFIX}::${funnelSlug(funnelId)}`;
}

// ---------------------------------------------------------------------------
// CREATE — a brand-new, honestly-empty funnel-definition
// ---------------------------------------------------------------------------

/**
 * Author a new funnel-definition from a human title. `idEntropy` is a short,
 * caller-supplied unique fragment (e.g. a base36 timestamp) appended to the
 * title slug so two funnels with the same title get distinct, stable ids —
 * injected (not generated here) to keep this pure. When the title has no
 * slug-able characters, the id falls back to the entropy alone.
 *
 * The result is HONEST and EMPTY: a real, user-created funnel with zero stages
 * (never seeded with demo/sample stages — L117). The user adds steps next.
 */
export function buildNewFunnelDefinition(title: string, idEntropy: string): FunnelDefinition {
  const trimmed = (typeof title === 'string' ? title.trim() : '');
  const base = slugify(trimmed);
  const entropy = slugify(idEntropy) || 'funnel';
  const id = `funnel:${base ? `${base}-${entropy}` : entropy}`;
  return {
    kind: 'funnel-definition',
    id,
    ...(trimmed ? { title: trimmed } : {}),
    stages: [],
  };
}

// ---------------------------------------------------------------------------
// ADD STEP — append ONE stage row to an existing funnel-definition
// ---------------------------------------------------------------------------

/**
 * Return a NEW funnel-definition with one title-only stage appended. The stage
 * gets a deterministic, collision-free `stage_address` derived from the funnel's
 * slug and the next free ordinal (existing addresses are respected so re-adds
 * never collide). Pure: the input def is not mutated. Wiring this stage to a
 * workflow node / offer / measure later is a DATA edit (add a `$ref` to this
 * same row) — no code change here.
 */
export function appendStage(def: FunnelDefinition, stageTitle: string): FunnelDefinition {
  const slug = funnelSlug(def.id);
  const title = (typeof stageTitle === 'string' ? stageTitle.trim() : '');
  const existing = new Set((def.stages ?? []).map((s) => s.stage_address));
  let ordinal = (def.stages?.length ?? 0) + 1;
  let stageAddress = `stage:${slug}:s${ordinal}`;
  while (existing.has(stageAddress)) {
    ordinal += 1;
    stageAddress = `stage:${slug}:s${ordinal}`;
  }
  const stage: FunnelStageSpec = {
    stage_address: stageAddress,
    ...(title ? { title } : {}),
  };
  return { ...def, stages: [...(def.stages ?? []), stage] };
}

// ---------------------------------------------------------------------------
// WRITE — the additive live write of a whole funnel-definition record
// ---------------------------------------------------------------------------

export interface FunnelDefinitionWriteRequest {
  target: string;
  payload: {
    operation_label: string;
    writes: Array<{
      address_label: string;
      address_mode: 'identity_text';
      path_labels: string[];
      payload: FunnelDefinition;
    }>;
  };
}

/**
 * Build the additive `write-batch` request that upserts a funnel-definition to
 * its name-stable published-record address at `current-item/published-record`
 * (the path the `funnel::funnel-definition-list` scoped feed reads). Used for
 * BOTH create (empty stages) and add-step (stages appended) — the same whole-
 * record upsert, never a partial patch, never a segment rebuild (L121/L128).
 */
export function buildFunnelDefinitionWrite(def: FunnelDefinition): FunnelDefinitionWriteRequest {
  return {
    target: LABEL_ADDRESSED_TARGET,
    payload: {
      operation_label: WRITE_BATCH_OPERATION,
      writes: [
        {
          address_label: funnelDefinitionAddress(def.id),
          address_mode: 'identity_text',
          path_labels: ['current-item', 'published-record'],
          payload: def,
        },
      ],
    },
  };
}
