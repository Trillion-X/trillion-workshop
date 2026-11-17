// Source-first adaptation of trillion src/live-tool-sources.mjs at 1cacb3a0d6adc87947638431c420a13efe7d8373.
//
// Purpose
//   Tools read live from where they are described, so an API with a description or a remote tool server is one row and
//   every operation or tool in it is a Workshop tool that changes when its source changes, with nothing copied in.
//   Native account admission supplies current source configuration and exact original logical records. Each kind
//   names a `tool-row-source` template, the shape this package's rowsFromList already pours into tool rows.
//   Shared and private sources stay distinct; original added servers retain their own source ids and tool prefixes.
//
//   How a source is read, cheapest first:
//     1. at most once every check_every_minutes per source;
//     2. an address that says how it changes (an ETag or Last-Modified) is asked whether it changed, and a "not
//        modified" answer ends the read; otherwise the answer's BLAKE3 identity is compared with the one kept, and an
//        unchanged answer ends it;
//     3. only a changed answer is parsed again; raw kept entries are re-derived through the current template.
//   A source that cannot be read keeps the rows of its last good read and says when that was and why the newest read
//   failed. A source removed is never read again and its rows leave at once. Exact current cache ids are derived
//   here and read by the native logical-record owner, so historical cache revisions are never enumerated.
//
// Non-negotiable invariants
//   1. Blind: nothing here names an API, a server, a host or a tool. Kinds and sources are rows.
//   2. A fact lives at its source: every row names the source it was read from and the identity of the answer it came
//      from; nothing is typed in by hand.
//   3. A key is never here: a source names the connection field its key comes from. Native source admission keeps
//      account, source, config, logical-root and key witnesses through network effects and output. Only native
//      credential owners place secrets; authenticated discovery carries public entries bound to the exact source.
//   4. Only public addresses are read, through the existing postWithFetch/public-address owner and native egress.
// The exact original is held in ports/source-baselines. The existing records door replaces retired SQL; native
// derivation opens no records descriptor and writes no durable cache. Nothing here starts the retired runtime.
import data from '../read-data/account-live-source-reads.json' with { type: 'json' };
import { rowsFromList } from './derive-tool-rows-from-sources.mjs';
import { openapiEntries } from './read-openapi.mjs';
import { toolServerSession, postWithFetch, messagesIn } from './talk-to-a-tool-server.mjs';
import { canonicalJson, makeHashCodeHexFromJson, makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { rowSourceOf } from './source-template.mjs';
export { rowSourceOf } from './source-template.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const fail = code => Object.assign(new Error(code), { code });
const positive = (n, fallback) => Number.isFinite(n) && n > 0 ? Math.min(n, fallback) : fallback;
const secretHeader = new RegExp(data.secret_header, 'i'), secretQuery = new RegExp(data.secret_query, 'i');
const identityOf = text => makeHashCodeHexFromBytes(new TextEncoder().encode(text));
/** Every tool row the reads hold, first source first; an id one source already gave is not given twice. */
export function rowsOf(reads) {
  const seen = new Set();
  return reads.flatMap(read => read.rows).filter(row => !seen.has(row.id) && seen.add(row.id));
}

/** The sources among `reads` that give no tools: { source_id, state: 'pending' | 'unavailable', reason }. Never an empty list standing for them. */
export function unavailableIn(reads) {
  return reads.filter(read => read.state !== 'ready').map(read => ({ source_id: read.source_id, state: read.state,
    reason: read.state === 'pending' ? 'It is being read for the first time.' : (read.error ?? read.held?.[0]?.reasons?.join(' ') ?? 'It has not been read.') }));
}
export function accountRowSource(source, config) {
  if (!object(source) || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(source.id) || !Object.hasOwn(config.kinds, source.kind)
    || !object(config.kinds[source.kind]?.source?.list)) throw fail('source_definition_refused');
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => secretQuery.test(key))
    || !object(source.headers ?? {}) || Object.entries(source.headers ?? {}).some(([key, value]) => secretHeader.test(key)
      || !/^[A-Za-z0-9-]{1,64}$/.test(key) || typeof value !== 'string' || value.length > 300)
    || source.only !== undefined && (!Array.isArray(source.only) || !source.only.every(id => typeof id === 'string'))
    || source.connection !== undefined && (!object(source.connection) || Object.keys(source.connection).some(key => !['connection_id', 'field_id'].includes(key))
      || typeof source.connection.connection_id !== 'string' || !source.connection.connection_id
      || typeof source.connection.field_id !== 'string' || !source.connection.field_id)) throw fail('source_credential_metadata_refused');
  const row = rowSourceOf(source, config.kinds);
  if (row.kind !== 'tool-row-source' || typeof row.id_prefix !== 'string' || !row.id_prefix || !object(row.entry)) throw fail('source_template_refused');
  return row;
}
const empty = () => ({ version: null, entries: [], held: [], read_at: null, checked_at: null, error: null, failures: 0 });
function derive(rowSource, read) {
  const made = rowsFromList(rowSource, read.entries);
  return { rows: made.rows.map(row => ({ ...row, provenance: { ...row.provenance, version: read.version, read_at: read.read_at } })),
    held: [...read.held, ...made.refused.map(() => ({ reasons: ['source_descriptor_refused'] }))] };
}
function cacheValid(value, item) {
  return object(value) && value.source_key === item.key && value.definition_identity === item.definition_identity
    && value.configuration_identity === item.configuration_identity && Array.isArray(value.entries)
    && value.entries.length <= data.max_rows && Array.isArray(value.held) && (value.version === null || typeof value.version === 'string');
}
function configOf(value) {
  if (!object(value) || !object(value.kinds) || !Array.isArray(value.sources)) throw fail('source_configuration_unavailable');
  return structuredClone(value);
}

