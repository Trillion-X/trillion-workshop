'use client';

import React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

type DeviceGrantRequest = {
  device_public_key_hash: string;
};

type EligibilityAssertion = {
  payload: {
    assertion_id: string;
    license_account_id: string;
    manifest_policy_id: string;
    device_public_key_hash: string;
    issued_at: number;
    expires_at: number;
  };
  signer_id: string;
  signature_hex: string;
};

type ProvisionedHandoff = {
  handoff: { code: string; expires_at: number };
};

type PendingDeviceGrant = {
  callbackUrl: string;
  codeChallenge: string;
  request: DeviceGrantRequest;
  state: string;
};

type ActivationStatus =
  | 'checking'
  | 'authorizing'
  | 'returning'
  | 'complete'
  | 'failed';

const HASH_PATTERN = /^1f:[0-9a-f]{64}$/i;
const PKCE_VALUE_PATTERN = /^[a-zA-Z0-9_-]{43}$/;
const ELIGIBILITY_ASSERTION_AUTHOR_TARGET = 'eligibility-assertion-author.author';
const RUNTIME_GRANT_PROVISION_TARGET = 'runtime-grant-provisioner.provision';
const PENDING_ACTIVATION_SESSION_KEY = 'bitfield.runtime-activation.pending.v1';
const PENDING_ACTIVATION_LOCAL_KEY = 'bitfield.runtime-activation.pending-cross-tab.v1';
const PENDING_ACTIVATION_MAX_AGE_MS = 10 * 60 * 1000;
const CALLBACK_PATH = '/bitfield/runtime-activation/callback';

function single(params: URLSearchParams, key: string) {
  const values = params.getAll(key).map((value) => value.trim()).filter(Boolean);
  if (values.length !== 1) return null;
  return values[0];
}

function safePkceValue(value: string | null) {
  if (!value || !PKCE_VALUE_PATTERN.test(value)) return null;
  return value;
}

function safeHash(value: string | null) {
  if (!value || !HASH_PATTERN.test(value)) return null;
  return value;
}

function safeLoopbackCallbackUrl(value: string | null) {
  if (!value || value.length > 1024) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'http:') return null;
    if (!url.port) return null;
    if (hostname !== '127.0.0.1') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== CALLBACK_PATH) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function readPendingDeviceGrant(queryString: string): PendingDeviceGrant | null {
  if (queryString.length > 2048) return null;
  const params = new URLSearchParams(queryString);
  const request = {
    device_public_key_hash: safeHash(single(params, 'device_public_key_hash')),
  };
  const callbackUrl = safeLoopbackCallbackUrl(single(params, 'callback_uri'));
  const state = safePkceValue(single(params, 'state'));
  const codeChallenge = safePkceValue(single(params, 'code_challenge'));
  if (
    !request.device_public_key_hash ||
    !callbackUrl ||
    !state ||
    !codeChallenge ||
    single(params, 'code_challenge_method') !== 'S256'
  ) {
    return null;
  }
  return {
    callbackUrl,
    codeChallenge,
    request: request as DeviceGrantRequest,
    state,
  };
}

function canonicalPendingDeviceGrantFragment(queryString: string) {
  const pending = readPendingDeviceGrant(queryString);
  if (!pending) return '';
  return new URLSearchParams({
    callback_uri: pending.callbackUrl,
    code_challenge: pending.codeChallenge,
    code_challenge_method: 'S256',
    device_public_key_hash: pending.request.device_public_key_hash,
    state: pending.state,
  }).toString();
}

function browserStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    return storage
      && typeof storage.getItem === 'function'
      && typeof storage.setItem === 'function'
      ? storage
      : null;
  } catch {
    return null;
  }
}

function storeCrossTabPendingActivation(fragment: string) {
  browserStorage()?.setItem(PENDING_ACTIVATION_LOCAL_KEY, JSON.stringify({
    fragment,
    stored_at_milliseconds: Date.now(),
  }));
}

