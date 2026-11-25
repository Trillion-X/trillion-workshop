// Who a pass this sign-in signed names, for a route a person's own engine calls with the pass its caller presented there
// (scoped-key.mjs: a key made or revoked by pass). The pass is `Authorization: Bearer <pass>`; it is checked by Better Auth's own
// verifyJWT against this sign-in's keys and issuer, for the one audience its kind carries:
//   session      the jwt plugin's session pass, made for settings.audience: the person, holding every method (`*`)
//   key-pass     a pass made for one of the person's keys (internal-verify.mjs), for settings.internal.pass_audience: the key's scopes
//   mcp-access   an AI's access token (header typ at+jwt), for settings.mcp.resource or a person's own engine (loopback-resource.mjs):
//                the scopes the person granted that AI
// The kind's name is the credential's own word in settings.credential_standing.kinds, the engine's `Principal::credential`
// (`<kind>:<user>[:<client>]`), so the credential is asked whether it still stands (credential-standing.mjs) and when it ends by
// itself, exactly as the engine asks. A pass of no kind here, one that does not verify, or a credential that no longer stands is
// refused, and nothing is answered about the person.
import { verifyJWT } from 'better-auth/plugins';
import { loopbackResource } from './loopback-resource.mjs';
import { credentialEnd, credentialStands } from './credential-standing.mjs';

const decoded = part => { try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; } };

/** The kind of a pass (its rule in settings.credential_standing.kinds) and the one audience of that kind it names, read before it is verified; null for none. */
function kindOf(settings, header, payload) {
  const audiences = [payload?.aud ?? []].flat().filter(audience => typeof audience === 'string');
  const pick = (rule, accepts) => {
    const audience = audiences.find(accepts);
    return audience ? { rule, audience } : null;
  };
  if (header?.typ === 'at+jwt') {
    return pick('client_grant', audience => audience === settings.mcp?.resource || !!loopbackResource(audience, settings.mcp?.loopback_resources));
  }
  if (typeof payload?.key_id === 'string' && payload.key_id) return pick('key_pass', audience => audience === settings.internal?.pass_audience);
  return pick('session', audience => audience === settings.audience);
}

/** The bearer of `headers` (a Headers), or null. */
export function bearerOf(headers) {
  const found = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(headers?.get('authorization') ?? '');
  return found ? found[1] : null;
}

/**
 * The caller a pass names: {user_id, credential, rights, ends} (`rights` the method patterns it holds, `ends` a Date or null when it
 * has no end of its own), or {refused} with the reason's code. `jwtOptions` are the jwt plugin's own options; called inside a Better
 * Auth endpoint, whose context verifyJWT reads.
 */
export async function passCaller(auth, settings, jwtOptions, pass) {
  const parts = typeof pass === 'string' ? pass.split('.') : [];
  if (parts.length !== 3) return { refused: 'pass_required' };
  const found = kindOf(settings, decoded(parts[0]), decoded(parts[1]));
  if (!found) return { refused: 'pass_not_accepted' };
  const payload = await verifyJWT(pass, { ...jwtOptions, jwt: { ...jwtOptions.jwt, issuer: settings.issuer, audience: found.audience } });
  if (!payload?.sub) return { refused: 'pass_not_accepted' };
  const standing = settings.credential_standing;
  const kind = Object.keys(standing?.kinds ?? {}).find(name => standing.kinds[name] === found.rule);
  if (!kind) return { refused: 'pass_not_accepted' };
  const client = found.rule === 'key_pass' ? payload.key_id : found.rule === 'client_grant' ? payload.azp : null;
  if (found.rule !== 'session' && typeof client !== 'string') return { refused: 'pass_not_accepted' };
  const credential = [kind, payload.sub, ...(client ? [client] : [])].join(':');
  if (!await credentialStands(auth, standing, credential).catch(() => false)) return { refused: 'credential_not_standing' };
  const rights = found.rule === 'session' ? ['*'] : String(payload.scope ?? '').split(' ').filter(Boolean);
  return { user_id: payload.sub, credential, rights, ends: await credentialEnd(auth, standing, credential) };
}
