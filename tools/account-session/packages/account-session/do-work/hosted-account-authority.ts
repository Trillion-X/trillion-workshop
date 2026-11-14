import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { safeAccountId } from '../read-data/safe-account-id';
import type { AccountPortalSessionV2 } from '../read-data/session-token';

type Sender = typeof sendRequestToBitfieldTarget;
type Row = Record<string, any>;
export const HOSTED_ACCOUNT_AUTHORITY_ADDRESS = 'package::account-session::hosted-authority';
export type HostedAccountAuthority = { kind: 'account-session-hosted-authority'; origin: string };

function json(payload: Uint8Array): Row {
  const result = JSON.parse(new TextDecoder().decode(payload));
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid sign-in service response.');
  return result;
}

/** Trust comes from installed package DATA plus HTTPS certificate validation, never request fields. */
export async function readHostedAccountAuthority(sender: Sender = sendRequestToBitfieldTarget): Promise<HostedAccountAuthority | null> {
  const reply = json((await sender({ target: 'engine.operation.label-addressed', payload: {
    operation_label: 'engine.operation.read-current', address_label: HOSTED_ACCOUNT_AUTHORITY_ADDRESS,
  } })).payload);
  if (reply.found === false) return null;
  const value = reply.payload;
  if (reply.found !== true || value?.kind !== 'account-session-hosted-authority'
    || Object.keys(value).some(key => !['kind', 'origin'].includes(key)) || typeof value.origin !== 'string') {
    throw new Error('Sign-in service is not configured correctly.');
  }
  const url = new URL(value.origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== value.origin
    || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || /^\[|^[\d.]+$/.test(url.hostname)) {
    throw new Error('Sign-in service origin is not allowed.');
  }
  return { kind: 'account-session-hosted-authority', origin: url.origin };
}

const targets = {
  request: 'account-session.login-link',
  redeem: 'account-session.redeem-desktop-login',
  verify: 'account-session.verify-desktop-session',
  revoke: 'account-session.revoke-desktop-session',
  revision: 'account-session.verify-session-revision',
} as const;
export async function callHostedAccountAuthority(config: HostedAccountAuthority, operation: keyof typeof targets, input: Row, sender: Sender = sendRequestToBitfieldTarget): Promise<Row> {
  const target = targets[operation];
  const reply = json((await sender({ target: 'slot::http-client', payload: {
    url: `${config.origin}/target/${encodeURIComponent(target)}`, method: 'POST', authorization: null, credential_injections: [],
    headers: { 'content-type': 'application/json' }, body: Array.from(new TextEncoder().encode(JSON.stringify(input))), timeout_ms: 15000,
  } })).payload);
  // http-client's declared transport uses redirect:'manual'. A 3xx is always
  // refused here; verifier/token bodies must never be replayed at another origin.
  if (reply.status_code !== 200) throw new Error('Sign-in service rejected the request.');
  if (typeof reply.body === 'string') return json(new TextEncoder().encode(reply.body));
  if (Array.isArray(reply.body) && reply.body.every((v: unknown) => Number.isInteger(v) && Number(v) >= 0 && Number(v) <= 255)) return json(Uint8Array.from(reply.body));
  throw new Error('Invalid sign-in service response.');
}

export function readVerifiedHostedSession(value: unknown, nowMs: number): AccountPortalSessionV2 | null {
  const row = value as Row;
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.version !== 2
    || Object.keys(row).some(key => !['accountId', 'expiresAt', 'issuedAt', 'sessionId', 'sessionRevision', 'version'].includes(key))
    || !safeAccountId(row.accountId) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt * 1000 <= nowMs
    || !Number.isSafeInteger(row.issuedAt) || row.issuedAt * 1000 > nowMs || row.issuedAt >= row.expiresAt
    || !Number.isSafeInteger(row.sessionRevision) || row.sessionRevision < 1
    || typeof row.sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.sessionId)) return null;
  return { accountId: row.accountId, expiresAt: row.expiresAt, issuedAt: row.issuedAt,
    sessionId: row.sessionId, sessionRevision: row.sessionRevision, version: 2 };
}

export async function verifyHostedAccountSession(config: HostedAccountAuthority, token: string, nowMs: number, sender: Sender = sendRequestToBitfieldTarget) {
  if (!token || token.length > 16384) return null;
  const reply = await callHostedAccountAuthority(config, 'verify', { token }, sender);
  return reply.authorized === true ? readVerifiedHostedSession(reply.session, nowMs) : null;
}
