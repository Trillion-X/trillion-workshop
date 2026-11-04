// Registries read at find time, and calls sent through Trillion's own account at a gateway.
//
// A `tool-search-source` row (ai-tool-catalog DATA) says how to ask a registry for tools that do a job (`search`), how to
// read one tool by its id (`get`), which result field holds what (`entry`), how its input fields become a JSON Schema
// (`input_dialect`), where its quoted price is (`price`), and the tool row each result fills (`row`). Nothing is copied
// in ahead of time: a registry with thousands of tools is asked when a job is asked, and a tool is kept as a row only
// after its first checked run (`kept`), so what is stored is what someone actually used.
//
// A `tool-gateway` row is Trillion's one account at a gateway: the NAME its key is kept under in the platform's locked
// box, where the key is placed, the only hosts it may go to, the per-call tag that names the person, and the markup.
// The key is placed by the platform box (src/pool.mjs `gatewaySend`); nothing here ever holds it.
import signals from './tool-effect-signals.json' with { type: 'json' };
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const at = (value, field) => (object(value) ? value[field] : undefined);

/** A field of a registry's answer by where it sits: a name, or the steps to it (names and list positions). */
export function pick(value, path) {
  let here = value;
  for (const step of Array.isArray(path) ? path : [path]) {
    if (here === null || typeof here !== 'object') return undefined;
    here = here[step];
  }
  return here;
}

// A template value `{ fill: { from: 'entry', field } }` is the entry's field; everything else is copied as written.
function fillFromEntry(template, entry) {
  if (Array.isArray(template)) return template.map(item => fillFromEntry(item, entry));
  if (!object(template)) return template;
  if (Object.keys(template).length === 1 && object(template.fill) && template.fill.from === 'entry') return entry[template.fill.field];
  return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fillFromEntry(value, entry)]));
}

