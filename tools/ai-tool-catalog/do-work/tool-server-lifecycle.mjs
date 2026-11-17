// Remote server lifecycle. Inert until the native host supplies the current
// account's facts, named vault and callback custody. This registers no route.
// Raw keys/codes/tokens/verifiers never enter JS. Native intake supplies opaque,
// one-use handles bound to this account, browser, exact server and OAuth state.
import data from '../read-data/tool-server-lifecycle.json' with { type: 'json' };
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { ToolServerNeedsSignIn, toolServerSession } from './talk-to-a-tool-server.mjs';
import { authorizationAddress, discoverSignIn, registerClient } from './sign-in-to-a-tool-server.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => Object.assign(new Error(code), { code });
const fact = (family, value) => `${data[`${family}_fact_prefix`]}${value}`;
function address(value) {
  let url; try { url = new URL(value); } catch { throw fail('tool_server_address_refused'); }
  if (typeof value !== 'string' || value !== value.trim() || url.protocol !== 'https:' || url.username || url.password || url.hash) throw fail('tool_server_address_refused');
  return value; // Native admitAddress and the existing transport own public-host/DNS admission.
}
function callbackAddress(value) {
  let url; try { url = new URL(value); } catch { throw fail('tool_server_callback_address_refused'); }
  // The callback is supplied by the admitted native host. Its existing local
  // listener uses the RFC 8252 loopback exception; remote egress still requires
  // HTTPS through address()/admitAddress and never inherits this exception.
  if (typeof value !== 'string' || value !== value.trim() || url.username || url.password || url.hash || url.search
    || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw fail('tool_server_callback_address_refused');
  return value;
}
/** The exact original source identity/shape, kept as a built source. */
export function addedToolServerSource(server, name, signIn = false, key = null) {
  address(server);
  const id = makeHashCodeHexFromBytes(new TextEncoder().encode(server)).slice(3, 3 + data.source_digest_chars);
  return { kind: 'tool-row-source', id: `${data.source_id_prefix}${id}`, label: name,
    list: { mcp: { url: server, ...(signIn ? { sign_in: 'per-person' } : {}), ...(key ? { key } : {}) } },
    entry: { id: 'name', label: 'title', job: 'description', input_schema: 'inputSchema', output_schema: 'outputSchema' },
    id_prefix: `${data.tool_id_prefix}${id}:`, row: { ...structuredClone(data.row),
      invoke: { kind: 'mcp-tool-call', url: server, tool: { fill: { from: 'entry', field: 'id' } }, ...(signIn ? { sign_in: true } : {}), ...(key ? { key } : {}) },
      provenance: { api: name, server, read_from: "the server's own tools list, read again when it changes" } } };
}
function keyPlacement(input) {
  if (input.key_header !== undefined && typeof input.key_header !== 'string') throw fail('tool_server_key_header_refused');
  const name = input.key_header?.trim() || data.key_header_default;
  const prefix = input.key_prefix ?? (name.toLowerCase() === data.key_header_default.toLowerCase() ? data.key_prefix_default : '');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof prefix !== 'string' || prefix.length > 256 || /[\x00-\x1f\x7f]/.test(prefix)) throw fail('tool_server_key_header_refused');
  return { kind: 'header', name, prefix };
}
/** Host requirements: same-account fact read/write; atomic one-use consumePending;
 * admitted opaque key intake + generation-specific rollback; stored PKCE verifier
 * with only challenge returned; receipt-owned exchangeAndKeep sealing tokens before
 * return; state→account callback custody; existing public egress for request and
 * admitAddress; source-aware postFor and assertCurrent. Source flags satisfy none
 * of these requirements. This factory has no default host, vault or credential.
 */
