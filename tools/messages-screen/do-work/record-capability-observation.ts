// PORTED FROM: bitfield-packages/packages/chat/do-work/record-capability-observation.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';

const OBSERVABILITY_TARGET = 'slot::observability';
const OBSERVABILITY_OPERATION = 'record_observation_events';
const allowed = new Set(['event', 'address', 'revision', 'score_provenance_ref', 'reason_ref', 'live_revision', 'authority_ref', 'source', 'result_ref']);

/** Persist the four capability-round facts through the generic observability slot. */
export async function recordCapabilityObservation(input: {
  turnId: string; round: number; event: Record<string, unknown>;
}): Promise<void> {
  const eventName = typeof input.event.event === 'string' ? input.event.event : '';
  if (!['chat.capability_discovered', 'chat.action_admitted', 'chat.action_denied', 'chat.tool_result_prepared'].includes(eventName)) return;
  const context = Object.fromEntries(Object.entries(input.event).filter(([key, value]) => allowed.has(key) && key !== 'event' && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')));
  const address = typeof context.address === 'string' ? context.address : '';
  const id = `${input.turnId}:${input.round}:${eventName}:${address}:${typeof context.result_ref === 'string' ? context.result_ref : ''}`;
  await sendRequestToBitfieldTarget({ target: OBSERVABILITY_TARGET, payload: {
    operation: OBSERVABILITY_OPERATION,
    input: { source: 'chat.capability-round', events: [{ id, kind: eventName, context: { turn_id: input.turnId, round: input.round, correlation_id: input.turnId, ...context } }] },
  } });
}
