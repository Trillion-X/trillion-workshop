// Whether a credential still stands, for the engine (the engine's `credential_standing`): POST
// settings.credential_standing.path {credential} on the internal listener answers {valid}. `credential` is the engine's own id
// for it (`Principal::credential`): `<kind>:<id>[:<client>]`, the kind's meaning declared in settings.credential_standing.kinds.
//   api_key       the key's own id: its row exists, is enabled and has not expired
//   session       the pass's subject (a user): it holds a session that has not ended
//   client_grant  `<user>:<client>`: the client holds a refresh or access token of that user that is not revoked and has not ended (an AI's access has
//                 no end unless the person set a limit for it). Revoking deletes the consent and every token, and a reused refresh token deletes its chain, so neither stands.
// Every kind also needs the user to exist and not be banned. A credential of a kind the settings do not declare, one that
// names nothing Better Auth holds, or one that does not read, does not stand: the tool admits nothing it cannot find.
// Better Auth's own records are read; no copy of a key or session is kept here.

const live = (row, now) => !row.revoked && (!row.expiresAt || new Date(row.expiresAt) > now);

/** The answer for `credential`: true while it stands. */
export async function credentialStands(auth, standing, credential, { now = new Date() } = {}) {
  if (typeof credential !== 'string') return false;
  const [kind, id, client] = credential.split(':');
  const rule = standing.kinds?.[kind];
  if (!rule || !id) return false;
  const { adapter } = await auth.$context;
  const one = (model, field, value) => adapter.findOne({ model, where: [{ field, value }] });
  // The database picks the live row (not revoked, not ended), so a holder with hundreds of old rows is not cut off by a page limit.
  const someLive = async (model, where, { revocable } = {}) => (await adapter.findMany({
    model, limit: 1, where: [...where, { field: 'expiresAt', operator: 'gt', value: now }, ...(revocable ? [{ field: 'revoked', value: null }] : [])],
  })).length > 0;
  let userId = id;
  if (rule === 'api_key') {
    const key = await one('apikey', 'id', id);
    if (!key || key.enabled === false || !live(key, now)) return false;
    userId = key.referenceId;
  }
  const user = await one('user', 'id', userId);
  if (!user || user.banned) return false;
  if (rule === 'api_key') return true;
  const ofUser = { field: 'userId', value: userId };
  if (rule === 'session') return someLive('session', [ofUser]);
  if (rule === 'client_grant' && client) {
    const granted = [ofUser, { field: 'clientId', value: client }];
    const consent = await adapter.findOne({ model: 'oauthConsent', where: granted });
    return !!consent && (await someLive('oauthRefreshToken', granted, { revocable: true }) || await someLive('oauthAccessToken', granted, { revocable: true }));
  }
  return false;
}
