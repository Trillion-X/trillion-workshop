const BROWSER_ID_STORAGE_KEY = 'bitfield.account-session.browser-id';

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

function randomId() {
  const cryptoSource = globalThis.crypto;
  if (cryptoSource && typeof cryptoSource.randomUUID === 'function') {
    return cryptoSource.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function currentLogBrowserSessionBrowserId() {
  const storage = browserStorage();
  const existing = storage?.getItem(BROWSER_ID_STORAGE_KEY)?.trim();
  if (existing) return existing;
  const next = `browser:${randomId()}`;
  storage?.setItem(BROWSER_ID_STORAGE_KEY, next);
  return next;
}
