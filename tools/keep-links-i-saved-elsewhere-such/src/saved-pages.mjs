// src/saved-pages.mjs
//
// PURPOSE
//   A web page a person saved as a clip, kept in their own Trillion files: the page's address, its title, its text, a
//   snapshot picture when the tool that read it can draw one, a refresh policy and the time it was last refreshed. The
//   same record is the file anyone can read, so every AI and screen sees the same saved page.
//     savePage       reads the page through the capture tool of src/saved-pages.json and keeps it (again for a page
//                    already saved: the same record is replaced, because the address is its key)
//     readSavedPage  one saved page, or with no address the index of all of them
//     editSavedPage  changes only the refresh policy or the title
//     refreshPages   reads again the pages that are due (or the one asked), so a schedule (set_schedule on the
//                    refresh tool) keeps clips current; every attempt stamps last_refreshed_at or last_error
//     removePage     sets the page's files aside (Recently Deleted) and takes it out of the index
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every path, tool, field and word is a row of src/saved-pages.json; nothing names a site.
//   2. A failed refresh keeps the last good title and text and records why it failed.
//   3. A key is the BLAKE3 of the address, so the same address is always the same saved page.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import settings from './saved-pages.json' with { type: 'json' };

export class SavedPagesError extends Error {}

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const at = (value, path) => (path ?? []).reduce((here, part) => (here === undefined || here === null ? undefined : here[part]), value);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** The one http(s) address a page is known by, or null. */
export function pageAddress(value) {
  if (!nonempty(value)) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

/** The key of a saved page: the first `key_chars` hex characters of the BLAKE3 of its address. */
export const pageKey = (address, data = settings) => bytesToHex(blake3(new TextEncoder().encode(address))).slice(0, data.key_chars);

const bytesOfBase64 = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));

/** The whole hours a refresh policy allows: null (no refresh) or a whole number in range; anything else throws. */
export function refreshHours(value, data = settings) {
  if (value === null) return null;
  const { min_every_hours: min, max_every_hours: max } = data.refresh;
  if (!Number.isInteger(value) || value < min || value > max) throw new SavedPagesError(fill(data.words.bad_hours, { min, max }));
  return value;
}

const nextRefresh = (hours, from) => (hours === null ? null : new Date(new Date(from).getTime() + hours * 3600000).toISOString());

/**
 * files: { read(name) → text | null, write(name, text|bytes, media_type), remove(name, state) }
 * run:   async (tool_id, input, purpose) → the tool's output; throws when it did not complete
 * now:   () → Date
 */
