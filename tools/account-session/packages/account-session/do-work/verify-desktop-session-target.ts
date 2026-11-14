import { readTrustedRuntimeClockMs, sendRequestToBitfieldTarget, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';
import { currentLogSessionAuthorityAddress } from './current-log-browser-session';
import { readAccountPortalSessionToken, sessionCookieName } from '../read-data/session-token';
import { authorizeTransientSessionTarget } from './authorize-transient-session-target';
import { readHostedAccountAuthority } from './hosted-account-authority';

/** Hosted introspection accepts the bearer cookie, never a browser/account ID. */
export async function verifyDesktopSessionTarget(input: unknown, context?: BitfieldRuntimeContext) {
  if (await readHostedAccountAuthority()) throw new Error('This app does not issue hosted account sessions.');
  const row = input as Record<string, unknown>;
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => key !== 'token')
    || typeof row.token !== 'string' || !row.token || row.token.length > 16384 || /[;\r\n]/.test(row.token)) return { authorized: false };
  const authorized = await authorizeTransientSessionTarget({ cookie_header: `${sessionCookieName()}=${row.token}` }, context);
  if (!authorized.authorized) return { authorized: false };
  const session = await readAccountPortalSessionToken(row.token, readTrustedRuntimeClockMs(context));
  if (!session || authorized.principal_ref !== session.accountId || authorized.session_ref !== `account-session:${session.sessionId}`
    || authorized.session_revision !== session.sessionRevision || authorized.expires_at_milliseconds !== session.expiresAt * 1000) return { authorized: false };
  return { authorized: true, session };
}

export async function revokeDesktopSessionTarget(input: unknown, context?: BitfieldRuntimeContext) {
  const verified = await verifyDesktopSessionTarget(input, context);
  if (!verified.authorized || !verified.session) return { revoked: true };
  const session = verified.session;
  const label = currentLogSessionAuthorityAddress(`account-session:${session.sessionId}`);
  const read = JSON.parse(new TextDecoder().decode((await sendRequestToBitfieldTarget({ target: 'engine.operation.label-addressed', payload: {
    operation_label: 'engine.operation.read-current', address_label: label,
  } })).payload));
  if (read.found !== true || !/^1f:[a-f0-9]{64}$/.test(read.content_hash ?? '')
    || read.payload?.actor_ref !== session.accountId || read.payload?.session_revision !== session.sessionRevision) throw new Error('Session changed during sign-out.');
  const result = JSON.parse(new TextDecoder().decode((await sendRequestToBitfieldTarget({ target: 'engine.operation.label-addressed', payload: {
    operation_label: 'engine.operation.write-batch', writes: [{ address_label: label, path_labels: ['account-session', 'session-authority'],
      expected_current: { payload_hash_base64: Buffer.from(makeMultihashEncodedBytesFromCodeHex(read.content_hash)).toString('base64') },
      payload: { ...read.payload, state: 'revoked', session_revision: session.sessionRevision + 1 } }],
  } })).payload));
  if (result.write_count !== 1 && result.writeCount !== 1) throw new Error('Sign-out could not finish.');
  return { revoked: true };
}