// The answer at an address, or `unchanged` when it says it has not changed since the kept read.
async function fetched(url, headers, kept, selected, budgetMs, request) {
  const asked = { accept: 'application/json', ...headers, ...(kept?.etag ? { 'if-none-match': kept.etag } : {}), ...(kept?.last_modified ? { 'if-modified-since': kept.last_modified } : {}) };
  const response = await request(url, { headers: asked, signal: AbortSignal.timeout(budgetMs) });
  if (response.status === 304 && kept?.version) return { unchanged: true };
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > selected.max_description_bytes) throw fail('source_read_bounds');
  return { text, etag: response.headers.get('etag'), last_modified: response.headers.get('last-modified') };
}

// What a source holds now: its list entries and the version they came from, or `unchanged`.
async function listOf(rowSource, kept, selected, budgetMs, { request, postFor, mcpEntries } = {}) {
  const list = rowSource.list ?? {};
  if (list.openapi) {
    const answer = await fetched(list.openapi.url, list.openapi.headers ?? {}, kept, selected, budgetMs, request);
    if (answer.unchanged) return answer;
    const version = identityOf(answer.text);
    if (kept && version === kept.version) return { unchanged: true, etag: answer.etag, last_modified: answer.last_modified };
    let document;
    try { document = JSON.parse(answer.text); } catch { throw new Error(`${list.openapi.url} is not JSON; an API description is read as OpenAPI or Swagger JSON.`); }
    const { entries, held_back } = openapiEntries(document, { url: list.openapi.url, connection: list.openapi.connection ?? null, only: list.openapi.only ?? null, headers: list.openapi.headers ?? {} });
    return { entries, held: held_back.map(item => ({ item: item.operation, reasons: item.reasons })), version, etag: answer.etag, last_modified: answer.last_modified };
  }
  if (list.mcp) {
    const post = mcpEntries ? null : await postFor(rowSource);
    if (!mcpEntries && !post) throw fail('source_connection_unavailable');
    const entries = mcpEntries ?? await toolServerSession({ url: list.mcp.url, post }).list();
    const version = identityOf(JSON.stringify(entries));
    if (kept && version === kept.version) return { unchanged: true };
    return { entries, held: [], version };
  }
  if (list.url) {
    const answer = await fetched(list.url, {}, kept, selected, budgetMs, request);
    if (answer.unchanged) return answer;
    const version = identityOf(answer.text);
    if (kept && version === kept.version) return { unchanged: true, etag: answer.etag, last_modified: answer.last_modified };
    const value = JSON.parse(answer.text);
    const entries = Array.isArray(value) ? value : list.items_field ? value?.[list.items_field] : null;
    if (!Array.isArray(entries)) throw new Error(`${list.url} did not return a list`);
    return { entries, held: [], version, etag: answer.etag, last_modified: answer.last_modified };
  }
  throw new Error('A live source reads an API description, a tool server or a web list.');
}

