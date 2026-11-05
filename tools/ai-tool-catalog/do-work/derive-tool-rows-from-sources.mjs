// parts/ai-tool-catalog/do-work/derive-tool-rows-from-sources.mjs
//
// Turns a live capability list into `ai-tool-descriptor` rows, so a tool set nobody typed by hand is callable
// by job. Each `tool-row-source` row says where the list lives, which entry field holds what, and the row
// template every entry fills. Nothing here names an application: a new source is one DATA row.
//
// The rows are DERIVED, never stored as package-set source: whoever needs them (a deploy, a local service)
// reads the sources live at that moment. A source that cannot be read is reported with the reason and yields
// no rows; a guess is never produced.
//
// A source's list is either a live web address (`list.url`) or a package's own records
// (`list.records = { package, kind, file?, each_of?, not_carried_into_each? }`): the payloads of that kind in the
// package's `records.json` (the package's folder found through the caller's `packageDir`, parts/ when none is given) (or the records file `file` names inside the package), one entry each, or with `each_of` one entry per key of that object field, the
// key's own fields laid over the payload's other fields, less any the source lists in `not_carried_into_each`
// (a field that describes the whole record, not each key). Each record entry also carries `record_address` and `record_name`
// (the address's last part, then `-<key>` under `each_of`), so a row id comes from the record, never retyped.
//
// The explicit derive-tool-rows-from-sources-cli.mjs entry prints the derived
// row ids, unread sources and refusals for inspection. Importing this library
// never examines another program's argv or starts a command, including when bundled.
//
// A source's list may also be a remote tool server's own `tools/list` (`list.mcp = { url, sign_in? }`): the server is
// started as the Model Context Protocol says and every page of its tools is read, one entry per tool (`name`,
// `title`, `description`, `inputSchema`, `annotations` as the server wrote them). A server that answers only to a
// signed-in person (`sign_in: "per-person"`) has no list until someone signs in: it is read in that person's own
// store with their sign-in (`options.post`), and a derivation without one reports it unread, naming why.
//
// A source's list may also be an API's own description (`list.openapi = { url, headers?, connection?, only? }`, OpenAPI
// 3.x or Swagger 2.0 as JSON, read by ./read-openapi.mjs): one entry per operation, carrying its method, address, query,
// headers, body and input schema in the Workshop's request grammar, and the connection field its key comes from.
//
// A source may also carry `lay_over: [{ where: { <entry field>: <value>, ... }, row: { ... } }]`: fields the source's
// owner adds to every derived row whose entry matches all of `where` (a price the seller sets on one service's tools,
// which the service's own records never carry). Matching is on the renamed entry fields; the row is laid over last, its
// `{ fill: { from: "entry" } }` values filled from the entry like the template's.
//
// A source may also carry `about` (plain words about what everything in it does, from its row in records/live-tool-sources.json):
// each derived row's job and description start with it, followed by the entry's own.
//
// Invariants: every returned row passes the ai-tool-catalog decoder; a template value
// `{ "fill": { "from": "entry", "field": <entry field> } }` is filled now, every other `fill` is left for run time.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitToolDescriptor } from '../read-data/read-ai-tool-catalog.ts';
import { postWithFetch, toolServerSession } from './talk-to-a-tool-server.mjs';
import { openapiEntries } from './read-openapi.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Read when a package's own records are listed, never at load, so a bundle that only reads web lists can carry this file.
const packagesFolder = () => resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function fillFromEntry(template, entry) {
  if (Array.isArray(template)) return template.map(item => fillFromEntry(item, entry));
  if (!object(template)) return template;
  if (Object.keys(template).length === 1 && object(template.fill) && template.fill.from === 'entry') return entry[template.fill.field];
  return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fillFromEntry(value, entry)]));
}

// One list entry, renamed through the source's `entry` field map, then poured into its row template.
export function rowsFromList(source, list) {
  const rows = [];
  const refused = [];
  for (const raw of list) {
    const entry = Object.fromEntries(Object.entries(source.entry).map(([field, from]) => [field, raw?.[from]]));
    const filled = fillFromEntry(source.row ?? {}, entry);
    // A source's `about` (plain words about the whole source) goes in front of each entry's job, so a caller asking in those words finds every tool in it.
    const job = typeof source.about === 'string' && source.about ? `${source.about}. ${entry.job ?? entry.label ?? entry.id}` : entry.job;
    const payload = {
      kind: 'ai-tool-descriptor', id: `${source.id_prefix}${entry.id}`, label: entry.label ?? entry.id, job, description: job,
      status: entry.available === false ? 'unavailable' : 'active',
      input_schema: entry.input_schema ?? { type: 'object' },
      ...(entry.effect ? { needs: { effect: entry.effect } } : {}),
      ...filled,
      ...Object.assign({}, ...(source.lay_over ?? [])
        .filter(over => object(over?.where) && object(over.row) && Object.entries(over.where).every(([field, value]) => entry[field] === value))
        .map(over => fillFromEntry(over.row, entry))),
      provenance: { ...(filled.provenance ?? {}), source: source.id },
    };
    const admitted = admitToolDescriptor(payload);
    if ('refused' in admitted) refused.push(admitted.refused);
    else rows.push(payload);
  }
  return { rows, refused };
}

