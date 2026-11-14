// packages/ai-tool-catalog/do-work/derive-tool-rows-from-sources.mjs
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
// (`list.records = { package, kind, each_of?, not_carried_into_each? }`): the payloads of that kind in the package's
// `things-to-store-and-run.json`, one entry each, or with `each_of` one entry per key of that object field, the
// key's own fields laid over the payload's other fields, less any the source lists in `not_carried_into_each`
// (a field that describes the whole record, not each key). Each record entry also carries `record_address` and `record_name`
// (the address's last part, then `-<key>` under `each_of`), so a row id comes from the record, never retyped.
//
//   node packages/ai-tool-catalog/do-work/derive-tool-rows-from-sources.mjs <records file or folder> ...
// prints the derived row ids, unread sources and refusals for inspection.
//
// A source's list may also be a remote tool server's own `tools/list` (`list.mcp = { url, sign_in? }`): the server is
// started as the Model Context Protocol says and every page of its tools is read, one entry per tool (`name`,
// `title`, `description`, `inputSchema`, `annotations` as the server wrote them). A server that answers only to a
// signed-in person (`sign_in: "per-person"`) has no list until someone signs in: it is read in that person's own
// store with their sign-in (`options.post`), and a derivation without one reports it unread, naming why.
//
// A source may also carry `lay_over: [{ where: { <entry field>: <value>, ... }, row: { ... } }]`: fields the source's
// owner adds to every derived row whose entry matches all of `where` (a price the seller sets on one service's tools,
// which the service's own records never carry). Matching is on the renamed entry fields; the row is laid over last.
//
// Invariants: every returned row passes the ai-tool-catalog decoder; a template value
// `{ "fill": { "from": "entry", "field": <entry field> } }` is filled now, every other `fill` is left for run time.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitToolDescriptor } from '../read-data/read-ai-tool-catalog.ts';
import { postWithFetch, toolServerSession } from './talk-to-a-tool-server.mjs';

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
    const payload = {
      kind: 'ai-tool-descriptor', id: `${source.id_prefix}${entry.id}`, label: entry.label ?? entry.id, job: entry.job, description: entry.job,
      status: entry.available === false ? 'unavailable' : 'active',
      input_schema: entry.input_schema ?? { type: 'object' },
      ...(entry.effect ? { needs: { effect: entry.effect } } : {}),
      ...filled,
      ...Object.assign({}, ...(source.lay_over ?? [])
        .filter(over => object(over?.where) && object(over.row) && Object.entries(over.where).every(([field, value]) => entry[field] === value))
        .map(over => over.row)),
      provenance: { ...(filled.provenance ?? {}), source: source.id },
    };
    const admitted = admitToolDescriptor(payload);
    if ('refused' in admitted) refused.push(admitted.refused);
    else rows.push(payload);
  }
  return { rows, refused };
}

// The payloads of one kind in one package's own records, as list entries.
export function recordsList({ package: owner, kind, each_of: eachOf, not_carried_into_each: notCarried = [] }, folder = packagesFolder()) {
  if (typeof owner !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(owner)) throw new Error(`list.records.package must be a package name, not ${JSON.stringify(owner)}`);
  if (typeof kind !== 'string' || !kind) throw new Error('list.records.kind must name a record kind');
  const things = JSON.parse(readFileSync(join(folder, owner, 'things-to-store-and-run.json'), 'utf8')).things ?? [];
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

export async function readList(source, request = fetch, options = {}) {
  if (source.list?.records) return recordsList(source.list.records);
  if (source.list?.mcp) return toolServerList(source.list.mcp, { request, post: options.post });
  const { url, method = 'GET', body, items_field: itemsField } = source.list;
  const response = await request(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const value = await response.json();
  const list = Array.isArray(value) ? value : itemsField ? value?.[itemsField] : null;
  if (!Array.isArray(list)) throw new Error(`${url} did not return a list`);
  return list;
}

/** Every tool row the `tool-row-source` payloads in `payloads` yield right now. */
export async function toolRowsFromSources(payloads, request = fetch) {
  const result = { rows: [], unread: [], refused: [], per_person: [] };
  for (const source of payloads.filter(payload => payload?.kind === 'tool-row-source')) {
    // A list only a signed-in person can read is handed on as the source itself, for each person's store to read.
    if (source.list?.mcp?.sign_in) { result.per_person.push(source); continue; }
    try {
      const { rows, refused } = rowsFromList(source, await readList(source, request));
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = process.argv.slice(2);
  if (!paths.length) throw new Error('usage: derive-tool-rows-from-sources.mjs <records file or folder> ...');
  const derived = await toolRowsFromSources(paths.flatMap(payloadsIn));
  process.stdout.write(JSON.stringify({ rows: derived.rows.length, ids: derived.rows.map(row => row.id), unread: derived.unread, refused: derived.refused }, null, 2) + '\n');
  if (derived.unread.length) process.exitCode = 1;
}
