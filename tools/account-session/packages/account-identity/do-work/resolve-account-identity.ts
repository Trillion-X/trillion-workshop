import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { ACCOUNT_IDENTITY_MATERIALIZATION_SPEC, deriveAccountIdentity } from './derive-account-identity';
import { materializeRoleAddressedRecords, readMaterializedRoleValue } from '../../../../shared-code/packages/account-identity/read-data/account-identity-materialization';

export const ACCOUNT_BINDING_SCHEMA = 'account-identity.established-subject-binding';
export function accountBindingAddress(inputIdentity: string) {
  return `package::account-identity::established-subject::${inputIdentity}`;
}

function readAccountBindingReply(payload: Uint8Array) {
  const text = new TextDecoder().decode(payload);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    // A failed label-addressed request can arrive as a plain-text target error
    // (for example, the public-entry proxy's 502 body). Keep that actual owner
    // response visible in the target failure instead of replacing it with the
    // unhelpful JSON parser token and byte excerpt.
    const excerpt = text.trim().replace(/\s+/g, ' ').slice(0, 240);
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Account identity binding read returned a non-JSON target reply${excerpt ? `: ${excerpt}` : ''} (${detail}).`,
      { cause },
    );
  }
}

function isTemporaryBindingReadFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('public entry unavailable')
    || message.includes('The effect source is unavailable.');
}

async function readAccountBinding(addressLabel: string, sender: typeof sendRequestToBitfieldTarget) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = await sender({ target: 'engine.operation.label-addressed', payload: {
        operation_label: 'engine.operation.read-current', address_label: addressLabel,
      } });
      return readAccountBindingReply(reply.payload);
    } catch (error) {
      if (attempt === 2 || !isTemporaryBindingReadFailure(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw new Error('Account identity binding read did not complete.');
}

/** Resolve only owner-published bindings. Caller input cannot override a subject.
 * The opaque established subject is retained; new proof/revision hashes use the
 * crypto owner. Signed events and inbound account references need no rewrite.
 */
export async function resolveAccountIdentity(input: unknown, _context: unknown = undefined, sender = sendRequestToBitfieldTarget) {
  const derived = deriveAccountIdentity(input);
  // Custom role materializations are not the account namespace.
  if (input && typeof input === 'object' && 'materialization_spec' in input) return derived;
  const inputIdentity = readMaterializedRoleValue(derived, 'identity.proof.email');
  const result = await readAccountBinding(accountBindingAddress(inputIdentity), sender);
  if (result.found === false) return derived;
  const binding = result.payload;
  if (result.found !== true || binding?.kind !== ACCOUNT_BINDING_SCHEMA
      || binding.input_identity !== inputIdentity
      || typeof binding.subject !== 'string' || !/^bitfield-account-[0-9a-f]{64}$/.test(binding.subject)
      || typeof binding.source_ref !== 'string' || !binding.source_ref.trim()) {
    throw new Error('Established account identity binding is invalid; refusing a new subject.');
  }
  return materializeRoleAddressedRecords(ACCOUNT_IDENTITY_MATERIALIZATION_SPEC,
    { email: readMaterializedRoleValue(derived, 'identity.input.normalized') },
    new Map([['identity.subject', binding.subject]]));
}