export function makeSavedPages({ files, run, now = () => new Date(), data = settings }) {
  const indexFile = `${data.folder}/${data.index_name}`;
  const pageFile = key => `${data.folder}/${data.file_name.replace('{key}', key)}`;
  const readJson = async name => { const text = await files.read(name); if (text === null) return null; try { return JSON.parse(text); } catch { return null; } };
  const readIndex = async () => { const index = await readJson(indexFile); return Array.isArray(index?.pages) ? index.pages : []; };
  const writeIndex = pages => files.write(indexFile, JSON.stringify({ updated_at: now().toISOString(), pages }, null, 1), data.media_type);
  const summary = page => ({ key: page.key, url: page.url, title: page.title, file: pageFile(page.key), refresh_every_hours: page.refresh_every_hours, last_refreshed_at: page.last_refreshed_at, next_refresh_at: page.next_refresh_at, state: page.state });

  async function keyOf({ url, key }) {
    if (nonempty(key)) return key.trim();
    const address = pageAddress(url);
    if (!address) throw new SavedPagesError(nonempty(url) ? fill(data.words.bad_url, { url }) : data.words.no_url);
    return pageKey(address, data);
  }

  async function capture(address) {
    const answer = await run(data.capture.tool_id, { url: address }, 'capture');
    const text = at(answer, data.capture.fields.text);
    if (!nonempty(text)) throw new SavedPagesError(fill(data.words.no_text, { url: address }));
    const picture = at(answer, data.capture.fields.snapshot.base64);
    return {
      title: at(answer, data.capture.fields.title) ?? null,
      text: text.slice(0, data.text_max_chars),
      picture: nonempty(picture) ? { base64: picture, media_type: at(answer, data.capture.fields.snapshot.media_type) ?? 'image/png' } : null,
    };
  }

  async function keepSnapshot(key, picture) {
    if (!picture) return null;
    const extension = data.snapshot_extensions[picture.media_type];
    if (!extension) return null;
    const name = `${data.folder}/${data.snapshot_name.replace('{key}', key).replace('{extension}', extension)}`;
    const bytes = bytesOfBase64(picture.base64);
    await files.write(name, bytes, picture.media_type);
    return { file: name, media_type: picture.media_type, bytes: bytes.byteLength };
  }

  async function savePage({ url, refresh_every_hours: asked = null } = {}) {
    const address = pageAddress(url);
    if (!address) throw new SavedPagesError(nonempty(url) ? fill(data.words.bad_url, { url }) : data.words.no_url);
    const hours = refreshHours(asked, data);
    const key = pageKey(address, data);
    const read = await capture(address);
    const stamp = now().toISOString();
    const before = await readJson(pageFile(key));
    const page = {
      key, url: address, title: read.title, text: read.text, text_chars: read.text.length,
      snapshot: await keepSnapshot(key, read.picture),
      refresh_every_hours: hours, saved_at: before?.saved_at ?? stamp, last_refreshed_at: stamp, next_refresh_at: nextRefresh(hours, stamp),
      refresh_count: before?.refresh_count ?? 0, state: 'ok', last_error: null,
    };
    await files.write(pageFile(key), JSON.stringify(page, null, 1), data.media_type);
    await writeIndex([summary(page), ...(await readIndex()).filter(row => row.key !== key)]);
    return { ...page, file: pageFile(key), ...(page.snapshot ? {} : { said: data.words.no_snapshot }) };
  }

  async function readSavedPage(input = {}) {
    if (!nonempty(input.url) && !nonempty(input.key)) return { pages: await readIndex() };
    const key = await keyOf(input);
    const page = await readJson(pageFile(key));
    if (!page) throw new SavedPagesError(fill(data.words.no_page, { asked: input.url ?? key }));
    return { ...page, file: pageFile(key) };
  }

  async function editSavedPage(input = {}) {
    const key = await keyOf(input);
    const page = await readJson(pageFile(key));
    if (!page) throw new SavedPagesError(fill(data.words.no_page, { asked: input.url ?? key }));
    const next = { ...page };
    if ('refresh_every_hours' in input) {
      next.refresh_every_hours = refreshHours(input.refresh_every_hours, data);
      next.next_refresh_at = nextRefresh(next.refresh_every_hours, page.last_refreshed_at);
    }
    if (nonempty(input.title)) next.title = input.title.trim();
    await files.write(pageFile(key), JSON.stringify(next, null, 1), data.media_type);
    await writeIndex((await readIndex()).map(row => (row.key === key ? summary(next) : row)));
    return { ...next, file: pageFile(key) };
  }

  async function refreshOne(row) {
    const page = await readJson(pageFile(row.key));
    if (!page) return { key: row.key, url: row.url, state: 'missing' };
    const stamp = now().toISOString();
    let next;
    try {
      const read = await capture(page.url);
      next = {
        ...page, title: read.title, text: read.text, text_chars: read.text.length,
        snapshot: (await keepSnapshot(page.key, read.picture)) ?? page.snapshot,
        last_refreshed_at: stamp, next_refresh_at: nextRefresh(page.refresh_every_hours, stamp),
        refresh_count: page.refresh_count + 1, state: 'ok', last_error: null,
      };
    } catch (error) {
      next = { ...page, state: 'failed', last_error: String(error.message ?? error), next_refresh_at: nextRefresh(page.refresh_every_hours, stamp) };
    }
    await files.write(pageFile(page.key), JSON.stringify(next, null, 1), data.media_type);
    return summary(next);
  }

  async function refreshPages(input = {}) {
    const index = await readIndex();
    const asked = nonempty(input.url) || nonempty(input.key) ? await keyOf(input) : null;
    if (asked !== null && !index.some(row => row.key === asked)) throw new SavedPagesError(fill(data.words.no_page, { asked: input.url ?? asked }));
    const stamp = now().getTime();
    const due = index.filter(row => (asked !== null ? row.key === asked : row.next_refresh_at !== null && new Date(row.next_refresh_at).getTime() <= stamp)).slice(0, data.refresh.per_run);
    const done = new Map();
    for (const row of due) done.set(row.key, await refreshOne(row));
    if (done.size) await writeIndex(index.map(row => done.get(row.key) ?? row));
    return { refreshed: [...done.values()], due: due.length, total: index.length };
  }

  async function removePage(input = {}) {
    const key = await keyOf(input);
    const page = await readJson(pageFile(key));
    const index = await readIndex();
    if (!page && !index.some(row => row.key === key)) throw new SavedPagesError(fill(data.words.no_page, { asked: input.url ?? key }));
    for (const name of [pageFile(key), ...(page?.snapshot ? [page.snapshot.file] : [])]) await files.remove(name, data.removal);
    await writeIndex(index.filter(row => row.key !== key));
    return { removed: key, url: page?.url ?? null, kept_in: data.removal };
  }

  return {
    savePage, readSavedPage, editSavedPage, refreshPages, removePage,
    actions: () => ({
      'save-page': input => savePage(input ?? {}),
      'read-saved-page': input => readSavedPage(input ?? {}),
      'edit-saved-page': input => editSavedPage(input ?? {}),
      'refresh-saved-pages': input => refreshPages(input ?? {}),
      'remove-saved-page': input => removePage(input ?? {}),
    }),
  };
}
