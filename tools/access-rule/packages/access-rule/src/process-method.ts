import type { AccessDecision, AccessDecisionRequest, EnvelopeDispatcher, RevisionVector } from './records';
import { evaluateAccessDecision } from './evaluate';

export function revisionsMatch(left: RevisionVector, right: RevisionVector): boolean {
  return left.session_revision === right.session_revision
    && left.policy_revision === right.policy_revision
    && left.membership_revision === right.membership_revision
    && left.resource_revision === right.resource_revision;
}

/** Reads and mutations call this same decision path with their current bases. */
export async function processAccessDecision(input: {
  dispatcher: EnvelopeDispatcher;
  expected_revisions: RevisionVector;
  now_unix_ms: number;
  request: AccessDecisionRequest;
}): Promise<AccessDecision> {
  const decision = await evaluateAccessDecision(input.request, input.dispatcher, input.now_unix_ms);
  if (!revisionsMatch(input.expected_revisions, decision.revisions)) {
    return { ...decision, decision: 'deny', deny_reason: 'stale-revision' };
  }
  return decision;
}