function takeCrossTabPendingActivation() {
  const storage = browserStorage();
  const raw = storage?.getItem(PENDING_ACTIVATION_LOCAL_KEY);
  storage?.removeItem(PENDING_ACTIVATION_LOCAL_KEY);
  if (!raw) return '';
  try {
    const value = JSON.parse(raw) as { fragment?: unknown; stored_at_milliseconds?: unknown };
    const storedAt = Number(value.stored_at_milliseconds);
    if (
      typeof value.fragment !== 'string'
      || !Number.isSafeInteger(storedAt)
      || storedAt > Date.now()
      || Date.now() - storedAt > PENDING_ACTIVATION_MAX_AGE_MS
    ) {
      return '';
    }
    return canonicalPendingDeviceGrantFragment(value.fragment);
  } catch {
    return '';
  }
}

function clearPendingActivation() {
  globalThis.sessionStorage?.removeItem(PENDING_ACTIVATION_SESSION_KEY);
  browserStorage()?.removeItem(PENDING_ACTIVATION_LOCAL_KEY);
}

function useBrowserQueryString() {
  const [queryString, setQueryString] = React.useState<string | null>(null);
  React.useEffect(() => {
    const rawFragment = globalThis.location?.hash?.startsWith('#')
      ? globalThis.location.hash.slice(1)
      : '';
    const fragment = rawFragment ? canonicalPendingDeviceGrantFragment(rawFragment) : '';
    if (rawFragment) {
      globalThis.history?.replaceState(null, '', `${globalThis.location.pathname}${globalThis.location.search}`);
    }
    if (fragment) {
      globalThis.sessionStorage?.setItem(PENDING_ACTIVATION_SESSION_KEY, fragment);
      // Account-portal authentication and checkout returns may cross tabs. The
      // launch fragment contains only public, bounded request fields (never the
      // verifier, code, assertion, or receipt), so retain it for at most ten
      // minutes in same-origin storage.
      storeCrossTabPendingActivation(fragment);
    } else if (rawFragment) {
      clearPendingActivation();
    }
    const crossTab = fragment ? '' : takeCrossTabPendingActivation();
    if (crossTab) {
      globalThis.sessionStorage?.setItem(PENDING_ACTIVATION_SESSION_KEY, crossTab);
    }
    const nextQuery = fragment
      || crossTab
      || globalThis.sessionStorage?.getItem(PENDING_ACTIVATION_SESSION_KEY)
      || '';
    setQueryString(nextQuery);
  }, []);
  return queryString;
}

function readJsonReply<T>(payload: Uint8Array): T {
  const text = new TextDecoder().decode(payload);
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

function validEligibilityAssertion(value: unknown): value is EligibilityAssertion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const assertion = value as Record<string, unknown>;
  const payload = assertion.payload;
  return Boolean(
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && typeof assertion.signer_id === 'string'
    && /^[0-9a-f]{128}$/i.test(String(assertion.signature_hex ?? '')),
  );
}

async function authorizeDeviceGrant(
  request: DeviceGrantRequest,
  codeChallenge: string,
): Promise<ProvisionedHandoff> {
  const assertionReply = await sendRequestToBitfieldTarget({
    target: ELIGIBILITY_ASSERTION_AUTHOR_TARGET,
    payload: { device_public_key_hash: request.device_public_key_hash },
  });
  const assertionBody = readJsonReply<{ eligibility_assertion?: unknown; error?: unknown }>(assertionReply.payload);
  const assertion = assertionBody.eligibility_assertion ?? assertionBody;
  if (!validEligibilityAssertion(assertion)) {
    throw new Error('Bitfield did not return a signed eligibility assertion.');
  }
  const provisionReply = await sendRequestToBitfieldTarget({
    target: RUNTIME_GRANT_PROVISION_TARGET,
    payload: {
      eligibility_assertion: assertion,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    },
  });
  const provisioned = readJsonReply<Partial<ProvisionedHandoff> & { error?: unknown }>(provisionReply.payload);
  if (
    !provisioned.handoff
    || !PKCE_VALUE_PATTERN.test(String(provisioned.handoff.code ?? ''))
    || !Number.isSafeInteger(provisioned.handoff.expires_at)
  ) {
    throw new Error('Bitfield did not return an opaque activation handoff.');
  }
  return provisioned as ProvisionedHandoff;
}

