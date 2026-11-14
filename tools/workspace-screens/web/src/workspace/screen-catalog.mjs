// src/workspace/screen-catalog.mjs
//
// PURPOSE
//   The changing catalog behind every whole Trillion workspace: the viewer's access, the person's tool screens,
//   pursuits and conversations. Both main.tsx and screen-view.tsx supply the same offeredScreens projection and their
//   own read transport. The first available rows are usable immediately; later tool pages and conversations join the
//   same catalog after the workspace has drawn.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Screens are rows supplied by the existing owners, never a second list of screen names here.
//   2. One source's newer read or replacement cancels its older answer and traversal, including an older first page.
//      Rows are deduplicated by the shared identity rule: the last row wins without changing its first-seen order.
//   3. A failed or malformed read keeps the last usable rows and names the source as failed. During a new traversal,
//      previous tool rows remain offered beside its progressive additions: a missing page is not a revoked screen.
//      Only a successful terminal page makes that traversal authoritative and removes rows absent from it. The
//      viewer's access is projected on every change, so this retention never overrides the offer owner's filtering.
//      A repeated cursor fails that traversal instead of looping forever.
//      A host-confirmed plan refusal instead marks an optional source unavailable and withdraws its rows. It is a
//      settled access decision, not a successful empty read or a transient error; it never supplies viewer access.
//   4. Hosts choose when to read. This owner starts no timers or sockets and holds no credentials. Stopping it prevents
//      every pending answer from publishing. A complete new traversal replaces the old tool catalog, including an
//      actually empty answer; hosts must not close absent saved tabs while the catalog is incomplete.
//   5. A source whose read is null (screen-catalog.json: the engine has no owner for it) is settled empty from the
//      start and never read, so no host asks a path nothing answers.

import firstAnswers from './first-answers.json' with { type: 'json' };
import settings from './screen-catalog.json' with { type: 'json' };
import { oneRowPerId } from './one-row-per-id.mjs';

export const SCREEN_CATALOG_READS = Object.freeze({
  viewer: firstAnswers.paths.viewer,
  tools: firstAnswers.paths.tool_screens,
  pursuits: firstAnswers.paths.pursuits,
  conversations: settings.conversations.path,
});
export const SCREEN_CATALOG_CONVERSATIONS_EVERY_MS = settings.conversations.refresh_after_ms;
export const screenCatalogWords = settings.words;

const SOURCES = Object.keys(SCREEN_CATALOG_READS);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const rowsOf = (value, source) => {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new TypeError(`The ${source} catalog did not return its rows.`);
  }
  return value;
};
/** The person's pursuits as sidebar rows, from the records door's list read of pursuit records (first-answers.json
 *  paths.pursuits): each record's value, under its record id. */
export const pursuitRowsOf = answer => rowsOf(Array.isArray(answer?.records)
  ? answer.records.filter(record => record?.value && typeof record.value === 'object').map(record => ({ ...record.value, id: record.id }))
  : undefined, 'pursuits');
const viewerOf = value => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.access_refs)
    || value.access_refs.some(ref => typeof ref !== 'string')) throw new TypeError('The viewer catalog did not return its access.');
  return value;
};
const toolPageOf = value => {
  const rows = rowsOf(value?.surfaces, 'tools');
  if (rows.some(row => typeof row.id !== 'string' || !row.id)) throw new TypeError('A tool screen has no identity.');
  if (value.next != null && (typeof value.next !== 'string' || !value.next)) throw new TypeError('The tool screen cursor is invalid.');
  return { surfaces: oneRowPerId(rows), next: value.next ?? null };
};
const afterPath = (path, cursor) => `${path}${path.includes('?') ? '&' : '?'}after=${encodeURIComponent(cursor)}`;

/**
 * What a mounted workspace knows about catalog absence. A row withdrawn from a previously accepted offer is known
 * unavailable even while unrelated sources are incomplete; a saved row never offered here remains unknown. Copy
 * membership because hosts may mutate their offered array in place. Reoffering an identity cancels its withdrawal.
 * The returned state keeps its identity until completeness or withdrawn rows change, so record subscribers sleep.
 */
export function createScreenCatalogPresence(initialRows, complete = true) {
  const indexed = rows => new Map(rows.filter(row => typeof row?.id === 'string').map(row => [row.id, row]));
  let accepted = indexed(initialRows);
  const withdrawn = new Map();
  let state = { complete, withdrawn: [] };
  let text = JSON.stringify(state);
  return {
    state: () => state,
    reoffer(rows, nextComplete = state.complete) {
      const next = indexed(rows);
      for (const [id, row] of accepted) if (!next.has(id)) withdrawn.set(id, row);
      for (const id of next.keys()) withdrawn.delete(id);
      accepted = next;
      const candidate = { complete: nextComplete, withdrawn: [...withdrawn.values()] };
      const nextText = JSON.stringify(candidate);
      if (nextText !== text) { state = candidate; text = nextText; }
      return state;
    },
  };
}

/**
 * `initial` may carry viewer, tools ({ surfaces, next }), pursuits and conversations; an omitted source starts idle.
 * `offer({ viewer, tools, pursuits, conversations })` returns the offered rows; tools is its flattened surface array.
 * `onChange(rows, state)` also hears source-state changes when the projection is unchanged, so hosts can show an
 * incomplete catalog. `onError(error, source, state)` identifies a failed read separately from an empty success.
 * `unavailable(error, source)` classifies the host's typed plan refusal and returns its access reason, or null. Only
 * optional row sources may be unavailable; a viewer refusal remains an error and can never settle access discovery.
 * A tool traversal publishes its accepted rows progressively, retaining previous rows until its terminal page.
 * Access filtering belongs to `offer` and is applied to retained rows too; only a complete traversal proves that
 * a formerly offered tool is absent. `state.complete` is the host's signal that absence may close a saved tab.
 */
