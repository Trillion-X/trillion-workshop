// src/live-tool-sources.mjs
//
// Purpose
//   Tools read live from where they are described, so an API with a description or a remote tool server is one row and
//   every operation or tool in it is a Workshop tool that changes when its source changes, with nothing copied in.
//   records/live-tool-sources.json names each source (an id, its kind, its address, and for an API the headers it sends
//   and the connection its key comes from) and each kind (a `tool-row-source` template, the shape
//   parts/ai-tool-catalog/do-work/derive-tool-rows-from-sources.mjs already pours into tool rows). The shared pool
//   (src/pool.mjs) holds one reader for the sources anyone can read, so one read serves every account; each person's
//   store (src/person-store.mjs) holds one for the sources only that person can read (a tool server that takes their
//   key or their sign-in), and src/workshop.mjs lists the rows beside the shipped, published and saved tools.
//
//   How a source is read, cheapest first:
//     1. at most once every check_every_minutes per source;
//     2. an address that says how it changes (an ETag or Last-Modified) is asked whether it changed, and a "not
//        modified" answer ends the read; otherwise the answer's BLAKE3 identity is compared with the one kept, and an
//        unchanged answer ends it;
//     3. only a changed answer is turned into rows again.
//   A source that cannot be read keeps the rows of its last good read and says when that was and why the newest read
//   failed. A source removed is never read again and its rows leave at once; a read nobody listed for forget_after_days
//   is forgotten.
//
// Non-negotiable invariants
//   1. Blind: nothing here names an API, a server, a host or a tool. Kinds and sources are rows.
//   2. A fact lives at its source: every row names the source it was read from and the identity of the answer it came
//      from; nothing is typed in by hand.
//   3. A key is never here: a source names the connection field its key comes from, and the person's locked box places
//      it at run time (src/workshop.mjs httpJson); a tool server's sign-in or key is placed by the box through `postFor`.
//   4. Only public addresses are read (the caller's `request` is parts/http-client/do-work/public-address.mjs fetchPublic).
//
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { rowsFromList } from '../parts/ai-tool-catalog/do-work/derive-tool-rows-from-sources.mjs';
import { openapiEntries } from '../parts/ai-tool-catalog/do-work/read-openapi.mjs';
import { postWithFetch, toolServerSession } from '../parts/ai-tool-catalog/do-work/talk-to-a-tool-server.mjs';
import { currentPlacement } from './renamed-tools.mjs';
import { isStoreFull } from './store-size.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
// One source's whole read (its asks, one after another for a tool server) never holds a caller longer than this: a source
// that does not answer is recorded as failed like any other failure, and the caller goes on with the rows of its last good read.
export const SOURCE_READ_BUDGET_MS = 10_000;
const identityOf = text => `1f:${bytesToHex(blake3(new TextEncoder().encode(text)))}`;

const SPDX = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;
const MAKER = /^maker:[a-z0-9][a-z0-9._/-]{0,127}$/;

/**
 * Every problem with one source row against the kinds it may name, at once. `licenceClasses` (the licence-class rows,
 * optional) also checks that a row's licence_class exists, lists its licence, and allows the placements its kind's tools run at.
 * A row may also say, for the tools it lists: `licence` (SPDX), `licence_class`, `maker` (maker:<where it is kept>),
 * `page` (the https page that describes it) and `about` (plain words about what it does, put in front of each tool's job).
 */