async function withinBudget(work, budgetMs) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`it did not answer within ${budgetMs / 1000} seconds`)), budgetMs); });
  work.catch(() => {});
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

function builtRowSource(source) {
  const placement = value => value === undefined || object(value) && value.kind === 'header'
    && Object.keys(value).every(key => ['kind', 'name', 'prefix'].includes(key))
    && typeof value.name === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value.name)
    && typeof value.prefix === 'string' && value.prefix.length <= 300 && !/[\r\n\0]/.test(value.prefix);
  if (!object(source) || source.kind !== 'tool-row-source' || typeof source.id !== 'string' || !source.id
    || typeof source.id_prefix !== 'string' || !source.id_prefix || !object(source.entry) || !object(source.list)
    || (typeof source.list.url === 'string' ? Object.keys(source.list).some(key => !['url', 'items_field'].includes(key))
      : Object.keys(source.list).length !== 1 || !object(source.list.mcp ?? source.list.openapi))
    || !placement(source.list.mcp?.key) || !placement(source.row?.invoke?.key)) throw fail('source_definition_refused');
  const remote = source.list.mcp ?? source.list.openapi ?? source.list, url = new URL(remote.url);
  if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => secretQuery.test(key))
    || !object(remote.headers ?? {}) || Object.keys(remote.headers ?? {}).some(key => secretHeader.test(key))) throw fail('source_credential_metadata_refused');
  return structuredClone(source);
}

/** `sourceConfig` and `requestKey` are native-owned context, not tool input. `wait:false` reads caches only.
 * A needed cold source is fetched under the native egress sandbox and the shared public-address reader.
 * Optional `postFor` is a native service-connection capability, never a raw credential or customer flag.
 */
