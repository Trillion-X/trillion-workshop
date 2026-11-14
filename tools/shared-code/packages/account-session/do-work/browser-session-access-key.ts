const KEY = 'bitfield.account-session.presenter-access-key';
const ID = 'bitfield.account-session.presenter-browser-id';
const PERSISTED = 'bitfield.account-session.presenter-browser-credential';
const ADOPTED = 'bitfield.account-session.presenter-browser-credential-adopted';
const LEGACY_CANDIDATE = 'bitfield.account-session.presenter-browser-credential-legacy-candidate';

type BrowserCredential = { browserId: string; accessKey: string };

function validCredential(value: unknown): value is BrowserCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pair = value as Partial<BrowserCredential>;
  return typeof pair.browserId === 'string' && /^browser:[A-Za-z0-9._:-]{8,200}$/.test(pair.browserId)
    && typeof pair.accessKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(pair.accessKey);
}

function storedPair(storage: Storage | undefined, key: string): BrowserCredential | null {
  try {
    const value = storage?.getItem(key);
    if (!value) return null;
    const parsed = JSON.parse(value) as unknown;
    return validCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function legacyTabPair(): BrowserCredential | null {
  try {
    const pair = {
      browserId: globalThis.sessionStorage.getItem(ID),
      accessKey: globalThis.sessionStorage.getItem(KEY),
    };
    return validCredential(pair) ? pair : null;
  } catch {
    return null;
  }
}

function newCredential(): BrowserCredential {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return {
    browserId: `browser:${globalThis.crypto.randomUUID()}`,
    accessKey: btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
  };
}

/** Keep browser correlation and its capability paired across tabs and restarts.
 * The server's current authority record still decides expiry and revocation.
 * Adopt the older per-tab pair once so people already signed in keep access. */
function currentCredential(): BrowserCredential {
  let persistent: Storage | undefined;
  try { persistent = globalThis.localStorage; } catch { /* private storage may be unavailable */ }
  const saved = storedPair(persistent, PERSISTED);
  const legacy = legacyTabPair();
  // A cloned old tab must not replace the shared credential until its old
  // session has been checked against the current authority record.
  const candidate = legacy && saved
    && (legacy.browserId !== saved.browserId || legacy.accessKey !== saved.accessKey)
    ? legacy : null;
  const pair = saved ?? legacy ?? newCredential();
  try { persistent?.setItem(PERSISTED, JSON.stringify(pair)); } catch { /* retain the tab fallback */ }
  try {
    if (candidate) globalThis.sessionStorage.setItem(LEGACY_CANDIDATE, JSON.stringify(candidate));
    globalThis.sessionStorage.setItem(ID, pair.browserId);
    globalThis.sessionStorage.setItem(KEY, pair.accessKey);
    globalThis.sessionStorage.setItem(ADOPTED, '1');
  } catch { /* the persistent pair is enough */ }
  return pair;
}

export function unverifiedLegacyPresenterBrowserCredential(): BrowserCredential | null {
  try { return storedPair(globalThis.sessionStorage, LEGACY_CANDIDATE); } catch { return null; }
}

export function adoptVerifiedLegacyPresenterBrowserCredential(candidate: BrowserCredential): void {
  const pending = unverifiedLegacyPresenterBrowserCredential();
  if (!pending || pending.browserId !== candidate.browserId || pending.accessKey !== candidate.accessKey) return;
  try { globalThis.localStorage.setItem(PERSISTED, JSON.stringify(candidate)); } catch { /* tab fallback */ }
  try {
    globalThis.sessionStorage.setItem(ID, candidate.browserId);
    globalThis.sessionStorage.setItem(KEY, candidate.accessKey);
    globalThis.sessionStorage.setItem(ADOPTED, '1');
    globalThis.sessionStorage.removeItem(LEGACY_CANDIDATE);
  } catch { /* persistent pair remains usable */ }
}

export function forgetUnverifiedLegacyPresenterBrowserCredential(): void {
  try { globalThis.sessionStorage.removeItem(LEGACY_CANDIDATE); } catch { /* unavailable storage */ }
}

export function currentPresenterBrowserSessionId(): string {
  return currentCredential().browserId;
}

export function currentBrowserSessionAccessKey(): string {
  return currentCredential().accessKey;
}

export function forgetPresenterBrowserSession(): void {
  try { globalThis.localStorage.removeItem(PERSISTED); } catch { /* unavailable storage */ }
  try {
    globalThis.sessionStorage.removeItem(ID);
    globalThis.sessionStorage.removeItem(KEY);
    globalThis.sessionStorage.removeItem(ADOPTED);
    globalThis.sessionStorage.removeItem(LEGACY_CANDIDATE);
  } catch { /* unavailable storage */ }
}