export function createScreenCatalog({ initial = {}, read, offer, unavailable = () => null, onChange = () => {}, onError = () => {} }) {
  const known = source => (has(initial, source) && initial[source] !== undefined) || SCREEN_CATALOG_READS[source] === null;
  const values = {
    viewer: known('viewer') ? viewerOf(initial.viewer) : { access_refs: [] },
    tools: known('tools') ? toolPageOf(initial.tools).surfaces : [],
    pursuits: known('pursuits') ? rowsOf(initial.pursuits, 'pursuits') : [],
    conversations: known('conversations') ? rowsOf(initial.conversations ?? [], 'conversations') : [],
  };
  const generation = Object.fromEntries(SOURCES.map(source => [source, 0]));
  const sources = Object.fromEntries(SOURCES.map(source => [source, {
    status: known(source) && !(source === 'tools' && initial.tools?.next) ? 'ready' : 'idle', error: null,
  }]));
  let stopped = false;
  let rows = oneRowPerId(offer(values));
  const state = () => ({
    sources: Object.fromEntries(SOURCES.map(source => [source, { ...sources[source] }])),
    complete: !stopped && SOURCES.every(source => ['ready', 'unavailable'].includes(sources[source].status)),
    stopped,
  });
  const publish = () => {
    if (stopped) return;
    const next = oneRowPerId(offer(values));
    if (JSON.stringify(next) !== JSON.stringify(rows)) rows = next;
    onChange(rows, state());
  };
  const current = (source, token) => !stopped && generation[source] === token;
  const begin = source => {
    const token = ++generation[source];
    sources[source] = { status: 'loading', error: null };
    publish();
    return token;
  };
  const fail = (source, error) => {
    const access = source === 'viewer' ? null : unavailable(error, source);
    if (access) {
      values[source] = [];
      sources[source] = { status: 'unavailable', error: null, access };
      publish();
      return;
    }
    sources[source] = { status: 'error', error };
    publish();
    onError(error, source, state());
  };

  function replace(source, value) {
    if (stopped) return state();
    ++generation[source];
    let accepted;
    try { accepted = source === 'viewer' ? viewerOf(value) : rowsOf(value, source); }
    catch (error) { fail(source, error); return state(); }
    values[source] = accepted;
    sources[source] = { status: 'ready', error: null };
    publish();
    return state();
  }

  async function readSource(source, first) {
    if (stopped || (first === undefined && SCREEN_CATALOG_READS[source] === null)) return state();
    const token = begin(source);
    let accepted;
    try {
      const answer = await (first === undefined ? read(SCREEN_CATALOG_READS[source]) : first);
      accepted = source === 'viewer' ? viewerOf(answer) : source === 'pursuits' ? pursuitRowsOf(answer) : rowsOf(answer?.[source], source);
    } catch (error) {
      if (current(source, token)) fail(source, error);
      return state();
    }
    if (!current(source, token)) return state();
    values[source] = accepted;
    sources[source] = { status: 'ready', error: null };
    publish();
    return state();
  }

  // A supplied first-page promise is fenced before it resolves. Main passes its already-started first read here,
  // so a kept-answer replacement that arrives later wins even when that original read is still pending.
  async function takeTools(first) {
    if (stopped) return state();
    const token = begin('tools');
    let page;
    try { page = toolPageOf(first && typeof first.then === 'function' ? await first : first); }
    catch (error) { if (current('tools', token)) fail('tools', error); return state(); }
    if (!current('tools', token)) return state();
    const previous = values.tools;
    let traversed = page.surfaces;
    values.tools = page.next ? oneRowPerId([...previous, ...traversed]) : traversed;
    sources.tools = { status: page.next ? 'loading' : 'ready', error: null };
    publish();
    const seen = new Set();
    while (page.next && current('tools', token)) {
      const cursor = page.next;
      if (seen.has(cursor)) { fail('tools', new Error('The tool screen cursor repeated before the catalog was complete.')); return state(); }
      seen.add(cursor);
      try { page = toolPageOf(await read(afterPath(SCREEN_CATALOG_READS.tools, cursor))); }
      catch (error) { if (current('tools', token)) fail('tools', error); return state(); }
      if (!current('tools', token)) return state();
      traversed = oneRowPerId([...traversed, ...page.surfaces]);
      values.tools = page.next ? oneRowPerId([...previous, ...traversed]) : traversed;
      sources.tools = { status: page.next ? 'loading' : 'ready', error: null };
      publish();
    }
    return state();
  }

  return {
    get rows() { return rows; },
    get viewer() { return values.viewer; },
    state,
    takeTools,
    takePursuits: first => readSource('pursuits', first),
    readTools: () => stopped ? Promise.resolve(state()) : takeTools(Promise.resolve().then(() => read(SCREEN_CATALOG_READS.tools))),
    readViewer: () => readSource('viewer'),
    readPursuits: () => readSource('pursuits'),
    readConversations: () => readSource('conversations'),
    replaceViewer: value => replace('viewer', value),
    replacePursuits: value => replace('pursuits', value),
    replaceConversations: value => replace('conversations', value),
    // Offer again from what is already read, when something `offer` reads besides the sources changed (a pursuit's
    // parts, src/workspace/pursuit-parts.ts).
    offerAgain: () => { publish(); return state(); },
    reportFailure: (source, error) => {
      if (stopped || !has(sources, source)) return state();
      ++generation[source];
      fail(source, error);
      return state();
    },
    stop: () => { stopped = true; for (const source of SOURCES) ++generation[source]; },
  };
}
