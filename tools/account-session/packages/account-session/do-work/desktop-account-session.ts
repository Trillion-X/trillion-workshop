import { createHash, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { makeMultihashEncodedBytesFromCodeHex } from '@bitfield/slot-protocol';
import { sendRequestToBitfieldTarget, createTrustedRuntimeIdMinter, readTrustedRuntimeEntropyHex, readTrustedRuntimeClockMs, type BitfieldRuntimeContext } from '@bitfield/runtime-kit';
import { callHostedAccountAuthority, verifyHostedAccountSession, type HostedAccountAuthority } from './hosted-account-authority';
import { desktopLoginVerifierChallenge } from './desktop-login-handoff';
import { writeCurrentLogBrowserSession, readCurrentLogBrowserSession, type CurrentSessionAuthority } from './current-log-browser-session';
import { accountAccessSessionCookieForToken } from './write-browser-session';

type Row = Record<string, any>;
type Sender = typeof sendRequestToBitfieldTarget;
function requireLocalAdmission(context?: BitfieldRuntimeContext) {
  const caller = (context?.runtime as unknown as { caller?: { local_command_list_admitted?: unknown } } | undefined)?.caller;
  if (caller?.local_command_list_admitted !== true) throw new Error('Sign-in is available only from this app.');
}
function accessHash(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Sign-in belongs to another app window. Request a new link here.');
  return createHash('sha256').update(value).digest('hex');
}
function requireAccess(state: Row, value: unknown) {
  const hash = accessHash(value);
  if (typeof state.access_hash !== 'string' || !/^[a-f0-9]{64}$/.test(state.access_hash)
    || !timingSafeEqual(Buffer.from(hash), Buffer.from(state.access_hash))) throw new Error('Sign-in belongs to another app window. Request a new link here.');
}
function key(browserId: unknown) {
  if (typeof browserId !== 'string' || !/^browser:[A-Za-z0-9._:-]{8,200}$/.test(browserId)) throw new Error('Invalid browser binding.');
  return `account-session-desktop-${createHash('sha256').update(browserId).digest('hex')}`;
}
async function vault(input: Row, sender: Sender): Promise<Row> {
  const result = JSON.parse(new TextDecoder().decode((await sender({ target: 'slot::credentials-vault', payload: input })).payload));
  if (result?.success !== true) throw new Error('Private sign-in state is unavailable.');
  return result;
}
async function stateRead(browserId: string, sender: Sender) {
  const address_label = `package::account-session::desktop-client::${key(browserId)}`;
  const read = JSON.parse(new TextDecoder().decode((await sender({ target: 'engine.operation.label-addressed', payload: {
    operation_label: 'engine.operation.read-current', address_label,
  } })).payload));
  if (read.found !== false && (read.found !== true || !/^1f:[a-f0-9]{64}$/.test(read.content_hash ?? ''))) throw new Error('Sign-in state could not be verified.');
  return { ...read, address_label, expected_current: { payload_hash_base64: read.found
    ? Buffer.from(makeMultihashEncodedBytesFromCodeHex(read.content_hash)).toString('base64') : null } };
}
function secretKey(browserId: string, requestId: unknown) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(requestId)) throw new Error('Invalid sign-in request.');
  return `${key(browserId)}-${requestId}`;
}
function aad(origin: string, browserId: string, requestId: string) {
  return Buffer.from(JSON.stringify(['account-session-presenter-sealed/v1', origin, browserId, requestId]));
}
async function save(browserId: string, requestId: string, value: Row, sender: Sender, sessionAccessKey: unknown, context?: BitfieldRuntimeContext, create = false) {
  const encryptionKey = Buffer.from(accessHash(sessionAccessKey), 'hex');
  const plaintext = JSON.stringify(value);
  // One encryption per invocation, using all 256 runtime-provided random bits.
  // Domain separation avoids UUID formatting and the non-cryptographic ID mixer.
  const iv = createHash('sha256').update('account-session-seal-nonce/v1\0')
    .update(Buffer.from(readTrustedRuntimeEntropyHex(context), 'hex')).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  cipher.setAAD(aad(value.origin, browserId, requestId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const sealed = { format: 'account-session-presenter-sealed/v1', iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  await vault({ operation: create ? 'create' : 'write', key: secretKey(browserId, requestId), value: JSON.stringify(sealed) }, sender);
}
async function load(browserId: string, requestId: string, sender: Sender, sessionAccessKey: unknown, origin: string): Promise<Row> {
  const encryptionKey = Buffer.from(accessHash(sessionAccessKey), 'hex');
  const opened = await vault({ operation: 'read', key: secretKey(browserId, requestId), handle_ttl_seconds: 60, one_time: true }, sender);
  if (typeof opened.handle !== 'string' || !opened.handle) throw new Error('Private sign-in state is unavailable.');
  const resolved = await vault({ operation: 'resolve_handle', handle: opened.handle, actor_id: 'account-session' }, sender);
  let value: Row;
  try {
    const sealed = JSON.parse(resolved.value);
    if (!sealed || sealed.format !== 'account-session-presenter-sealed/v1'
      || Object.keys(sealed).some(key => !['format', 'iv', 'ciphertext', 'tag'].includes(key))
      || ![sealed.iv, sealed.ciphertext, sealed.tag].every(value => typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value))
      || Buffer.from(sealed.iv, 'base64').length !== 12 || Buffer.from(sealed.tag, 'base64').length !== 16) throw new Error('Invalid sealed state');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(aad(origin, browserId, requestId));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw new Error('Sign-in belongs to another app window. Request a new link here.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Private sign-in state is invalid.');
  return value;
}

/** Verifier/token remain in the local vault, never browser storage or public records. */
export async function requestDesktopAccountLogin(config: HostedAccountAuthority, input: { email?: unknown; browser_id?: unknown; session_access_key?: unknown }, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget) {
  requireLocalAdmission(context);
  const access = accessHash(input.session_access_key);
  key(input.browser_id);
  if (typeof input.email !== 'string' || !input.email.trim() || input.email.length > 320) throw new Error('Enter a valid email address.');
  const browserId = input.browser_id as string;
  const current = await stateRead(browserId, sender);
  if (current.found) {
    const prior = await load(browserId, current.payload?.request_id, sender, input.session_access_key, config.origin);
    requireAccess(prior, input.session_access_key);
    if (prior.origin !== config.origin || prior.browser_id !== browserId) throw new Error('Sign-in service binding changed.');
  }
  const mint = createTrustedRuntimeIdMinter(context);
  const verifier = createHash('sha256').update('account-session-pkce-verifier/v1\0')
    .update(Buffer.from(readTrustedRuntimeEntropyHex(context), 'hex')).digest('base64url');
  const requestId = `${mint()}${mint()}`.replaceAll('-', '');
  const challenge = desktopLoginVerifierChallenge(verifier);
  const state = { state: 'pending', origin: config.origin, browser_id: browserId, request_id: requestId, code_verifier: verifier, access_hash: access,
    expires_at_milliseconds: readTrustedRuntimeClockMs(context) + 15 * 60 * 1000 };
  await save(browserId, requestId, state, sender, input.session_access_key, context, true);
  const written = JSON.parse(new TextDecoder().decode((await sender({ target: 'engine.operation.label-addressed', payload: {
    operation_label: 'engine.operation.write-batch', writes: [{ address_label: current.address_label,
      expected_current: current.expected_current, path_labels: ['account-session', 'desktop-client'],
      payload: { kind: 'account-session-desktop-client', request_id: requestId, browser_id: browserId, origin: config.origin } }],
  } })).payload));
  if (written.write_count !== 1 && written.writeCount !== 1) throw new Error('Another sign-in request replaced this one.');
  const reply = await callHostedAccountAuthority(config, 'request', { email: input.email.trim(), browser_id: browserId,
    desktop_handoff: { request_id: requestId, code_challenge: challenge, code_challenge_method: 'S256' } }, sender);
  if (reply.ok !== true && reply.accepted !== true) throw new Error('Sign-in service rejected the request.');
  return { accepted: true };
}

/** Refresh is demand-driven (open/focus), and every active read rechecks hosted authority. */
export async function readDesktopAccountSession(config: HostedAccountAuthority, browserId: string, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget, sessionAccessKey?: unknown) {
  requireLocalAdmission(context);
  accessHash(sessionAccessKey);
  const nowMs = readTrustedRuntimeClockMs(context);
  const current = await stateRead(browserId, sender);
  if (!current.found) return { session: null };
  const pointer = current.payload;
  if (pointer?.kind !== 'account-session-desktop-client' || pointer.browser_id !== browserId || pointer.origin !== config.origin) throw new Error('Sign-in service binding changed.');
  let state = await load(browserId, pointer.request_id, sender, sessionAccessKey, config.origin);
  requireAccess(state, sessionAccessKey);
  if (state.origin !== config.origin || state.browser_id !== browserId) throw new Error('Sign-in service binding changed. Request a new link.');
  if (state.state === 'pending') {
    if (!Number.isSafeInteger(state.expires_at_milliseconds) || state.expires_at_milliseconds <= nowMs) return { session: null };
    let redeemed: Row;
    try {
      redeemed = await callHostedAccountAuthority(config, 'redeem', { request_id: state.request_id, code_verifier: state.code_verifier }, sender);
    } catch {
      throw new Error('Sign-in could not finish. Request a new sign-in link.');
    }
    if (redeemed.pending === true) return { session: null };
    if (redeemed.browser_id !== browserId || typeof redeemed.cookie?.value !== 'string') throw new Error('Sign-in response does not match this app.');
    // Verification is a separate server authority check, not acceptance of
    // account/session fields supplied in the redemption reply or public DATA.
    const verified = await verifyHostedAccountSession(config, redeemed.cookie.value, nowMs, sender);
    if (!verified || verified.accountId !== redeemed.session?.accountId || verified.sessionId !== redeemed.session?.sessionId
      || verified.sessionRevision !== redeemed.session?.sessionRevision || verified.expiresAt !== redeemed.session?.expiresAt) throw new Error('Sign-in authority could not be verified.');
    state = { state: 'active', origin: config.origin, browser_id: browserId, token: redeemed.cookie.value, access_hash: state.access_hash };
    await save(browserId, pointer.request_id, state, sender, sessionAccessKey, context);
  }
  if (state.state !== 'active' || typeof state.token !== 'string') return { session: null };
  const verified = await verifyHostedAccountSession(config, state.token, nowMs, sender);
  if (!verified) {
    await readCurrentLogBrowserSession({ browserId, nowMs });
    return { session: null };
  }
  const session = await writeCurrentLogBrowserSession({ accountId: verified.accountId, browserId, email: null, session: verified,
    preconditions: [{ address_label: current.address_label, expected_current: current.expected_current }],
    hostedAuthority: { browserId, origin: config.origin } });
  const authority = { actor_ref: verified.accountId, session_ref: `account-session:${verified.sessionId}`,
    session_revision: verified.sessionRevision, expires_at_milliseconds: verified.expiresAt * 1000, state: 'active' as const };
  return { session: { ...session, accountId: verified.accountId, authority, sessionExpiresAtMilliseconds: authority.expires_at_milliseconds },
    browserEffects: { cookies: [{ ...accountAccessSessionCookieForToken(state.token), maxAge: Math.max(0, verified.expiresAt - Math.floor(nowMs / 1000)) }] } };
}

export async function verifyDesktopAuthoritySnapshot(config: HostedAccountAuthority, authority: CurrentSessionAuthority, nowMs: number, sender: Sender = sendRequestToBitfieldTarget) {
  if (authority.state !== 'active' || authority.hosted_origin !== config.origin || !authority.hosted_browser_id) return false;
  const current = await stateRead(authority.hosted_browser_id, sender);
  if (!current.found || current.payload?.origin !== config.origin || current.payload?.browser_id !== authority.hosted_browser_id) return false;
  const verified = await callHostedAccountAuthority(config, 'revision', { actor_ref: authority.actor_ref,
    session_ref: authority.session_ref, session_revision: String(authority.session_revision) }, sender);
  return verified.verified === true && verified.session_revision === String(authority.session_revision)
    && authority.expires_at_milliseconds > nowMs;
}

export async function clearDesktopAccountSession(config: HostedAccountAuthority, browserId: string, context?: BitfieldRuntimeContext, sender: Sender = sendRequestToBitfieldTarget, sessionAccessKey?: unknown) {
  requireLocalAdmission(context);
  accessHash(sessionAccessKey);
  const current = await stateRead(browserId, sender);
  if (!current.found) return;
  const state = await load(browserId, current.payload.request_id, sender, sessionAccessKey, config.origin);
  requireAccess(state, sessionAccessKey);
  if (state.origin !== config.origin || state.browser_id !== browserId) throw new Error('Sign-in service binding changed.');
  if (state.state === 'active') {
    const revoked = await callHostedAccountAuthority(config, 'revoke', { token: state.token }, sender);
    if (revoked.revoked !== true) throw new Error('Sign-out could not finish. Try again.');
  }
  const result = JSON.parse(new TextDecoder().decode((await sender({ target: 'engine.operation.label-addressed', payload: {
    operation_label: 'engine.operation.write-batch', writes: [{ address_label: current.address_label,
      expected_current: current.expected_current, path_labels: ['account-session', 'desktop-client'] }],
  } })).payload));
  if (result.write_count !== 1 && result.writeCount !== 1) throw new Error('Sign-in state changed.');
  await vault({ operation: 'delete', key: secretKey(browserId, current.payload.request_id) }, sender);
}
