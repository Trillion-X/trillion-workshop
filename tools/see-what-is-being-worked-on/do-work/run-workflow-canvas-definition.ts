// packages/workflow-canvas/do-work/run-workflow-canvas-definition.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Build the owner request that runs one definition NOW and returns the real
// per-step results. The workflow owner's `execute_definition` reply carries
// `{status, duration_ms, output?, steps?{<step_id>: {status, error,
// duration_ms, output}}}` — the canvas renders that reply as the live run
// pulse and the plain-language run report. No invented run store: the reply
// IS the evidence for canvas-initiated runs.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. do-work builds request bytes and sends them to the owner — nothing else.
// 2. The reply is decoded tolerantly and never trusted blindly — missing or
//    malformed fields degrade to honest unknowns, never crashes.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records';

import { decodeWorkflowRunReply, type WorkflowRunResult } from '#workspace-records';
export { decodeWorkflowRunReply, type WorkflowRunResult, type WorkflowRunStepResult } from '#workspace-records';

/** Path kind for run receipts — `find-current-items in:` this kind. */
export const RUN_RECEIPT_KIND = 'workflow-canvas-run-receipt';

export async function runWorkflowCanvasDefinition(input: {
  definitionId: string;
  runInput?: Record<string, unknown>;
}): Promise<WorkflowRunResult> {
  // Each run asks the owner to write a completion receipt to a run-unique
  // address on the run-receipt path — that durable trail IS the "Past runs"
  // history (no invented run store; the owner's receipt is the evidence).
  const startedAt = Date.now();
  const reply = await sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: input.definitionId,
      include_steps: true,
      include_output: true,
      input: input.runInput ?? {},
      receipt: {
        address: `package::workflow-canvas::run-receipt::${input.definitionId}::${startedAt}`,
        path: ['current-item', RUN_RECEIPT_KIND],
        evidence: { definition_id: input.definitionId, started_at_ms: startedAt },
      },
    },
  });
  return decodeWorkflowRunReply(input.definitionId, reply);
}
