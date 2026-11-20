// tools/keep-anything-sent-to-the-account-a-link-file/read-data/share-inbox-rules.mjs
//
// The decisions of the share inbox, with no storage in them (ported from the earlier code base src/share-inbox.mjs at b6ae0ebf815f):
// whether a store's answer means "not now", what a share is kept as, when a kept share resumes, what the answer means for
// the kept share (delivered, still waiting, or refused for good with its reason), and when it is too big or has tried too
// often. Which storage holds what waits is an owner ruling, so this file names none; the numbers and words are DATA
// (share-inbox-rules.json).
import rules from './share-inbox-rules.json' with { type: 'json' };

const NOT_NOW = [408, 429];

/** Whether a reply status says the store did not answer now: 5xx, 408 timed out, 429 used up for now. */
export const notNowStatus = status => Number(status) >= 500 || NOT_NOW.includes(Number(status));

/** The bytes a request holds: its body text and its files' base64. Refused past max_bytes; never kept half. */
export function tooBig(body, files = []) {
  const size = String(body).length + (files ?? []).reduce((sum, file) => sum + (file.base64?.length ?? 0), 0);
  return size > rules.max_bytes;
}

/** The request as kept: { key, body } with a request_key (the one the device sent, else a new one), or null when it is not a
 *  share this road can keep (not an object, no list of items, or a `to` that is not a list). */
export function shareToKeep(text, makeKey = () => `rk_${crypto.randomUUID()}`) {
  let given;
  try { given = JSON.parse(text); } catch { return null; }
  if (!given || typeof given !== 'object' || Array.isArray(given)) return null;
  if (!Array.isArray(given.items) || !given.items.length) return null;
  if (given.to !== undefined && !Array.isArray(given.to)) return null;
  const key = typeof given.request_key === 'string' && given.request_key.trim() ? given.request_key : makeKey();
  return { key, body: JSON.stringify({ ...given, request_key: key }) };
}

/**
 * When a refused answer says it runs again, in ms since epoch, clamped to resume_wait_at_most_seconds from now; null when
 * it names no later time. `answer` is { retry_at?, retry_after? } (retry_after as seconds or an HTTP date).
 */
export function resumeAtOf({ retry_at: retryAt, retry_after: retryAfter } = {}, now = Date.now()) {
  let at = Date.parse(retryAt ?? '');
  if (!Number.isFinite(at)) {
    at = /^\d+$/.test(String(retryAfter ?? '').trim()) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter ?? '');
  }
  if (!Number.isFinite(at) || at <= now) return null;
  return Math.min(at, now + rules.resume_wait_at_most_seconds * 1000);
}

/**
 * What the store's answer means for the kept share:
 *   { outcome: 'delivered' }                       the store took it (2xx, not queued): delete the kept share
 *   { outcome: 'later', resumeAt }                  not now (5xx, 408, 429) or queued: keep it
 *   { outcome: 'refused', status, reason_code, reason }  refused for good (other 4xx): keep it refused with its reason
 * `answer` is { status, ok, body? } where body is the parsed JSON (or null). The receiver's own words are kept exactly.
 */
export function outcomeOfAnswer({ status, ok, body = null }, now = Date.now()) {
  if (notNowStatus(status)) return { outcome: 'later', resumeAt: resumeAtOf(body ?? {}, now) };
  if (ok) return body?.queued === true ? { outcome: 'later', resumeAt: null } : { outcome: 'delivered' };
  const reason = typeof body?.error === 'string' && body.error.trim() ? body.error : null;
  return reason
    ? { outcome: 'refused', status, reason_code: 'receiver_refused', reason }
    : { outcome: 'refused', status, reason_code: 'receiver_refused_without_reason', reason: rules.no_reason };
}

/** Whether a kept share has tried too often to keep waiting (give_up_after_tries). */
export const gaveUp = tries => Number(tries) >= rules.give_up_after_tries;

/** The status line the share list shows for a kept share: waiting, or could not deliver with the reason. */
export function statusWords(entry) {
  if (entry.refused) return rules.refused_status.replace('{reason}', entry.refused.reason ?? rules.no_reason);
  return rules.waiting_status;
}

export { rules };
