// src/saved-links.mjs
//
// PURPOSE
//   Links a person saved somewhere else (a browser's pinned tabs and folders, a service's bookmarks), kept in their
//   own Trillion files so every AI of theirs and every screen reads them. Two ways in, both Workshop tools run in the
//   person's own store (records/workshop-saved-links-tool-records.json):
//     saveBrowserFile   a browser's own saved-items file, already in their files (handed in by the person, their AI
//                       or Trillion on their computer), decoded by the shape its row in saved-links.json describes;
//                       one file per group (an Arc space) replaces that group's earlier file, because the browser's
//                       file is the whole truth at the moment it was read.
//     saveServiceList   a list a connected service keeps (X bookmarks), read page by page through the service's own
//                       Workshop tools; what is new is added to what was kept. Without `since` it keeps every link
//                       the service hands out (the first read, and a bulk read on demand); with `since` (the newest
//                       link the last read saw) it reads only until it meets that link and returns the new ones, so
//                       the service's event source row (records/workshop-event-source-records.json) hands each to
//                       the person's rules on the store's alarm.
//     findLinkProvider  which registered provider an address belongs to (`url_providers`, found by host), what it can be
//                       read through, and the NAMES of the values its sign-in uses (never a value)
//     saved pages       web clips with a snapshot, extracted text and a refresh policy (src/saved-pages.mjs), whose
//                       account actions are merged into `actions()` below
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a browser, a service, a field of theirs or a place: every shape, path, tool and file name is
//      a row of src/saved-links.json.
//   2. Links land where shares land: named files in the person's files (DATA `folder` and `file_name`), as JSON anyone
//      can read. No second list is kept anywhere else.
//   3. A read that meets nothing it recognizes changes nothing and says why in plain words.
//   4. A service read never loses a link it already kept: new links go first, kept ones stay after them.
//   5. With `since`, a link that was there before is never returned as new: if the read no longer finds `since` in
//      the pages it may read (the person removed that bookmark), everything read is kept, nothing is returned as new,
//      and the newest link becomes the next `since`.
//
import settings from '../../shared-code/src/saved-links.json' with { type: 'json' };
import connections from '../../connect-a-service-and-seal-its-key/records.json' with { type: 'json' };
import { makeSavedPages } from './saved-pages.mjs';

export class SavedLinksError extends Error {}

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const at = (value, path) => (path ?? []).reduce((here, part) => (here === undefined || here === null ? undefined : here[part]), value);
const firstText = (value, paths) => paths.map(path => at(value, path)).find(nonempty) ?? null;
// A list that alternates a key and its value, as [key, value] entries; a plain list's items with their positions.
const entries = (list, pairs) => (!Array.isArray(list) ? [] : pairs
  ? Array.from({ length: Math.floor(list.length / 2) }, (_, index) => [list[index * 2], list[index * 2 + 1]])
  : list.map((item, index) => [index, item]));
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(values[name] ?? ''));
const holes = template => [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1]);

/** The file a group of links is kept in: DATA `folder` and `file_name`, with any slash in a name made harmless. */
export function savedLinksName(savedFrom, group, data = settings) {
  const part = text => String(text).replace(/[\\/\u0000-\u001f]/g, '-').trim().slice(0, 120) || '-';
  return `${data.folder}/${data.file_name.replace('{saved_from}', part(savedFrom)).replace('{group}', part(group))}`;
}

// ---- Which provider an address belongs to --------------------------------------------------------------------------

/** The host of an http(s) address, lower case, or null. */
function hostOf(value) {
  if (!nonempty(value)) return null;
  try { const url = new URL(value.trim()); return url.protocol === 'https:' || url.protocol === 'http:' ? url.hostname.toLowerCase() : null; } catch { return null; }
}

/**
 * The credential NAMES a provider's sign-in uses, read from its service-connection record (the one home of how it signs
 * in). The token exchange is the server's: no value is read or returned, only the names the sealed values are kept under.
 */