export function liveSourceProblems(source, kinds, licenceClasses = null) {
  if (!object(source)) return ['A source must be an object.'];
  const problems = [];
  if (!SAFE_ID.test(String(source.id ?? ''))) problems.push('id must be lowercase letters, numbers, dots, dashes or underscores.');
  if (!Object.hasOwn(kinds, source.kind)) problems.push(`kind must be one of: ${Object.keys(kinds).join(', ')}.`);
  let address = null;
  try { address = new URL(String(source.url ?? '')); } catch { address = null; }
  if (address?.protocol !== 'https:') problems.push('url must be an https address.');
  if (source.headers !== undefined && !(object(source.headers) && Object.entries(source.headers).every(([name, value]) => HEADER.test(name) && typeof value === 'string' && value.length <= 300))) problems.push('headers must be header names with short text values.');
  if (source.connection !== undefined && !(object(source.connection) && typeof source.connection.connection_id === 'string' && typeof source.connection.field_id === 'string')) problems.push('connection must name a connection_id and a field_id.');
  if (source.only !== undefined && !(Array.isArray(source.only) && source.only.every(item => typeof item === 'string'))) problems.push('only must be a list of operation ids.');
  if (source.licence !== undefined && !SPDX.test(String(source.licence))) problems.push('licence must be an SPDX licence id such as Apache-2.0.');
  if (source.maker !== undefined && !MAKER.test(String(source.maker))) problems.push('maker must look like maker:github.com/owner.');
  if (source.page !== undefined) {
    let page = null;
    try { page = new URL(String(source.page)); } catch { page = null; }
    if (page?.protocol !== 'https:') problems.push('page must be an https address.');
  }
  if (source.about !== undefined && !(typeof source.about === 'string' && source.about.trim() && source.about.length <= 600)) problems.push('about must be plain words, at most 600 characters.');
  if (source.licence_class !== undefined) {
    const chosen = Array.isArray(licenceClasses) ? licenceClasses.find(item => item.id === source.licence_class) : null;
    if (typeof source.licence_class !== 'string' || !source.licence_class) problems.push('licence_class must name a licence class.');
    else if (Array.isArray(licenceClasses) && !chosen) problems.push(`licence_class ${source.licence_class} is not a known licence class.`);
    else if (chosen) {
      if (source.licence !== undefined && !chosen.licences.includes(source.licence)) problems.push(`licence_class ${chosen.id} does not list the licence ${source.licence}.`);
      const placements = kinds?.[source.kind]?.source?.row?.placements ?? [];
      if (placements.length && !placements.some(id => chosen.allowed_placements.map(currentPlacement).includes(currentPlacement(id)))) problems.push(`licence_class ${chosen.id} does not allow ${placements.join(', ')}.`);
    }
  }
  return problems;
}

// A kind's template with this source's own values in it: `{ fill: { from: "source", field } }` is the source's field.
function fromSource(template, values) {
  if (Array.isArray(template)) return template.map(item => fromSource(item, values));
  if (!object(template)) return template;
  if (Object.keys(template).length === 1 && object(template.fill) && template.fill.from === 'source') return values[template.fill.field] ?? template.fill.default;
  return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, fromSource(item, values)]).filter(([, item]) => item !== undefined));
}

/** The `tool-row-source` a source row is, through its kind's template. */
export function rowSourceOf(source, kinds) {
  const values = { ...source, name: source.name ?? new URL(source.url).host, tool_prefix: `tool:${source.id}:`, connection_record: source.connection?.connection };
  return fromSource(kinds[source.kind].source, values);
}

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

/**
 * sql:     `exec(query, ...values).toArray()` where reads are kept
 * request: (address, init) → Response, only to public addresses
 * config:  current config, or an async resolver for its exact Marketplace sections
 * postFor: (tool-row-source) → a tool server `post` that carries this person's sign-in or key, or null for an open one
 * readBudgetMs: the longest one source's whole read may take (SOURCE_READ_BUDGET_MS)
 * keepAlive: (promise) → void; lets a read finish after the caller has what it holds (a host whose replies do not wait for it)
 * need: true, or the id of the one tool a caller cannot go on without (a run or describe of it): the source that tool belongs to,
 *   if never read, is read now, bounded by the read budget, however the host defers reads.
 * refreshLater: () → void; for a host whose replies do wait for kept work (a metered resource): says a read is wanted, and the
 *              host calls reads() with wait from its own scheduled entry. Wins over keepAlive.
 */
