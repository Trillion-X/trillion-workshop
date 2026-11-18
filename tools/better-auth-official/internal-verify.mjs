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

export function serveInternal(auth, { host, port, verify_path: path }, standing = null) {
  return createServer(async (request, response) => {
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