export function connectionAuth(vendor) {
  const record = connections.things.find(thing => thing.payload?.vendor === vendor)?.payload;
  if (!record) return null;
  const client = record.acquire?.hosted_client;
  return {
    connection: vendor, flow: record.acquire?.flow ?? null, token_exchange: 'server',
    credential_names: client ? [client.id_name, client.secret_name].filter(nonempty) : [],
  };
}

/** The registered provider an address belongs to: its row, its read lists and its sign-in names; throws, naming the registered ones, when none does. */
export function findLinkProvider(url, data = settings) {
  const host = hostOf(url);
  const rows = Object.entries(data.url_providers).filter(([id]) => !id.startsWith('_'));
  if (!host) throw new SavedLinksError(nonempty(url) ? data.url_provider_words.none.replace('{url}', url).replace('{known}', rows.map(([, row]) => row.label).join(', ')) : data.url_provider_words.no_url);
  const found = rows.find(([, row]) => row.hosts.some(name => host === name || host.endsWith(`.${name}`)));
  if (!found) throw new SavedLinksError(data.url_provider_words.none.replace('{url}', url).replace('{known}', rows.map(([, row]) => row.label).join(', ')));
  const [id, row] = found;
  return { provider: id, label: row.label, host, lists: row.lists.map(list => ({ id: list, group: data.service_lists[list].group, tool: `save_${list.replace(/-/g, '_')}` })), auth: connectionAuth(row.connection) };
}

// ---- A browser's saved-items file --------------------------------------------------------------------------------

/** Which browser file row a document is: the one asked for, else the first whose `recognize` path it holds. */
export function browserFormatOf(document, asked = null, data = settings) {
  if (asked !== null) {
    if (!data.browser_files[asked]) throw new SavedLinksError(`There is no saved-items format "${asked}". Known: ${Object.keys(data.browser_files).join(', ')}.`);
    return asked;
  }
  const found = Object.entries(data.browser_files).find(([, shape]) => at(document, shape.recognize) !== undefined);
  if (!found) throw new SavedLinksError(`This file is not a saved-items file Trillion can read. It reads: ${Object.values(data.browser_files).map(shape => shape.label).join(', ')}.`);
  return found[0];
}

/**
 * Every saved link in a browser's file, as { group, links: [{ title, url, folder, saved_at? }] } per group, in the
 * browser's own order. The file is a tree of nodes kept by id: each group names the roots it keeps, a node is a link
 * when `link.when` is present, a folder when `folder.when` is, and anything else (a split view, a container) passes
 * its children on unchanged. A node reached twice is read once.
 */
export function decodeBrowserFile(document, shape) {
  const groups = new Map();
  const epoch = shape.saved_at ? Date.parse(shape.saved_at.seconds_since) : null;
  const add = (group, link) => {
    const kept = groups.get(group) ?? new Map();
    const key = `${link.url}\u0000${link.folder.join('\u0000')}`;
    if (!kept.has(key)) kept.set(key, link);
    groups.set(group, kept);
  };
  for (const container of Array.isArray(at(document, shape.containers)) ? at(document, shape.containers) : []) {
    if (!object(container)) continue;
    const nodes = new Map(entries(container[shape.nodes.field], shape.nodes.pairs));
    if (!nodes.size) continue;
    const seen = new Set();
    const walk = (id, group, folder) => {
      const node = nodes.get(id);
      if (!object(node) || seen.has(id)) return;
      seen.add(id);
      const title = firstText(node, shape.title);
      if (at(node, shape.link.when) !== undefined) {
        const url = at(node, shape.link.url);
        const seconds = epoch === null ? null : Number(at(node, shape.saved_at.path));
        if (nonempty(url)) add(group, { title: title ?? url, url, folder, ...(Number.isFinite(seconds) ? { saved_at: new Date(epoch + seconds * 1000).toISOString() } : {}) });
      }
      const inner = at(node, shape.folder.when) !== undefined ? [...folder, title ?? ''] : folder;
      for (const child of Array.isArray(at(node, shape.children)) ? at(node, shape.children) : []) walk(child, group, inner);
    };
    for (const [, space] of entries(container[shape.groups.field], shape.groups.pairs)) {
      if (!object(space)) continue;
      const group = firstText(space, shape.groups.title) ?? shape.groups.untitled;
      for (const [key, root] of entries(space[shape.groups.roots.field], shape.groups.roots.pairs)) {
        if (shape.groups.roots.keep.includes(key)) walk(root, group, []);
      }
    }
    for (const extra of shape.extra_roots ?? []) {
      for (const [, root] of entries(container[extra.field], extra.pairs)) walk(root, extra.group, []);
    }
  }
  return [...groups].map(([group, kept]) => ({ group, links: [...kept.values()] }));
}

