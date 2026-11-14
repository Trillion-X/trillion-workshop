//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Reads the three live records the Guardrails surface needs — the trading rule,
// the agent's latest cycle, and the latest order check — and hands them to the
// pure decoder to produce the human surface.
//
// The reads go through `useBitfieldData`, the canonical in-browser live-read
// path that all trading surfaces share. Each input is declared as a
// `bitfield-input-descriptor` in things-to-store-and-run.json and bound to a
// hash-readable address (the in-browser read scope resolves labels by hash, so
// the raw identity-text fact addresses are read through hash bridges instead).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ONE READ PATH. The surface reads live data only through `useBitfieldData`
//    + input descriptors — the same mechanism every other trading surface uses.
//    No bespoke engine fetch, no identity-text read that the browser scope
//    cannot resolve.
// 2. HONEST ON ABSENCE. A missing input resolves to the pessimistic surface
//    (paper / blocked), with `recordsMissing` true — never an invented state.
// 3. PURE DECODE. All translation lives in `live-guardrails-surface.ts`; this
//    file only wires the live inputs into it.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  buildLiveGuardrailsSurface,
  type LiveGuardrailsSurface,
} from './live-guardrails-surface.ts';

/**
 * Input names the surface reads. Each is declared as a `bitfield-input-descriptor`
 * in things-to-store-and-run.json, bound to a hash-readable label (the in-browser
 * read scope resolves labels by hash, so identity-text facts are read through
 * derived records this package declares as `record_from_matching_records` rows,
 * recomputed by the runtime whenever their source changes, never copied by hand):
 *   rule   -> the live lease, via `permission-lease:rule.live`, derived from the
 *             `permission_lease` record whose `lease_ref` is the default lease
 *   cycle  -> the agent's cycle, via `permission-lease:agent-cycle.live`, derived
 *             from the `attribute_fact` row `agent:trading-momentum` / `last_cycle`
 *   check  -> the latest order check, via `permission-lease:last-check.live`, derived
 *             from the `attribute_fact` row `agent:trading-momentum` / `last_check`
 *             (absent until the agent performs a checked order, so "No check yet")
 *   fields -> the visual-database FIELD DESCRIPTORS for the guardrail dimensions,
 *             via `permission-lease:guardrails.fields`, a `record` row in this
 *             package's manifest. WHICH guardrails render + their labels/types are
 *             these descriptors.
 *   views  -> the visual-database VIEW, via `permission-lease:guardrails.views`,
 *             also a manifest `record` row.
 * Each derived row is a JSON array of matching payloads; the input descriptor's
 * `projection` selects element 0, so the decoder sees one payload, not a list.
 */
export const GUARDRAILS_INPUTS = {
  rule: 'permission-rule',
  cycle: 'permission-agent-cycle',
  check: 'permission-last-check',
  fields: 'guardrails-fields',
  views: 'guardrails-views',
} as const;

export interface LiveGuardrailsState {
  surface: LiveGuardrailsSurface;
  loading: boolean;
  /** Raw visual-database field descriptors (DATA) for the guardrail dimensions. */
  fieldsData: unknown;
  /** Raw visual-database view descriptor (DATA). */
  viewsData: unknown;
}

/**
 * Live hook: reads the guardrails inputs and decodes them into the human surface.
 * `useBitfieldData` keeps each input live, so the surface tracks the agent's
 * current posture as it cycles. The field/view descriptor DATA is returned raw
 * for the panel to feed `decodeVisualDatabaseModel` — the panel owns the record-
 * board model construction (it pairs the descriptors with the projected lease
 * record).
 */
export function useLiveGuardrails(): LiveGuardrailsState {
  const rule = useBitfieldData(GUARDRAILS_INPUTS.rule);
  const cycle = useBitfieldData(GUARDRAILS_INPUTS.cycle);
  const latestCheck = useBitfieldData(GUARDRAILS_INPUTS.check);
  const fieldsData = useBitfieldData(GUARDRAILS_INPUTS.fields);
  const viewsData = useBitfieldData(GUARDRAILS_INPUTS.views);

  const surface = React.useMemo(
    () => buildLiveGuardrailsSurface({ rule, cycle, latestCheck }),
    [rule, cycle, latestCheck],
  );

  // The rule (lease) is the package's own seeded data; once the read scope is
  // ready it resolves immediately. We are "loading" only until the very first
  // resolution of the rule input.
  const loading = rule === undefined;

  return { surface, loading, fieldsData, viewsData };
}
