// packages/service-connections/do-work/shell-redirect-acquisition.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// An OAuth authorization-code acquire that needs NO child process. The app
// shell is already a browser on a loopback origin, so it opens the provider's
// authorize URL itself and it receives the redirect itself. This file owns the
// two halves of that round trip:
//
//   begin:    build the authorize URL from the descriptor, remember a `state`
//             value on this browser, and navigate to the provider.
//   complete: on return, read `code` and `state` from the entry context, refuse
//             a `state` this browser did not issue, run the workflow action that
//             exchanges the code inside the engine (the client secret never
//             reaches JS), and write the connection facts.
//
// Selected by DATA presence: a descriptor whose `redirect.transport` is
// "shell". No vendor name appears here (L090). Every authorization-code
// provider whose client accepts a loopback redirect is one descriptor row.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
// 1. The token exchange happens in the workflow, never here. This file sees a
//    one-time `code` and an account label; it never sees a token or a secret.
// 2. `state` is issued per attempt, stored on this browser before navigation,
//    and checked verbatim on return (RFC 6749 section 10.12). A mismatch writes
//    nothing.
// 3. The redirect_uri sent at authorize time is the one echoed at exchange time;
//    it is carried inside the stored attempt, not recomputed.
// 4. The query is stripped from the address bar the moment it is read, so a
//    reload cannot replay it and it does not sit in history.
// 5. One attempt is consumed exactly once: the stored attempt is removed before
//    the exchange runs.
// 6. Owner actions and the fact write arrive through `seams`
//    (ServiceConnectionSeams); no seams = `engineSeams`, the engine route.

import {
  connectServiceWithCredentialHandle,
  type ServiceConnectionSeams,
} from '@/packages/service-connections/do-work/connect-service';
import { engineSeams } from '@/packages/service-connections/do-work/engine-seams';
import {
  deriveConnectionInstanceId,
  type ServiceAcquireDescriptor,
  type ServiceConnectionTarget,
} from '@/packages/service-connections/read-data/read-service-connection-options';

const ATTEMPT_STORAGE_KEY = 'bitfield.service-connections.shell-redirect-attempt';

/** True when the descriptor asks the shell itself to receive the redirect. */
export function isShellRedirectAcquire(acquire: unknown): acquire is ServiceAcquireDescriptor {
  return !!acquire
    && typeof acquire === 'object'
    && typeof (acquire as ServiceAcquireDescriptor).redirect === 'object'
    && (acquire as ServiceAcquireDescriptor).redirect?.transport === 'shell';
}

export interface ShellRedirectAttempt {
  state: string;
  redirectUri: string;
  connection: ServiceConnectionTarget;
  acquire: ServiceAcquireDescriptor;
  /** The OAuth client id, read from the descriptor's vault-held client by the
   *  begin action; the authorize URL needs it and it is not secret. */
  clientId: string;
}

function browserStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

function randomState(): string {
  const cryptoSource = globalThis.crypto;
  if (cryptoSource && typeof cryptoSource.randomUUID === 'function') return cryptoSource.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function outputRecord(reply: unknown): Record<string, unknown> {
  const record = reply && typeof reply === 'object' ? reply as Record<string, unknown> : {};
  const output = record.output;
  return output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, unknown>
    : record;
}

/**
 * Build the authorize URL for a shell-received redirect. Pure: the caller
 * supplies the origin (the shell's own) and the client id.
 */
export function buildShellRedirectAuthorizeUrl(input: {
  acquire: ServiceAcquireDescriptor;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(String(input.acquire.authorize_url ?? ''));
  for (const [key, value] of Object.entries(input.acquire.auth_params ?? {})) url.searchParams.set(key, value);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.acquire.scopes ?? []).join(' '));
  url.searchParams.set('state', input.state);
  return url.toString();
}

/**
 * Remember the attempt on this browser and navigate to the provider. Returns
 * the URL it navigated to (for tests; `navigate` is injectable).
 */