// ---- A list a connected service keeps ----------------------------------------------------------------------------

/** One page of a service's list, as links: { key, url, title, ...fields } in the service's own order. */
export function linksFromPage(page, list) {
  const spec = list.items;
  const lookups = (spec.lookups ?? []).map(lookup => ({ ...lookup, by_key: new Map((Array.isArray(at(page, lookup.list)) ? at(page, lookup.list) : []).map(item => [String(at(item, lookup.key)), item])) }));
  const links = [];
  for (const item of Array.isArray(at(page, spec.list)) ? at(page, spec.list) : []) {
    const key = at(item, spec.key);
    if (key === undefined || key === null || key === '') continue;
    const scope = { ...item, ...Object.fromEntries(lookups.map(lookup => [lookup.as, lookup.by_key.get(String(at(item, lookup.by)))])) };
    const fields = Object.fromEntries(Object.entries(spec.fields).map(([name, path]) => [name, at(scope, path)]).filter(([, value]) => value !== undefined && value !== null && value !== ''));
    const values = { ...fields, key: String(key) };
    const template = holes(spec.url.template).every(name => nonempty(String(values[name] ?? ''))) ? spec.url.template : spec.url.otherwise;
    links.push({ key: String(key), url: fill(template, values), ...fields, title: fields.title ?? fill(template, values) });
  }
  return links;
}

/** New links first, then every kept one that is not among them (invariant 4). */
export function mergeLinks(kept, fresh) {
  const keys = new Set(fresh.map(link => link.key));
  return [...fresh, ...kept.filter(link => !keys.has(link.key))];
}

/**
 * files:  { read(name) → text | null, write(name, text | bytes, media_type) → { identity }, remove(name, state) }
 * run:    async (tool_id, input, purpose) → the tool's output; throws when the run did not complete
 * now:    () → Date
 */
