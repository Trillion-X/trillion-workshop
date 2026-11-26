// The business's own clean-up, reached by address (settings.delete_user.before_delete_url) for a unit whose copy of this tool is a pinned
// checkout it cannot put code into. Before a person's account is deleted, this tool POSTs {user_id, email} to that local address. The
// request is signed with the secret the unit holds under the name settings.delete_user.before_delete_secret (read from the credentials
// folder, CREDENTIALS_DIRECTORY, as the email sender reads its key): x-sign-in-timestamp is the time in whole seconds, and
// x-sign-in-signature is `sha256=` plus the HMAC-SHA256 of `<timestamp>.<body>` with that secret, in lower-case hex. The business checks
// the signature over the raw body it received and refuses a timestamp more than a few minutes old. Any answer other than 2xx, a refused
// connection or a timeout throws, and the account is kept.
// postSigned is the one signed local call of this tool: the after-sign-up call (after-sign-up.ts) is signed the same way.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SIGNATURE_HEADER = 'x-sign-in-signature';
export const TIMESTAMP_HEADER = 'x-sign-in-timestamp';

/** The signature a body sent at `timestamp` carries, under `secret`. */
export function signatureOf(secret, timestamp, body) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** POSTs `payload` as JSON to `url`, signed with the credential named `secretName` (the credentials folder), waiting at most
 * `timeoutMs`; answers the response. A missing credentials folder throws before anything is sent. */
export async function postSigned(url, secretName, payload, timeoutMs, { now = Date.now() } = {}) {
  const folder = process.env.CREDENTIALS_DIRECTORY;
  if (!folder) throw new Error(`the credential ${secretName} is not handed to this process (no CREDENTIALS_DIRECTORY)`);
  const secret = readFileSync(join(folder, secretName), 'utf8').trim();
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now / 1000));
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signatureOf(secret, timestamp, body) },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Asks the business's clean-up to remove the person's rows. Resolves when it answers 2xx; throws otherwise. */
export async function callBeforeDelete(delete_user, user, { now = Date.now() } = {}) {
  const answer = await postSigned(delete_user.before_delete_url, delete_user.before_delete_secret, { user_id: user.id, email: user.email }, delete_user.before_delete_timeout_ms, { now });
  if (!answer.ok) throw new Error(`the clean-up before deleting an account answered HTTP ${answer.status}; the account is kept`);
}
