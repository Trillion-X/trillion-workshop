// packages/motion-analysis/do-work/request-match-perception.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The browser-side dispatch wrapper for the SwingVision capture→stats loop: it
// turns a staged clip + a perception TrackerDescriptor (DATA) into ONE Envelope
// dispatch of `action:run-match-perception-and-stats` — the composite workflow
// that chains perception → 5 measures → a `match-stat` record, all by Envelope
// `definition_id` (no god package: this module owns NO perception, NO measure,
// NO dashboard logic; it composes the proven actions).
//
// It is the composite analogue of `submit-motion-analysis.ts`'s
// `submitMotionAnalysisRequest` (which dispatches perception-only). The composite
// input is the SAME `{request_id, sources, lanes, options, requested_at}` that
// `buildMotionAnalysisInput` already produces from the TrackerDescriptor DATA —
// PLUS the `stat_id` / `stat_label` that the composite's `write_stat` step binds
// to address + label the emitted `match-stat` record. We REUSE
// `buildMotionAnalysisInput` verbatim so the `options.motion_command.process_-
// descriptor` (orchestrator path, model checkpoint, env) comes ONLY from the
// caller-supplied `tracker` DATA — this generic package names no tool, no model,
// and no machine path (Physics vs Society / L089: env is data, not a code
// branch). The capture surface reads the TrackerDescriptor from a DATA record and
// hands it here; it never hardcodes a python interpreter path, a vendored-model-
// root env var, or any orchestrator/checkpoint path — every such location is a
// value on the tracker DATA, asserted by the companion test.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { submitWorkflowAction } from '../../content-media-evidence/do-work/content-media-work-loop';
import {
  buildMotionAnalysisInput,
  type MotionAnalysisWorkflowInput,
  type SubmitMotionAnalysisRequest,
} from './submit-motion-analysis.ts';

/** The composite workflow that produces the instant stats: perception → measures
 *  → one `match-stat` record. Dispatched on Stop in the capture surface. */
const MATCH_PERCEPTION_ACTION_ID = 'action:run-match-perception-and-stats';

/** A capture→stats request: everything a perception request needs (the clip
 *  source + the perception `tracker` DATA), PLUS where the resulting `match-stat`
 *  record is addressed/labelled. `statId` becomes the record id (the dashboard
 *  reads `package::progression-evaluator::match-stat::<statId>`); `statLabel` is
 *  the human row label ("This match"). Both are DATA the caller chooses — the
 *  surface supplies a per-session id (e.g. the request id) and a neutral label. */
export type RequestMatchPerceptionRequest = SubmitMotionAnalysisRequest & {
  /** Record id for the emitted match-stat (the dashboard's projection key). */
  statId: string;
  /** Human label for the match-stat row (domain copy stays in the caller). */
  statLabel: string;
};

/** The composite workflow input: the perception input shape + the two stat
 *  binding fields the `write_stat` step reads. */
export type MatchPerceptionWorkflowInput = MotionAnalysisWorkflowInput & {
  stat_id: string;
  stat_label: string;
};

/** Build the composite input from a clip + tracker DATA + stat identity. Pure —
 *  no dispatch, no I/O, fully testable. The perception half is delegated to
 *  `buildMotionAnalysisInput` so the process descriptor stays DATA-derived; this
 *  function only appends the stat binding fields. */
export function buildMatchPerceptionInput(
  request: RequestMatchPerceptionRequest,
): MatchPerceptionWorkflowInput {
  const base = buildMotionAnalysisInput(request);
  return {
    ...base,
    stat_id: request.statId,
    stat_label: request.statLabel,
  };
}

/** Dispatch the capture→stats composite. Returns the built input (so the caller
 *  can correlate the resulting `match-stat` record by `stat_id` / `request_id`
 *  from the live record stream). The workflow response is awaited but not parsed
 *  here — the surface watches for the emitted `match-stat`, the canonical source
 *  of truth (SSOT), rather than the echoed step output. */
export async function requestMatchPerception(
  request: RequestMatchPerceptionRequest,
): Promise<MatchPerceptionWorkflowInput> {
  const input = buildMatchPerceptionInput(request);
  await submitWorkflowAction({
    definitionId: MATCH_PERCEPTION_ACTION_ID,
    input,
    // The composite echoes hundreds of per-frame writes on the response channel;
    // we never read them here (the record is the SSOT), so keep the response lean.
    includeSteps: false,
    includeOutput: false,
  });
  return input;
}
