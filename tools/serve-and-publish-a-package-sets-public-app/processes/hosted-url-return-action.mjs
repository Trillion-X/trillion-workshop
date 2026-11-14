function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function validAction(value) {
  return record(value)
    && value.kind === 'hosted-url-return-action'
    && nonempty(value.target)
    && record(value.match_query)
    && Object.keys(value.match_query).length > 0
    && record(value.payload_fields)
    && Array.isArray(value.clear_query_params)
    && value.reload_on_success === true;
}

function actionMatches(action, url) {
  return Object.entries(action.match_query).every(([key, wanted]) => (
    typeof wanted === 'string' && url.searchParams.get(key) === wanted
  ));
}

export function selectHostedUrlReturnAction(actions, url) {
  const matches = (Array.isArray(actions) ? actions : [])
    .filter(validAction)
    .filter((action) => actionMatches(action, url));
  if (matches.length > 1) {
    throw new Error('More than one hosted URL return action matched this request.');
  }
  return matches[0] ?? null;
}

export function hostedUrlReturnPayload(action, url) {
  const payload = {};
  for (const [field, source] of Object.entries(action.payload_fields)) {
    const queryParam = record(source) ? nonempty(source.query_param) : '';
    if (!queryParam) throw new Error(`Hosted URL return field ${field} has no query parameter.`);
    const value = url.searchParams.get(queryParam);
    if (value !== null) payload[field] = value;
  }
  return payload;
}

function cookieToken(value, label) {
  const token = nonempty(value);
  if (!token || /[\u0000-\u001f\u007f;,\s]/.test(token)) {
    throw new Error(`Browser cookie ${label} is invalid.`);
  }
  return token;
}

export function serializeBrowserCookie(cookie) {
  if (!record(cookie)) throw new Error('Browser cookie is invalid.');
  const name = cookieToken(cookie.name, 'name');
  const value = cookieToken(cookie.value, 'value');
  const parts = [`${name}=${value}`];
  if (Number.isSafeInteger(cookie.maxAge) && cookie.maxAge >= 0) parts.push(`Max-Age=${cookie.maxAge}`);
  const path = nonempty(cookie.path);
  if (path) {
    if (!path.startsWith('/') || /[\u0000-\u001f\u007f;]/.test(path)) {
      throw new Error('Browser cookie path is invalid.');
    }
    parts.push(`Path=${path}`);
  }
  if (cookie.httpOnly === true) parts.push('HttpOnly');
  if (cookie.secure === true) parts.push('Secure');
  const sameSite = nonempty(cookie.sameSite).toLowerCase();
  if (sameSite) {
    const rendered = sameSite === 'lax' ? 'Lax' : sameSite === 'strict' ? 'Strict' : sameSite === 'none' ? 'None' : '';
    if (!rendered) throw new Error('Browser cookie SameSite value is invalid.');
    parts.push(`SameSite=${rendered}`);
  }
  return parts.join('; ');
}

export async function executeHostedUrlReturnAction(actions, url, invokeTarget) {
  const action = selectHostedUrlReturnAction(actions, url);
  if (!action) return null;
  const output = await invokeTarget(action.target, hostedUrlReturnPayload(action, url));
  const cookies = Array.isArray(output?.browserEffects?.cookies)
    ? output.browserEffects.cookies.map(serializeBrowserCookie)
    : [];
  const destination = new URL(url.toString());
  for (const key of action.clear_query_params) {
    if (typeof key === 'string') destination.searchParams.delete(key);
  }
  return {
    cookies,
    location: `${destination.pathname}${destination.search}${destination.hash}`,
    output,
    target: action.target,
  };
}
