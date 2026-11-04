import { sendRequestToBitfieldTarget } from '#workspace-records';

const ENGINE_OPERATION_LABEL_TARGET = 'engine.operation.label-addressed';
const ENGINE_READ_CURRENT_OPERATION = 'engine.operation.read-current';
const SESSION_ADDRESS_PREFIX = 'package::account-session::browser-session::';
const SESSION_AUTHORITY_ADDRESS_PREFIX = 'package::account-session::session-authority::';
const SESSION_TARGET_TIMEOUT_MS = 5000;

const textDecoder = new TextDecoder();

type TargetReplyEnvelope = { payload?: Uint8Array };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredBrowserId(value: unknown) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('browser_id is required.');
  }
  return value.trim();
}

async function readCurrentAddress(addressLabel: string, stage: string) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), SESSION_TARGET_TIMEOUT_MS);
  let reply: TargetReplyEnvelope;
  try {
    reply = await sendRequestToBitfieldTarget({
      target: ENGINE_OPERATION_LABEL_TARGET,
      payload: {
        address_label: addressLabel,
        operation_label: ENGINE_READ_CURRENT_OPERATION,
      },
    }, controller.signal) as TargetReplyEnvelope;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${stage} did not reply.`, { cause: error });
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

function decodeSession(value: unknown) {
  if (!isRecord(value)) return null;
  const accountId = typeof value.accountIdHash === 'string'
    ? value.accountIdHash
    : typeof value.accountId === 'string'
      ? value.accountId
      : null;
  if (!accountId) return null;
  const sessionRef = typeof value.session_ref === 'string' && value.session_ref.trim()
    ? value.session_ref.trim()
    : null;
  const sessionRevision = Number.isSafeInteger(value.session_revision) && Number(value.session_revision) > 0
    ? Number(value.session_revision)
    : null;
  if (!sessionRef || sessionRevision === null) return null;
  return {
    accountIdHash: accountId,
    email: typeof value.email === 'string' ? value.email : null,
    emailConfirmed: value.emailConfirmed === true,
    signedAccountSessionProofId: typeof value.signedAccountSessionProofId === 'string'
      ? value.signedAccountSessionProofId
      : 'current-log-session',
    status: 'signed_in' as const,
    session_ref: sessionRef,
    session_revision: sessionRevision,
  };
}

function authorityAddress(sessionRef: string) {
  const match = /^account-session:([0-9a-f-]{36})$/i.exec(sessionRef);
  if (!match) throw new Error('session_ref is invalid.');
  return `${SESSION_AUTHORITY_ADDRESS_PREFIX}${match[1]}`;
}

function decodeAuthority(value: unknown) {
  if (!isRecord(value)) return null;
  const actorRef = typeof value.actor_ref === 'string' && value.actor_ref.trim()
    ? value.actor_ref.trim()
    : null;
  const sessionRef = typeof value.session_ref === 'string' && value.session_ref.trim()
    ? value.session_ref.trim()
    : null;
  const expiresAtMilliseconds = typeof value.expires_at_milliseconds === 'number'
    ? value.expires_at_milliseconds
    : Number.NaN;
  const sessionRevision = typeof value.session_revision === 'number'
    ? value.session_revision
    : Number.NaN;
  if (!actorRef || !sessionRef || !Number.isSafeInteger(expiresAtMilliseconds)
    || !Number.isSafeInteger(sessionRevision) || sessionRevision < 1
    || (value.state !== 'active' && value.state !== 'revoked')) return null;
  return {
    actor_ref: actorRef,
    expires_at_milliseconds: expiresAtMilliseconds,
    session_ref: sessionRef,
    session_revision: sessionRevision,
    state: value.state,
  };
}

/**
 * Browser-safe presentation read. Keep this module free of the desktop verifier
 * and Node crypto so any surface may bundle it without pulling server-only code.
 */
export async function readAccountPortalSession(input: { browserId: unknown; nowMs: number }) {
  const browserId = requiredBrowserId(input.browserId);
  const sessionResult = await readCurrentAddress(`${SESSION_ADDRESS_PREFIX}${browserId}`, 'browser session read');
  const session = sessionResult.found === true ? decodeSession(sessionResult.payload) : null;
  if (!session) return null;

  const authorityResult = await readCurrentAddress(authorityAddress(session.session_ref), 'session authority read');
  const authority = authorityResult.found === true ? decodeAuthority(authorityResult.payload) : null;
  if (!authority || authority.actor_ref !== session.accountIdHash
    || authority.session_ref !== session.session_ref || authority.state !== 'active'
    || authority.expires_at_milliseconds <= input.nowMs
    || authority.session_revision !== session.session_revision) return null;

  return {
    accountId: session.accountIdHash,
    accountIdHash: session.accountIdHash,
    email: session.email,
    emailConfirmed: session.emailConfirmed,
    signedAccountSessionProofId: session.signedAccountSessionProofId,
    status: session.status,
    authority,
  };
}