function postHandoffToLoopback(callbackUrl: string, code: string, state: string) {
  const form = document.createElement('form');
  form.action = callbackUrl;
  form.method = 'POST';
  form.enctype = 'application/x-www-form-urlencoded';
  for (const [name, value] of [['code', code], ['state', state]]) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

function AuthorizeDeviceGrantContent() {
  const queryString = useBrowserQueryString();
  const pending = queryString === null ? null : readPendingDeviceGrant(queryString);
  const [status, setStatus] = React.useState<ActivationStatus>('checking');
  const [message, setMessage] = React.useState('Checking this device request.');

  React.useEffect(() => {
    let cancelled = false;
    if (queryString === null) {
      return () => {
        cancelled = true;
      };
    }
    if (!pending) {
      setStatus('failed');
      setMessage('This device authorization link is incomplete.');
      return () => {
        cancelled = true;
      };
    }
    const deviceGrant = pending;

    async function run() {
      try {
        // This entry is published only behind hosted-public-app's account-mode
        // authority. The carrier validates the durable session and injects a
        // current server admission for each declared target. Duplicating login
        // inside this browser entry would require exposing unauthenticated
        // account-session targets through the protected target route.
        setStatus('authorizing');
        setMessage('Authorizing this device.');
        const provisioned = await authorizeDeviceGrant(
          deviceGrant.request,
          deviceGrant.codeChallenge,
        );
        if (cancelled) return;
        setStatus('returning');
        setMessage('Returning to Bitfield on this computer.');
        clearPendingActivation();
        postHandoffToLoopback(
          deviceGrant.callbackUrl,
          provisioned.handoff.code,
          deviceGrant.state,
        );
      } catch (error) {
        if (cancelled) return;
        const raw = error instanceof Error ? error.message : String(error);
        console.error('[activation-manager] device authorization failed:', raw);
        setStatus('failed');
        setMessage('Device authorization failed. Please try again or contact support.');
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  return (
    <main className="account-access-root" data-bitfield-account-web-app>
      <section className="account-access-frame">
        <section className="account-ui-container account-ui-container--column account-ui-container--gap-lg">
          <div className="account-ui-container account-ui-container--column account-ui-container--gap-xs">
            <p className="account-ui-text account-ui-text--label">Bitfield</p>
            <h1 className="account-ui-text account-ui-text--hero">Authorize this device.</h1>
            <p className="account-ui-text account-ui-text--body account-ui-text--muted">{message}</p>
          </div>
          {status === 'failed' ? (
            <div className="account-ui-container account-ui-container--column account-ui-container--gap-sm">
              <p className="account-ui-text account-ui-text--body account-ui-text--muted" role="alert">
                Start activation again from Bitfield on this computer.
              </p>
              <a className="account-ui-button" data-tone="quiet" href="/account">
                Open account
              </a>
            </div>
          ) : null}
          {status === 'complete' ? (
            <button className="account-ui-button" type="button" onClick={() => window.close()}>
              Close this tab
            </button>
          ) : null}
        </section>
      </section>
    </main>
  );
}

export function AuthorizeDeviceGrantPage() {
  return (
    <React.Suspense
      fallback={
        <main className="account-access-root" data-bitfield-account-web-app>
          <section className="account-access-frame">
            <section className="account-ui-container account-ui-container--column account-ui-container--gap-lg">
              <p className="account-ui-text account-ui-text--body account-ui-text--muted">
                Preparing device authorization.
              </p>
            </section>
          </section>
        </main>
      }
    >
      <AuthorizeDeviceGrantContent />
    </React.Suspense>
  );
}

export default AuthorizeDeviceGrantPage;
