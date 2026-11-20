// Purpose: a service's own sign-in app values (its client id, its client secret, and the secret a delivery to the service is
// signed with) and an account's own sign-in app for one connect row: which names a row set says a service holds, sealing
// them in the account's locked box, the plain client id every sign-in link carries, removing them, which names are held,
// and the answer of the /work/service-values request.
//
// Ported from the retired repository src/service-values.mjs (tag before-worker-retire, b6ae0ebf81). Its Worker imports are
// not ported: the box, the plain-fact store, the Connections address and the fresh-sign-in address come in as arguments.
// The box is any `{ exists(name), write(name, value), reveal(name), remove(name) }`; the account's real box is the native
// vault (tools/connect-a-service-and-seal-its-key/do-work/put-one-secret-in-the-vault.mjs and read-data/ask-the-vault-for-one-secret.mjs).
// The box name of an account's own sign-in app is `own-sign-in-app:<tool id>:<need>` (the colon names the same way plainFactName does),
// not the old boxName hex, so this tool does not import another tool's file.
//
// Not ported here (named in this tool's README, with the gap): lending one-time handles of the operator's sign-in app to
// another account's token request (old lendSignInClient, borrowSignInClient: they need the engine's handle store), the
// account-action runner that calls these functions (trillion-rust src/tool_runs/tools.rs KINDS has no account-action kind),
// and the DATA shape: this reads the old `rows.tools` / `rows.event_sources` shape, not the current sign-in-app list rows.

export const MAX_VALUE_LENGTH = 4096;
const OWN_NEEDS = ['client_id', 'client_secret', 'basic'];

/** The name of the Basic value made from a sign-in app's id and secret. */
export const basicName = secretName => `${secretName}-basic`;
/** The plain fact a held name the DATA marks plain is kept under. */
export const plainFactName = name => `service-value-plain:${name}`;

/** The sign-in app each hosted connect row names, with how that app authenticates. */
const signInClients = rows => (rows.tools ?? []).filter(tool => tool.invoke?.connects?.acquire?.hosted_client)
  .map(tool => ({ tool, client: tool.invoke.connects.acquire.hosted_client, basic: tool.invoke.connects.acquire.client_auth === 'basic' }));

/** Every name the DATA says the service holds: `name -> { label, plain }`. */
export function serviceValueNames(rows) {
  const names = new Map();
  for (const source of rows.event_sources ?? []) if (source.signature) names.set(source.signature.secret_name, { label: `Signs deliveries for ${source.label}`, plain: false });
  for (const { tool, client } of signInClients(rows)) {
    names.set(client.id_name, { label: `${tool.label ?? tool.id}: the sign-in app's id`, plain: true });
    names.set(client.secret_name, { label: `${tool.label ?? tool.id}: the sign-in app's secret`, plain: false });
  }
  return names;
}

/**
 * What a service connected by signing in needs from its developer dashboard before anyone can connect it:
 * `provider -> { made_at, values: [{ name, label, plain }] }`: the sign-in app's id and secret, then the secret each event
 * source read with that service's connection signs its deliveries with (held once when it is the same name).
 */
export function signInAppSetups(rows) {
  const setups = new Map();
  for (const { tool, client } of signInClients(rows)) {
    const values = [{ name: client.id_name, label: 'Client ID', plain: true }, { name: client.secret_name, label: 'Client secret', plain: false }];
    for (const source of rows.event_sources ?? []) {
      const proof = (rows.tools ?? []).find(item => item.id === source.route_key_proof?.tool_id);
      if (!source.signature || proof?.invoke?.connection !== tool.invoke.connects.connection || values.some(value => value.name === source.signature.secret_name)) continue;
      values.push({ name: source.signature.secret_name, label: `Signs deliveries for ${source.label}`, plain: false });
    }
    setups.set(tool.invoke.provider, { made_at: client.made_at ?? null, values });
  }
  return setups;
}

/** Seal the values the operator pasted; a name the DATA does not list is refused before anything is kept. */
export function keepServiceValues({ box, rows, values, readPlain, writePlain }) {
  const names = serviceValueNames(rows);
  const given = Object.entries(values ?? {}).filter(([, value]) => typeof value === 'string' && value.trim());
  for (const [name, value] of given) {
    if (!names.has(name)) throw new Error(`${name} is not a value this service holds.`);
    if (value.length > MAX_VALUE_LENGTH) throw new Error(`${name} is too long.`);
  }
  const typed = Object.fromEntries(given.map(([name, value]) => [name, value.trim()]));
  for (const [name, value] of Object.entries(typed)) {
    box.write(name, value);
    if (names.get(name).plain) writePlain(name, value);
  }
  for (const { client, basic } of signInClients(rows)) {
    const secret = typed[client.secret_name];
    const id = typed[client.id_name] ?? readPlain(client.id_name);
    if (basic && secret && id) box.write(basicName(client.secret_name), btoa(`${id}:${secret}`));
  }
  return { saved: Object.keys(typed) };
}

/** The plain value of each held name the DATA marks plain (a sign-in app's id). */
export const servicePlainValues = ({ rows, readPlain }) => Object.fromEntries([...serviceValueNames(rows)].filter(([, item]) => item.plain)
  .map(([name]) => [name, readPlain(name)]).filter(([, value]) => typeof value === 'string' && value));

