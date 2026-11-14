// PORTED FROM: bitfield-packages/packages/chat/do-work/cancel-in-flight-capability.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';
import type { CapabilityRef } from '../read-data/read-chat-work-actions';
import type { InFlightCapabilityDispatch } from './execute-chat-work-requests';

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Generic cancellation is another current Workflow capability.  The original
 * action only declares its exact triple; this helper JIT-hydrates it before
 * dispatch, so a stale string or an action-id lookalike can never cancel work.
 */
export async function cancelInFlightCapability(input: {
  inFlight: InFlightCapabilityDispatch | null;
}): Promise<'cancelled-before-dispatch' | 'cancellation-requested' | 'still-running'> {
  const active = input.inFlight;
  if (!active || active.state === 'pre-dispatch') return 'cancelled-before-dispatch';
  if (active.state !== 'dispatched' || !active.action.cancellationCapabilityRef) return 'still-running';
  const cancelRef = active.action.cancellationCapabilityRef;
  const hydration = await sendRequestToBitfieldTarget({ target: 'slot::workflow', payload: {
    operation: 'owner_slot_hydration_status', expected_records: [{ address: cancelRef.canonicalAddress, expected_payload_hash: cancelRef.payloadHash }],
  } });
  const row = object(hydration) && object(hydration.output) ? hydration.output : hydration;
  const hydrated = object(row) && row.status === 'ok' && Array.isArray(row.hydrated) && row.hydrated.length === 1 && object(row.hydrated[0]) ? row.hydrated[0] : null;
  if (!hydrated || hydrated.address !== cancelRef.canonicalAddress || hydrated.payload_hash !== cancelRef.payloadHash || typeof hydrated.definition_id !== 'string') return 'still-running';
  await sendRequestToBitfieldTarget({ target: 'slot::workflow', payload: {
    operation: 'execute_definition', definition_id: hydrated.definition_id, include_steps: true, include_output: true,
    input: { correlation_id: active.attemptId, target_capability_ref: active.request.capabilityRef },
  } });
  return 'cancellation-requested';
}
