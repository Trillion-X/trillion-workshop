// packages/ask-questions-sort-answers-follow-up/do-work/process-submission.ts
//
// The pipeline integration point: on submit, atomically persist the answers AND
// the decision (score + segment) in ONE engine write-batch, then return the
// per-segment follow-up sequence for the workflow slot to execute. One batch =
// answers and decision are recorded together (no half-state). Pure builder
// (testable) + thin I/O wrapper. Ties CAPTURE -> DECIDE -> ACT with zero new
// concepts — it composes the already-tested layers.

import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  buildAnswerFactWrites,
  ENGINE_OPERATION_LABEL_TARGET,
  ENGINE_WRITE_BATCH_OPERATION,
  type WriteEntry,
} from './answer-fact-writes';
import { buildSegmentAssignmentWrite } from './segment-assignment-writes';
import {
  decide,
  type DecideResult,
} from '../read-data/score-and-segment';
import {
  selectFollowUpSequence,
  type FollowUpSequence,
} from '../../../read-data/follow-up-sequences';
import type { DecideConfig } from '../../../read-data/read-decide-config';

export type { DecideConfig };

export interface ProcessSubmissionPlan {
  request: {
    target: string;
    payload: { operation_label: string; writes: WriteEntry[] };
  };
  decision: DecideResult;
  followUp: FollowUpSequence | null;
}

/** Pure: build the atomic write-batch + the selected follow-up. No I/O. */
export function buildProcessSubmission(
  formId: string,
  respondentId: string,
  answers: Readonly<Record<string, unknown>>,
  config: DecideConfig,
  decidedAt: string,
  submissionId?: string,
): ProcessSubmissionPlan {
  const decision = decide(answers, config.scoreRules, config.segmentRules);
  const writes: WriteEntry[] = [
    ...buildAnswerFactWrites(formId, respondentId, answers, decidedAt, submissionId),
    buildSegmentAssignmentWrite(formId, respondentId, decision, decidedAt, submissionId),
  ];
  return {
    request: {
      target: ENGINE_OPERATION_LABEL_TARGET,
      payload: { operation_label: ENGINE_WRITE_BATCH_OPERATION, writes },
    },
    decision,
    followUp: selectFollowUpSequence(decision.segmentId, config.followUpSequences),
  };
}

export interface ProcessSubmissionOutcome extends ProcessSubmissionPlan {
  written: unknown;
}

/** Persist the batch, then hand back the decision + follow-up to run. */
export async function processSubmission(
  formId: string,
  respondentId: string,
  answers: Readonly<Record<string, unknown>>,
  config: DecideConfig,
  decidedAt: string = new Date().toISOString(),
  submissionId?: string,
): Promise<ProcessSubmissionOutcome> {
  const plan = buildProcessSubmission(formId, respondentId, answers, config, decidedAt, submissionId);
  const written = await sendRequestToBitfieldTarget(plan.request);
  return { ...plan, written };
}
