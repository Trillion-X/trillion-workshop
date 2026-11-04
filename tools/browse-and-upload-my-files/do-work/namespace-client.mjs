// Purpose: reach a hosted namespace (the Workshop's /namespace service) from any program on any computer. Control
// requests (mint a lease, look a file up, name files) go through a transport the caller chooses: `bearerControl`
// sends them with an access token the caller holds in memory (a customer's browser sign-in or personal key), and
// `vaultControl` (vault-control.mjs) has a running app's web client inject a vault-held key at request time, so that
// program never holds the key at all. Bytes then move with a short-lived lease the service minted, never with the key.
//
// Invariants:
// - The account key or token never enters an argument, a file or a log; a vault-held key never enters this process.
// - A lease is kept in memory only and renewed before it expires. Leases are long (a day by default), so the
//   transport, which may answer slowly, is asked rarely.
// - `readers()` returns the target readers the live-namespace resolver needs for the rows this service hands out
//   (read-data/resolve-identity-to-bytes.mjs). The resolver still names no protocol; this module is the host that
//   owns the http transport.

import { sharedNamespaceFile as sharedMountedFile } from './shared-file-reference.mjs';

const RENEW_BEFORE_MS = 10 * 60 * 1000;

/**
 * Control requests sent straight to the service with `Authorization: <await authorization()>`, for a caller that
 * holds its own access (an OAuth access token from signing in, or a personal key). Returns { status, body }.
 */
export function bearerControl({ origin, authorization, fetchImpl = fetch }) {
  const base = origin.replace(/\/$/, '');
  return async (path, { method = 'GET', body = null, alsoInjected = [], signal = null } = {}) => {
    if (alsoInjected.length) throw new Error('Values held in a vault can only be sent through a vault transport.');
    const response = await fetchImpl(`${base}/mcp/api${path}`, { method, headers: { authorization: await authorization(), ...(body === null ? {} : { 'content-type': 'application/json' }) }, body: body === null ? null : JSON.stringify(body), ...(signal ? { signal } : {}) });
    const raw = await response.text();
    let parsed = raw;
    try { parsed = JSON.parse(raw); } catch {}
    return { status: response.status, body: parsed };
  };
}

