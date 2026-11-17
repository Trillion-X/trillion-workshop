// Whether a credential still stands, for the engine (trillion-rust src/account/signed_in.rs `credential_standing`): POST
// settings.credential_standing.path {credential} on the internal listener answers {valid}. `credential` is the engine's own id
// for it (`Principal::credential`): `<kind>:<id>[:<client>]`, the kind's meaning declared in settings.credential_standing.kinds.
//   api_key       the key's own id: its row exists, is enabled and has not expired
//   session       the pass's subject (a user): it holds a session that has not ended
//   client_grant  `<user>:<client>`: the client holds a refresh or access token of that user not revoked and not expired; asked by the
//                 engine's wake runner for a scheduled job the person switched on (`heldByWake`), it also stands past its idle end while
//                 the person's consent and an unrevoked refresh token remain, and that ask is noted (the consent's updatedAt) so the
//                 Connections page can say only the job still uses it
// Every kind also needs the user to exist and not be banned. A credential of a kind the settings do not declare, one that
// names nothing Better Auth holds, or one that does not read, does not stand: the tool admits nothing it cannot find.
// Better Auth's own records are read; no copy of a key or session is kept here.

const live = (row, now) => !row.revoked && (!row.expiresAt || new Date(row.expiresAt) > now);

/** The answer for `credential`: true while it stands. `heldByWake` is read only from the internal listener (internal-verify.mjs). */
export async function credentialStands(auth, standing, credential, { now = new Date(), heldByWake = false } = {}) {
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
    if ((await someLive('oauthRefreshToken', granted, { revocable: true })) || (await someLive('oauthAccessToken', granted, { revocable: true }))) return true;
    if (!heldByWake) return false;
    const consent = await adapter.findOne({ model: 'oauthConsent', where: granted });
    const family = (await adapter.findMany({ model: 'oauthRefreshToken', limit: 1, where: [...granted, { field: 'revoked', value: null }] })).length > 0;
    if (!consent || !family) return false;
    await adapter.update({ model: 'oauthConsent', where: [{ field: 'id', value: consent.id }], update: { updatedAt: now } });
    return true;
  }
  return false;
}
