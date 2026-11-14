import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import type { AccountSessionProjection } from '../read-data/read-session';
import { readHostedAccountAuthority } from './hosted-account-authority';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_READ_CURRENT_OPERATION = 'engine.operation.read-current';
const ENGINE_WRITE_BATCH_OPERATION = 'engine.operation.write-batch';
const SESSION_ADDRESS_PREFIX = 'package::account-session::browser-session::';
const SESSION_AUTHORITY_ADDRESS_PREFIX = 'package::account-session::session-authority::';
const SESSION_TARGET_TIMEOUT_MS = 5000;

const textDecoder = new TextDecoder();

type TargetReplyEnvelope = {
  payload?: Uint8Array;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRequiredBrowserId(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('browser_id is required.');
  }
  return value.trim();
}

export function currentLogBrowserSessionAddress(input: { browserId: unknown }) {
  return `${SESSION_ADDRESS_PREFIX}${readRequiredBrowserId(input.browserId)}`;
}

async function sendLabelOperation(payload: Record<string, unknown>, stage: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), SESSION_TARGET_TIMEOUT_MS);
  let reply: TargetReplyEnvelope;
  try {
    reply = await sendRequestToBitfieldTarget({
      target: ENGINE_OPERATION_LABEL_TARGET,
      payload,
    }, controller.signal) as TargetReplyEnvelope;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${stage} did not reply.`, { cause: error });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
  const bytes = reply.payload;
  if (!bytes || !ArrayBuffer.isView(bytes)) return {};
  const text = textDecoder.decode(bytes);
  const parsed = text.trim() ? JSON.parse(text) as unknown : {};
  return isRecord(parsed) ? parsed : {};
}

type BrowserSessionState = Partial<AccountSessionProjection> & {
  session_ref?: string;
  session_revision?: number;
};

function decodeSessionPayload(value: unknown): BrowserSessionState | null {
  if (!isRecord(value)) return null;
  const accountId = typeof value.accountIdHash === 'string'
    ? value.accountIdHash
    : typeof value.accountId === 'string'
      ? value.accountId
      : null;
  if (!accountId) return null;
  const sessionRef = typeof value.session_ref === 'string' && value.session_ref.trim()
    ? value.session_ref.trim() : undefined;
  const sessionRevision = Number.isSafeInteger(value.session_revision) && Number(value.session_revision) > 0
    ? Number(value.session_revision) : undefined;
  return {
    accountIdHash: accountId,
    email: typeof value.email === 'string' ? value.email : null,
    emailConfirmed: value.emailConfirmed === true,
    signedAccountSessionProofId: typeof value.signedAccountSessionProofId === 'string'
      ? value.signedAccountSessionProofId
      : 'current-log-session',
    status: 'signed_in',
    session_ref: sessionRef,
    session_revision: sessionRevision,
  };
}

export type CurrentSessionAuthority = {
  actor_ref: string;
  expires_at_milliseconds: number;
  session_ref: string;
  session_revision: number;
  state: 'active' | 'revoked';
  hosted_browser_id?: string;
  hosted_origin?: string;
};

export function decodeCurrentSessionAuthority(value: unknown): CurrentSessionAuthority | null {
  if (!isRecord(value)) return null;
  const actorRef = typeof value.actor_ref === 'string' && value.actor_ref.trim()
    ? value.actor_ref.trim() : null;
  const sessionRef = typeof value.session_ref === 'string' && value.session_ref.trim()
    ? value.session_ref.trim() : null;
  const expires = value.expires_at_milliseconds;
  const revision = value.session_revision;
  const state = value.state;
  const expiresAtMilliseconds = typeof expires === 'number' ? expires : Number.NaN;
  const revisionNumber = typeof revision === 'number' ? revision : Number.NaN;
  if (!actorRef || !sessionRef || !Number.isFinite(expiresAtMilliseconds) || !Number.isInteger(expiresAtMilliseconds)
    || !Number.isFinite(revisionNumber) || !Number.isInteger(revisionNumber)
    || revisionNumber < 1 || (state !== 'active' && state !== 'revoked')) return null;
  return {
    actor_ref: actorRef,
    expires_at_milliseconds: expiresAtMilliseconds,
    session_ref: sessionRef,
    session_revision: revisionNumber,
    state,
    ...(typeof value.hosted_browser_id === 'string' ? { hosted_browser_id: value.hosted_browser_id } : {}),
    ...(typeof value.hosted_origin === 'string' ? { hosted_origin: value.hosted_origin } : {}),
  };
}

export function currentLogSessionAuthorityAddress(sessionRef: string) {
  const match = /^account-session:([0-9a-f-]{36})$/i.exec(sessionRef);
  if (!match) throw new Error('session_ref is invalid.');
  return `${SESSION_AUTHORITY_ADDRESS_PREFIX}${match[1]}`;
}

export async function readCurrentLogBrowserSession(input: { browserId: unknown; nowMs: number }) {
  const result = await sendLabelOperation({
    address_label: currentLogBrowserSessionAddress(input),
    operation_label: ENGINE_READ_CURRENT_OPERATION,
  }, 'browser session read');
  const session = result.found === true ? decodeSessionPayload(result.payload) : null;
  if (!session) return null;
  // SSOT enforcement (SP2 time-bounded signed leases): a browser-session record
  // proves only WHO once logged in on this browser. Whether that login is STILL
  // valid is owned exclusively by the session-authority record (its
  // expires_at_milliseconds / state / session_revision). Without this cross-read
  // any browser that ever held a session reads as permanently signed_in, so an
  // anonymous visitor with a stale record sees empty access-scoped content
  // instead of the login screen. The authority record is the canonical source.
  const sessionRef = typeof session.session_ref === 'string' ? session.session_ref.trim() : '';
  if (!sessionRef) return null;
  const authority = await readCurrentLogSessionAuthority({ sessionRef, nowMs: input.nowMs });
  if (!authority) return null;
  if (authority.actor_ref !== session.accountIdHash || authority.session_ref !== sessionRef) return null;
  if (authority.state !== 'active') return null;
  if (authority.expires_at_milliseconds <= input.nowMs) return null;
  if (authority.session_revision !== session.session_revision) return null;
  return {
    ...session,
    authority,
    // Presentation owners use this canonical lease boundary to schedule ONE
    // exact re-check when the current session expires. This is not a poller:
    // the authority's own expiry time remains the clock source.
    sessionExpiresAtMilliseconds: authority.expires_at_milliseconds,
  };
}

async function readLocalCurrentLogSessionAuthorityRecord(input: { sessionRef: unknown }) {
  const sessionRef = typeof input.sessionRef === 'string' ? input.sessionRef.trim() : '';
  if (!sessionRef) return null;
  const result = await sendLabelOperation({
    address_label: currentLogSessionAuthorityAddress(sessionRef),
    operation_label: ENGINE_READ_CURRENT_OPERATION,
  }, 'session authority read');
  const authority = result.found === true ? decodeCurrentSessionAuthority(result.payload) : null;
  if (!authority) return null;
  return { authority, result, sessionRef };
}

/** Read this runtime's authority fact without following any configured hosted authority. */
export async function readLocalCurrentLogSessionAuthority(input: { sessionRef: unknown }) {
  return (await readLocalCurrentLogSessionAuthorityRecord(input))?.authority ?? null;
}

export async function readCurrentLogSessionAuthority(input: { sessionRef: unknown; nowMs?: number }) {
  const local = await readLocalCurrentLogSessionAuthorityRecord(input);
  if (!local) return null;
  const { authority, result, sessionRef } = local;
  const hosted = await readHostedAccountAuthority();
  if (!hosted) return authority.hosted_origin ? null : authority;
  if (!Number.isSafeInteger(input.nowMs)) return null;
  const { verifyDesktopAuthoritySnapshot } = await import('./desktop-account-session');
  if (await verifyDesktopAuthoritySnapshot(hosted, authority, input.nowMs!)) return authority;
  if (authority.state === 'active') {
    if (!/^1f:[0-9a-f]{64}$/.test(String(result.content_hash))) throw new Error('Session authority could not be verified.');
    const revoked = await sendLabelOperation({ operation_label: ENGINE_WRITE_BATCH_OPERATION, writes: [{
      address_label: currentLogSessionAuthorityAddress(sessionRef), path_labels: ['account-session', 'session-authority'],
      expected_current: { payload_hash_base64: Buffer.from(makeMultihashEncodedBytesFromCodeHex(String(result.content_hash))).toString('base64') },
      payload: { ...(result.payload as Record<string, unknown>), state: 'revoked', session_revision: authority.session_revision + 1 },
    }] }, 'session authority revocation');
    assertSessionWriteCount(revoked, 1);
  }
  return null;
}

function assertSessionWriteCount(result: Record<string, unknown>, expected: number) {
  const writeCount = typeof result.write_count === 'number'
    ? result.write_count
    : typeof result.writeCount === 'number'
      ? result.writeCount
      : null;
  if (writeCount !== expected) {
    throw new Error('browser session write was not committed.');
  }
}

export async function writeCurrentLogBrowserSession(input: {
  accountId: string;
  browserId: string;
  email: string | null;
  session: {
    expiresAt: number;
    sessionId: string;
    sessionRevision: number;
  };
  preconditions?: Array<{ address_label: string; expected_current: { payload_hash_base64: string | null } }>;
  hostedAuthority?: { browserId: string; origin: string };
}) {
  const sessionRef = `account-session:${input.session.sessionId}`;
  const session = {
    accountIdHash: input.accountId,
    email: input.email,
    emailConfirmed: true,
    signedAccountSessionProofId: `supabase:${input.accountId}`,
    status: 'signed_in',
    session_ref: sessionRef,
    session_revision: input.session.sessionRevision,
  };
  const result = await sendLabelOperation({
    operation_label: ENGINE_WRITE_BATCH_OPERATION,
    ...(input.preconditions ? { preconditions: input.preconditions } : {}),
    writes: [
      {
        address_label: currentLogBrowserSessionAddress({ browserId: input.browserId }),
        path_labels: ['account-session', 'browser-session'],
        payload: session,
      },
      {
        address_label: currentLogSessionAuthorityAddress(sessionRef),
        path_labels: ['account-session', 'session-authority'],
        payload: {
          actor_ref: input.accountId,
          expires_at_milliseconds: input.session.expiresAt * 1000,
          session_ref: sessionRef,
          session_revision: input.session.sessionRevision,
          state: 'active',
          ...(input.hostedAuthority ? { hosted_browser_id: input.hostedAuthority.browserId, hosted_origin: input.hostedAuthority.origin } : {}),
        },
      },
    ],
  }, 'browser session write');
  assertSessionWriteCount(result, 2);
  return session satisfies Partial<AccountSessionProjection>;
}

export async function revokeCurrentLogBrowserSession(input: { browserId: string; nowMs: number }) {
  const current = await readCurrentLogBrowserSession({ browserId: input.browserId, nowMs: input.nowMs });
  const sessionRef = typeof current?.session_ref === 'string' ? current.session_ref : '';
  const currentAuthority = sessionRef
    ? await readCurrentLogSessionAuthority({ sessionRef, nowMs: input.nowMs })
    : null;
  const writes: Array<Record<string, unknown>> = [
    {
      address_label: currentLogBrowserSessionAddress({ browserId: input.browserId }),
      path_labels: ['account-session', 'browser-session'],
      payload: null,
    },
  ];
  if (currentAuthority) {
    writes.push({
      address_label: currentLogSessionAuthorityAddress(currentAuthority.session_ref),
      path_labels: ['account-session', 'session-authority'],
      payload: {
        ...currentAuthority,
        session_revision: currentAuthority.session_revision + 1,
        state: 'revoked',
      },
    });
  }
  const result = await sendLabelOperation({
    operation_label: ENGINE_WRITE_BATCH_OPERATION,
    writes,
  }, 'browser session clear');
  assertSessionWriteCount(result, writes.length);
  if (currentAuthority) {
    console.info(`[account-session] session=${currentAuthority.session_ref} revision=${currentAuthority.session_revision + 1} state=revoked`);
  }
}