/** A registry's own input description (groups of fields with their types) as a JSON Schema, read through the dialect. */
export function schemaFromDialect(input, dialect) {
  const properties = {};
  const required = [];
  for (const [group, name] of Object.entries(dialect?.groups ?? {})) {
    const fields = at(input, group);
    if (!object(fields) || !Object.keys(fields).length) continue;
    const inner = {};
    const needed = [];
    for (const [field, spec] of Object.entries(fields)) {
      const type = dialect.types?.[String(at(spec, 'type') ?? '').toLowerCase()];
      inner[field] = {
        ...(type ? { type } : {}),
        ...(at(spec, 'note') ? { description: String(spec.note) } : {}),
        ...(at(spec, 'example') !== undefined ? { examples: [spec.example] } : {}),
      };
      if (at(spec, 'required') === true) needed.push(field);
    }
    properties[name] = { type: 'object', properties: inner, ...(needed.length ? { required: needed } : {}) };
    if (needed.length) required.push(name);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** One registry result's fields, named as the source's `entry` says, each read from where it sits. */
export const entryOf = (source, raw) => Object.fromEntries(Object.entries(source.entry).map(([field, from]) => [field, pick(raw, from)]));

/**
 * Whether a registry tool only reads ('read'), may change something out in the world ('write') or neither signal says
 * ('unknown'): from the request's own character (the entry's `read_only`, else its method) and, apart from that, the
 * words the tool describes itself with (src/tool-effect-signals.json, or the source's own `effect_signals`).
 */
export function toolEffectOf(entry, using = signals) {
  const words = new RegExp(`\\b(${using.write_words.join('|')})\\b`, 'i');
  const spoken = words.test(`${entry.label ?? ''} ${entry.job ?? ''}`);
  const method = typeof entry.method === 'string' ? entry.method.toUpperCase() : null;
  const asked = typeof entry.read_only === 'boolean' ? (entry.read_only ? 'read' : 'write') : method ? (using.safe_methods.includes(method) ? 'read' : 'write') : null;
  if (asked === 'write' || spoken && asked !== 'read') return 'write';
  if (asked === 'read') return spoken ? 'write' : 'read';
  return spoken ? 'write' : 'unknown';
}

/** One registry result as a tool row: the source's template filled from the result, its price and what the registry measured. */
export function rowFromEntry(source, raw) {
  const entry = entryOf(source, raw);
  if (typeof entry.id !== 'string' || !entry.id) return null;
  const filled = fillFromEntry(source.row, entry);
  const invoke = object(filled.invoke) ? { ...filled.invoke } : null;
  // A tool that is not known to only read is kept as one that may change things (see toolEffectOf).
  if (invoke && invoke.external_effect === undefined && toolEffectOf(entry, source.effect_signals ?? signals) !== 'read') invoke.external_effect = true;
  // The registry's own id goes into the address now, escaped, so the run-time request grammar never reads it as a hole.
  if (invoke && typeof invoke.url === 'string') invoke.url = invoke.url.replace('{id}', encodeURIComponent(entry.id));
  const cost = source.price ? at(raw, source.price.field) : undefined;
  const usd = Number(at(cost, source.price?.usd));
  const provenance = {
    source: source.id,
    ...(object(entry.test_request) ? { example_input: renamedGroups(entry.test_request, source.input_dialect) } : {}),
    ...(source.surface ? { surface: source.surface } : {}),
  };
  return {
    kind: 'ai-tool-descriptor',
    id: `${source.id_prefix}${entry.id}`,
    label: String(entry.label ?? entry.id),
    job: String(entry.job ?? entry.label ?? entry.id),
    description: [entry.job, entry.provider ? `from ${entry.provider}, through ${source.label}` : `through ${source.label}`].filter(Boolean).join(', '),
    status: 'active',
    input_schema: source.input_dialect ? schemaFromDialect(entry.input, source.input_dialect) : (entry.input_schema ?? { type: 'object' }),
    ...filled,
    ...(invoke ? { invoke } : {}),
    billing: {
      ...(object(filled.billing) ? filled.billing : {}),
      ...(Number.isFinite(usd) ? { price_micros: Math.round(usd * 1e6), per: String(at(cost, source.price.per) ?? 'call') } : {}),
      source: source.id,
      ...(entry.verified || entry.works ? { measured_by_source: { ...(entry.verified ? { verified_on: entry.verified } : {}), ...(entry.works ? { works: entry.works } : {}) } } : {}),
    },
    provenance,
  };
}

const renamedGroups = (value, dialect) => (dialect?.groups ? Object.fromEntries(Object.entries(value).map(([group, fields]) => [dialect.groups[group] ?? group, fields])) : value);

export async function readJson(request, url, init, timeoutMs = 20000) {
  const response = await request(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} answered ${response.status}`);
  return response.json();
}

/** What a source lists when its row does not say: tools. */
export const LISTS_TOOLS = 'tools';
/** The sources in `sources` that list `finds`. */
export const sourcesThatFind = (sources, finds) => sources.filter(source => (source.finds ?? LISTS_TOOLS) === finds);

/**
 * The registries in the shared rows, asked live.
 *   data()   the shared rows (`search_sources`)
 *   kept     { list(only?) → rows, keep(row) }: tools kept after their first checked run; optional `only` selects an id
 */
export function toolSources({ data, kept, request = fetch }) {
  // Every registry that lists tools is asked at once; one that cannot be read is named in `unread`, never hidden.
  async function search(job, limit) {
    const { search_sources: all = [] } = await data();
    const answers = await Promise.all(sourcesThatFind(all, LISTS_TOOLS).map(async source => {
      const url = new URL(source.search.url);
      url.searchParams.set(source.search.query_param, job);
      if (source.search.limit_param) url.searchParams.set(source.search.limit_param, String(limit));
      try {
        const reply = await readJson(request, url.href, { method: source.search.method ?? 'GET', ...(source.search.headers ? { headers: source.search.headers } : {}) });
        return { rows: (pick(reply, source.search.items_field) ?? []).map(raw => rowFromEntry(source, raw)).filter(Boolean) };
      } catch (error) {
        return { unread: { source: source.id, reason: String(error.message ?? error) } };
      }
    }));
    return { rows: answers.flatMap(answer => answer.rows ?? []), unread: answers.flatMap(answer => (answer.unread ? [answer.unread] : [])) };
  }

  async function resolve(toolId) {
    const kepts = await kept.list();
    const saved = kepts.find(row => row.id === toolId);
    if (saved) return saved;
    const { search_sources: sources = [] } = await data();
    const source = sourcesThatFind(sources, LISTS_TOOLS).find(item => toolId.startsWith(item.id_prefix));
    if (!source?.get) return null;
    const id = toolId.slice(source.id_prefix.length);
    const segments = source.get.id_path_segments;
    const parts = id.split('/');
    if (segments && (parts.length !== segments || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..'))) return null;
    const safeId = segments ? parts.map(encodeURIComponent).join('/') : encodeURIComponent(id);
    const reply = await readJson(request, source.get.url.replace('{id}', safeId), { method: 'GET', ...(source.get.headers ? { headers: source.get.headers } : {}) }).catch(() => null);
    const raw = source.get.item_field ? at(reply, source.get.item_field) : reply;
    return raw ? rowFromEntry(source, raw) : null;
  }

  return { search, resolve, kept: only => kept.list(only), keep: row => kept.keep(row) };
}

/**
 * The executor for `invoke.kind: 'gateway-call'`: the person's input `{ query?, body? }` becomes one request to the
 * gateway's own address for that tool, sent by the platform box with Trillion's account key (`gatewaySend`). The
 * person is named only by an opaque tag, and a retry of the same task carries the same idempotency key. The gateway's
 * reported cost is handed back through `report`, so the charge becomes what the call actually cost.
 */
export function gatewayCall({ gateways, gatewaySend, personTag }) {
  return async ({ invocation, input, task, report }) => {
    const gateway = (await gateways()).find(item => item.id === invocation.gateway);
    if (!gateway) throw new Error(`There is no gateway ${invocation.gateway}.`);
    const url = new URL(invocation.url);
    const settings = gateway.settings ?? {};
    // The input groups the gateway reads from the address's query (`settings.query_groups`, DATA on the gateway row):
    // a gateway that takes a tool's path fields there lists that group too.
    for (const group of settings.query_groups ?? ['query']) {
      for (const [name, value] of Object.entries(input?.[group] ?? {})) url.searchParams.set(name, typeof value === 'string' ? value : JSON.stringify(value));
    }
    const method = String(invocation.method ?? (input?.body ? 'POST' : 'GET')).toUpperCase();
    const headers = {
      accept: 'application/json',
      'idempotency-key': task.task_id,
      ...(gateway.meta ? { [gateway.meta.header]: `${gateway.meta.key}=${personTag}` } : {}),
      ...(settings.max_cost_header && task.payer?.quote_micros !== undefined ? { [settings.max_cost_header]: String(Math.max(task.payer.quote_micros, 1) / 1e6) } : {}),
      ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
    };
    const reply = await gatewaySend({ gateway: gateway.id, request: { url: url.href, method, headers, ...(method !== 'GET' ? { body: JSON.stringify(input?.body ?? {}) } : {}) } });
    const text = typeof reply.body === 'string' ? reply.body : new TextDecoder().decode(Uint8Array.from(reply.body ?? []));
    const cost = Number(Object.entries(reply.headers ?? {}).find(([name]) => name.toLowerCase() === String(settings.cost_header ?? '').toLowerCase())?.[1]);
    if (Number.isFinite(cost)) report?.({ cost_micros: cost });
    let value;
    try { value = JSON.parse(text); } catch { value = text; }
    if (!(reply.status_code >= 200 && reply.status_code < 300)) throw Object.assign(new Error(`${gateway.label} answered ${reply.status_code}: ${(typeof value?.error === 'string' ? value.error : typeof value?.detail === 'string' ? value.detail : text).slice(0, 300)}`), { service_answered: reply.status_code });
    return value;
  };
}
