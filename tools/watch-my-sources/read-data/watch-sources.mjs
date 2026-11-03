// tools/watch-my-sources/read-data/watch-sources.mjs (moved from Trillion-X/trillion src/watch-sources.mjs)
//
// Purpose
//   The outside places a person wants watched (any site's feed, a YouTube channel, a blog, a changelog, a page) are DATA
//   ROWS of one of their lists, and one scheduled tool (tool:watch-sources) reads them all. Each new item becomes a row
//   of a second list; each is weighed against what the person is pursuing and the content formats they use, and only
//   what moves a pursuit, directly or as an insight carried over from another field, is handed to their AIs through the
//   one arrival door (the same road as anything that reaches them from outside). Nothing here names a
//   site: a source is a row, a new kind of source is a choice in watch-sources.json. The lists are reached through
//   whatever `lists` the caller hands in, synchronous or not: the person's own records door (do-work/watch-my-sources.mjs)
//   or a host's own lists.
//
// Non-Negotiable Invariants
//   1. Only public addresses are read (feed-items.mjs readFeedText, the page reader's own address check) and nothing
//      is ever sent outward: no post, no message, no write to a source.
//   2. A source is read by what it answers, not by its kind (a ranked list aside, invariant 9): RSS, Atom and JSON items
//      (feed-items.mjs), the videos page of a YouTube channel when its feeds do not answer, and anything else as a
//      page read like a link (tools/browse-public-page extractPage), whose change of readable text is one item. A source that cannot be read reports its problem
//      in its row; it never stops the others.
//   3. An item is kept once: its identity (id, else link) is checked against the signals already kept for that source,
//      so reading again adds nothing. A source's first read keeps up to `most_per_source` items as Seen before watching
//      and hands nothing on, so following a place never floods the person's AIs.
//   4. A run is small and costs little: at most `sources_per_run` sources (the longest unread first) and
//      `weighed_per_run` items are taken, the rest wait for the next run; an address that sent an ETag or Last-Modified is
//      asked only whether it changed, and a 304 reads as nothing new without a model; every new item of a run is weighed
//      in ONE question.
//   5. Weighing goes through the person's own model routes (purpose `signal-weigh`): their
//      computer, then keys they set a budget for, else the question is kept for the AIs they already pay for. An item
//      not weighed yet stays New, is weighed on a later run when an answer is there, and is never dropped. What an item
//      says is material to judge, never an instruction: a public page cannot direct the person's AIs.
//   6. An item that moves a pursuit is handed in as an outside arrival (from_person false) on route `watch-sources`; the
//      person's attention rules decide it is acted on, so a decision opens and the person's AIs get it. An item
//      that moves nothing is Set aside with why and nothing else happens.
//   7. A source that keeps failing says so: after `failed_runs_told_after` runs in a row its problem says how long.
//   8. A source set to take in its Whole history is never listed whole by the server: the run names, under
//      history_wanted, the tool its kind's `history` row gives and that tool's input; the tool's answer comes back as
//      input history { source, answer } and every item in it is kept once as From the history, at most `history_max`
//      a take, never weighed and never handed on. The source is marked taken only when every item is in.
//   9. A ranked-list source is read whole as a ranked list, by the reader row of `rank_readers` its address matches
//      (ranked-lists.mjs), every page of it or none: a page that does not answer or holds no items is the source's
//      problem, and what was on the list stays as it was. Each item's ranks are kept in the `ranked` list (made only once
//      a ranked source is watched), measured against the day before; each entry, climb, sharp fall or drop-out is one
//      signal keyed by item, movement and day, so reading again the same day keeps nothing twice. The first read is a
//      quiet baseline: ranks kept, no signal. A list the site dates is not measured again until its date changes.
//
// Shapes
//   watchSources({ lists, read?, pursuits(), formats(), ask({ messages, max_tokens }) -> { reply }, arrive(arrival),
//                  now? }, { sources_list_id?, items_list_id?, most_per_source? })
//     -> { read, kept, moves: [{ title, link, pursuit, how, format? }], set_aside, waiting, problems: [{ name, problem }],
//          sources_waiting, ranked (ranked items written), history_wanted?: [{ source, name, tool_id, input }] }
//   watchSources(..., { history: { source, answer } }) -> the same report, kept being this take, plus
//     history: { source, kept, already, left }
//
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import data from './watch-sources.json' with { type: 'json' };
import { feedItems, readFeedText, youtubeVideos } from './feed-items.mjs';
import { movementOf, pagesOf, rankedItems, rankReaderOf } from './ranked-lists.mjs';
import { extractPage } from '../../browse-public-page/do-work/page-facts.mjs';

