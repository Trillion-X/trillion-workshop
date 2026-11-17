import { readTrustedRuntimeClockMs, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { createEngineAtomicOperationWorkStore } from '../../../../operation-records/read-data/operation-work-store';
import { observeSavedWorkResult } from './observe-saved-work-result';

export async function observeSavedWorkResultTarget(input: unknown, context?: BitfieldRuntimeContext) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['binding_ref', 'permission_lease_ref', 'saved_delivery'].includes(key))
    || ('binding_ref' in input) === ('permission_lease_ref' in input)
    || ('binding_ref' in input ? typeof input.binding_ref !== 'string' : typeof input.permission_lease_ref !== 'string')) {
    throw new Error('Choose the saved-result learning binding or its existing permission.');
  }
  return observeSavedWorkResult('binding_ref' in input ? input.binding_ref as string : { permission_lease_ref: input.permission_lease_ref as string }, createEngineAtomicOperationWorkStore(context),
    'saved_delivery' in input ? input.saved_delivery : undefined,
    new Date(readTrustedRuntimeClockMs(context)).toISOString());
}
export const mount = observeSavedWorkResultTarget;
