// A key that reaches only what a program on this computer may hand out: POST settings.api_key.scoped_create.path on the internal
// listener (internal-verify.mjs) with {user_id, name, permissions: {"<resource>": [patterns]}, expires_in?} makes a Better Auth API
// key for that user with exactly those permissions, through the plugin's server-only createApiKey (the client's /api-key/create may
// not set permissions). Every pattern must be one settings.api_key.scoped_create.allowed_patterns names, written the same; the key
// gets the settings prefix (api_key.prefix) like every other key. The answer {key, id} is the only place the key ever appears: it
// is never logged or kept, so the caller hands it straight to its vault.
//
// A person's own engine asks the same by pass (settings.api_key.scoped_create.by_pass, routes under the public base path): its
// caller's pass, as `Authorization: Bearer`, names the user (pass-caller.mjs), never the body, and the body is {name, permissions,
// expires_in}. Each pattern must also be one the caller's own credential holds, expires_in is required and at most
// by_pass.most_seconds, and the key ends no later than that credential does when it has an end. The key is marked as made this way
// (its metadata names by_pass.mark and the credential), and its answer is {key, id, expires_at}. Revoke by pass {key_id} deletes a
// key only when this user made it this way; any other id, the user's own other keys included, is key_not_found.

const FIELDS = new Set(['user_id', 'name', 'permissions', 'expires_in']);
const PASS_FIELDS = new Set(['name', 'permissions', 'expires_in']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Whether a credential holding the method patterns `rights` holds `pattern`: `*`, a prefix ending in `*`, or the method itself. */
export const holds = (rights, pattern) => rights.some(right => right === '*' || right === pattern || (right.endsWith('*') && pattern.startsWith(right.slice(0, -1))));

/** Whether `address` (a socket's remoteAddress) is this computer's own loopback: 127.0.0.0/8, ::1, or 127.x mapped into IPv6. */
export const isLoopback = address => typeof address === 'string' && (address === '::1' || /^(::ffff:)?127\./.test(address));

/** Why `request` may not ask for a key, or null: it came from another computer, or a proxy on this one carried it from elsewhere. */
export function callerRefusal(request) {
  if (!isLoopback(request.socket?.remoteAddress)) return 'loopback_only';
  if (request.headers.forwarded || request.headers['x-forwarded-for'] || request.headers['x-real-ip']) return 'loopback_only';
  return null;
}

/** Why `body` is not a scoped key request under `allowed` (the allow list), or null. `fields` are the ones it may hold: a request by
 *  pass names no user and must say when its key ends. */
function bodyRefusal(body, allowed, fields = FIELDS) {
  if (!plain(body)) return { error: 'body_not_an_object' };
  const extra = Object.keys(body).find(field => !fields.has(field));
  if (extra) return { error: 'unknown_field', field: extra };
  if (fields.has('user_id') && (typeof body.user_id !== 'string' || !body.user_id)) return { error: 'user_id_required' };
  if (typeof body.name !== 'string' || !body.name) return { error: 'name_required' };
  if (!plain(body.permissions) || !Object.keys(body.permissions).length) return { error: 'permissions_required' };
  for (const [resource, patterns] of Object.entries(body.permissions)) {
    if (!resource || !Array.isArray(patterns) || !patterns.length) return { error: 'permissions_required', resource };
    const refused = patterns.find(pattern => typeof pattern !== 'string' || !allowed.includes(pattern));
    if (refused !== undefined) return { error: 'pattern_not_allowed', pattern: refused };
  }
  if (!fields.has('user_id') && body.expires_in === undefined) return { error: 'expires_in_required' };
  if (body.expires_in !== undefined && !(Number.isInteger(body.expires_in) && body.expires_in > 0)) return { error: 'expires_in_invalid' };
  return null;
}

/** Make the key `body` asks for, for `userId`, with `metadata` when given: [status, body] as `mintScopedKey` answers. */
async function made(auth, userId, body, metadata) {
  try {
    const found = await (await auth.$context).internalAdapter.findUserById(userId);
    if (!found) return [404, { error: 'unknown_user' }];
    if (found.banned) return [403, { error: 'user_banned' }];
    const key = await auth.api.createApiKey({
      body: { userId: found.id, name: body.name, permissions: body.permissions, ...(body.expires_in ? { expiresIn: body.expires_in } : {}), ...(metadata ? { metadata } : {}) },
    });
    return [200, { key: key.key, id: key.id, ...(metadata ? { expires_at: key.expiresAt ? new Date(key.expiresAt).toISOString() : null } : {}) }];
  } catch (error) {
    // The plugin's own refusal (a name or expiry outside its limits) by its code; anything else is this computer's fault. Neither holds the key.
    return error?.body?.code ? [400, { error: error.body.code }] : [500, { error: 'not_made' }];
  }
}

/** The answer to a scoped key request: [status, body]. 200 {key, id}; 400, 403 or 404 with {error} and no key made; 500 when the store failed. */
export async function mintScopedKey(auth, { allowed_patterns: allowed }, body) {
  const refused = bodyRefusal(body, allowed);
  if (refused) return [400, refused];
  return made(auth, body.user_id, body);
}

/** The metadata of the key row `row`, as an object (the plugin keeps it as JSON text). */
const metadataOf = row => { try { return plain(row?.metadata) ? row.metadata : JSON.parse(row?.metadata ?? 'null') ?? {}; } catch { return {}; } };

/**
 * The answer to a scoped key request by pass, for `caller` (pass-caller.mjs: {user_id, credential, rights, ends}), at `now`: 200
 * {key, id, expires_at}, or 400/403/404 with {error} and no key made. The caller's own refusal (no pass, a credential that no longer
 * stands) is the route's, before this.
 */
export async function mintScopedKeyByPass(auth, { allowed_patterns: allowed, by_pass: byPass }, caller, body, now = Date.now()) {
  const refused = bodyRefusal(body, allowed, PASS_FIELDS);
  if (refused) return [400, refused];
  if (body.expires_in > byPass.most_seconds) return [400, { error: 'expires_in_too_long', most_seconds: byPass.most_seconds }];
  const beyond = Object.values(body.permissions).flat().find(pattern => !holds(caller.rights, pattern));
  if (beyond !== undefined) return [403, { error: 'pattern_not_held_by_caller', pattern: beyond }];
  if (caller.ends && now + body.expires_in * 1000 > caller.ends.getTime()) return [400, { error: 'expires_after_credential', credential_ends_at: caller.ends.toISOString() }];
  return made(auth, caller.user_id, body, { made_by: byPass.mark, credential: caller.credential });
}

/** The answer to a revoke by pass {key_id} for `caller`: 200 {key_id, revoked: true} once the key is deleted, 400 for another
 *  body, and 404 key_not_found for a key that is not this user's or was not made by pass. */
export async function revokeScopedKeyByPass(auth, { by_pass: byPass }, caller, body) {
  if (!plain(body) || Object.keys(body).length !== 1 || typeof body.key_id !== 'string' || !body.key_id) return [400, { error: 'key_id_required' }];
  const { adapter } = await auth.$context;
  const where = [{ field: 'id', value: body.key_id }];
  const row = await adapter.findOne({ model: 'apikey', where });
  if (!row || row.referenceId !== caller.user_id || metadataOf(row).made_by !== byPass.mark) return [404, { error: 'key_not_found' }];
  await adapter.delete({ model: 'apikey', where });
  return [200, { key_id: body.key_id, revoked: true }];
}