export function makeSavedLinks({ files, run, assertBinding = null, now = () => new Date(), data = settings }) {
  const pages = makeSavedPages({ files, run: (tool, input, purpose) => run(tool, input, purpose, null), now });
  const fileBody = (savedFrom, group, links) => JSON.stringify({ saved_from: savedFrom, group, updated_at: now().toISOString(), links }, null, 1);
  async function keptLinks(name) {
    const text = await files.read(name);
    if (text === null) return [];
    try { const parsed = JSON.parse(text); return Array.isArray(parsed?.links) ? parsed.links : []; } catch { return []; }
  }

  async function saveBrowserFile({ file, format = null } = {}) {
    if (!nonempty(file)) throw new SavedLinksError('Give file: the saved-items file already in your files, by its identity (1f: then 64 hex) or its name (like /Arc/StorableSidebar.json).');
    const text = await files.read(file.trim());
    if (text === null) throw new SavedLinksError(`There is no file ${file} in your files. Send it first (write_file or start_file_upload), then give its identity or name.`);
    let document;
    try { document = JSON.parse(text); } catch { throw new SavedLinksError(`${file} is not a saved-items file Trillion can read: it is not JSON.`); }
    const id = browserFormatOf(document, format, data);
    const shape = data.browser_files[id];
    const groups = decodeBrowserFile(document, shape);
    if (!groups.length) throw new SavedLinksError(`${file} holds no saved links Trillion could find, so nothing was saved.`);
    const saved = [];
    for (const { group, links } of groups) {
      const name = savedLinksName(shape.label, group, data);
      await files.write(name, fileBody(shape.label, group, links), data.media_type);
      saved.push({ group, file: name, links: links.length });
    }
    return { saved_from: shape.label, groups: saved, links: saved.reduce((sum, item) => sum + item.links, 0) };
  }

  async function saveServiceList(id, { since = null } = {}, binding = null) {
    const list = data.service_lists[id];
    if (!list) throw new SavedLinksError(`There is no saved list ${id}.`);
    const allowed = async () => {
      if (!binding) return;
      if (!assertBinding) throw new SavedLinksError('This host cannot check the source’s current account binding.');
      await assertBinding(binding);
    };
    const readTool = async (tool, input, purpose) => { await allowed(); return run(tool, input, purpose, binding); };
    const account = at(await readTool(list.account.tool_id, {}, 'account'), list.account.id);
    if (account === undefined || account === null || account === '') throw new SavedLinksError(`The connected ${list.label} account did not say which account it is.`);
    if (binding && (!binding.account || String(account) !== binding.account))
      throw new SavedLinksError('The import account does not match the source’s proven provider identity. Nothing was imported.');
    const until = nonempty(since) ? since.trim() : null;
    const read = [];
    let met = false;
    let token = null;
    for (let page = 0; page < list.max_pages; page += 1) {
      const input = { [list.account_field]: String(account), ...(token ? { [list.more_pages.token_field]: token } : {}) };
      const answer = await readTool(token ? list.more_pages.tool_id : list.first_page.tool_id, input, `page-${page + 1}`);
      for (const link of linksFromPage(answer, list)) {
        if (until !== null && link.key === until) { met = true; break; }
        read.push(link);
      }
      token = at(answer, list.next_token);
      if (met || !nonempty(token)) break;
    }
    // Legacy files have no account identity. Leave them intact; bound imports use the actual provider identity,
    // so selecting another connected account can never mix its list or cursor with the old account's links.
    const name = savedLinksName(list.label, binding ? `${list.group} (${account})` : list.group, data);
    const kept = await keptLinks(name);
    const keptKeys = new Set(kept.map(link => link.key));
    const found_at = now().toISOString();
    const fresh = read.filter(link => !keptKeys.has(link.key)).map(link => ({ ...link, found_at }));
    const links = mergeLinks(kept, fresh);
    await allowed();
    if (fresh.length || !kept.length) await files.write(name, binding
      ? JSON.stringify({ saved_from: list.label, group: list.group, source_account: String(account), updated_at: now().toISOString(), links }, null, 1)
      : fileBody(list.label, list.group, links), data.media_type);
    const newest = read[0]?.key ?? until ?? kept[0]?.key ?? null;
    // Only a read that met `since` can tell what is new; without `since` every link read is kept, none handed on.
    const items = until !== null && met ? fresh : [];
    return {
      newest, items, saved: fresh.length, total: links.length, file: name,
      ...(until !== null && !met ? { said: `The last ${list.label} link Trillion saw is no longer in the list, so everything read was kept and none of it is counted as new.` } : {}),
    };
  }

  return {
    saveBrowserFile,
    saveServiceList,
    // One account action per row: the browser file reader, and `save-<list id>` for each service list.
    actions: () => ({
      'save-browser-saved-items': input => saveBrowserFile(input ?? {}),
      'find-link-provider': input => findLinkProvider(input?.url, data),
      ...pages.actions(),
      ...Object.fromEntries(Object.keys(data.service_lists).map(id => [`save-${id}`, (input, invocation) => saveServiceList(id, input ?? {}, invocation?.source_connection ?? null)])),
    }),
  };
}
