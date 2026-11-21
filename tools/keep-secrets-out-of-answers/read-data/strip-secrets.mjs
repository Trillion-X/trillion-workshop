// tools/keep-secrets-out-of-answers/read-data/strip-secrets.mjs
//
// PURPOSE: the one place that takes sign-in secrets out of a service's answer before a tool hands it back. A service can put
// the caller's own token inside its answer: Meta's Graph API writes access_token=… into every paging.next and
// paging.previous link, and other services echo keys in URLs or headers. stripSecrets walks any JSON value and gives back a
// copy where each such secret reads "[removed]", so a step answer, a run record or a chat transcript never holds one.
// Nothing here names a service or a tool.

export const REMOVED = '[removed]';

// Query parameters that carry a secret in a URL (compared without case).
const SECRET_PARAMS = new Set(['access_token', 'accesstoken', 'token', 'api_key', 'apikey', 'key', 'client_secret',
  'refresh_token', 'id_token', 'code', 'signature', 'sig', 'x-amz-signature', 'x-goog-signature', 'password', 'secret']);

// Object fields that hold a secret value whatever is in them (compared without case or - and _).
const SECRET_FIELDS = new Set(['accesstoken', 'refreshtoken', 'idtoken', 'token', 'apikey', 'xapikey', 'clientsecret',
  'authorization', 'proxyauthorization', 'cookie', 'setcookie', 'password', 'secret']);

const fieldKey = name => name.toLowerCase().replace(/[-_]/g, '');

// One URL-shaped string with each secret query parameter's value replaced; any other string comes back as it was.
const QUERY_PARAM = /([?&;])([^=&#\s"']+)=([^&#\s"']*)/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

export function stripSecretsFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .replace(QUERY_PARAM, (all, lead, name, value) =>
      (value && SECRET_PARAMS.has(decodeSafe(name).toLowerCase()) ? `${lead}${name}=${REMOVED}` : all))
    .replace(BEARER, (all, scheme) => `${scheme} ${REMOVED}`);
}

function decodeSafe(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** A copy of value with every secret field and every secret in a URL or header string replaced by "[removed]". */
export function stripSecrets(value) {
  if (typeof value === 'string') return stripSecretsFromText(value);
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value === null || typeof value !== 'object') return value;
  const copy = {};
  for (const [name, inner] of Object.entries(value)) {
    copy[name] = SECRET_FIELDS.has(fieldKey(name)) && inner !== null && inner !== '' && typeof inner !== 'object'
      ? REMOVED
      : stripSecrets(inner);
  }
  return copy;
}
