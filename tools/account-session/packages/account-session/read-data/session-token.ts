import { timingSafeEqual } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import packageContract from '../things-to-store-and-run.json' with { type: 'json' };
import { safeAccountId } from './safe-account-id';
import { readHostedAccountAuthority, verifyHostedAccountSession } from '../do-work/hosted-account-authority';

/**
 * A signed cookie identifies a session, but it is not by itself authority.
 * The current session-authority record is checked before every hosted action.
 */
export type AccountPortalSessionV2 = {
  accountId: string;
  expiresAt: number;
  issuedAt: number;
  sessionId: string;
  sessionRevision: number;
  version: 2;
};

const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_SESSION_COOKIE_NAME = '__Host_account_session';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function packageRecords(): readonly JsonRecord[] {
  return Array.isArray(packageContract.things)
    ? packageContract.things.filter(isRecord)
    : [];
}

export function sessionCookieName() {
  return (
    process.env.ACCOUNT_SESSION_COOKIE_NAME?.trim() ||
    DEFAULT_SESSION_COOKIE_NAME
  );
}

export function configuredSessionTtlSeconds() {
  const configured = process.env.ACCOUNT_SESSION_TTL_SECONDS;
  if (!configured) return DEFAULT_SESSION_TTL_SECONDS;
  const parsed = Number(configured);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error('ACCOUNT_SESSION_TTL_SECONDS is invalid.');
}

function readRequiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function readPositiveInteger(value: unknown, label: string) {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} is required.`);
  }
  return Number(value);
}

function readSigningDescriptor() {
  for (const thing of packageRecords()) {
    const payload = thing.payload;
    if (isRecord(payload) && payload.kind === 'account-session-login-proof-signing-descriptor') {
      return payload;
    }
  }
  throw new Error('Account session signing descriptor is not configured.');
}

function readJsonReply(payload: Uint8Array) {
  const text = new TextDecoder().decode(payload);
  return text.trim() ? JSON.parse(text) as JsonRecord : {};
}

async function readSessionSecretHex() {
  const descriptor = readSigningDescriptor();
  const target = readRequiredString(
    descriptor.credential_resolver_target,
    'descriptor.credential_resolver_target',
  );
  const key = readRequiredString(descriptor.credential_key, 'descriptor.credential_key');
  const ttlSeconds = readPositiveInteger(
    descriptor.handle_ttl_seconds,
    'descriptor.handle_ttl_seconds',
  );
  const actorId = readRequiredString(
    descriptor.credential_resolver_actor_id,
    'descriptor.credential_resolver_actor_id',
  );
  const readReply = readJsonReply((await sendRequestToBitfieldTarget({
    target,
    payload: {
      handle_ttl_seconds: ttlSeconds,
      key,
      one_time: true,
      operation: 'read',
    },
  })).payload);
  const handle = readRequiredString(readReply.handle, 'credential handle');
  const resolveReply = readJsonReply((await sendRequestToBitfieldTarget({
    target,
    payload: {
      actor_id: actorId,
      handle,
      operation: 'resolve_handle',
    },
  })).payload);
  return readRequiredString(resolveReply.value, 'resolved credential value');
}

function sessionSecret(secretHex: string) {
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) {
    throw new Error('Account session signing credential must be exactly 32 bytes of hex key material.');
  }
  return Uint8Array.from(Buffer.from(secretHex, 'hex'));
}

function base64urlJson(value: AccountPortalSessionV2) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signPayload(payload: string, secretHex: string) {
  const signature = blake3(new TextEncoder().encode(payload), {
    key: sessionSecret(secretHex),
  });
  return Buffer.from(signature).toString('base64url');
}

function sameSignature(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

/**
 * The clock and the session identity are runtime facts, never invented here: the
 * engine hands both to the target that starts a session, so the same log replays
 * to the same session.
 */
export type AccountPortalSessionMinting = {
  mintId: () => string;
  nowMs: number;
};

export async function createAccountPortalSession(
  accountId: string,
  minting: AccountPortalSessionMinting,
): Promise<{
  session: AccountPortalSessionV2;
  token: string;
}> {
  const safeId = safeAccountId(accountId);
  if (!safeId) throw new Error('Account key is invalid.');

  const issuedAt = Math.floor(minting.nowMs / 1000);
  const session = {
    accountId: safeId,
    expiresAt: issuedAt + configuredSessionTtlSeconds(),
    issuedAt,
    sessionId: minting.mintId(),
    sessionRevision: 1,
    version: 2 as const,
  };
  const payload = base64urlJson(session);
  return {
    session,
    token: `b3.${payload}.${signPayload(payload, await readSessionSecretHex())}`,
  };
}

export async function createAccountPortalSessionToken(
  accountId: string,
  minting: AccountPortalSessionMinting,
) {
  return (await createAccountPortalSession(accountId, minting)).token;
}

export async function readAccountPortalSessionToken(
  token: string | undefined,
  nowMs: number,
): Promise<AccountPortalSessionV2 | null> {
  if (!token) return null;
  const hosted = await readHostedAccountAuthority();
  if (hosted) return verifyHostedAccountSession(hosted, token, nowMs);
  return readLocallyIssuedAccountPortalSessionToken(token, nowMs);
}

/**
 * Verify only a token issued by this runtime's own signing authority.
 *
 * Hosted authority endpoints must use this path: the same package DATA may also
 * declare the public authority origin for clients, and following that client
 * delegation while already serving the authority would call the endpoint back
 * through itself. Possession of the local signing credential remains the
 * cryptographic boundary; this function never accepts a caller-selected key or
 * falls back to a remote verifier.
 */
export async function readLocallyIssuedAccountPortalSessionToken(
  token: string | undefined,
  nowMs: number,
): Promise<AccountPortalSessionV2 | null> {
  if (!token) return null;
  const [format, payload, signature, extra] = token.split('.');
  if (format !== 'b3' || !payload || !signature || extra) return null;
  if (!sameSignature(signature, signPayload(payload, await readSessionSecretHex()))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const session = parsed as Partial<AccountPortalSessionV2>;
  const accountId = safeAccountId(session.accountId);
  if (!accountId || session.version !== 2) return null;
  if (
    typeof session.expiresAt !== 'number' ||
    !Number.isFinite(session.expiresAt) ||
    session.expiresAt <= Math.floor(nowMs / 1000)
  ) {
    return null;
  }
  if (typeof session.issuedAt !== 'number' || !Number.isFinite(session.issuedAt)) {
    return null;
  }
  if (typeof session.sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(session.sessionId)) {
    return null;
  }
  if (!Number.isSafeInteger(session.sessionRevision) || Number(session.sessionRevision) < 1) {
    return null;
  }

  return {
    accountId,
    expiresAt: session.expiresAt,
    issuedAt: session.issuedAt,
    sessionId: session.sessionId,
    sessionRevision: session.sessionRevision,
    version: 2,
  };
}
