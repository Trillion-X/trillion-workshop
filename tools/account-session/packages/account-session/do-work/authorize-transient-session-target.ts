import { readTrustedRuntimeClockMs, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import {
  readAccountPortalSessionToken,
  readLocallyIssuedAccountPortalSessionToken,
  sessionCookieName,
} from '../read-data/session-token';
import {
  readCurrentLogSessionAuthority,
  readLocalCurrentLogSessionAuthority,
} from './current-log-browser-session';

export type TransientSessionHandshakeEvidence = {
  cookie_header?: unknown;
  header_map?: unknown;
  headers?: unknown;
};

export type TransientSessionAuthorityReply =
  | { authorized: false }
  | {
      authorized: true;
      expires_at_milliseconds: number;
      principal_ref: string;
      session_ref: string;
      session_revision: number;
    };

export type SessionRevisionVerificationReply =
  | { verified: false }
  | { verified: true; session_revision: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function readCookieValue(
  cookieHeader: unknown,
  cookieName: string,
): string | undefined {
  if (typeof cookieHeader !== 'string' || !cookieName) return undefined;

  let found: string | undefined;
  for (const segment of cookieHeader.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0 || segment.slice(0, separator).trim() !== cookieName) {
      continue;
    }
    const value = segment.slice(separator + 1).trim();
    if (!value || found !== undefined) return undefined;
    found = value;
  }
  return found;
}

type CookieHeaderEvidence = {
  present: boolean;
  valid: boolean;
  value?: string;
};

function directCookieHeaderEvidence(
  input: Record<string, unknown>,
): CookieHeaderEvidence {
  if (!hasOwn(input, 'cookie_header')) return { present: false, valid: true };
  return typeof input.cookie_header === 'string'
    ? { present: true, valid: true, value: input.cookie_header }
    : { present: true, valid: false };
}

function listedCookieHeaderEvidence(
  input: Record<string, unknown>,
): CookieHeaderEvidence {
  if (!hasOwn(input, 'headers')) return { present: false, valid: true };
  if (!Array.isArray(input.headers)) return { present: true, valid: false };

  let cookieHeader: string | undefined;
  for (const header of input.headers) {
    if (
      !isRecord(header) ||
      typeof header.name !== 'string' ||
      !header.name.trim() ||
      typeof header.value !== 'string'
    ) {
      return { present: true, valid: false };
    }
    if (header.name.trim().toLowerCase() !== 'cookie') continue;
    if (cookieHeader !== undefined) return { present: true, valid: false };
    cookieHeader = header.value;
  }
  return { present: true, valid: true, value: cookieHeader };
}

function handshakeSessionToken(
  input: Record<string, unknown>,
  cookieName: string,
) {
  const direct = directCookieHeaderEvidence(input);
  const listed = listedCookieHeaderEvidence(input);
  if (!direct.valid || !listed.valid) return undefined;

  const directToken = readCookieValue(direct.value, cookieName);
  const listedToken = readCookieValue(listed.value, cookieName);
  if (direct.present && listed.present) {
    return directToken && directToken === listedToken ? directToken : undefined;
  }
  return directToken ?? listedToken;
}

type SessionTokenReader = typeof readAccountPortalSessionToken;
type SessionAuthorityReader = typeof readCurrentLogSessionAuthority;

async function authorizeTransientSessionWithReaders(
  input: unknown,
  context: BitfieldRuntimeContext | undefined,
  readToken: SessionTokenReader,
  readAuthority: SessionAuthorityReader,
): Promise<TransientSessionAuthorityReply> {
  // Read BEFORE the try. A bad cookie is attacker-supplied and denying it silently is correct;
  // a runtime that supplied no clock is an operator error, and swallowing it here would sign
  // every user out with nothing anywhere saying why.
  const nowMs = readTrustedRuntimeClockMs(context);
  try {
    if (!isRecord(input)) return { authorized: false };
    const token = handshakeSessionToken(input, sessionCookieName());
    if (!token) return { authorized: false };
    const session = await readToken(token, nowMs);
    if (!session) return { authorized: false };

    const expiresAtMilliseconds = session.expiresAt * 1000;
    if (!Number.isSafeInteger(expiresAtMilliseconds)) {
      return { authorized: false };
    }

    const sessionRef = `account-session:${session.sessionId}`;
    const authority = await readAuthority({ sessionRef, nowMs });
    if (
      !authority
      || authority.state !== 'active'
      || authority.actor_ref !== session.accountId
      || authority.session_ref !== sessionRef
      || authority.session_revision !== session.sessionRevision
      || authority.expires_at_milliseconds !== expiresAtMilliseconds
      || authority.expires_at_milliseconds <= nowMs
    ) return { authorized: false };
    return {
      authorized: true,
      expires_at_milliseconds: expiresAtMilliseconds,
      principal_ref: session.accountId,
      session_ref: sessionRef,
      session_revision: session.sessionRevision,
    };
  } catch {
    return { authorized: false };
  }
}

export async function authorizeTransientSessionTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
): Promise<TransientSessionAuthorityReply> {
  return authorizeTransientSessionWithReaders(
    input,
    context,
    readAccountPortalSessionToken,
    readCurrentLogSessionAuthority,
  );
}

/** Authority endpoint path: validate only this runtime's token and authority fact. */
export async function authorizeLocallyIssuedTransientSession(
  input: unknown,
  context?: BitfieldRuntimeContext,
): Promise<TransientSessionAuthorityReply> {
  return authorizeTransientSessionWithReaders(
    input,
    context,
    readLocallyIssuedAccountPortalSessionToken,
    readLocalCurrentLogSessionAuthority,
  );
}

/** Owner-to-owner revocation check. It accepts no browser credential and
 * returns no account/session metadata beyond the exact revision requested. */
export async function verifySessionRevisionTarget(
  input: unknown,
  context?: BitfieldRuntimeContext,
): Promise<SessionRevisionVerificationReply> {
  const nowMs = readTrustedRuntimeClockMs(context);
  try {
    if (!isRecord(input)) return { verified: false };
    const actorRef = typeof input.actor_ref === 'string' ? input.actor_ref.trim() : '';
    const sessionRef = typeof input.session_ref === 'string' ? input.session_ref.trim() : '';
    const sessionRevision = typeof input.session_revision === 'string'
      ? input.session_revision.trim()
      : Number.isSafeInteger(input.session_revision)
        ? String(input.session_revision)
        : '';
    if (!actorRef || !sessionRef || !sessionRevision || Object.keys(input).some((key) => !['actor_ref', 'session_ref', 'session_revision'].includes(key))) return { verified: false };
    const authority = await readLocalCurrentLogSessionAuthority({ sessionRef });
    if (!authority || authority.state !== 'active' || authority.actor_ref !== actorRef || authority.session_ref !== sessionRef || String(authority.session_revision) !== sessionRevision || authority.expires_at_milliseconds <= nowMs) return { verified: false };
    return { verified: true, session_revision: sessionRevision };
  } catch { return { verified: false }; }
}
