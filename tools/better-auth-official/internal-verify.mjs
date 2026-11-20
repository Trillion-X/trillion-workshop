// The engine's one call to check a personal API key, on a listener only the computer itself reaches (settings.internal:
// `host`, `port`, `verify_path`; Caddy routes nothing to it). POST verify_path {key} runs Better Auth's own
// auth.api.verifyApiKey (server-only, so no public address answers it) and answers {valid, key: {id, userId, permissions}},
// or {valid: false, key: null}: the key's user is the person. The same listener answers settings.credential_standing.path
// {credential} with {valid}: whether a credential the engine names by its id still stands (credential-standing.mjs).
// `/readyz` says whether this process still takes work (stop-without-dropping.mjs). Anything else is 404.
import { createServer } from 'node:http';
import { credentialStands } from './credential-standing.mjs';
import { readiness } from './stop-without-dropping.mjs';

const json = (response, status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const bodyOf = (request, most) => new Promise(done => {
  let text = '';
  request.on('data', chunk => { text += chunk; if (text.length > most) request.destroy(); });
  request.on('end', () => { try { done(JSON.parse(text)); } catch { done(null); } });
  request.on('close', () => done(null));
});
const keyOf = async request => { const { key } = (await bodyOf(request, 4096)) ?? {}; return typeof key === 'string' && key ? key : null; };

/** Better Auth's answer for `key`, in the engine's shape. */
async function verified(auth, key) {
  const answer = await auth.api.verifyApiKey({ body: { key } });
  if (!answer.valid || !answer.key) return { valid: false, key: null };
  const { id, referenceId: userId, permissions = null } = answer.key;
  return { valid: true, key: { id, userId, permissions } };
}

/** A short pass for a verified key, signed with the sign-in's own keys (Better Auth's jwt plugin, the same JWKS every computer
 *  checks): its person, the key's id and its scopes, for the MCP resource, ending `seconds` from now. Null when the key is not valid. */
async function passFor(auth, key, { seconds, audience }) {
  const answer = await verified(auth, key);
  if (!answer.valid) return null;
  const scopes = Object.values(answer.key.permissions ?? {}).flat().filter(scope => typeof scope === 'string');
  const now = Math.floor(Date.now() / 1000);
  const { token } = await auth.api.signJWT({ body: { payload: { sub: answer.key.userId, aud: audience, key_id: answer.key.id, scope: [...new Set(scopes)].join(' '), iat: now, exp: now + seconds } } });
  return { pass: token, expires_in: seconds };
}

export function serveInternal(auth, { host, port, verify_path: path, pass_path: passPath, pass_seconds: passSeconds, pass_audience: passAudience }, standing = null) {
  return createServer(async (request, response) => {
    // A carried call made with a key goes on to a person's own computer with a pass in its place (the gateway asks here), so the
    // key never leaves the computer that checked it and every computer checks what it is handed by signature alone.
    if (passPath && request.method === 'POST' && request.url === passPath) {
      const key = await keyOf(request);
      if (!key) return json(response, 400, { error: 'key_required' });
      const made = await passFor(auth, key, { seconds: passSeconds, audience: passAudience }).catch(() => null);
      return made ? json(response, 200, made) : json(response, 200, { valid: false });
    }
    if (readiness(request, response)) return;
    if (standing && request.method === 'POST' && request.url === standing.path) {
      const { credential } = (await bodyOf(request, 4096)) ?? {};
      return json(response, 200, { valid: await credentialStands(auth, standing, credential).catch(() => false) });
    }
    if (request.method !== 'POST' || request.url !== path) return json(response, 404, { error: 'not_found' });
    const key = await keyOf(request);
    if (!key) return json(response, 400, { error: 'key_required' });
    json(response, 200, await verified(auth, key));
  }).listen(port, host);
}
