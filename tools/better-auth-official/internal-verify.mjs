// The engine's one call to check a personal API key, on a listener only the computer itself reaches (settings.internal:
// `host`, `port`, `verify_path`; Caddy routes nothing to it). POST verify_path {key} runs Better Auth's own
// auth.api.verifyApiKey (server-only, so no public address answers it) and answers {valid, key: {id, userId, metadata}},
// or {valid: false, key: null}. Anything else is 404.
//
// A computer elsewhere (another engine) asks the same over the public origin at settings.key_check.path, admitted by its
// own proof, never a shared credential: `authorization: Bearer trp_<computer>_<blake3 of the key>_<at>_<signature>`
// signed for the `key-check` use (computer-proof.mjs), and in the body, beside the key, `kept`: its account's own signed
// computers row and the account's public key, as it tells a forwarder. A proof binds one key, so it is never replayed for
// another; the row must list the computer; and a computer learns only about keys of its own account.
import { createServer } from 'node:http';
import { enrolledAccount, keyDigest, readProof } from './computer-proof.mjs';

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
  const { id, referenceId: userId, metadata = null } = answer.key;
  return { valid: true, key: { id, userId, metadata } };
}

/** The public key check for a computer elsewhere: true when it answered the request (its path), false otherwise. */
export function computerKeyCheck(auth, settings) {
  const { key_check: check, computer_proof: proof, account_claim: claim } = settings;
  return async (request, response) => {
    if (!check || !proof || request.url !== check.path) return false;
    if (request.method !== 'POST') return json(response, 405, { error: 'post_only' }), true;
    const body = await bodyOf(request, 64 * 1024);
    const key = typeof body?.key === 'string' && body.key ? body.key : null;
    if (!key) return json(response, 400, { error: 'key_required' }), true;
    const credential = (request.headers.authorization ?? '').replace(/^Bearer /, '');
    const read = readProof(proof, check.use, credential, Date.now());
    const account = read && read.part === keyDigest(key) ? enrolledAccount(proof, body.kept, read.computer) : null;
    if (!account) return json(response, 401, { error: 'computer_not_admitted' }), true;
    const answer = await verified(auth, key);
    const owner = answer.key?.metadata?.[claim?.claim ?? 'trillion_account'];
    return json(response, 200, owner === account ? answer : { valid: false, key: null }), true;
  };
}

export function serveInternal(auth, { host, port, verify_path: path }) {
  return createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== path) return json(response, 404, { error: 'not_found' });
    const key = await keyOf(request);
    if (!key) return json(response, 400, { error: 'key_required' });
    json(response, 200, await verified(auth, key));
  }).listen(port, host);
}