const { limits, states, words } = data;
const DAY = 86_400_000;
const LIST_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PAGE_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

export class WatchSourcesError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const text = value => (typeof value === 'string' ? value.trim() : '');
const hashOf = value => makeHashCodeHexFromBytes(new TextEncoder().encode(value)).slice(3, 27);
const slugOf = value => String(value).trim().replace(/[/\s]+/g, '-').slice(0, 100);
const hostOf = url => { try { return new URL(url).host; } catch { return 'The address'; } };
const only = (fields, values) => Object.fromEntries(Object.entries(values).filter(([id]) => fields.has(id)));
// A list's field ids, from its definition alone (lists.find): reading the list itself read every row of it, and the items
// list holds every signal ever kept, four times a run.
const ids = list => new Set((list?.fields ?? []).map(field => field.id));
// A signal whose key names a change (a page's words, an item's move on a ranked list) shares its link with others, so
// its link is not its identity.
const CHANGE_KEY = /^(page|rank):/;
const dayOf = date => date.toISOString().slice(0, 10);
const rankOrNull = value => (Number.isSafeInteger(value) && value > 0 ? value : null);

// A ranked list read whole, every page of its reader: { ranks: [{ id, rank, title, link, facts }], dated } | { problem }, or
// { not_modified, dated } when the site dates its list and the date is the one kept at the last read.
async function readRanks(source, read) {
  const address = text(source.address);
  if (!address) return { problem: words.no_address };
  const reader = rankReaderOf(address, data.rank_readers.rows);
  if (!reader) return { problem: fill(words.no_rank_reader, { host: hostOf(address) }) };
  const ranks = new Map();
  let dated = null;
  for (const url of pagesOf(address, reader)) {
    const got = await readFeedText(read, url);
    if (!got.ok) return { problem: got.status ? fill(words.answered, { host: hostOf(url), status: got.status }) : fill(words.silent, { host: hostOf(url) }) };
    const page = rankedItems(reader, got.text);
    if (!page?.items.length) return { problem: fill(words.no_ranks, { host: hostOf(url) }) };
    dated ??= page.dated;
    for (const item of page.items) if (!ranks.has(item.id)) ranks.set(item.id, item);
  }
  if (dated && dated === text(source.list_dated) && [].concat(source.on_the_list ?? []).length) return { not_modified: true, dated };
  return { ranks: [...ranks.values()].sort((a, b) => a.rank - b.rank), dated };
}

// The videos page of a YouTube channel address (the handle or channel page, with or without a tab), else null.
function videosPageOf(address) {
  let url;
  try { url = new URL(address); } catch { return null; }
  if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
  const path = url.pathname.replace(/\/(videos|featured|streams|shorts|playlists|community|about)\/?$/, '').replace(/\/+$/, '');
  return /^\/(@[^/]+|channel\/UC[\w-]+|c\/[^/]+|user\/[^/]+)$/.test(path) ? `https://www.youtube.com${path}/videos` : null;
}

