// tools/take-payments/do-work/stripe-send.mjs
//
// The only place a Stripe key is read and used. A row mounts the person's own key (the held value named in the row's
// credential_mounts) on a private descriptor; `heldKey` reads it, `makeStripeSender` puts it on the Authorization
// header of one request at the moment of sending. The key is never returned, never printed, never put in an error: a
// Stripe refusal is reported by Stripe's own message with every key-shaped word redacted.
//
//   const send = makeStripeSender({ key: heldKey(4) });
//   const reply = await send(buildStripeHttpRequest({ ... }));    // the decoded JSON reply, or a StripeError
import { readFileSync } from 'node:fs';
import { redactStripeResponse } from './stripe-response-redactor.mjs';

export class StripeError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** The person's held Stripe key, read from the descriptor the row mounts it on. Refuses when none arrived. */
export function heldKey(descriptor, read = fd => readFileSync(fd, 'utf8')) {
  let value = '';
  try { value = read(descriptor).trim(); } catch { value = ''; }
  if (!value) throw new StripeError('No Stripe key arrived: put your Stripe key in your held values under the name this tool asks for.', 400);
  return value;
}

/**
 * @param {{ key: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {(request: { method: string, url: string, headers: Record<string,string>, body?: string }) => Promise<Record<string, unknown>>}
 */
export function makeStripeSender({ key, fetchImpl = fetch, timeoutMs = 30_000 }) {
  if (typeof key !== 'string' || !key) throw new StripeError('A Stripe key is required to send.', 400);
  return async function send(request) {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers, Authorization: `Bearer ${key}` },
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed = {};
    try { parsed = text.trim() ? JSON.parse(text) : {}; } catch { parsed = {}; }
    if (response.status < 200 || response.status >= 300) {
      const said = redactStripeResponse(parsed)?.error?.message;
      throw new StripeError(typeof said === 'string' && said ? said : 'Stripe rejected the request.', response.status || 502);
    }
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  };
}
