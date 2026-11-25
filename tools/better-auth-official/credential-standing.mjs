// Whether a credential still stands, for the engine (the engine's `credential_standing`): POST
// settings.credential_standing.path {credential} on the internal listener answers {valid}. `credential` is the engine's own id
// for it (`Principal::credential`): `<kind>:<id>[:<client>]`, the kind's meaning declared in settings.credential_standing.kinds.
//   api_key       the key's own id: its row exists, is enabled and has not expired
//   session       the pass's subject (a user): it holds a session that has not ended
//   key_pass      `<user>:<key id>`: a pass signed for a key (internal-verify.mjs pass_path) stands while that key does and is the user's.
//   client_grant  `<user>:<client>`: the client holds a refresh or access token of that user that is not revoked and has not ended (an AI's access has
//                 no end unless the person set a limit for it). Revoking deletes the consent and every token, and a reused refresh token deletes its chain, so neither stands.
// Every kind also needs the user to exist and not be banned. A credential of a kind the settings do not declare, one that
// names nothing Better Auth holds, or one that does not read, does not stand: the tool admits nothing it cannot find.
// Better Auth's own records are read; no copy of a key or session is kept here. `credentialEnd` says when a standing
// credential ends by itself: a key at its own expiresAt, an AI's access at the end of its newest live refresh token, and the
// person's own session never (it is renewed while they use it), so a key a credential makes can be held to end no later.

const live = (row, now) => !row.revoked && (!row.expiresAt || new Date(row.expiresAt) > now);

/** `credential` read as its kind's rule, its id and its client, or null when it names no kind the settings declare. */
function parsed(standing, credential) {
  if (typeof credential !== 'string') return null;
  // The client is everything after the second ':' (an AI's client id is often a URL, which holds ':' itself).
  const [kind, id] = credential.split(':', 2);
  const client = credential.split(':').slice(2).join(':') || undefined;
  const rule = standing.kinds?.[kind];
  return rule && id ? { rule, id, client } : null;
}

/** When `credential` ends by itself (a Date), or null when it has no end of its own; read only for a credential that stands. */
export async function credentialEnd(auth, standing, credential) {
  const { rule, id, client } = parsed(standing, credential) ?? {};
  const { adapter } = await auth.$context;
  if (rule === 'key_pass' || rule === 'api_key') {
    const key = await adapter.findOne({ model: 'apikey', where: [{ field: 'id', value: rule === 'key_pass' ? client : id }] });
    return key?.expiresAt ? new Date(key.expiresAt) : null;
  }
  if (rule === 'client_grant') {
    // The latest end of an unrevoked refresh or access token of that AI: each refresh makes a new pair, and the person's limit for
    // that AI shortens its refresh tokens (connected/limit). With neither, the access has already ended.
    const where = [{ field: 'userId', value: id }, { field: 'clientId', value: client }, { field: 'revoked', value: null }];
    const newest = async model => (await adapter.findMany({ model, where, limit: 1, sortBy: { field: 'expiresAt', direction: 'desc' } }))[0];
    const ends = (await Promise.all(['oauthRefreshToken', 'oauthAccessToken'].map(newest))).filter(Boolean).map(token => new Date(token.expiresAt).getTime());
    return new Date(ends.length ? Math.max(...ends) : 0);
  }
  return null;
}

/** The answer for `credential`: true while it stands. */
export async function credentialStands(auth, standing, credential, { now = new Date() } = {}) {
  const { rule, id, client } = parsed(standing, credential) ?? {};
  if (!rule) return false;
  const { adapter } = await auth.$context;
  const one = (model, field, value) => adapter.findOne({ model, where: [{ field, value }] });
  // The database picks the live row (not revoked, not ended), so a holder with hundreds of old rows is not cut off by a page limit.
  const someLive = async (model, where, { revocable } = {}) => (await adapter.findMany({
    model, limit: 1, where: [...where, { field: 'expiresAt', operator: 'gt', value: now }, ...(revocable ? [{ field: 'revoked', value: null }] : [])],
  })).length > 0;
  let userId = id;
  if (rule === 'key_pass') {
    const key = client && await one('apikey', 'id', client);
    if (!key || key.referenceId !== id || key.enabled === false || !live(key, now)) return false;
  }
  if (rule === 'api_key') {
    const key = await one('apikey', 'id', id);
    if (!key || key.enabled === false || !live(key, now)) return false;
    userId = key.referenceId;
  }
  const user = await one('user', 'id', userId);
  if (!user || user.banned) return false;
  if (rule === 'api_key' || rule === 'key_pass') return true;
  const ofUser = { field: 'userId', value: userId };
  if (rule === 'session') return someLive('session', [ofUser]);
  if (rule === 'client_grant' && client) {
    const granted = [ofUser, { field: 'clientId', value: client }];
    const consent = await adapter.findOne({ model: 'oauthConsent', where: granted });
    return !!consent && (await someLive('oauthRefreshToken', granted, { revocable: true }) || await someLive('oauthAccessToken', granted, { revocable: true }));
  }
  return false;
}