// What to try for one source, in order: { url, videos?, feed? }. A YouTube channel's feeds sometimes answer 404, so the
// channel's own feed is followed by its uploads playlist's, then by its videos page.
function candidatesOf(source) {
  const address = text(source.address);
  const feed = text(source.feed);
  if (source.kind !== 'youtube-channel') return feed || address ? [{ url: feed || address }] : [];
  const channel = /\/channel\/(UC[\w-]{10,})/.exec(address)?.[1] ?? /channel_id=(UC[\w-]{10,})/.exec(feed)?.[1];
  const tries = [];
  if (feed) tries.push({ url: feed, feed: true });
  else if (channel) tries.push({ url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}`, feed: true });
  if (channel) tries.push({ url: `https://www.youtube.com/feeds/videos.xml?playlist_id=UU${channel.slice(2)}`, feed: true });
  const page = videosPageOf(address || feed);
  if (page) tries.push({ url: page, videos: true });
  return tries.filter((one, index) => tries.findIndex(other => other.url === one.url) === index);
}

// One source read: { items, etag, modified } | { page: { hash, text }, ... } | { not_modified, etag, modified } | { ranks }
// | { problem }.
async function readOne(source, read) {
  if (source.kind === 'ranked-list') return readRanks(source, read);
  if (source.kind === 'youtube-subscriptions') return { problem: words.subscriptions };
  if (source.kind === 'x-account' && !text(source.feed)) return { problem: words.x };
  const tries = candidatesOf(source);
  if (!tries.length) return { problem: source.kind === 'youtube-channel' ? words.channel : words.no_address };
  if (source.kind === 'youtube-channel' && !tries.some(one => one.feed || one.videos)) return { problem: words.channel };
  let last = null;
  for (const one of tries) {
    const got = await readFeedText(read, one.url, { etag: text(source.etag) || null, modified: text(source.modified) || null, browser: Boolean(one.videos) });
    if (got.not_modified) return { not_modified: true, etag: got.etag, modified: got.modified };
    if (!got.ok) { last = got; continue; }
    const kept = { etag: got.etag, modified: got.modified };
    if (one.videos) {
      const items = youtubeVideos(got.text);
      if (items.length) return { items, ...kept };
      continue;
    }
    const parsed = feedItems(got.text, got.url);
    if (parsed) return { items: parsed.items, ...kept };
    if (one.feed) continue;
    // Anything else is a page, read like a link (the page facts a link's card is made of): a change of its readable text
    // is one item.
    const page = extractPage(got.text, new URL(one.url), !PAGE_TYPES.slice(0, 2).includes(got.type));
    if (!page.text.trim()) return { problem: page.title ? words.no_text : words.says_nothing };
    return { page: { hash: hashOf(page.text), text: page.text }, ...kept };
  }
  return { problem: last && last.status ? fill(words.answered, { host: hostOf(last.url), status: last.status }) : fill(words.silent, { host: hostOf(tries[0].url) }) };
}

// A reply's JSON object, whichever way the model's service wrapped it.
function replyObject(reply) {
  const value = reply?.choices?.[0]?.message?.content ?? reply?.response ?? (typeof reply?.content === 'string' ? reply.content : reply);
  if (value && typeof value === 'object') return value;
  const said = String(value ?? '');
  const start = said.indexOf('{');
  const end = said.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(said.slice(start, end + 1)); } catch { return null; }
}

/**
 * lists: the person's lists, each call answered at once or as a promise. read(url, init) fetches. pursuits() -> their pursuits; formats() -> their
 * content formats; ask({ messages, max_tokens }) -> { reply } asks their model routes (throws when none answers);
 * arrive(arrival) hands one item in at the arrival door.
 */
