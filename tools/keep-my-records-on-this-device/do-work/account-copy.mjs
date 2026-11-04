// An offline copy belongs to the account that opened it, including every sync request.
// Unbound legacy directories are deliberately left untouched for recovery; they are never adopted.
import { compressFrame } from './frame-compression.mjs';

export const DEVICE_ACCOUNT_HEADER = 'x-trillion-device-account';

export function accountCopyLocation(account) {
  if (typeof account !== 'string' || !account || account.length > 256) throw new Error('Sign in to keep records on this device.');
  // Encode bytes, not a lossy slug: two account names can never select the same directory.
  const name = [...new TextEncoder().encode(account)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { directory: `.trillion-account-records-${name}`, name: 'records.sqlite3' };
}

export function accountCopySender({ account, url, fetch: fetchAnswer = globalThis.fetch, stopped = () => {} }) {
  accountCopyLocation(account);
  let active = true;
  const abort = new AbortController();
  const stop = () => { if (!active) return; active = false; abort.abort(); stopped(); };
  const send = async request => {
    if (!active) throw new Error('This account’s copy is closed.');
    // A large batch goes as a frame compressed against the sample of settle JSON both ends hold (frame-compression.mjs);
    // a short one, or one that would not shrink, goes as plain JSON, which the receiver always reads.
    const text = JSON.stringify(request);
    const frame = compressFrame(text);
    const response = await fetchAnswer(url, { method: 'POST', credentials: 'same-origin', signal: abort.signal,
      headers: { 'content-type': 'application/json', [DEVICE_ACCOUNT_HEADER]: account, ...frame?.headers }, body: frame?.body ?? text });
    if ([401, 403, 409].includes(response.status)) stop();
    const answer = await response.json().catch(() => ({}));
    if (!active) throw new Error('Sign in again to use this account’s copy.');
    if (!response.ok) throw new Error(answer.error ?? `The store answered ${response.status}.`);
    return answer;
  };
  return { send, stop };
}