export async function readAccountLiveSources(input = {}, { door, sourceConfig, requestKey, request = fetch,
  now = () => new Date(), postFor = async () => null, definitionSnapshot, cacheSnapshot = [], mcpLists = [], builtSources = [], cacheKeysOnly = false, mcpPlanOnly = false } = {}) {
  if (!object(input) || Object.keys(input).some(key => !['need', 'wait'].includes(key))
    || input.need !== undefined && typeof input.need !== 'string' && typeof input.need !== 'boolean'
    || input.wait !== undefined && typeof input.wait !== 'boolean') throw fail('source_input_refused');
  const nativeSnapshot = definitionSnapshot !== undefined;
  if (nativeSnapshot && (!Array.isArray(cacheSnapshot) || cacheSnapshot.length > data.max_sources
    || cacheSnapshot.some(row => !object(row) || typeof row.id !== 'string' || !object(row.value)))) throw fail('source_owner_unavailable');
  if (nativeSnapshot && (!Array.isArray(mcpLists) || mcpLists.length > data.max_sources
    || mcpLists.some(list => !object(list) || !object(list.source) || !Array.isArray(list.entries)))) throw fail('source_owner_unavailable');
  if (nativeSnapshot && (!Array.isArray(builtSources) || builtSources.length > data.max_sources
    || typeof cacheKeysOnly !== 'boolean' || typeof mcpPlanOnly !== 'boolean')) throw fail('source_owner_unavailable');
  if (nativeSnapshot ? !Array.isArray(definitionSnapshot) : !door || !['readRecord', 'list', 'write'].every(key => typeof door[key] === 'function'))
    throw fail('source_owner_unavailable');
  if (!sourceConfig || typeof sourceConfig.config !== 'function') throw fail('source_owner_unavailable');
  const assertCurrent = async () => { if (typeof sourceConfig.assertCurrent === 'function') await sourceConfig.assertCurrent(); };
  await assertCurrent();
  const config = configOf(await sourceConfig.config()), configurationIdentity = makeHashCodeHexFromJson(config);
  const own = [];
  if (nativeSnapshot) {
    for (const value of definitionSnapshot) {
      if (!object(value) || typeof value.id !== 'string') throw fail('source_owner_unavailable');
      // An immutable value snapshot only; actual physical roots/keys/current caller/configuration remain
      // in the native Source witness. No fake record identity or record-door permission is manufactured.
      own.push({ value: structuredClone(value) });
      if (own.length > data.max_sources) throw fail('source_read_bounds');
    }
  } else for await (const record of door.list({ type: data.source_type, prefix: data.source_prefix })) {
    if (!object(record.value) || record.id !== `${data.source_prefix}${record.value.id}`) throw fail('source_owner_unavailable');
    const exact = await door.readRecord(data.source_type, record.id);
    if (!exact || !same(exact.value, record.value) || typeof exact.identity !== 'string' || !exact.identity) throw fail('source_definitions_changed');
    own.push({ id: record.id, identity: exact.identity, value: structuredClone(record.value) });
    if (own.length > data.max_sources) throw fail('source_read_bounds');
  }
  const active = own.filter(record => record.value.status !== 'deleted'), privateIds = new Set(active.map(record => record.value.id));
  const candidates = [...config.sources.filter(source => !privateIds.has(source.id)).map(source => ({ source, scope: 'default' })),
    ...active.map(record => ({ source: record.value, scope: 'account' })),
    ...(nativeSnapshot ? builtSources.filter(source => source?.status !== 'deleted').map(source => ({ source, scope: 'account', built: true })) : [])];
  if (candidates.length > data.max_sources || new Set(candidates.map(item => item.source.id)).size !== candidates.length) throw fail('source_read_bounds');
  const current = async () => {
    await assertCurrent();
    if (makeHashCodeHexFromJson(configOf(await sourceConfig.config())) !== configurationIdentity) throw fail('source_configuration_changed');
    if (nativeSnapshot) return; // Its native owner fences effects and output using the retained real roots.
    const rows = [];
    for await (const record of door.list({ type: data.source_type, prefix: data.source_prefix })) {
      rows.push({ id: record.id, value: record.value });
      if (rows.length > data.max_sources) throw fail('source_read_bounds');
    }
    if (!same(rows, own.map(({ id, value }) => ({ id, value })))) throw fail('source_definitions_changed');
    for (const pin of own) if ((await door.readRecord(data.source_type, pin.id))?.identity !== pin.identity) throw fail('source_definitions_changed');
    await assertCurrent();
  };
  const reads = [], cacheIds = [], mcpSources = [];
  // The original owner reads independent sources together. Keep source order for precedence and diagnostics.
  await Promise.all(candidates.map(async (candidate, at) => {
    const item = { ...candidate, definition_identity: makeHashCodeHexFromJson(candidate.source), configuration_identity: configurationIdentity };
    try { item.rowSource = candidate.built ? builtRowSource(candidate.source) : accountRowSource(candidate.source, config); }
    catch (error) {
      reads[at] = { source_id: candidate.source.id, scope: candidate.scope, definition_identity: item.definition_identity,
        configuration_identity: configurationIdentity, state: 'unavailable', version: null, rows: [], tools: [], held: [],
        error: error.code ?? 'source_definition_refused', read_at: null, checked_at: now().toISOString() };
      return;
    }
    item.key = makeHashCodeHexFromJson({ definition: candidate.source, configuration_identity: configurationIdentity, row_source: item.rowSource });
    const cacheId = `${data.record_prefix}${item.key.slice(3)}`;
    if (nativeSnapshot && cacheKeysOnly) {
      if (typeof input.need !== 'string' || input.need.startsWith(item.rowSource.id_prefix)) cacheIds[at] = cacheId;
      return;
    }
    const stored = nativeSnapshot ? cacheSnapshot.find(row => row.id === cacheId) ?? null : await door.readRecord(data.record_type, cacheId);
    const kept = cacheValid(stored?.value, item) ? stored.value : null;
    const needs = input.need === undefined || input.need === true || typeof input.need === 'string' && input.need.startsWith(item.rowSource.id_prefix);
    const every = kept?.error ? Math.min(positive(config.retry_ceiling_minutes, data.retry_ceiling_minutes), positive(config.check_every_minutes, data.check_every_minutes), 2 ** Math.max(0, Math.min(data.max_failures, kept.failures || 1) - 1))
      : positive(config.check_every_minutes, data.check_every_minutes);
    const fresh = kept && Number.isFinite(Date.parse(kept.checked_at)) && now().getTime() - Date.parse(kept.checked_at) < every * 60000;
    let read = kept, cacheState = 'kept';
    if (nativeSnapshot && mcpPlanOnly) {
      const remote = item.rowSource.list.mcp;
      if (!fresh && input.wait !== false && needs && (!kept || kept.request_key !== requestKey)
        && remote && (remote.sign_in || remote.key || remote.connection || candidate.source.connection)) mcpSources[at] = structuredClone(candidate.source);
      return;
    }
    if (!fresh && input.wait !== false && needs && (!kept || kept.request_key !== requestKey)) {
      if (typeof requestKey !== 'string' || !requestKey) throw fail('source_request_key_required');
      const at = now().toISOString(), controller = new AbortController();
      const budget = positive(config.read_budget_ms, data.read_budget_ms), timer = setTimeout(() => controller.abort(), budget);
      try {
        let bytes = 0;
        const maxBytes = positive(config.max_description_bytes, data.max_description_bytes);
        const webPost = postWithFetch((url, init) => request(url, { ...init, signal: AbortSignal.any([controller.signal, init.signal].filter(Boolean)) }), budget);
        const boundedPost = async asked => {
          const answer = await webPost(asked);
          bytes += Buffer.byteLength(answer.text, 'utf8');
          if (bytes > maxBytes) throw fail('source_read_bounds');
          return answer;
        };
        const publicRequest = async (url, init) => {
          const answer = await boundedPost({ url, method: 'GET', ...init });
          return new Response([204, 205, 304].includes(answer.status) ? null : answer.text, { status: answer.status, headers: answer.headers });
        };
        const sourcePost = async rowSource => {
          const nativePost = await postFor(rowSource), remote = rowSource.list.mcp;
          if (!nativePost && (remote.sign_in || remote.key || remote.connection || candidate.source.connection)) throw fail('source_connection_unavailable');
          const post = nativePost ?? boundedPost;
          let lastCursor = null, pages = 0;
          return async asked => {
            if (controller.signal.aborted) throw fail('source_read_timeout');
            const answer = await post(asked), message = JSON.parse(asked.body);
            if (nativePost) {
              bytes += Buffer.byteLength(answer.text, 'utf8');
              if (bytes > maxBytes) throw fail('source_read_bounds');
            }
            if (message.method === 'tools/list') {
              pages += 1;
              const result = messagesIn(answer.text).find(item => item.id === message.id)?.result;
              if (result?.nextCursor && (pages >= 100 || result.nextCursor === lastCursor)) throw fail('source_read_bounds');
              lastCursor = result?.nextCursor ?? null;
            }
            return answer;
          };
        };
        // Native list results carry no credential and must match the exact retained source definition.
        const supplied = nativeSnapshot ? mcpLists.find(list => same(list.source, candidate.source)) : null;
        if (supplied && (supplied.entries.length > data.max_rows || supplied.entries.some(entry => !object(entry))
          || Buffer.byteLength(JSON.stringify(supplied.entries), 'utf8') > maxBytes)) throw fail('source_read_bounds');
        const got = await withinBudget(listOf(item.rowSource, kept, { ...config, max_description_bytes: maxBytes }, budget,
          { request: publicRequest, postFor: sourcePost, mcpEntries: supplied ? structuredClone(supplied.entries) : undefined }), budget);
        if (got.unchanged) read = { ...kept, etag: got.etag ?? kept.etag, last_modified: got.last_modified ?? kept.last_modified, checked_at: at, error: null, failures: 0 };
        else {
          if (got.entries.length > data.max_rows) throw fail('source_read_bounds');
          read = { version: got.version, entries: got.entries, held: got.held, etag: got.etag ?? null,
            last_modified: got.last_modified ?? null, read_at: at, checked_at: at, error: null, failures: 0 };
        }
      } catch (error) {
        const code = ['source_connection_unavailable', 'source_read_bounds', 'source_kind_unavailable'].includes(error?.code) ? error.code
          : controller.signal.aborted ? 'source_read_timeout' : 'source_remote_unavailable';
        read = { ...(kept ?? empty()), checked_at: at, error: code, failures: Math.min(data.max_failures, (kept?.failures ?? 0) + 1) };
      } finally { clearTimeout(timer); controller.abort(); }
      await current();
      const value = { ...read, source_id: item.source.id, source_key: item.key, definition_identity: item.definition_identity,
        configuration_identity: configurationIdentity, request_key: requestKey };
      if (nativeSnapshot) cacheState = 'not_kept';
      else try {
        await door.write([{ id: cacheId, type: data.record_type, value, expected: stored ? { type: data.record_type, value: stored.value } : null }],
          { key: `source-read:${requestKey}:${item.key}` });
      } catch (error) { cacheState = error?.outcome === 'unknown' ? 'unknown' : 'not_kept'; }
      await current();
    }
    read ??= { ...empty(), pending: true };
    const made = derive(item.rowSource, read);
    reads[at] = { source_id: item.source.id, kind: item.source.kind, scope: item.scope,
      definition_identity: item.definition_identity, configuration_identity: configurationIdentity, source_key: item.key,
      state: read.pending ? 'pending' : read.version === null ? 'unavailable' : 'ready', version: read.version,
      rows: made.rows, tools: made.rows.map(row => row.id), held: made.held, read_at: read.read_at, checked_at: read.checked_at,
      ...(read.error ? { error: read.error } : {}), ...(read.error && read.version ? { stale: true } : {}),
      ...(cacheState !== 'kept' ? { cache_state: cacheState } : {}) };
  }));
  await current();
  return { reads: reads.filter(Boolean), rows: rowsOf(reads), configuration_identity: configurationIdentity,
    ...(nativeSnapshot && cacheKeysOnly ? { cache_ids: cacheIds.filter(Boolean) } : {}),
    ...(nativeSnapshot && mcpPlanOnly ? { mcp_sources: mcpSources.filter(Boolean) } : {}),
    unavailable: unavailableIn(reads) };
}

