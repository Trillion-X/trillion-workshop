import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { readAccountGrantedAccessProjection } from './read-account-granted-access-refs';
import { sessionAuthorityState } from '../read-data/session-authority-state';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decode(reply: unknown): Record<string, unknown> {
  let value = record(reply) && 'payload' in reply ? reply.payload : reply;
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > 65536) throw new Error('Session response is too large.');
    value = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (typeof value === 'string') {
    if (value.length > 65536) throw new Error('Session response is too large.');
    value = JSON.parse(value);
  }
  if (!record(value)) throw new Error('Session could not be read.');
  return value;
}

/** Resolve a browser session through its owner before reading that account's access.
 * This read accepts no asserted principal, object owner operation or caller clock. A session's end is its pass's own
 * expiry, refused where the pass is verified (read-data/session-authority-state.ts), so no time is read here.
 */
export async function readSessionAccessTarget(input: unknown): Promise<{
  authenticated: boolean; granted_access_refs: string[]; membership_revision?: string;
}> {
  if (!record(input) || Object.keys(input).some(key => key !== 'browser_id')
    || typeof input.browser_id !== 'string' || !input.browser_id.trim() || input.browser_id.length > 4096) {
    throw new Error('A browser session is required.');
  }
  const root = decode(await sendRequestToBitfieldTarget({ target: 'account-session.browser-session', payload: { browser_id: input.browser_id } }));
  if (root.session === null) return { authenticated: false, granted_access_refs: [] };
  const session = sessionAuthorityState(root.session);
  if (!session.active) return { authenticated: false, granted_access_refs: [] };
  return { authenticated: true, ...await readAccountGrantedAccessProjection(session.subject) };
}
