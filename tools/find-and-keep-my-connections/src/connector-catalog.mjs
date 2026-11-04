// src/connector-catalog.mjs
//
// PURPOSE
//   Find a connector: one search over every public catalog of tool servers (MCP servers) the shared rows name, asked
//   live and at once. Each answer becomes a connector a person can add to their AI in one press, with where it was
//   found, what it does, how it connects, and the count each catalog itself reports.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The catalogs are DATA: every `tool-search-source` row whose `finds` names tool servers (ai-tool-catalog records).
//      Nothing here names a catalog, a vendor or an address; a new catalog is one row.
//   2. Nothing is copied ahead of time and no count is made up: `total` is the sum of the totals the catalogs reported
//      in this very answer, and a catalog that reports none is marked so (`all_reported: false`).
//   3. A catalog that fails or is slower than the time bound is named in `sources` as not reached, with the reason;
//      it never hides the others' results and never turns into an empty list that looks like "nothing matches".
//   4. A connector gets a connect address only when its source's `connector.connect` template fills completely from
//      that result into an https address (a template left with a hole, such as a server that wants a value typed into
//      its address, has none). The address is what the Workshop's add-a-tool-server tool is handed.
//
// KEY CONCEPTS
//   A source row's `search` says how to ask: `url`, `query_param`, `limit_param`, `fixed_query`, `items_field` and
//   `total_field` (a name or the steps to it), `timeout_ms`, and `paging`: either `{ param, next_field }` (the catalog
//   hands back where the next page starts) or `{ param, first, step }` (a number that grows by `step`, or by the page
//   size when `step` is "page_size"). Its `entry` names each result's fields; its `connector` is
//   `{ key?, connect: [template], connect_when?: { field, equals }, page: [template] }`, where a template is
//   `{field}` holes filled from the entry, the first complete one wins, and a template that is one hole alone takes
//   that field's own https address as it is.
//   `page` is an opaque word from a previous answer's `next_page`: where each catalog's next page starts.
import { entryOf, pick, readJson } from './tool-sources.mjs';

export const FINDS_TOOL_SERVERS = 'tool-servers';
const PAGE_SIZE_STEP = 'page_size';

const httpsAddress = value => {
  if (typeof value !== 'string' || /[{}\s]/.test(value)) return null;
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
};
// A value put into a hole keeps its slashes (an owner/name) and has every other character escaped.
const segments = value => String(value).split('/').map(encodeURIComponent).join('/');

/** The first template in `templates` that fills completely from `entry` into an https address, or null. */
export function filledAddress(templates, entry) {
  for (const template of Array.isArray(templates) ? templates : []) {
    if (typeof template !== 'string') continue;
    const whole = /^\{(\w+)\}$/.exec(template);
    if (whole) {
      const address = httpsAddress(entry[whole[1]]);
      if (address) return address;
      continue;
    }
    let missing = false;
    const filled = template.replace(/\{(\w+)\}/g, (hole, field) => {
      const value = entry[field];
      if ((typeof value !== 'string' && typeof value !== 'number') || String(value) === '') { missing = true; return hole; }
      return segments(value);
    });
    const address = missing ? null : httpsAddress(filled);
    if (address) return address;
  }
  return null;
}

const fillKey = (template, entry) => template.replace(/\{(\w+)\}/g, (hole, field) => String(entry[field] ?? ''));
const words = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** One catalog result as a connector, or null when it has no id. */
export function connectorFromEntry(source, raw) {
  const entry = entryOf(source, raw);
  if ((typeof entry.id !== 'string' && typeof entry.id !== 'number') || String(entry.id) === '') return null;
  const connector = source.connector ?? {};
  const key = fillKey(typeof connector.key === 'string' ? connector.key : '{id}', entry);
  const when = connector.connect_when;
  const connectable = !when || entry[when.field] === when.equals;
  return {
    id: `${source.id_prefix}${key}`,
    key,
    name: words(entry.label) ?? key,
    job: words(entry.job),
    logo: httpsAddress(entry.logo),
    source: { id: source.id, label: source.label },
    connect_url: connectable ? filledAddress(connector.connect, entry) : null,
    page_url: filledAddress(connector.page, entry),
  };
}