export async function beginShellRedirectAcquisition(input: {
  acquire: ServiceAcquireDescriptor;
  connection: ServiceConnectionTarget;
  origin: string;
  navigate?: (url: string) => void;
  storage?: Storage | null;
}, seams: ServiceConnectionSeams = engineSeams()): Promise<string> {
  // The client id is not secret, but it lives in the vault beside its secret.
  // The read action returns only the id.
  const reply = await seams.runOwnerAction(
    'read-oauth-client-id',
    { acquire: input.acquire },
    { includeOutput: true },
  );
  const clientId = readString(outputRecord(reply), 'client_id');
  if (!clientId) throw new Error('Sign-in is not ready for this service because its secure app setup is missing.');

  const state = randomState();
  const redirectUri = `${input.origin.replace(/\/$/, '')}/`;
  const attempt: ShellRedirectAttempt = {
    state,
    redirectUri,
    connection: input.connection,
    acquire: input.acquire,
    clientId,
  };
  const storage = input.storage === undefined ? browserStorage() : input.storage;
  if (!storage) throw new Error('This browser cannot remember the sign-in attempt.');
  storage.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify(attempt));
  const url = buildShellRedirectAuthorizeUrl({ acquire: input.acquire, clientId, redirectUri, state });
  (input.navigate ?? ((target) => { globalThis.location.assign(target); }))(url);
  return url;
}

/** The attempt this browser stored before leaving, or null. Reading consumes it. */
export function takeStoredShellRedirectAttempt(storage: Storage | null = browserStorage()): ShellRedirectAttempt | null {
  if (!storage) return null;
  const raw = storage.getItem(ATTEMPT_STORAGE_KEY);
  if (!raw) return null;
  storage.removeItem(ATTEMPT_STORAGE_KEY);
  try {
    const parsed = JSON.parse(raw) as ShellRedirectAttempt;
    return parsed && typeof parsed.state === 'string' && parsed.state ? parsed : null;
  } catch {
    return null;
  }
}

export interface ShellRedirectCompletion {
  accountLabel: string;
  connectionId: string;
}

/**
 * Finish a shell-received redirect. `query` is the entry context's query map.
 * Returns null when there is nothing to complete (no code in the query, or no
 * stored attempt). Throws when the provider returned an error or the state
 * does not match.
 */
export async function completeShellRedirectAcquisition(input: {
  query: Record<string, string>;
  existingConnectionIds?: Iterable<string>;
  storage?: Storage | null;
  writeFacts?: typeof connectServiceWithCredentialHandle;
}, seams: ServiceConnectionSeams = engineSeams()): Promise<ShellRedirectCompletion | null> {
  const code = input.query.code ?? '';
  const state = input.query.state ?? '';
  const providerError = input.query.error ?? '';
  if (!code && !providerError) return null;
  const attempt = takeStoredShellRedirectAttempt(input.storage === undefined ? browserStorage() : input.storage);
  if (!attempt) return null;
  if (providerError) throw new Error(`The service refused the sign-in: ${providerError}`);
  if (state !== attempt.state) throw new Error('The sign-in reply did not match this browser. Try again.');

  const reply = await seams.runOwnerAction(
    'exchange-authorization-code',
    {
      acquire: attempt.acquire,
      code,
      redirect_uri: attempt.redirectUri,
      redirect_uri_encoded: encodeURIComponent(attempt.redirectUri),
    },
    { includeOutput: true },
  );
  const result = outputRecord(reply);
  const accountLabel = readString(result, 'account_label');
  const credentialHandleRef = readString(result, 'credential_handle_ref');
  const resourceId = readString(result, 'resource_id');
  const resourceCollection = attempt.acquire.identity?.resource_collections?.[0];
  const resourceRef = resourceId && resourceCollection?.ref_prefix
    ? `${resourceCollection.ref_prefix}${resourceId}`
    : '';
  if (!accountLabel || !credentialHandleRef) {
    throw new Error('The sign-in finished but returned no account. Try again.');
  }
  const connectionId = deriveConnectionInstanceId(
    attempt.connection.serviceVendor,
    accountLabel,
    new Set(input.existingConnectionIds ?? []),
  );
  const writeFacts = input.writeFacts ?? connectServiceWithCredentialHandle;
  await writeFacts({
    connection: {
      ...attempt.connection,
      id: connectionId,
      accountLabel,
      resourceRefs: resourceRef ? [resourceRef] : [],
    },
    credentialHandleRef,
  }, undefined, seams);
  return { accountLabel, connectionId };
}

/** Remove `code`, `state` and `error` from the address bar without a reload. */
export function stripShellRedirectQuery(location: Location = globalThis.location, history: History = globalThis.history): void {
  const url = new URL(location.href);
  if (!url.searchParams.has('code') && !url.searchParams.has('state') && !url.searchParams.has('error')) return;
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  url.searchParams.delete('scope');
  history.replaceState(history.state, '', url.toString());
}