// The payloads of one kind in one package's own records, as list entries.
export function recordsList({ package: owner, kind, file = 'records.json', each_of: eachOf, not_carried_into_each: notCarried = [] }, packageDir = name => join(packagesFolder(), name)) {
  if (typeof owner !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(owner)) throw new Error(`list.records.package must be a package name, not ${JSON.stringify(owner)}`);
  if (typeof kind !== 'string' || !kind) throw new Error('list.records.kind must name a record kind');
  if (typeof file !== 'string' || !file.endsWith('.json') || file.startsWith('/') || file.split('/').includes('..')) throw new Error(`list.records.file must be a records file inside ${owner}, not ${JSON.stringify(file)}`);
  const things = JSON.parse(readFileSync(join(packageDir(owner), file), 'utf8')).things ?? [];
  const entries = [];
  for (const { address, payload } of things.filter(thing => thing?.payload?.kind === kind)) {
    const record_name = String(address).split('::').pop();
    if (!eachOf) {
      entries.push({ ...payload, record_address: address, record_name });
      continue;
    }
    if (!object(payload[eachOf])) throw new Error(`${address} has no object field ${eachOf}`);
    const { [eachOf]: items, ...shared } = payload;
    for (const field of notCarried) delete shared[field];
    for (const [key, item] of Object.entries(items)) entries.push({ ...shared, ...item, record_address: address, record_name: `${record_name}-${key}` });
  }
  return entries;
}

/** Every tool a remote tool server lists, read through `post` (a plain fetch unless the caller signs the requests). */
export async function toolServerList({ url, sign_in: signIn }, { request = fetch, post } = {}) {
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error(`list.mcp.url must be an https address, not ${JSON.stringify(url)}`);
  if (signIn && !post) throw new Error(`${new URL(url).host} lists its tools only to a signed-in person, so its tools appear in each person's Workshop after they sign in.`);
  return toolServerSession({ url, post: post ?? postWithFetch(request) }).list();
}

/** Every operation an API's description holds as list entries (./read-openapi.mjs), read from its address now. */
export async function openapiList({ url, headers = {}, connection = null, only = null }, request = fetch) {
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error(`list.openapi.url must be an https address, not ${JSON.stringify(url)}`);
  const response = await request(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return openapiEntries(await response.json(), { url, connection, only, headers }).entries;
}

export async function readList(source, request = fetch, options = {}) {
  if (source.list?.records) return recordsList(source.list.records, options.packageDir);
  if (source.list?.mcp) return toolServerList(source.list.mcp, { request, post: options.post });
  if (source.list?.openapi) return openapiList(source.list.openapi, request);
  const { url, method = 'GET', body, items_field: itemsField } = source.list;
  const response = await request(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const value = await response.json();
  const list = Array.isArray(value) ? value : itemsField ? value?.[itemsField] : null;
  if (!Array.isArray(list)) throw new Error(`${url} did not return a list`);
  return list;
}

/** Every tool row the `tool-row-source` payloads in `payloads` yield right now. */
export async function toolRowsFromSources(payloads, request = fetch, options = {}) {
  const result = { rows: [], unread: [], refused: [], per_person: [] };
  for (const source of payloads.filter(payload => payload?.kind === 'tool-row-source')) {
    // A list only a signed-in person can read (their own sign-in, or one of their connections) is handed on as the
    // source itself, for each person's store to read.
    if (source.list?.mcp?.sign_in || source.list?.mcp?.connection) { result.per_person.push(source); continue; }
    try {
      const { rows, refused } = rowsFromList(source, await readList(source, request, options));
      result.rows.push(...rows);
      result.refused.push(...refused);
    } catch (error) {
      result.unread.push({ source: source.id, reason: String(error.message ?? error) });
    }
  }
  return result;
}

export function payloadsIn(path) {
  const files = statSync(path).isDirectory() ? readdirSync(path).filter(name => name.endsWith('.json')).map(name => join(path, name)) : [path];
  return files.flatMap(file => (JSON.parse(readFileSync(file, 'utf8')).records ?? []).map(record => record.payload));
}