export async function watchSources({ lists, read = fetch, pursuits = async () => [], formats = async () => [], ask, arrive, now = () => new Date() }, input = {}) {
  const sourcesId = input.sources_list_id ?? data.sources.id;
  const itemsId = input.items_list_id ?? data.items.id;
  const rankedId = data.ranked.id;
  for (const [field, value] of [['sources_list_id', sourcesId], ['items_list_id', itemsId]]) {
    if (typeof value !== 'string' || !LIST_ID.test(value)) throw new WatchSourcesError(fill(words.bad_list, { field }));
  }
  const most = Number.isInteger(input.most_per_source) && input.most_per_source > 0 ? Math.min(input.most_per_source, limits.most_per_source_max) : limits.most_per_source_default;
  const actor = { by: 'tool:watch-sources' };

  // The lists, made the way save_list makes one when the person has not, each link naming the list given for it. A link
  // field waits until the list it names is made: the ranked list is made only once a ranked source is watched.
  const listIds = { [data.sources.id]: sourcesId, [data.items.id]: itemsId, [data.ranked.id]: rankedId };
  const keepList = async (shape, id) => {
    const definition = { ...shape, id, fields: shape.fields.map(field => (field.links_to ? { ...field, links_to: listIds[field.links_to] } : field)) };
    const made = new Map(await Promise.all(definition.fields.filter(field => field.links_to && field.links_to !== id).map(async field => [field.links_to, await lists.has(field.links_to)])));
    const ready = field => !field.links_to || field.links_to === id || made.get(field.links_to);
    await lists.ensure({ ...definition, fields: definition.fields.filter(ready) }, { actor });
    // A list made by an earlier version lacks the fields added since (kept_run, 2026-10-08), and a row keeps only the
    // fields its list has, so they are added after the list's own; a field the person added or changed is left alone.
    const fields = (await lists.find(id)).fields;
    const missing = definition.fields.filter(field => ready(field) && !fields.some(one => one.id === field.id));
    if (missing.length) await lists.save({ id, fields: [...fields, ...missing] }, { actor });
  };
  await keepList(data.sources, sourcesId);
  await keepList(data.items, itemsId);
  let sourceFields = ids(await lists.find(sourcesId));
  const itemFields = ids(await lists.find(itemsId));

  const stamp = now();
  const iso = stamp.toISOString();
  const report = { read: 0, kept: 0, ranked: 0, moves: [], set_aside: 0, waiting: 0, problems: [], sources_waiting: 0 };
  if (input.history !== undefined) {
    const history = await takeHistory({ lists, sourcesId, itemsId, sourceFields, itemFields, actor, iso, stamp }, input.history);
    return { ...report, kept: history.kept, history };
  }

  // Which sources, longest unread first, and what each already holds.
  const watched = (await lists.read(sourcesId)).rows.filter(row => row.values.watching !== 'No');
  let rankedFields = null;
  if (watched.some(row => row.values.kind === 'ranked-list')) {
    await keepList(data.ranked, rankedId);
    await keepList(data.sources, sourcesId);
    sourceFields = ids(await lists.find(sourcesId));
    rankedFields = ids(await lists.find(rankedId));
  }
  watched.sort((a, b) => String(a.values.last_read ?? '').localeCompare(String(b.values.last_read ?? '')));
  const due = watched.slice(0, limits.sources_per_run);
  report.sources_waiting = watched.length - due.length;
  const held = new Map(), itemWrites = [], sourceWrites = [];
  // The items list is read once a run, its own values only (no linked or derived fields): what each source already holds,
  // and below the New signals to weigh, with what this run keeps added to it.
  const itemRows = (await lists.read(itemsId, { only: [...itemFields] })).rows;
  for (const row of itemRows) {
    for (const sourceId of Array.isArray(row.values.source) ? row.values.source : [row.values.source]) {
      if (!sourceId) continue;
      const mine = held.get(sourceId) ?? { keys: new Set(), links: new Set() };
      if (row.values.key) mine.keys.add(row.values.key);
      if (row.values.link && !CHANGE_KEY.test(String(row.values.key ?? ''))) mine.links.add(row.values.link);
      held.set(sourceId, mine);
    }
  }

  for (const row of due) {
    const source = row.values;
    const name = text(source.name) || row.id;
    const mine = held.get(row.id) ?? { keys: new Set(), links: new Set() };
    let result;
    try { result = await readOne(source, read); } catch (error) { result = { problem: String(error?.message ?? error) }; }

    if (result.problem) {
      const runs = (Number(source.failed_runs) || 0) + 1;
      const since = text(source.failing_since) || iso;
      const problem = runs >= limits.failed_runs_told_after ? fill(words.failed_in_a_row, { problem: result.problem, runs, since: since.slice(0, 10) }) : result.problem;
      sourceWrites.push({ id: row.id, values: only(sourceFields, { problem, failed_runs: runs, failing_since: since }) });
      report.problems.push({ name, problem });
      continue;
    }
    report.read += 1;

    const firstRead = !text(source.last_read);
    const lastRead = Date.parse(text(source.last_read));
    let fresh = [];
    let onTheList = null;
    if (result.ranks) {
      const kept = await keepRanks({ lists, rankedId, rankedFields, row, name, ranks: result.ranks, stamp, actor });
      onTheList = kept.on_the_list;
      report.ranked += kept.written;
      for (const signal of kept.signals) {
        if (mine.keys.has(signal.key)) continue;
        mine.keys.add(signal.key);
        fresh.push(signal);
      }
    } else if (result.items) {
      for (const item of result.items) {
        const key = item.id || item.link;
        if (!key || mine.keys.has(key) || (item.link && mine.links.has(item.link))) continue;
        mine.keys.add(key);
        fresh.push({ key, title: item.title || item.link || key, link: item.link || (/^https?:\/\//.test(key) ? key : text(source.address) || text(source.feed)), published: item.published, summary: item.summary });
      }
    } else if (result.page) {
      const key = `page:${result.page.hash}`;
      if (!mine.keys.has(key)) {
        mine.keys.add(key);
        fresh.push({ key, title: firstRead ? name : fill(words.changed, { name }), link: text(source.address) || text(source.feed), published: null, summary: result.page.text.slice(0, limits.page_summary_chars) });
      }
    }
    // A first read remembers everything the source lists now (up to baseline_max), so nothing it already showed comes back as
    // New. Every move on a ranked list is kept: it is bounded by the list's own pages, and one not kept today is gone tomorrow.
    const taken = result.ranks ? fresh : fresh.slice(0, firstRead ? limits.baseline_max : most);
    const writes = taken.map(item => {
      const old = !firstRead && item.published && Number.isFinite(lastRead) && Date.parse(item.published) < lastRead - limits.unseen_older_than_days * DAY;
      return { id: `${slugOf(row.id)}-${hashOf(item.key)}`, values: only(itemFields, {
        title: item.title.slice(0, 500), link: item.link, key: item.key, source: [row.id], published: item.published ?? iso, ...(item.summary ? { summary: item.summary.slice(0, limits.summary_chars) } : {}),
        state: firstRead || old ? states.baseline : states.new, kept_run: stamp.getTime(),
      }) };
    });
    itemWrites.push(...writes);
    itemRows.push(...writes);
    report.kept += writes.length;
    held.set(row.id, mine);
    // Items past this run's take are not kept, so the validators are not either: the next read is the whole feed, not a 304.
    const validators = fresh.length > taken.length ? { etag: null, modified: null } : result;
    sourceWrites.push({ id: row.id, values: only(sourceFields, {
      last_read: iso, problem: null, failed_runs: null, failing_since: null,
      ...(validators.etag !== undefined ? { etag: validators.etag ?? null } : {}), ...(validators.modified !== undefined ? { modified: validators.modified ?? null } : {}),
      ...(writes.length ? { new_last_time: stamp.getTime() } : {}), ...(onTheList ? { on_the_list: onTheList } : {}),
      ...(result.dated !== undefined ? { list_dated: result.dated } : {}),
    }) });
  }
  // What the run keeps, and each source's new state, are written once for the run, not once per source.
  await putAll(lists, itemsId, itemWrites, actor);
  await putAll(lists, sourcesId, sourceWrites, actor);

  await weigh({ lists, itemsId, itemRows, sourcesId, itemFields, pursuits, formats, ask, arrive, stamp, actor, report });
  const wanted = watched.filter(row => row.values.history === data.history.whole && !text(row.values.history_taken) && data.history.tools[row.values.kind])
    .map(row => {
      const tool = data.history.tools[row.values.kind];
      return { source: row.id, name: text(row.values.name) || row.id, tool_id: tool.tool_id,
        input: Object.fromEntries(Object.entries(tool.input).map(([name, field]) => [name, row.values[field] ?? null])) };
    });
  if (wanted.length) report.history_wanted = wanted;
  return report;
}

// Rows put in writes of at most limits.rows_per_write, the most the lists owner takes at once (a Trillion list's too_many).
async function putAll(lists, listId, rows, actor) {
  for (let at = 0; at < rows.length; at += limits.rows_per_write) await lists.putRows(listId, { rows: rows.slice(at, at + limits.rows_per_write) }, { actor });
}

// One read of a ranked source, kept per item in the ranked list: its rank now, the rank of the day before it is measured
// against, its best, the days it was listed and its recent ranks. Each item that moved since the day before (ranked-
// lists.mjs movementOf) makes one signal, keyed by item, movement and day, so reading again the same day measures against
// the same day before and keeps nothing twice. A source with nothing on the list yet is a baseline: its ranks are kept and
// no signal is made. -> { signals, on_the_list: [ranked row id], written }
async function keepRanks({ lists, rankedId, rankedFields, row, name, ranks, stamp, actor }) {
  const day = dayOf(stamp);
  const rowIdOf = id => `${slugOf(row.id)}-${hashOf(id)}`;
  const before = [].concat(row.values.on_the_list ?? []).filter(id => typeof id === 'string' && id);
  const baseline = !before.length;
  const now = new Map(ranks.map(item => [rowIdOf(item.id), item]));
  const named = [...new Set([...now.keys(), ...before])];
  const held = new Map((await lists.read(rankedId, { row_ids: named })).rows.map(one => [one.id, one.values]));
  const writes = [];
  const signals = [];
  for (const rowId of named) {
    const item = now.get(rowId) ?? null;
    const kept = held.get(rowId) ?? null;
    if (!item && !kept) continue;
    const from = kept ? rankOrNull(Number(kept.ranked_on === day ? kept.previous_rank : kept.rank)) : null;
    const to = item ? item.rank : null;
    const id = item ? item.id : text(kept.item);
    const title = (item && item.title !== item.id ? item.title : text(kept?.title)) || id;
    const link = item ? item.link : text(kept.link);
    const best = Math.min(...[to, rankOrNull(Number(kept?.best_rank))].filter(value => value !== null));
    const recent = String(kept?.recent_ranks ?? '').split(' ').filter(entry => entry && !entry.startsWith(`${day}:`));
    if (to !== null) recent.push(`${day}:${to}`);
    const days = (Number(kept?.days_listed) || 0) + (to !== null && kept?.last_seen !== day ? 1 : 0);
    writes.push({ id: rowId, values: only(rankedFields, {
      title: title.slice(0, 500), link, item: id, source: [row.id], rank: to, previous_rank: from, best_rank: Number.isFinite(best) ? best : null,
      first_seen: kept?.first_seen ?? day, last_seen: to !== null ? day : kept?.last_seen ?? null, ranked_on: day, days_listed: days,
      recent_ranks: recent.slice(-limits.rank_recent_days).join(' '), ...(item ? item.facts : {}),
    }) });
    const movement = baseline ? null : movementOf(from, to, limits);
    if (!movement) continue;
    const shown = { from: from ?? words.off_the_list, to: to ?? words.off_the_list };
    signals.push({ key: `rank:${id}:${movement}:${day}`, title: fill(words[movement], { ...shown, title }), link, published: stamp.toISOString(),
      summary: fill(words.rank_summary, { ...shown, source: name, best: Number.isFinite(best) ? best : shown.to, days, recent: recent.slice(-limits.rank_recent_days).join(' ') || words.off_the_list }) });
  }
  await putAll(lists, rankedId, writes, actor);
  return { signals, on_the_list: [...now.keys()], written: writes.length };
}

// Keeps a source's whole history, as listed by the tool its kind's `history` row names: each item once, From the history.
async function takeHistory({ lists, sourcesId, itemsId, sourceFields, itemFields, actor, iso, stamp }, history) {
  const sourceId = text(history?.source);
  const row = (await lists.read(sourcesId)).rows.find(one => one.id === sourceId);
  if (!row) throw new WatchSourcesError(fill(words.history_no_source, { name: sourceId }));
  const name = text(row.values.name) || row.id;
  if (row.values.history !== data.history.whole) throw new WatchSourcesError(fill(words.history_not_wanted, { name }));
  const tool = data.history.tools[row.values.kind];
  if (!tool) throw new WatchSourcesError(fill(words.history_no_tool, { name }));
  const entries = history?.answer?.[tool.entries];
  if (!Array.isArray(entries)) throw new WatchSourcesError(fill(words.history_no_entries, { name }));
  const mine = { keys: new Set(), links: new Set() };
  for (const one of (await lists.read(itemsId)).rows) {
    if (![].concat(one.values.source).includes(row.id)) continue;
    if (one.values.key) mine.keys.add(one.values.key);
    if (one.values.link) mine.links.add(one.values.link);
  }
  const fresh = [];
  let already = 0;
  for (const entry of entries) {
    const link = text(entry?.[tool.item.link]);
    const key = text(String(entry?.[tool.item.key] ?? '')) || link;
    if (!key) continue;
    if (mine.keys.has(key) || (link && mine.links.has(link))) { already += 1; continue; }
    mine.keys.add(key);
    if (link) mine.links.add(link);
    fresh.push({ key, link, title: text(entry?.[tool.item.title]) || link || key });
  }
  const taken = fresh.slice(0, limits.history_max);
  const writes = taken.map(item => ({ id: `${slugOf(row.id)}-${hashOf(item.key)}`, values: only(itemFields, {
    title: item.title.slice(0, 500), link: item.link || null, key: item.key, source: [row.id], state: states.history, kept_run: stamp.getTime(),
  }) }));
  await putAll(lists, itemsId, writes, actor);
  const left = fresh.length - taken.length;
  if (!left) await lists.putRows(sourcesId, { rows: [{ id: row.id, values: only(sourceFields, { history_taken: iso }) }] }, { actor });
  return { source: row.id, kept: taken.length, already, left };
}

// The New signals of the OLDEST run that still has any, weighed in ONE question, at most `weighed_per_run` of them. Signals kept
// later never change an open batch, so a question kept for the person's AIs is sent byte-identical until it is answered.
async function weigh({ lists, itemsId, itemRows, sourcesId, itemFields, pursuits, formats, ask, arrive, stamp, actor, report }) {
  const names = new Map((await lists.read(sourcesId)).rows.map(row => [row.id, text(row.values.name) || row.id]));
  const keptRun = row => Number(row.values.kept_run) || 0;
  const waiting = itemRows.filter(row => row.values.state === states.new).sort((a, b) => keptRun(a) - keptRun(b) || a.id.localeCompare(b.id));
  const batch = waiting.filter(row => keptRun(row) === keptRun(waiting[0])).slice(0, limits.weighed_per_run);
  report.waiting = waiting.length;
  if (!batch.length) return;

  const pursuitRows = (await pursuits()).filter(one => one.status !== 'ended').slice(0, limits.pursuits_asked);
  const formatRows = (await formats()).slice(0, limits.formats_asked);
  if (!pursuitRows.length && !formatRows.length) return;
  const line = (...parts) => `- ${parts.map(part => String(part ?? '').replace(/\s+/g, ' ').trim()).join(' | ')}`;
  const sourceOf = row => names.get([].concat(row.values.source)[0]) ?? '';
  const messages = [
    { role: 'system', content: data.weigh.system },
    { role: 'user', content: [
      data.weigh.pursuits, ...(pursuitRows.length ? pursuitRows.map(one => line(one.id, one.title, `after: ${one.after ?? ''}`)) : [data.weigh.none]),
      '', data.weigh.formats, ...(formatRows.length ? formatRows.map(one => line(one.id, one.label, String(one.description ?? '').slice(0, 100))) : [data.weigh.none]),
      '', data.weigh.items, ...batch.map((row, index) => `${index + 1}. Source: ${sourceOf(row)}\n   Title: ${row.values.title ?? ''}\n   Summary: ${String(row.values.summary ?? '').slice(0, limits.summary_chars)}\n   Link: ${row.values.link ?? ''}`),
    ].join('\n') },
  ];
  let answer;
  try {
    answer = replyObject((await ask({ messages, max_tokens: data.weigh.max_tokens })).reply);
  } catch (error) {
    // No route answered just now: the question is kept for the person's AIs and the items stay New for a later run.
    if (!error?.no_chosen_ai && !error?.model_budget_reached) report.problems.push({ name: data.weigh.purpose, problem: fill(words.unweighed, { why: String(error?.message ?? error) }) });
    return;
  }
  const byNumber = new Map((Array.isArray(answer?.items) ? answer.items : []).map(one => [Number(one?.n), one]));
  const pursuitById = new Map(pursuitRows.map(one => [String(one.id), one]));
  const formatById = new Map(formatRows.map(one => [String(one.id), one]));

  for (const [index, row] of batch.entries()) {
    const verdict = byNumber.get(index + 1);
    if (!verdict || typeof verdict !== 'object') continue;
    // A small model can number its answers off by one: a verdict that names another item's link is not this item's, and
    // the item waits for a later answer rather than taking a reason written for something else.
    if (verdict.link !== undefined && text(verdict.link) !== text(row.values.link)) continue;
    const pursuit = pursuitById.get(String(verdict.moves ?? ''));
    const format = formatById.get(String(verdict.format ?? ''));
    const said = String(verdict.why ?? '').replace(/\s+/g, ' ').trim().slice(0, limits.reply_chars);
    const title = text(row.values.title);
    const link = text(row.values.link);
    if (!pursuit && !(format && verdict.how === 'insight')) {
      await lists.putRows(itemsId, { rows: [{ id: row.id, values: only(itemFields, { state: states.set_aside, why: said || null, pursuit: null, how: null }) }] }, { actor });
      report.set_aside += 1;
      report.waiting -= 1;
      continue;
    }
    const how = pursuit && verdict.how !== 'insight' ? 'direct' : 'insight';
    const why = how === 'insight'
      ? fill(pursuit ? words.insight_for_pursuit : words.insight_for_format, { target: pursuit ? pursuit.title : format.label, why: said || words.fallback_why })
      : said || words.fallback_why;
    const source = names.get([].concat(row.values.source)[0]) ?? '';
    const change = CHANGE_KEY.test(String(row.values.key ?? ''));
    try {
      await arrive({ route: data.route, source_id: change ? `${link}#${row.values.key}` : link, from_person: false, title, ...(source ? { from: source } : {}),
        text: `${source}: ${title}\n${why}\n${link}`, at: text(row.values.published) || stamp.toISOString() });
    } catch (error) {
      // The item stays New and is handed in on a later run.
      report.problems.push({ name: source || data.route, problem: String(error?.message ?? error) });
      continue;
    }
    await lists.putRows(itemsId, { rows: [{ id: row.id, values: only(itemFields, { state: states.moves, pursuit: pursuit ? String(pursuit.id) : null, how, why }) }] }, { actor });
    report.moves.push({ title, link, pursuit: pursuit ? String(pursuit.id) : null, how, ...(format ? { format: String(format.id) } : {}) });
    report.waiting -= 1;
  }
}