export function makeLiveToolSources({ sql, request, config, postFor = () => null, now = () => new Date(), readBudgetMs = SOURCE_READ_BUDGET_MS, keepAlive = null, refreshLater = null }) {
  sql.exec('CREATE TABLE IF NOT EXISTS live_tool_source_reads (source_key TEXT PRIMARY KEY, version TEXT, etag TEXT, last_modified TEXT, rows TEXT NOT NULL, held TEXT NOT NULL, read_at TEXT, checked_at TEXT NOT NULL, error TEXT)');
  // How many reads of a source failed in a row, kept with the read: a book that is reset keeps its back-off instead of asking again at once.
  const ensureFailures = () => {
    if (!sql.exec('PRAGMA table_info(live_tool_source_reads)').toArray().some(column => column.name === 'failures')) sql.exec('ALTER TABLE live_tool_source_reads ADD COLUMN failures INTEGER NOT NULL DEFAULT 0');
  };
  // What a read keeps in its row. A store that is full refuses the write; the answer (the tools just read, or the last good ones) is
  // still given, and the in-memory back-off stands in until the store has room.
  const keep = write => {
    try { ensureFailures(); write(); } catch (error) { if (!isStoreFull(error)) throw error; }
  };
  keep(() => {});
  const reading = new Map();
  // How many reads of a source failed in a row in this isolate; a retry waits 1, 2, 4, 8 ... minutes, up to check_every_minutes.
  const failing = new Map();
  // A source is read again when anything in it changes, so its key is the whole row source it makes.
  const keyOf = rowSource => identityOf(JSON.stringify(rowSource));
  const keptOf = key => {
    const row = sql.exec('SELECT * FROM live_tool_source_reads WHERE source_key = ?', key).toArray()[0];
    return row ? { ...row, rows: JSON.parse(row.rows), held: JSON.parse(row.held) } : null;
  };

  // The answer at an address, or `unchanged` when it says it has not changed since the kept read.
  async function fetched(url, headers, kept, selected, budgetMs) {
    const asked = { accept: 'application/json', ...headers, ...(kept?.etag ? { 'if-none-match': kept.etag } : {}), ...(kept?.last_modified ? { 'if-modified-since': kept.last_modified } : {}) };
    const response = await request(url, { headers: asked, signal: AbortSignal.timeout(budgetMs) });
    if (response.status === 304 && kept) return { unchanged: true };
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const text = await response.text();
    if (text.length > (selected.max_description_bytes ?? 5_000_000)) throw new Error(`${url} is ${text.length} bytes; a source holds at most ${selected.max_description_bytes}.`);
    return { text, etag: response.headers.get('etag'), last_modified: response.headers.get('last-modified') };
  }

  // What a source holds now: its list entries and the version they came from, or `unchanged`.
  async function listOf(rowSource, kept, selected, budgetMs) {
    const list = rowSource.list ?? {};
    if (list.openapi) {
      const answer = await fetched(list.openapi.url, list.openapi.headers ?? {}, kept, selected, budgetMs);
      if (answer.unchanged) return answer;
      const version = identityOf(answer.text);
      if (kept && version === kept.version) return { unchanged: true, etag: answer.etag, last_modified: answer.last_modified };
      let document;
      try { document = JSON.parse(answer.text); } catch { throw new Error(`${list.openapi.url} is not JSON; an API description is read as OpenAPI or Swagger JSON.`); }
      const { entries, held_back } = openapiEntries(document, { url: list.openapi.url, connection: list.openapi.connection ?? null, only: list.openapi.only ?? null, headers: list.openapi.headers ?? {} });
      return { entries, held: held_back.map(item => ({ item: item.operation, reasons: item.reasons })), version, etag: answer.etag, last_modified: answer.last_modified };
    }
    if (list.mcp) {
      const post = (await postFor(rowSource)) ?? (list.mcp.sign_in || list.mcp.key || list.mcp.connection ? null : postWithFetch(request));
      if (!post) throw new Error(`${new URL(list.mcp.url).host} lists its tools only to the person who signed in or gave it a key.`);
      const entries = await toolServerSession({ url: list.mcp.url, post }).list();
      const version = identityOf(JSON.stringify(entries));
      if (kept && version === kept.version) return { unchanged: true };
      return { entries, held: [], version };
    }
    if (list.url) {
      const answer = await fetched(list.url, {}, kept, selected, budgetMs);
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

  async function read(rowSource, key, kept, selected, budgetMs) {
    const at = now().toISOString();
    try {
      const got = await withinBudget(listOf(rowSource, kept, selected, budgetMs), budgetMs);
      if (got.unchanged) {
        keep(() => sql.exec('UPDATE live_tool_source_reads SET failures = 0, checked_at = ?, error = NULL, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified) WHERE source_key = ?', at, got.etag ?? null, got.last_modified ?? null, key));
        failing.delete(key);
        return { ...kept, checked_at: at, error: null };
      }
      const made = rowsFromList(rowSource, got.entries);
      const rows = made.rows.map(row => ({ ...row, provenance: { ...row.provenance, version: got.version, read_at: at } }));
      const held = [...got.held, ...made.refused.map(reason => ({ reasons: [String(reason?.reason ?? reason?.message ?? JSON.stringify(reason))] }))];
      keep(() => sql.exec('INSERT OR REPLACE INTO live_tool_source_reads (source_key, version, etag, last_modified, rows, held, read_at, checked_at, error, failures) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)',
        key, got.version, got.etag ?? null, got.last_modified ?? null, JSON.stringify(rows), JSON.stringify(held), at, at));
      failing.delete(key);
      return { version: got.version, rows, held, read_at: at, checked_at: at, error: null };
    } catch (error) {
      const reason = String(error?.message ?? error).slice(0, 500);
      const failures = (kept?.failures ?? failing.get(key) ?? 0) + 1;
      failing.set(key, failures);
      if (kept) {
        keep(() => sql.exec('UPDATE live_tool_source_reads SET checked_at = ?, error = ?, failures = ? WHERE source_key = ?', at, reason, failures, key));
        return { ...kept, checked_at: at, error: reason, failures };
      }
      keep(() => sql.exec('INSERT OR REPLACE INTO live_tool_source_reads (source_key, version, rows, held, read_at, checked_at, error, failures) VALUES (?, NULL, ?, ?, NULL, ?, ?, ?)', key, '[]', '[]', at, reason, failures));
      return { version: null, rows: [], held: [], read_at: null, checked_at: at, error: reason, failures };
    }
  }

  // A source whose last check is older than check_every_minutes is read again; one whose last read failed, sooner (1, 2, 4,
  // 8 ... minutes). With `keepAlive` (the host's way to let work outlast a reply), a caller that holds a kept read, good or
  // a failure, goes on with it at once and the new read finishes beside the reply. A source never read at all is waited for
  // (up to the read budget) only by a caller that asks to `wait`; any other caller gets it pending and the read runs beside.
  // `need` is true, or the id of the one tool the caller names: then only the source that id belongs to (the one whose id_prefix
  // starts it, tool:<source>:...) is needed; a source naming no prefix is needed by any named tool.
  const needs = (need, rowSource) => typeof need === 'string' ? !rowSource.id_prefix || need.startsWith(rowSource.id_prefix) : Boolean(need);
  function current(rowSource, selected, wait, refreshing = false, need = false) {
    const key = keyOf(rowSource);
    const kept = keptOf(key);
    // A failed source waits 1, 2, 4 ... minutes, counted across resets, up to retry_ceiling_minutes (never past check_every_minutes).
    const every = kept?.error ? Math.min(selected.retry_ceiling_minutes ?? selected.check_every_minutes, selected.check_every_minutes, 2 ** Math.max(0, (kept.failures || failing.get(key) || 1) - 1)) : selected.check_every_minutes;
    if (kept && now().getTime() - Date.parse(kept.checked_at) < every * 60_000) return kept;
    // A caller that needs this source's tools to go on (a run or describe of one named tool) and holds none of them reads it now.
    if (refreshLater && !refreshing && !(need && !kept)) {
      refreshLater();
      return kept ?? { version: null, rows: [], held: [], read_at: null, checked_at: null, error: null, pending: true };
    }
    // A read made from the book's own alarm (refreshing) is held to refresh_budget_ms, so a slow remote can never hold the book.
    const budgetMs = refreshing ? Math.min(readBudgetMs, selected.refresh_budget_ms ?? readBudgetMs) : readBudgetMs;
    if (!reading.has(key)) reading.set(key, read(rowSource, key, kept, selected, budgetMs).finally(() => reading.delete(key)));
    if (keepAlive && !refreshing && !(need && !kept) && (kept || !wait)) {
      keepAlive(reading.get(key).catch(() => {}));
      return kept ?? { version: null, rows: [], held: [], read_at: null, checked_at: null, error: null, pending: true };
    }
    return reading.get(key);
  }

  // What a source's read means to a caller: its tools are `ready`, it is `pending` its first read, or it is `unavailable`
  // (never read successfully; error says why). A source with a kept good read is ready even when its newest read failed.
  const stateOf = item => item.pending ? 'pending' : item.version === null ? 'unavailable' : 'ready';

  return {
    /**
     * Every source as last read: its rows, what was held back with why, the version, when, and any failure. `sources`
     * are the DATA rows unless given; `also` are more source rows (one account's own), checked against the kinds;
     * `built` are `tool-row-source` rows already made by a trusted owner (the tool servers a person added, from
     * src/tool-servers.mjs addedSource), read as they are.
     */
    async reads({ sources, also = [], built = [], wait = true, refreshing = false, need = false } = {}) {
      const selected = typeof config === 'function' ? await config() : config;
      if (!object(selected?.kinds) || !Array.isArray(sources ?? selected.sources) || !Array.isArray(also) || !Array.isArray(built))
        throw Object.assign(new Error('Current live-source configuration is unavailable.'),{code:'marketplace_content_source_unavailable'});
      const own = also.filter(source => source?.status !== 'deleted'), privateIds = new Set(own.map(source => source?.id));
      // A later default cannot replace an existing account source with the same
      // id, even if a changed template now refuses that private source.
      const candidates = [...(sources ?? selected.sources).filter(source => !privateIds.has(source?.id)).map(source => ({source,scope:'default'})),
        ...own.map(source => ({source,scope:'account'}))];
      const valid = [], refused = [];
      for (const {source,scope} of candidates) {
        const problems = liveSourceProblems(source,selected.kinds);
        if (problems.length) refused.push({source_id:source?.id ?? null,kind:source?.kind ?? null,scope,version:null,read_at:null,checked_at:now().toISOString(),
          error:'This source does not match the current live-source templates.',rows:[],held:[{reasons:problems}]});
        else valid.push({id:source.id,kind:source.kind,scope,rowSource:rowSourceOf(source,selected.kinds)});
      }
      const all = [...valid, ...built.filter(object).map(rowSource => ({ id: rowSource.id, kind: Object.keys(rowSource.list ?? {})[0] ?? null, scope:'built', rowSource }))];
      const read = await Promise.all(all.map(item => current(item.rowSource,selected,wait,refreshing,needs(need,item.rowSource))));
      if (typeof config === 'function' && identityOf(JSON.stringify(await config())) !== identityOf(JSON.stringify(selected)))
        throw Object.assign(new Error('The live-source definitions changed while their tools were being read; read the current sources again.'),{code:'marketplace_content_source_unavailable'});
      keep(() => sql.exec('DELETE FROM live_tool_source_reads WHERE checked_at < ?', new Date(now().getTime() - (selected.forget_after_days ?? 30) * 86_400_000).toISOString()));
      return [...read.map((item, at) => ({
        source_id: all[at].id, kind: all[at].kind, scope:all[at].scope, version: item.version, read_at: item.read_at, checked_at: item.checked_at,
        state: stateOf(item), ...(item.error ? { error: item.error } : {}), ...(item.error && item.version ? { stale: true } : {}), rows: item.rows, held: item.held,
      })),...refused.map(item => ({ ...item, state: 'unavailable' }))];
    },
    /** Every tool row every source holds now, first source first; an id one source already gave is not given twice. */
    async rows(options) {
      return rowsOf(await this.reads(options));
    },
    /** The rows, and every source that has none to give yet: pending its first read, or never read successfully and why. */
    async catalog(options) {
      const reads = await this.reads(options);
      return { rows: rowsOf(reads), unavailable: unavailableIn(reads) };
    },
  };
}