export function toolServerLifecycle({ facts, vault, callbacks, request, postFor, rowSources, admitAddress, assertCurrent, returnTo,
  clientName, listFor, now = () => Date.now(), random = bytes => crypto.getRandomValues(bytes) } = {}) {
  const required = [[facts, ['read', 'write', 'consumePending']], [vault, ['acceptKeyIntake', 'rollbackKey', 'createVerifier', 'removeVerifier', 'exchangeAndKeep']], [callbacks, ['remember', 'forget', 'recover']]];
  if (required.some(([owner, methods]) => methods.some(method => typeof owner?.[method] !== 'function'))
    || [request, postFor, rowSources, admitAddress, assertCurrent].some(method => typeof method !== 'function') || typeof clientName !== 'string' || !clientName) throw fail('tool_server_native_lifecycle_unmounted');
  callbackAddress(returnTo);
  const current = async () => { await assertCurrent(); };
  const admitted = async server => { address(server); await current(); await admitAddress(server); await current(); return server; };
  const list = async source => {
    const spec = source.list.mcp; await admitted(spec.url);
    if (typeof listFor === 'function') { const entries = await listFor(source); await current(); return entries; }
    const post = await postFor(source);
    if (!post) throw fail('tool_server_credential_binding_refused');
    const entries = await toolServerSession({ url: spec.url, post }).list();
    await current(); return entries;
  };
  async function start(server, challenge = {}) {
    await admitted(server);
    const found = await discoverSignIn({ server, challenge, request });
    for (const uri of [found.authorization_endpoint, found.token_endpoint, ...(found.registration_endpoint ? [found.registration_endpoint] : [])]) await admitted(uri);
    const clientKey = fact('client', `${found.issuer}|${returnTo}`);
    let client = await facts.read(clientKey);
    if (!client) { client = await registerClient({ found, redirect_uri: returnTo, client_name: clientName, request }); await current(); await facts.write(clientKey, client); }
    if (typeof client.client_id !== 'string' || !client.client_id) throw fail('tool_server_client_refused');
    const state = Array.from(random(new Uint8Array(data.state_bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
    const { challenge: codeChallenge } = await vault.createVerifier({ server, state });
    if (typeof codeChallenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw fail('tool_server_verifier_refused');
    await current();
    const pending = { server, found, client_id: client.client_id, started_at: new Date(now()).toISOString(), redirect_uri: returnTo };
    await facts.write(fact('pending', state), pending);
    await callbacks.remember({ state, pending, expires_at: now() + data.pending_minutes * 60000 }); await current();
    return { open: authorizationAddress({ found, client_id: client.client_id, redirect_uri: returnTo, challenge: codeChallenge, state }) };
  }
  async function add(input = {}) {
    if (!object(input) || Object.keys(input).some(key => !['server', 'name', 'key_intake', 'key_header', 'key_prefix'].includes(key))) throw fail('tool_server_add_input_refused');
    const server = await admitted(input.server), name = String(input.name ?? '').trim().slice(0, data.name_chars) || new URL(server).host;
    const shared = (await rowSources()).filter(source => source?.list?.mcp?.url === server);
    await current();
    if (input.key_intake !== undefined) {
      const key = keyPlacement(input), accepted = await vault.acceptKeyIntake({ server, intake: input.key_intake, placement: key });
      if (accepted?.changed !== true) throw fail('tool_server_key_unkept');
      const source = addedToolServerSource(server, name, false, key);
      try { await current(); const entries = await list(source); await facts.write(fact('added', server), source); await current(); return { server, name, tools: entries.length, state: 'ready' }; }
      catch (error) { if (accepted?.changed === true) await vault.rollbackKey({ server, rollback_handle: accepted.rollback_handle }); throw fail(error instanceof ToolServerNeedsSignIn ? 'tool_server_key_refused' : 'tool_server_add_unavailable'); }
    }
    const source = addedToolServerSource(server, name);
    try { const entries = await list(source); if (!shared.length) await facts.write(fact('added', server), source); await current(); return { server, name, tools: entries.length, state: 'ready', ...(shared.length ? { already_shared: true } : {}) }; }
    catch (error) {
      if (!(error instanceof ToolServerNeedsSignIn)) throw error;
      await current(); if (!shared.length) await facts.write(fact('added', server), addedToolServerSource(server, name, true));
      return { server, name, state: 'sign_in_required', ...await start(server, error) };
    }
  }
  /** Native consumePending validates the opaque callback's original binding
   * before mutation. Its durable claim and the existing HTTP/vault receipt are
   * distinct from transient raw-value custody. recover is a scoped facade over
   * that SAME receipt owner, never a second journal: a known sealed result can
   * finish metadata publication after restart without another code exchange. */
  async function finish(input = {}) {
    if (!object(input) || Object.keys(input).some(key => !['state', 'callback_intake', 'error'].includes(key))) throw fail('tool_server_callback_input_refused');
    const { state, callback_intake, error } = input;
    if (typeof state !== 'string' || !/^[a-f0-9]{48}$/.test(state)) throw fail('tool_server_pending_refused');
    await current();
    let pending = await facts.consumePending(fact('pending', state), { state, callback_intake });
    let sealed, replayed = false;
    if (!pending) {
      const receipt = await callbacks.recover(state);
      await current();
      if (!receipt) throw fail('tool_server_pending_consumed');
      if (typeof receipt.request_key !== 'string' || !receipt.request_key || receipt.request_key.length > 4096 || /[\x00-\x1f\x7f]/.test(receipt.request_key)) throw fail('tool_server_receipt_refused');
      if (receipt.status === 'unknown') throw Object.assign(fail('tool_server_exchange_unknown'), { outcome: 'unknown', request_key: receipt.request_key });
      if (receipt.status === 'refused') throw Object.assign(fail('tool_server_exchange_refused'), { request_key: receipt.request_key });
      if (receipt.status !== 'kept' || !object(receipt.pending) || receipt.result?.kept !== true) throw fail('tool_server_receipt_refused');
      pending = receipt.pending; sealed = receipt.result; replayed = true;
    } else await callbacks.forget(state);
    try {
      if (!replayed && error) throw fail('tool_server_sign_in_refused');
      if (pending.redirect_uri !== returnTo || !Number.isFinite(Date.parse(pending.started_at))) throw fail('tool_server_pending_refused');
      if (!replayed && (typeof callback_intake !== 'string' || !callback_intake
        || Date.parse(pending.started_at) > now() || Date.parse(pending.started_at) + data.pending_minutes * 60000 < now())) throw fail('tool_server_pending_expired');
      await admitted(pending.server);
      if (pending.found?.server !== pending.server || typeof pending.client_id !== 'string' || !pending.client_id) throw fail('tool_server_pending_refused');
      await admitted(pending.found.token_endpoint);
      try { if (!replayed) sealed = await vault.exchangeAndKeep({ ...pending, state, callback_intake }); }
      catch (error) { throw Object.assign(fail(error?.outcome === 'unknown' ? 'tool_server_exchange_unknown' : 'tool_server_exchange_refused'),
        error?.outcome === 'unknown' ? { outcome: 'unknown' } : {},
        typeof error?.request_key === 'string' && error.request_key && error.request_key.length <= 4096 && !/[\x00-\x1f\x7f]/.test(error.request_key) ? { request_key: error.request_key } : {}); }
      if (!sealed || sealed.kept !== true) throw fail('tool_server_token_reply_unkept');
      await current();
      const existing = await facts.read(fact('sign_in', pending.server));
      if (replayed && existing?.authorization_state && existing.authorization_state !== state) throw fail('tool_server_authorization_replaced');
      if (!replayed || existing?.authorization_state !== state) {
        await facts.write(fact('sign_in', pending.server), { server: pending.server, found: pending.found, client_id: pending.client_id,
          expires_at: sealed.expires_at ?? null, signed_in_at: sealed.signed_in_at ?? new Date(now()).toISOString(), refreshed_at: sealed.signed_in_at ?? new Date(now()).toISOString(), authorization_state: state });
      }
      const source = await facts.read(fact('added', pending.server)) ?? (await rowSources()).find(source => source?.list?.mcp?.url === pending.server);
      if (!source) throw fail('tool_server_source_withdrawn');
      const entries = await list(source); return { server: pending.server, tools: entries.length, state: 'ready' };
    } finally { if (!replayed) await vault.removeVerifier({ state }); }
  }
  return { add, start, finish };
}
