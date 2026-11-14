import { createHash, timingSafeEqual } from 'node:crypto';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';
import { sendRequestToBitfieldTarget, createTrustedRuntimeIdMinter, readTrustedRuntimeClockMs, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { readSignedAccountPortalLoginProofToken } from './login-proof-token-crypto';
import { readAccountAuthorityCanOpen } from '../read-data/read-account-authority-access';
import { issueAccountAccessSession } from './write-browser-session';
import { currentLogSessionAuthorityAddress } from './current-log-browser-session';

type Row = Record<string, any>;
type Sender = typeof sendRequestToBitfieldTarget;
export type DesktopLoginChallenge = { request_id: string; code_challenge: string; code_challenge_method: 'S256' };
const TARGET = 'engine.operation.label-addressed';
const READ = 'engine.operation.read-current';
const WRITE = 'engine.operation.write-batch';

export function readDesktopLoginChallenge(value: unknown): DesktopLoginChallenge {
  const row = value as Row;
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || Object.keys(row).some(key => !['request_id', 'code_challenge', 'code_challenge_method'].includes(key))
    || typeof row.request_id !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(row.request_id)
    || typeof row.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(row.code_challenge)
    || row.code_challenge_method !== 'S256') throw new Error('Invalid sign-in challenge.');
  return { request_id: row.request_id, code_challenge: row.code_challenge, code_challenge_method: 'S256' };
}

export function desktopLoginVerifierChallenge(verifier: unknown): string {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('Invalid sign-in verifier.');
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function address(requestId: string) {
  return `package::account-session::desktop-login::${requestId}`;
}

async function query(sender: Sender, payload: Row): Promise<Row> {
  const reply = await sender({ target: TARGET, payload });
  const value = JSON.parse(new TextDecoder().decode(reply.payload));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Sign-in state could not be read.');
  return value;
}

function basis(read: Row) {
  if (read.found === false) return null;
  if (read.found !== true || !/^1f:[a-f0-9]{64}$/.test(read.content_hash ?? '')) throw new Error('Sign-in state could not be verified.');
  return Buffer.from(makeMultihashEncodedBytesFromCodeHex(read.content_hash)).toString('base64');
}

function committed(result: Row, count: number) {
  if (result.write_count !== count && result.writeCount !== count) throw new Error('Sign-in state changed. Request a new link.');
}

/** Called only after the email proof is checked here; caller account/browser claims are never accepted. */
export async function approveDesktopLoginHandoff(token: string, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget) {
  const nowMs = readTrustedRuntimeClockMs(context);
  const proof = await readSignedAccountPortalLoginProofToken(token, Math.floor(nowMs / 1000));
  if (!proof?.desktopHandoff || !proof.browserId || !(await readAccountAuthorityCanOpen(proof.accountId))) throw new Error('Sign-in link is expired or invalid.');
  const challenge = readDesktopLoginChallenge(proof.desktopHandoff);
  const label = address(challenge.request_id);
  const current = await query(sender, { operation_label: READ, address_label: label });
  const expected = basis(current);
  const approved = {
    kind: 'account-session-desktop-login', state: 'approved', ...challenge,
    account_id: proof.accountId, browser_id: proof.browserId,
    expires_at_milliseconds: proof.expiresAt * 1000,
  };
  if (current.found) {
    const prior = current.payload;
    if (prior?.state === 'approved' && Object.keys(approved).every(key => prior[key] === approved[key as keyof typeof approved])) {
      return { approved: true };
    }
    throw new Error('Sign-in link has already been used.');
  }
  committed(await query(sender, { operation_label: WRITE, writes: [{ address_label: label,
    path_labels: ['account-session', 'desktop-login'], expected_current: { payload_hash_base64: expected }, payload: approved }] }), 1);
  return { approved: true };
}

/** Proof of verifier possession, authority recheck, session publication and consumption share one CAS. */
export async function redeemDesktopLoginHandoff(input: unknown, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget) {
  const request = input as Row;
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['request_id', 'code_verifier'].includes(key))
    || typeof request.request_id !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(request.request_id)) throw new Error('Invalid sign-in request.');
  const presented = desktopLoginVerifierChallenge(request.code_verifier);
  const nowMs = readTrustedRuntimeClockMs(context);
  const label = address(request.request_id);
  const current = await query(sender, { operation_label: READ, address_label: label });
  const expected = basis(current);
  if (!current.found) return { pending: true };
  const row = current.payload;
  const challenge = readDesktopLoginChallenge({ request_id: row?.request_id, code_challenge: row?.code_challenge, code_challenge_method: row?.code_challenge_method });
  if (row.kind !== 'account-session-desktop-login' || row.state !== 'approved'
    || challenge.request_id !== request.request_id
    || !Number.isSafeInteger(row.expires_at_milliseconds) || row.expires_at_milliseconds <= nowMs
    || typeof row.browser_id !== 'string' || !/^browser:[A-Za-z0-9._:-]{8,200}$/.test(row.browser_id)
    || !timingSafeEqual(Buffer.from(presented), Buffer.from(challenge.code_challenge))) throw new Error('Sign-in handoff is unavailable.');
  if (!(await readAccountAuthorityCanOpen(row.account_id))) throw new Error('Account access is unavailable.');
  const issued = await issueAccountAccessSession(row.account_id, { mintId: createTrustedRuntimeIdMinter(context), nowMs });
  const sessionRef = `account-session:${issued.session.sessionId}`;
  const authority = { actor_ref: row.account_id, session_ref: sessionRef, session_revision: issued.session.sessionRevision,
    expires_at_milliseconds: issued.session.expiresAt * 1000, state: 'active' };
  // Do not bind the authenticated session to a caller-selected browser ID. The
  // app proves possession of the issued cookie; the ID is presentation correlation only.
  committed(await query(sender, { operation_label: WRITE, writes: [
    { address_label: label, path_labels: ['account-session', 'desktop-login'],
      expected_current: { payload_hash_base64: expected }, payload: { ...row, state: 'consumed', consumed_at_milliseconds: nowMs } },
    { address_label: currentLogSessionAuthorityAddress(sessionRef), path_labels: ['account-session', 'session-authority'],
      expected_current: { payload_hash_base64: null }, payload: authority },
  ] }), 2);
  return { cookie: issued.cookie, session: issued.session, browser_id: row.browser_id, authority };
}