/** One held value's words, for the operator's own freshly signed-in browser only (the route checks the sign-in time). */
export function revealServiceValue({ box, rows, name }) {
  if (!serviceValueNames(rows).has(name)) throw new Error(`${name} is not a value this service holds.`);
  if (!box.exists(name)) throw new Error('Nothing is held under that name.');
  return box.reveal(name);
}

/** Take a sign-in app out of the box: its id, its secret and the Basic value made from them. */
export function removeServiceValues({ box, rows, names, removePlain }) {
  const known = serviceValueNames(rows);
  const asked = (Array.isArray(names) ? names : []).map(String).filter(name => known.has(name));
  for (const name of asked) {
    if (box.exists(name)) box.remove(name);
    if (box.exists(basicName(name))) box.remove(basicName(name));
    if (known.get(name).plain) removePlain(name);
  }
  return { removed: asked };
}

/** Which of the names the box holds (never a value). */
export const serviceValueStates = ({ box, rows }) => Object.fromEntries([...serviceValueNames(rows).keys()].map(name => [name, box.exists(name)]));

/** The box names of one part of an account's own sign-in app for a connect row, in `needs` order. */
export function ownSignInAppNames({ toolId, needs }) {
  return (needs ?? []).map(need => {
    if (!OWN_NEEDS.includes(need)) throw new Error(`A sign-in app has its id, its secret or its Basic value, not "${need}".`);
    return ownSignInAppName(toolId, need);
  });
}

/** The name one part of an account's own sign-in app is sealed under in its box. */
export const ownSignInAppName = (toolId, need) => `own-sign-in-app:${toolId}:${need}`;
/** The fact an account's own sign-in app id is kept readable under (every sign-in link carries it). */
export const ownSignInAppFact = toolId => `own-sign-in-app:${toolId}`;

/**
 * Seal an account's own sign-in app for `row` (a connect row signed in through): its id, its secret (left out only when the
 * row's sign-in sends no secret), and the Basic value when the row authenticates its app that way. Returns the id, which the
 * caller keeps readable under ownSignInAppFact.
 */
export function keepOwnSignInApp({ box, row, client_id, client_secret }) {
  const auth = row.invoke.connects.acquire.client_auth ?? 'form';
  const id = typeof client_id === 'string' ? client_id.trim() : '';
  const secret = typeof client_secret === 'string' ? client_secret.trim() : '';
  if (!id || id.length > MAX_VALUE_LENGTH) throw new Error('Give your sign-in app\'s client id, as the service\'s developer page shows it.');
  if (auth !== 'none' && !secret) throw new Error(`${row.label ?? row.invoke.provider} checks your sign-in app with its secret: give client_secret too.`);
  if (secret.length > MAX_VALUE_LENGTH) throw new Error('That client secret is too long.');
  dropOwnSignInApp({ box, toolId: row.id });
  box.write(ownSignInAppName(row.id, 'client_id'), id);
  if (secret) box.write(ownSignInAppName(row.id, 'client_secret'), secret);
  if (auth === 'basic') box.write(ownSignInAppName(row.id, 'basic'), btoa(`${id}:${secret}`));
  return id;
}

/** Remove an account's own sign-in app for one connect row from its box. */
export function dropOwnSignInApp({ box, toolId }) {
  for (const need of OWN_NEEDS) if (box.exists(ownSignInAppName(toolId, need))) box.remove(ownSignInAppName(toolId, need));
}

/**
 * The /work/service-values request, as an answer: `{ status, body }` or `{ status: 302, location }`. `operator` is the
 * account's store bound to its box and rows: `{ keep(values), reveal(name), remove(names) }`. A reveal is answered only when
 * `fresh` (the browser signed in within the fresh window); otherwise the answer names the sign-in address.
 */
export async function answerServiceValuesRequest({ method, origin, requestOrigin, text, fresh = false, operator, connectionsAddress, signInAgainAddress }) {
  // A sign-in app is set where services are connected: the Connections screen takes these saves; a visit opens that screen.
  if (method === 'GET') return { status: 302, location: `${origin}${connectionsAddress}` };
  if (method !== 'POST') return { status: 404, body: { error: 'Not found' } };
  if (requestOrigin !== origin) return { status: 403, body: { error: 'Not allowed.' } };
  let body;
  try { body = JSON.parse(String(text ?? '').slice(0, 64 * 1024)); } catch { return { status: 400, body: { error: 'Send the values as JSON.' } }; }
  try {
    if (body?.action === 'reveal') {
      if (!fresh) return { status: 200, body: { said: 'Sign in again to see it. For your safety it is shown only right after you sign in.', redirect: signInAgainAddress(connectionsAddress) } };
      return { status: 200, body: { reveal: { label: 'Copy it now. It hides again in 30 seconds.', text: await operator.reveal(String(body.name ?? '')), hide_after_seconds: 30 } } };
    }
    if (body?.action === 'remove') {
      const { removed } = await operator.remove(body.names ?? []);
      return { status: 200, body: { removed, said: removed.length ? 'Removed. Paste the new sign-in app to connect this service again.' : 'Nothing was held to remove.', refresh: true } };
    }
    const kept = await operator.keep(body?.values ?? {});
    return { status: 200, body: { ...kept, said: kept.saved?.length ? `Saved. ${kept.saved.length === 1 ? 'It is' : 'They are'} locked away and never shown again.` : 'Nothing to save: every box was empty.', refresh: true } };
  } catch (error) { return { status: 400, body: { error: String(error.message ?? error) } }; }
}