// The opaque page word: where each catalog's next page starts, by source id.
const pageWord = starts => (Object.keys(starts).length ? btoa(JSON.stringify(starts)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null);
function readPageWord(word) {
  if (typeof word !== 'string' || !word) return null;
  try {
    const value = JSON.parse(atob(word.replace(/-/g, '+').replace(/_/g, '/')));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(Object.entries(value).filter(([, start]) => typeof start === 'string' || Number.isFinite(start)));
  } catch { return null; }
}

// Where this source's next page starts, from its answer and its paging DATA; null when this was its last page. A
// counted start goes on while the catalog's own total says more are left (a catalog may answer a page short of the
// limit and still hold more), or, when it gives no total, while its pages come back full.
function nextStart(paging, reply, current, got, limit, total) {
  if (!paging?.param) return null;
  if (paging.next_field) {
    const next = pick(reply, paging.next_field);
    return (typeof next === 'string' && next) || Number.isFinite(next) ? next : null;
  }
  const step = paging.step === PAGE_SIZE_STEP ? limit : Number(paging.step);
  if (!Number.isFinite(step) || step <= 0 || got === 0) return null;
  const at = Number(current ?? paging.first ?? 0);
  const seen = (paging.step === PAGE_SIZE_STEP ? at : (at - Number(paging.first ?? 0)) * limit) + limit;
  if (total === null ? got < limit : seen >= total) return null;
  return at + step;
}

// Results from several catalogs, taken in turn, so the first screenful shows every catalog that answered.
function inTurn(lists) {
  const out = [];
  for (let index = 0; lists.some(list => index < list.length); index += 1) for (const list of lists) if (index < list.length) out.push(list[index]);
  return out;
}

/**
 * data()     the shared rows (`search_sources`)
 * request    fetch
 * timeoutMs  the longest any catalog is waited for; a source's own `search.timeout_ms` may be shorter
 */
export function connectorCatalog({ data, request = fetch, timeoutMs = 30000 }) {
  const catalogs = async () => ((await data()).search_sources ?? []).filter(source => source.finds === FINDS_TOOL_SERVERS);

  async function ask(source, text, start, limit) {
    const { search } = source;
    const url = new URL(search.url);
    for (const [name, value] of Object.entries(search.fixed_query ?? {})) url.searchParams.set(name, String(value));
    if (text) url.searchParams.set(search.query_param, text);
    if (search.limit_param) url.searchParams.set(search.limit_param, String(limit));
    const begins = start ?? search.paging?.first;
    if (search.paging?.param && begins !== undefined) url.searchParams.set(search.paging.param, String(begins));
    const wait = Math.min(Number(search.timeout_ms) || timeoutMs, timeoutMs);
    try {
      const reply = await readJson(request, url.href, { method: search.method ?? 'GET', headers: { accept: 'application/json', ...(search.headers ?? {}) } }, wait);
      const items = pick(reply, search.items_field);
      if (!Array.isArray(items)) throw new Error(`${url.hostname} did not answer with a list`);
      const connectors = items.map(raw => connectorFromEntry(source, raw)).filter(Boolean);
      const counted = search.total_field ? Number(pick(reply, search.total_field)) : NaN;
      const total = Number.isFinite(counted) ? counted : null;
      return {
        connectors,
        source: { id: source.id, label: source.label, reached: true, total, shown: connectors.length },
        next: nextStart(search.paging, reply, begins, items.length, limit, total),
      };
    } catch (error) {
      const slow = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      return {
        connectors: [],
        source: { id: source.id, label: source.label, reached: false, reason: slow ? `did not answer within ${Math.round(wait / 1000)} seconds` : String(error?.message ?? error) },
        next: null,
      };
    }
  }

  return {
    /** The catalogs this search asks, by name. */
    async labels() { return (await catalogs()).map(source => source.label); },

    /** Connectors matching `text` (every connector when empty), `limit` from each catalog, from `page` onwards. */
    async find({ text = '', page = null, limit = 10 } = {}) {
      const asking = String(text ?? '').trim().slice(0, 200);
      const size = Math.min(Math.max(Math.trunc(Number(limit)) || 10, 1), 50);
      const starts = readPageWord(page);
      const asked = (await catalogs()).filter(source => !starts || Object.hasOwn(starts, source.id));
      const answers = await Promise.all(asked.map(source => ask(source, asking, starts?.[source.id], size)));
      const reported = answers.filter(answer => answer.source.reached && answer.source.total !== null);
      return {
        text: asking,
        connectors: inTurn(answers.map(answer => answer.connectors)),
        sources: answers.map(answer => answer.source),
        total: reported.length ? reported.reduce((sum, answer) => sum + answer.source.total, 0) : null,
        all_reported: answers.length > 0 && reported.length === answers.length,
        next_page: pageWord(Object.fromEntries(answers.filter(answer => answer.next !== null).map(answer => [answer.source.id, answer.next]))),
      };
    },
  };
}
