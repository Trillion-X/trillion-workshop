// package://packages/item-record/do-work/record-activity-effect.ts
//
// Fires one signed_event_effect for an activity this package's actions
// perform (post created, comment added, like given). The effect carries WHO
// (subject = actor ref), WHAT (kind ref) and WHEN (material.created_at);
// scoring weights and level thresholds are records the leaderboard view
// reads — never constants here (Physics vs Society).
//
// Effects are points-source facts only: failure to record one never blocks
// the user action that produced it, so callers fire-and-forget.

const RECORD_EFFECT_ACTION = 'action:signed-event-effects.record-signed-event-effect';

export interface ActivityEffectRequest {
  /** Unique id for this effect (reuse the action's event ref). */
  eventRef: string;
  /** What happened — e.g. 'post_created', 'comment_added', 'like_given'. */
  kind: string;
  /** Who did it. */
  actorRef: string;
  /** What it happened to (item ref, group ref, ...). */
  targetRef: string;
  /** When it happened (ISO timestamp). */
  createdAt: string;
}

export async function recordActivityEffect(request: ActivityEffectRequest): Promise<{ target: string; payload: unknown }> {
  // Observability: [signed-events] effect actor=<a> kind=<k>
  console.log(`[signed-events] effect actor=${request.actorRef} kind=${request.kind}`);
  return {
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: RECORD_EFFECT_ACTION,
      include_steps: false,
      include_output: false,
      input: {
        effect_id: `activity:${request.eventRef}`,
        kind: request.kind,
        subject: request.actorRef,
        object: request.targetRef,
        source_event_ids: [request.eventRef],
        material: { created_at: request.createdAt },
        proof: {},
      },
    },
  };
}
