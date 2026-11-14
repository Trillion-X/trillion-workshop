import type { AccessDecisionRequest } from './records';

export function makeEvaluationFixture(): AccessDecisionRequest {
  return {
    kind: 'access-decision-request',
    correlation_id: 'correlation:test',
    subject_ref: 'subject:test',
    action_ref: 'action:test',
    authorized_action_refs: ['action:test'],
    constraints: {},
    predicate_ref: 'predicate:test',
    predicate_binding: { any: 'opaque formula binding' },
    context: { any: 'opaque evidence map' },
    ambient_actor: {
      actor_ref: 'actor:test',
      session_ref: 'session:test',
      session_revision: 'session:1',
    },
    revisions: {
      session_revision: 'session:1',
      policy_revision: 'policy:1',
      membership_revision: 'membership:1',
      resource_revision: 'resource:1',
    },
  };
}
