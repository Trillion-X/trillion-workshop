// A key that reaches only what a program on this computer may hand out: POST settings.api_key.scoped_create.path on the internal
// listener (internal-verify.mjs) with {user_id, name, permissions: {"<resource>": [patterns]}, expires_in?} makes a Better Auth API
// key for that user with exactly those permissions, through the plugin's server-only createApiKey (the client's /api-key/create may
// not set permissions). Every pattern must be one settings.api_key.scoped_create.allowed_patterns names, written the same; the key
// gets the settings prefix (api_key.prefix) like every other key. The answer {key, id} is the only place the key ever appears: it
// is never logged or kept, so the caller hands it straight to its vault.

const FIELDS = new Set(['user_id', 'name', 'permissions', 'expires_in']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Whether `address` (a socket's remoteAddress) is this computer's own loopback: 127.0.0.0/8, ::1, or 127.x mapped into IPv6. */
export const isLoopback = address => typeof address === 'string' && (address === '::1' || /^(::ffff:)?127\./.test(address));

/** Why `request` may not ask for a key, or null: it came from another computer, or a proxy on this one carried it from elsewhere. */
export function callerRefusal(request) {
  if (!isLoopback(request.socket?.remoteAddress)) return 'loopback_only';
  if (request.headers.forwarded || request.headers['x-forwarded-for'] || request.headers['x-real-ip']) return 'loopback_only';
  return null;
}

/** Why `body` is not a scoped key request under `allowed` (the allow list), or null. */
function bodyRefusal(body, allowed) {
  if (!plain(body)) return { error: 'body_not_an_object' };
  const extra = Object.keys(body).find(field => !FIELDS.has(field));
  if (extra) return { error: 'unknown_field', field: extra };
  if (typeof body.user_id !== 'string' || !body.user_id) return { error: 'user_id_required' };
  if (typeof body.name !== 'string' || !body.name) return { error: 'name_required' };
  if (!plain(body.permissions) || !Object.keys(body.permissions).length) return { error: 'permissions_required' };
  for (const [resource, patterns] of Object.entries(body.permissions)) {
    if (!resource || !Array.isArray(patterns) || !patterns.length) return { error: 'permissions_required', resource };
    const refused = patterns.find(pattern => typeof pattern !== 'string' || !allowed.includes(pattern));
    if (refused !== undefined) return { error: 'pattern_not_allowed', pattern: refused };
  }
  if (body.expires_in !== undefined && !(Number.isInteger(body.expires_in) && body.expires_in > 0)) return { error: 'expires_in_invalid' };
  return null;
}

/** The answer to a scoped key request: [status, body]. 200 {key, id}; 400, 403 or 404 with {error} and no key made; 500 when the store failed. */
export async function mintScopedKey(auth, { allowed_patterns: allowed }, body) {
  const refused = bodyRefusal(body, allowed);
  if (refused) return [400, refused];
  try {
    const found = await (await auth.$context).internalAdapter.findUserById(body.user_id);
    if (!found) return [404, { error: 'unknown_user' }];
    if (found.banned) return [403, { error: 'user_banned' }];
    const made = await auth.api.createApiKey({
      body: { userId: found.id, name: body.name, permissions: body.permissions, ...(body.expires_in ? { expiresIn: body.expires_in } : {}) },
    });
    return [200, { key: made.key, id: made.id }];
  } catch (error) {
    // The plugin's own refusal (a name or expiry outside its limits) by its code; anything else is this computer's fault. Neither holds the key.
    return error?.body?.code ? [400, { error: error.body.code }] : [500, { error: 'not_made' }];
  }
}
