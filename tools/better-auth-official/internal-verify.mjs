// The engine's one call to check a personal API key, on a listener only the computer itself reaches (settings.internal:
// `host`, `port`, `verify_path`; Caddy routes nothing to it). POST verify_path {key} runs Better Auth's own
// auth.api.verifyApiKey (server-only, so no public address answers it) and answers {valid, key: {id, userId, metadata}},
// or {valid: false, key: null}. The same listener answers settings.credential_standing.path {credential} with {valid}: whether
// a credential the engine names by its id still stands (credential-standing.mjs), and settings.internal.account_path
// {email, account} points a person's user at the account their own computer holds (accountClaimed): the one way to move a
// user already linked, which no sign-up, key check or public route does. Anything else is 404.
//
// A computer elsewhere (another engine) asks the same over the public origin at settings.key_check.path, admitted by its
// own proof, never a shared credential: `authorization: Bearer trp_<computer>_<blake3 of the key>_<at>_<signature>`
// signed for the `key-check` use (computer-proof.mjs), and in the body, beside the key, `kept`: its account's own signed
// computers row and the account's public key, as it tells a forwarder. A proof binds one key, so it is never replayed for
// another; the row must list the computer; and a computer learns only about keys of its own account.
//
// A key carries its account in its metadata when its user had one as it was made. A key whose user has none yet (an account
// made before this tool, never created here) takes its account on its first check by a computer its account's own row
// enrolls: the user is linked to that account, once (a user already linked is never moved), and every key of that user
// answers that account from then on. Holding the key and a computer of the account together is the proof both are one party's.
import { createServer } from 'node:http';
import { enrolledAccount, keyDigest, readProof } from './computer-proof.mjs';
import { credentialStands } from './credential-standing.mjs';

const json = (response, status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const bodyOf = (request, most) => new Promise(done => {
  let text = '';
  request.on('data', chunk => { text += chunk; if (text.length > most) request.destroy(); });
  request.on('end', () => { try { done(JSON.parse(text)); } catch { done(null); } });
  request.on('close', () => done(null));
});
const keyOf = async request => { const { key } = (await bodyOf(request, 4096)) ?? {}; return typeof key === 'string' && key ? key : null; };

/** Better Auth's answer for `key`, in the engine's shape. A key that names no account answers its user's account, if any;
 * with `link`, a user that has none is first linked to `link` (the account a computer proved, computerKeyCheck). */
async function verified(auth, key, claim, link = null) {
  const answer = await auth.api.verifyApiKey({ body: { key } });
  if (!answer.valid || !answer.key) return { valid: false, key: null };
  const { id, referenceId: userId, permissions = null } = answer.key;
  let metadata = answer.key.metadata ?? null;
  if (claim && !metadata?.[claim.claim]) {
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.findUserById(userId);
    if (user && !user[claim.field] && link) user[claim.field] = (await ctx.internalAdapter.updateUser(userId, { [claim.field]: link }))?.[claim.field] ?? link;
    if (user?.[claim.field]) metadata = { ...(metadata ?? {}), [claim.claim]: user[claim.field] };
  }
  return { valid: true, key: { id, userId, metadata, permissions } };
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
    const answer = await verified(auth, key, claim, account);
    const owner = answer.key?.metadata?.[claim?.claim ?? 'trillion_account'];
    return json(response, 200, owner === account ? answer : { valid: false, key: null }), true;
  };
}

/** Points the user whose email is `email` at `account` (a 64-hex account address), in the field settings.account_claim names.
 * Answers {email, account}; 400 for a body that is not both, 404 for an email no user has, 404 when the settings name no claim. */
async function accountClaimed(auth, claim, request, response) {
  const { email, account } = (await bodyOf(request, 4096)) ?? {};
  if (!claim || typeof email !== 'string' || !email || !/^[0-9a-f]{64}$/.test(account ?? '')) return json(response, 400, { error: 'email_and_account_required' });
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  if (!found?.user) return json(response, 404, { error: 'no_such_user' });
  await ctx.internalAdapter.updateUser(found.user.id, { [claim.field]: account });
  return json(response, 200, { email, account });
}

export function serveInternal(auth, { host, port, verify_path: path, account_path: accountPath }, claim = null, standing = null) {
  return createServer(async (request, response) => {
    if (accountPath && request.method === 'POST' && request.url === accountPath) return accountClaimed(auth, claim, request, response);
    if (standing && request.method === 'POST' && request.url === standing.path) {
      const { credential } = (await bodyOf(request, 4096)) ?? {};
      return json(response, 200, { valid: await credentialStands(auth, standing, credential).catch(() => false) });
    }
    if (request.method !== 'POST' || request.url !== path) return json(response, 404, { error: 'not_found' });
    const key = await keyOf(request);
    if (!key) return json(response, 400, { error: 'key_required' });
    json(response, 200, await verified(auth, key, claim));
  }).listen(port, host);
}