export function namespaceClient({ origin, control, leaseSeconds = 24 * 3600, namesTimeoutMs = 15_000, fetchImpl = fetch } = {}) {
  if (!origin || typeof control !== 'function') throw new Error('A namespace client needs the service origin and a control transport (bearerControl or vaultControl).');
  if (!Number.isInteger(namesTimeoutMs) || namesTimeoutMs < 1 || namesTimeoutMs > 2 ** 31 - 1) throw new Error('Namespace control reads need a finite positive time limit.');
  const base = origin.replace(/\/$/, '');
  const leases = new Map();

  // A control operation owns one budget across headers, body consumption and retry waits. The transport
  // receives its cancellation signal, and a transport that fails to honor it cannot hold the caller forever.
  // Byte readers keep their own streaming lifetime; only their short lease admission uses this budget.
  function awaitControl(work, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const stopped = () => { signal.removeEventListener('abort', stopped); reject(signal.reason); };
      signal.addEventListener('abort', stopped, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(value => {
        signal.removeEventListener('abort', stopped);
        if (signal.aborted) reject(signal.reason); else resolve(value);
      }, error => {
        signal.removeEventListener('abort', stopped);
        reject(signal.aborted ? signal.reason : error);
      });
    });
  }
  async function withControlDeadline(caller, work) {
    caller?.throwIfAborted();
    const controller = new AbortController(), signal = controller.signal;
    const stopped = () => controller.abort(caller.reason);
    caller?.addEventListener('abort', stopped, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('The Namespace control read did not answer in time.', 'TimeoutError')), namesTimeoutMs);
    const read = (path, options) => awaitControl(() => control(path, { ...options, signal }), signal);
    try { return await awaitControl(() => work(signal, read), signal); }
    finally { clearTimeout(timer); caller?.removeEventListener('abort', stopped); }
  }
  const controlAfterTransientFailure = (path, options) => withControlDeadline(options?.signal,
    (signal, read) => retryControl(path, { ...options, signal }, read));

  // Only transport failures and 5xx are tried again, at most eight times within that budget. Missing files,
  // access refusals and other answers stay final; a deadline or caller cancellation is never retried.
  async function retryControl(path, options, read) {
    const signal = options?.signal;
    for (let attempt = 1; ; attempt += 1) {
      signal?.throwIfAborted();
      let response;
      try { response = await read(path, options); }
      catch (error) {
        signal?.throwIfAborted();
        if (attempt >= 8) throw error;
        response = { status: 0 };
      }
      signal?.throwIfAborted();
      if ((response.status === 0 || response.status >= 500) && attempt < 8) {
        await new Promise((resolve, reject) => {
          const finish = () => { signal?.removeEventListener('abort', stopped); resolve(); };
          const timer = setTimeout(finish, Math.min(1000 * 2 ** (attempt - 1), 30000));
          const stopped = () => { clearTimeout(timer); signal.removeEventListener('abort', stopped); reject(signal.reason); };
          signal?.addEventListener('abort', stopped, { once: true });
        });
        continue;
      }
      return response;
    }
  }

  async function lease(scope, { signal } = {}) {
    signal?.throwIfAborted();
    const held = leases.get(scope);
    if (held && Date.parse(held.expires_at) - Date.now() > RENEW_BEFORE_MS) return held.lease;
    const { status, body } = await controlAfterTransientFailure('/namespace/leases', { method: 'POST', body: { scope, seconds: leaseSeconds }, ...(signal ? { signal } : {}) });
    if (status !== 200) throw Object.assign(new Error(`The namespace refused a ${scope} lease (${status}): ${body?.error ?? body}`), { status });
    leases.set(scope, body);
    return body.lease;
  }

  // One file by name or identity; mounted readers opt out of locators and a transferable read lease.
  async function file(nameOrIdentity, { signal, metadataOnly = false } = {}) {
    const { status, body } = await controlAfterTransientFailure('/namespace/files/lookup', { method: 'POST', body: { ...(nameOrIdentity.startsWith('/') ? { name: nameOrIdentity } : { identity: nameOrIdentity }), ...(metadataOnly ? { metadata: 'file' } : {}) }, ...(signal ? { signal } : {}) });
    if (status === 404) return null;
    if (status !== 200) throw Object.assign(new Error(`The namespace could not look up ${nameOrIdentity} (${status}): ${body?.error ?? body}`), { status });
    // An older service or malformed success cannot silently send a mounted reader down the lease path.
    if (metadataOnly && (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'error')
      || !/^(1f|12):[0-9a-f]{64}$|^up:[0-9a-f]{32}$/.test(body.identity ?? '')
      || !Number.isSafeInteger(body.byte_length) || body.byte_length < 0
      || typeof body.stored !== 'boolean' || body.stored !== (body.growing !== true)
      || Object.hasOwn(body, 'growing') && body.growing !== true
      || body.growing === true && typeof body.length_known !== 'boolean'
      || !Array.isArray(body.names) || body.names.length > 20
      || body.names.some(name => typeof name !== 'string' || !name.startsWith('/') || /[\u0000-\u001f\u007f]/.test(name))
      || typeof nameOrIdentity === 'string' && nameOrIdentity.startsWith('/') && !body.names.includes(nameOrIdentity))) {
      throw new Error('The namespace did not return current file metadata.');
    }
    return body;
  }

  // An exact name or implied folder, independently of stored bytes; only a successful explicit absence returns null.
  async function entry(name, { signal, fileMetadata = false } = {}) {
    if (typeof name !== 'string' || !name.startsWith('/') || name.length > 4096 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Give an exact name from your namespace.');
    const { status, body } = await controlAfterTransientFailure('/namespace/entry', { method: 'POST', body: { name, ...(fileMetadata ? { metadata: 'file' } : {}) }, ...(signal ? { signal } : {}) });
    if (status !== 200) throw Object.assign(new Error(`The namespace could not check ${name} (${status}): ${body?.error ?? body}`), { status });
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'error') || body.name !== name || typeof body.found !== 'boolean') throw new Error('The namespace did not return an exact name check.');
    if (!body.found) {
      if (body.entry !== null) throw new Error('The namespace did not return an exact name check.');
      return null;
    }
    if (!body.entry || typeof body.entry !== 'object' || Array.isArray(body.entry) || body.entry.name !== name || typeof body.entry.folder !== 'boolean') throw new Error('The namespace did not return an exact name check.');
    if (fileMetadata) {
      const row = body.entry;
      if (row.folder ? !/^folder:\d+$/.test(row.revision ?? '')
        : ![true, false, null].includes(row.stored)
          || (row.stored === true && (typeof row.identity !== 'string' || !row.identity || !Number.isSafeInteger(row.byte_length) || row.byte_length < 0))) {
        throw new Error('The namespace did not return current file metadata.');
      }
    }
    return body.entry;
  }
  // Shared inputs retain their member grant; never look up another contributor in this account's Files.
  async function readSharedFile({ space_id, item_id }, signal, read) {
    if (![space_id, item_id].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value))) throw new Error('A shared file needs its exact space_id and item_id.');
    const { status, body } = await retryControl(`/spaces/${encodeURIComponent(space_id)}/items/${encodeURIComponent(item_id)}/file`, { signal }, read);
    if (status === 404) return null;
    if (status !== 200 || body?.error) throw Object.assign(new Error(body?.error ?? `The shared file could not be opened (${status}).`), { status: status === 200 ? 403 : status });
    return body;
  }
  const sharedFile = (reference, { signal } = {}) => withControlDeadline(signal,
    (checked, read) => readSharedFile(reference, checked, read));
  async function sharedNamespaceFile(reference, { root, signal, catalog } = {}) {
    // Permission and the exact member catalog share one deadline; neither restarts its budget.
    return withControlDeadline(signal, async (checked, read) => {
      const row = await readSharedFile(reference, checked, read);
      const readCatalog = (path, options) => retryControl(path, { ...options, signal: checked }, read);
      return row ? sharedMountedFile(root, reference, readCatalog, { signal: checked, row, catalog }) : null;
    });
  }

  // A URL any reader (a player, ffmpeg, curl) can open for these bytes until the lease expires.
  async function readUrl(identity, { signal } = {}) {
    const capability = await lease('read', { signal });
    signal?.throwIfAborted();
    return `${base}/namespace/bytes/${identity}?lease=${capability}`;
  }

  // Readers for the rows this service hands out. `http-client` rows carry the service URL without a lease; the lease
  // is this host's capability, added here at read time.
  function readers() {
    return {
      'http-client': async request => {
        const signal = request.signal;
        signal?.throwIfAborted();
        const url = new URL(request.url);
        if (url.origin !== base) throw new Error(`this host holds no lease for ${url.origin}`);
        url.searchParams.set('lease', await lease('read', { signal }));
        const waiting = work => signal ? awaitControl(work, signal) : work();
        const response = await waiting(async () => {
          const answer = await fetchImpl(url, { method: request.method ?? 'GET', headers: request.headers ?? {}, ...(signal ? { signal } : {}) });
          // A transport can answer after its caller has cancelled. Retire that
          // actual body without starting another read or leaving it unconsumed.
          if (signal?.aborted) {
            void answer.body?.cancel(signal.reason).catch(() => {});
            signal.throwIfAborted();
          }
          return answer;
        });
        if (response.status !== 206 && response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw Object.assign(new Error(`the namespace answered ${response.status}`), { status: response.status });
        }
        // The caller owns byte lifetime. The metadata deadline ends once the
        // lease arrives; cancellation still reaches a pending native body read.
        const body = signal && response.body
          ? new Response(response.body.pipeThrough(new TransformStream(), { signal })) : response;
        return new Uint8Array(await waiting(() => body.arrayBuffer()));
      },
    };
  }

  // Write-lease requests for a file that grows while it uploads (/namespace/growing/...), lease in Authorization.
  async function grow(path, init = {}) {
    const headers = { ...(init.headers ?? {}), authorization: `Bearer ${await lease('write', { signal: init.signal })}` };
    init.signal?.throwIfAborted();
    return fetchImpl(`${base}/namespace/growing${path ? `/${path}` : ''}`, { ...init, headers });
  }

  // Small whole files, many in one request (/namespace/whole-files), with the write lease.
  async function keepWholeFiles(body, { signal } = {}) {
    const capability = await lease('write', { signal });
    signal?.throwIfAborted();
    return fetchImpl(`${base}/namespace/whole-files`, { method: 'POST', headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/octet-stream' }, body, ...(signal ? { signal } : {}) });
  }

  return {
    control, lease, file, entry, sharedFile, sharedNamespaceFile, readUrl, readers, grow, keepWholeFiles,
    summary: async () => (await control('/namespace/summary')).body,
    // Attach a store's access key (both halves held in the vault under their names) to this namespace. The service
    // checks it with one signed request to the store before keeping it; the values never pass through this process.
    attachStore: async ({ id, keyIdName, keySecretName, settings = null, shape = null }) => {
      const { status, body } = await control('/namespace/origins', { method: 'POST', body: { id, ...(settings ? { settings } : {}), ...(shape ? { interface: shape } : {}) }, alsoInjected: [{ header: 'x-key-id', vaultName: keyIdName }, { header: 'x-key', vaultName: keySecretName }] });
      if (status !== 200) throw new Error(`The namespace did not attach ${id} (${status}): ${body?.error ?? body}`);
      return body;
    },
    // Hand the service the app's own key for one of its stores, kept for everyone. The request also carries a
    // Cloudflare API token from the vault, which proves the sender runs the service; neither value passes through here.
    keepAppStoreKey: async ({ id, keyIdName, keySecretName, ownerTokenName }) => {
      const { status, body } = await control(`/namespace/origins/${encodeURIComponent(id)}/app-key`, { method: 'POST', body: {}, alsoInjected: [{ header: 'x-key-id', vaultName: keyIdName }, { header: 'x-key', vaultName: keySecretName }, { header: 'x-service-owner-token', vaultName: ownerTokenName }] });
      if (status !== 200) throw new Error(`The namespace did not keep the key for ${id} (${status}): ${body?.error ?? body}`);
      return body;
    },
    stores: async () => (await control('/namespace/origins')).body,
    // One page of a folder: its folders, and each name with its identity, size, modified time and whether it is stored.
    names: async (collection, { after = '', limit = 1000, signal } = {}) => {
      const { status, body } = await withControlDeadline(signal, (checked, read) => read('/namespace/listing', { method: 'POST', body: { collection, after, limit }, signal: checked }));
      if (status !== 200) throw new Error(`The namespace could not list ${collection} (${status}): ${body?.error ?? body}`);
      return body;
    },
    putNames: async (names, { signal } = {}) => {
      const { status, body } = await control('/namespace/names', { method: 'POST', body: { names }, ...(signal ? { signal } : {}) });
      if (status !== 200) throw Object.assign(new Error(`The namespace refused the names (${status}): ${body?.error ?? (body?.conflicts?.length ? 'A file name changed.' : body)}`), { status, conflicts: body?.conflicts ?? [] });
      return body;
    },
  };
}