/** Static row creates this envelope from separate input and native task fields. */
export function readLiveSourcesFromTask({ input = {}, source_data, request_key } = {}, { door } = {}) {
  if (!object(source_data) || !object(source_data.config)) throw fail('source_owner_unavailable');
  return readAccountLiveSources(input, { door, sourceConfig: { config: async () => source_data.config }, requestKey: request_key });
}

/** Exact installed inner row. No records descriptor is opened and no caller record permission is enlarged.
 * Native source admission supplies config+definitions and keeps their actual root/currentness witness through
 * derivation and execution. Request fields cannot supply these. This addressed path keeps no durable cache.
 */
export function deriveLiveSourcesFromTask({ input = {}, source_data, request_key } = {}) {
  if (!object(source_data) || !object(source_data.config) || !Array.isArray(source_data.own)) throw fail('source_owner_unavailable');
  return readAccountLiveSources(input, { sourceConfig: { config: async () => source_data.config },
    definitionSnapshot: source_data.own, cacheSnapshot: source_data.cache ?? [], mcpLists: source_data.mcp_lists ?? [],
    builtSources: source_data.built ?? [], cacheKeysOnly: source_data.cache_keys_only ?? false,
    mcpPlanOnly: source_data.mcp_plan_only ?? false, requestKey: request_key });
}
