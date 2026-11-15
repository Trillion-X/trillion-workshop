// The account's introduced AIs joined to the current native sign-in owners.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { listedAis } from '../src/ais.mjs';

// Earlier AI records named the OAuth client, rather than its individual grant. Keep reading those introductions.
const clientSignIn = clientId => typeof clientId === 'string' && clientId
  ? `key:oauth-${makeHashCodeHexFromBytes(new TextEncoder().encode(clientId)).slice(3, 27)}` : null;
const namesOfGrant = (grant, clients) => clients[`grant:${grant.id}`] ?? clients[clientSignIn(grant.clientId ?? grant.client_id)];

/** The one answer to "which AIs did this person connect": every current sign-in (OAuth grant or personal key) whose MCP
 *  client introduced itself, by the name it gave. A native app's grant (the iPhone app) is not an AI. Pure, so every screen
 *  reads the same list; the setup screen names each one (src/setup-steps.mjs shownAis) and never drops one it does not know. */
export function connectedAiNames({ grants = [], keys = [], clients = {} }) {
  const named = name => typeof name === 'string' && name.trim() ? name.trim() : null;
  return [
    ...grants.map(grant => named(namesOfGrant(grant, clients))),
    ...keys.map(key => named(clients[`key:${key.id}`])),
  ].filter(Boolean);
}
/** The names each sign-in introduced itself as, read off the one list of the person's AIs (src/ais.mjs): every `ai`
 *  record names the sign-ins it came in on. Two AIs on one key are both named, as one joined name. */
export function clientsOfAis(ais) {
  const named = Object.create(null);
  for (const ai of ais) for (const signIn of ai.sign_ins ?? []) if (typeof ai.label === 'string' && !(named[signIn] ?? []).includes(ai.label)) (named[signIn] ??= []).push(ai.label);
  return Object.fromEntries(Object.entries(named).map(([signIn, names]) => [signIn, names.join(' and ')]));
}

/** The run's own records door reads every page of the canonical AI list. An unreadable list remains unknown. */
export function nativeAisRead(door) {
  return async () => {
    const ais = [];
    for await (const row of door.list({ type: 'ai' })) {
      if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) throw new Error('The connected MCP clients could not be verified.');
      ais.push({ ...row.value, id: row.id });
    }
    return listedAis(ais);
  };
}

/** `call` is bound to the admitted account by its host and calls the existing @sign-in operations, not records claiming to be grants. */
export async function connectedAis({ call, door, readAis = nativeAisRead(door), now = Date.now }) {
  const [appsAnswer, keysAnswer, ais] = await Promise.all([
    call('@sign-in', 'sign-in:apps', {}), call('@sign-in', 'sign-in:keys', {}), readAis(),
  ]);
  if (!Array.isArray(appsAnswer?.apps) || !Array.isArray(keysAnswer?.keys) || !Array.isArray(ais)) throw new Error('The connected MCP clients could not be verified.');
  const grants = appsAnswer.apps;
  const namedId = value => typeof value === 'string' && value.length > 0;
  if (grants.some(grant => !grant || !namedId(grant.id) || !namedId(grant.client_id ?? grant.clientId))
    || keysAnswer.keys.some(key => !key || !namedId(key.id) || !Number.isSafeInteger(key.expires_at) || key.expires_at < 0)) {
    throw new Error('The connected MCP clients could not be verified.');
  }
  const keys = keysAnswer.keys.filter(key => !key.expired && (!key.expires_at || key.expires_at > now()));
  const current = new Set([
    ...grants.flatMap(grant => [`grant:${grant.id}`, clientSignIn(grant.client_id ?? grant.clientId)]),
    ...keys.map(key => `key:${key.id}`),
  ].filter(Boolean));
  return { grants, keys, ais, connected: ais.filter(ai => (ai.sign_ins ?? []).some(signIn => current.has(signIn))) };
}

/**
 * Whether an AI is connected: an existing sign-in that actually introduced an MCP client on the authenticated MCP
 * endpoint (connectedAiNames). Native API traffic, an OAuth grant alone and the general last-use timestamp do not prove
 * that connection. The remembered client must still match an existing OAuth grant or personal key. A failed owner read
 * remains unknown to setup. { connected, app, apps } is shared by Get started and the press of "Hand this to my AI".
 */
export async function aiConnection(host) {
  const { grants, keys, ais } = await connectedAis(host);
  const apps = connectedAiNames({ grants, keys, clients: clientsOfAis(ais) });
  return { connected: apps.length > 0, app: apps[0] ?? null, apps: [...new Set(apps)] };
}
