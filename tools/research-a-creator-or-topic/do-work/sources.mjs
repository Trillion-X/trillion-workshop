// tools/research-a-creator-or-topic/do-work/sources.mjs
//
// Readers for the places a person researches a creator or a topic from. Each takes the text a source gave and returns
// { source, items } (or the words of a video): a feed, a channel listing, the results of a public web search, a saved
// list in a file, and a video's captions. Nothing here fetches, runs a program or reads a disk; the commands beside it
// do, and hand the text to these. A new kind of source is one more reader here and one more command.
//
// An item is { item_id, title, url, published, description } and may carry more (duration, citation, source_family ...).

export const MAX_SEARCH_RESULTS = 10;
export const MAX_SAVED_ITEMS = 5000;
export const MAX_QUERY_LENGTH = 500;
export const DEFAULT_WATCH_BASE = 'https://www.youtube.com/watch?v=';

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'" };
// One pass, so "&amp;lt;" becomes "&lt;" and not "<".
const decodeEntities = text => text.replace(/&(amp|quot|apos|lt|gt|#39);/g, (_, name) => ENTITIES[name]);
const squash = text => text.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------------- feeds

const unwrapCdata = text => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const plainText = value => squash(decodeEntities(unwrapCdata(String(value ?? '')).replace(/<[^>]*>/g, ' ')));

function tagText(xml, names) {
  for (const name of names) {
    const match = xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
    if (match && plainText(match[1])) return plainText(match[1]);
  }
  return '';
}

// An Atom or RSS feed: its title, and each entry or item with the id it names (a video id, an id, a guid) or its link.
export function readFeed(xml) {
  const body = String(xml ?? '');
  const source = plainText(body.match(/<(?:feed|channel)\b[\s\S]*?<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const items = [];
  for (const match of body.matchAll(/<(entry|item)\b[^>]*>([\s\S]*?)<\/(?:entry|item)>/gi)) {
    const entry = match[2];
    const linkTag = entry.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
    const url = plainText(linkTag?.[1]) || tagText(entry, ['link']);
    const itemId = tagText(entry, ['videoId', 'id', 'guid']);
    if (!itemId && !url) continue;
    items.push({
      item_id: itemId || url,
      title: tagText(entry, ['title']),
      published: tagText(entry, ['published', 'pubDate', 'updated']),
      url,
      description: tagText(entry, ['description', 'summary']),
    });
  }
  return { source, items };
}

// ------------------------------------------------------------------------------------- a channel's video list

// The tabs of a channel's page that each list videos; a link to one of them, or to a playlist (list=), is listed as given.
const LISTING_TABS = /\/(videos|shorts|streams|podcasts|playlists)$/;

// The page that lists a channel's videos, from what the person gave: a link, a channel id (UC...), a @handle or a bare name.
export function channelListingUrl(raw) {
  const given = String(raw ?? '').trim();
  if (!given) throw new Error('Say which channel: a link, a channel id, or a @handle.');
  if (given.startsWith('http')) {
    if (/[?&]list=/.test(given)) return given;
    const link = given.replace(/\/+$/, '');
    return LISTING_TABS.test(link) ? link : `${link}/videos`;
  }
  if (given.startsWith('UC') && given.length >= 24) return `https://www.youtube.com/channel/${given}/videos`;
  if (given.startsWith('@')) return `https://www.youtube.com/${given}/videos`;
  return `https://www.youtube.com/@${given}/videos`;
}

// yt-dlp --flat-playlist --dump-json prints one JSON object per line; a line that is not one, or has no id, is skipped.
export function readChannelListing(lines, watchBase = DEFAULT_WATCH_BASE) {
  let source = '';
  const items = [];
  for (const line of String(lines ?? '').split(/\r?\n/)) {
    let record;
    try { record = JSON.parse(line.trim()); } catch { continue; }
    const id = record?.id;
    if (!id) continue;
    if (!source) source = record.playlist_channel || record.playlist_uploader || record.channel || record.uploader || 'Channel';
    items.push({
      item_id: id,
      title: record.title || '',
      duration: record.duration_string ? [record.duration_string] : [],
      published: String(record.upload_date || ''),
      view_count: Number.isFinite(record.view_count) ? record.view_count : null,
      url: `${watchBase}${id}`,
      description: String(record.description || '').slice(0, 500),
    });
  }
  return { source, items };
}

// ------------------------------------------------------------------------------------ public web search results

export function searchUrl(query) {
  const asked = String(query ?? '').trim();
  if (!asked || asked.length > MAX_QUERY_LENGTH) throw new Error(`Send query: 1 to ${MAX_QUERY_LENGTH} characters of what to search for.`);
  return `https://html.duckduckgo.com/html/?${new URLSearchParams({ q: asked })}`;
}

const markupText = value => squash(decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))));

// The result page of the search engine: each result's title, address and snippet, at most `limit`. Every item carries
// the address it cites. A result's address is the one the engine redirects to (its `uddg` value), never the engine's own.
export function readSearchResults(html, limit = MAX_SEARCH_RESULTS) {
  const body = String(html ?? '');
  const anchors = [...body.matchAll(/<a\b([^>]*\bclass=["'][^"']*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>/gi)];
  const items = [];
  for (let index = 0; index < anchors.length && items.length < limit; index++) {
    const href = anchors[index][1].match(/\bhref=["']([^"']+)["']/i);
    if (!href) continue;
    const written = markupText(href[1]);
    let parsed;
    try { parsed = new URL(written.startsWith('//') ? `https:${written}` : written, 'https://html.duckduckgo.com'); } catch { continue; }
    const url = parsed.searchParams.get('uddg') || parsed.href;
    if (!/^https?:\/\//i.test(url)) continue;
    const tailStart = anchors[index].index + anchors[index][0].length;
    const tailEnd = index + 1 < anchors.length ? anchors[index + 1].index : Math.min(body.length, tailStart + 12000);
    const snippet = body.slice(tailStart, tailEnd).match(/class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    items.push({
      item_id: Buffer.from(url).toString('base64url').slice(0, 24),
      title: markupText(anchors[index][2]) || url,
      url,
      description: markupText(snippet?.[1]),
      published: '',
      citation: { url, retrieved_via: 'DuckDuckGo HTML' },
    });
  }
  return { source: 'DuckDuckGo HTML', items };
}

// ------------------------------------------------------------------------------------------ a list saved in a file

const oneLine = value => squash(String(value ?? ''));

// A saved list as JSON: an array of rows, or an object holding rows under `sources`, `bookmarks`, `items`, `records`,
// `rows` or `data`. Each row becomes an item; a row with no id of its own gets one from its link or words.
export function readSavedList(text, limit = MAX_SAVED_ITEMS) {
  let parsed;
  try { parsed = JSON.parse(text || '{}'); } catch (problem) { throw new Error(`The file is not valid JSON: ${problem.message}`); }
  let rows = [];
  let family = 'Saved list';
  let container = '';
  let type = 'item';
  if (Array.isArray(parsed)) {
    rows = parsed;
    family = 'Saved array';
  } else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.sources)) {
      rows = parsed.sources;
      family = 'Source catalog';
      container = String(parsed.description || parsed.schema || '');
    } else if (Array.isArray(parsed.bookmarks)) {
      rows = parsed.bookmarks;
      family = `${parsed.mode || 'bookmarks'} capture`;
      container = String(parsed.refreshed_at || '');
      type = 'bookmark';
    } else {
      for (const key of ['items', 'records', 'rows', 'data']) {
        if (Array.isArray(parsed[key])) { rows = parsed[key]; family = key; break; }
      }
    }
  }
  const idOf = (row, index) => {
    const direct = row.item_id || row.id || row.slug || row.native_id;
    if (direct) return String(direct);
    const url = String(row.url || row.source_url || row.discovery_url || row.link || '');
    const status = url.match(/\/status(?:es)?\/(\d+)/);
    if (status) return `status:${status[1]}`;
    const words = url || oneLine(row.text) || oneLine(row.title) || oneLine(row.name);
    return words ? `saved:${Buffer.from(words).toString('base64url').slice(0, 32)}` : `saved:${family}:${index}`;
  };
  const items = [];
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') return;
    const words = oneLine(row.text || row.note || row.summary);
    const probeTitle = row.probe && typeof row.probe === 'object' ? oneLine(row.probe.title) : '';
    items.push({
      item_id: idOf(row, index),
      title: oneLine(row.title || row.name || row.savedTitle || row.label || probeTitle) || (words ? words.slice(0, 140) : 'Untitled source'),
      source_family: row.source_family || family,
      source_type: row.source_type || type,
      container_path: row.container_path || container,
      url: oneLine(row.url || row.source_url || row.discovery_url || row.link),
      published: oneLine(row.published || row.created_at || row.updated_at),
      description: oneLine(row.description || row.notes || row.snippet || words).slice(0, 700),
      license_status: oneLine(row.license_status || row.license || 'unknown') || 'unknown',
      lifecycle_status: oneLine(row.status || 'observed'),
    });
  });
  return { source: family, items: items.slice(0, limit) };
}

// ---------------------------------------------------------------------------------- a browser's sidebar of tabs

const SENSITIVE_URL = /(?:^|\/\/)(?:accounts|console|admin|dashboard|settings|billing)\.|\/(?:account|accounts|admin|dashboard|settings|billing|invoice|oauth|signin|login)\b|[?&](?:token|access_token|auth|session|password|api[_-]?key|sig|signature)=/i;

// The sidebar file of the Arc browser: pinned and current tabs of its default profile, with their folders. A tab whose
// address looks like an account, admin or sign-in page, or carries a token, is kept as "Private page" with no address,
// so the research never holds a credential. The file stores records and their ids as flat key, value, key, value lists.
export function readBrowserSidebar(text, limit = MAX_SAVED_ITEMS) {
  let root;
  try { root = JSON.parse(text || '{}'); } catch (problem) { throw new Error(`The file is not valid JSON: ${problem.message}`); }
  const containers = Array.isArray(root?.sidebar?.containers) ? root.sidebar.containers : [];
  const records = {};
  let space = null;
  for (const container of containers) {
    if (!container || !Array.isArray(container.items) || !Array.isArray(container.spaces)) continue;
    for (let i = 0; i < container.items.length; i += 2) {
      if (typeof container.items[i] === 'string') records[container.items[i]] = container.items[i + 1];
    }
    for (let i = 0; i < container.spaces.length; i += 2) {
      const candidate = container.spaces[i + 1];
      if (candidate && typeof candidate === 'object' && candidate.profile && typeof candidate.profile === 'object' && candidate.profile.default === true) {
        space = candidate;
        break;
      }
    }
    if (space) break;
  }
  if (!space) throw new Error('No default profile was found in the sidebar file.');
  const spaceTitle = String(space.title || 'Default profile');
  const isoFromSeconds = value => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const date = new Date(Math.round((seconds + 978307200) * 1000));
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
  };
  const items = [];
  const walk = (id, path, state, depth) => {
    if (depth > 12 || typeof id !== 'string') return;
    const row = records[id];
    if (!row || typeof row !== 'object') return;
    const data = row.data && typeof row.data === 'object' ? row.data : {};
    const childIds = Array.isArray(row.childrenIds) ? row.childrenIds.filter(value => typeof value === 'string') : [];
    if (data.list || childIds.length) {
      const title = String(row.title || 'Untitled folder').slice(0, 180);
      items.push({
        item_id: `tab:${row.id || id}`, title, source_family: 'Browser sidebar', source_type: 'folder', container_path: path.join(' / '),
        state, native_id: String(row.id || id), url: '', published: isoFromSeconds(row.createdAt), description: 'Folder', license_status: 'unknown',
      });
      for (const child of childIds) walk(child, path.concat([title]), state, depth + 1);
      return;
    }
    if (data.tab && typeof data.tab === 'object') {
      const address = String(data.tab.savedURL || '');
      const sensitive = SENSITIVE_URL.test(address);
      items.push({
        item_id: `tab:${row.id || id}`,
        title: sensitive ? 'Private page' : String(row.title || data.tab.savedTitle || 'Untitled tab').slice(0, 180),
        source_family: 'Browser sidebar', source_type: 'tab', container_path: path.join(' / '), state, native_id: String(row.id || id),
        url: sensitive ? '' : address, published: isoFromSeconds(row.createdAt),
        description: sensitive ? 'Address withheld; classification only' : 'Tab', license_status: 'unknown', sensitive,
      });
    }
  };
  const ids = Array.isArray(space.containerIDs) ? space.containerIDs : [];
  for (let i = 0; i < ids.length; i++) {
    const marker = ids[i];
    if (marker !== 'pinned' && marker !== 'unpinned') continue;
    const rootRow = records[ids[i + 1]];
    const children = Array.isArray(rootRow?.childrenIds) ? rootRow.childrenIds.filter(value => typeof value === 'string') : [];
    for (const child of children) walk(child, [spaceTitle, marker === 'pinned' ? 'Pinned' : 'Current'], marker, 1);
  }
  return { source: spaceTitle, items: items.slice(0, limit) };
}

// ------------------------------------------------------------------------------------------- a video's captions

// The words of a json3 caption file: every non-blank segment of every event, joined by single spaces.
export function readCaptionWords(json3Text) {
  let data;
  try { data = JSON.parse(json3Text); } catch { return ''; }
  const parts = [];
  for (const event of Array.isArray(data?.events) ? data.events : []) {
    for (const segment of Array.isArray(event?.segs) ? event.segs : []) {
      if (typeof segment?.utf8 === 'string' && segment.utf8.trim()) parts.push(segment.utf8);
    }
  }
  return squash(parts.join(' ').replace(/\n/g, ' '));
}

// The words of a WebVTT caption file: the text lines of every cue without their timings, ids or tags, and a line
// that only repeats the one before it (rolling captions say each line twice) once.
export function readVttWords(vtt) {
  const lines = String(vtt ?? '').split(/\r?\n/).map(line => line.trim());
  const words = [];
  lines.forEach((line, index) => {
    if (!line || line.includes('-->') || /^(WEBVTT|NOTE|STYLE|REGION|Kind:|Language:|X-TIMESTAMP-MAP)/.test(line)) return;
    if (lines.slice(index + 1).find(next => next)?.includes('-->')) return; // a cue id, not words
    const text = squash(decodeEntities(line.replace(/<[^>]*>/g, '')));
    if (text && text !== words.at(-1)) words.push(text);
  });
  return words.join(' ');
}

export const CAPTION_FORMATS = 'json3/vtt';

// The words of a caption file by its kind, from its name.
export function readCaptionFile(name, text) {
  return name.endsWith('.vtt') ? readVttWords(text) : readCaptionWords(text);
}

// The timed lines of a caption file by its kind, from its name: [[start second, words]], in order; a line a rolling
// caption repeats is kept once.
export function readCaptionLines(name, text) {
  return name.endsWith('.vtt') ? readVttLines(text) : readJson3Lines(text);
}

const seconds = milliseconds => Math.round(milliseconds) / 1000;

function readJson3Lines(json3Text) {
  let data;
  try { data = JSON.parse(json3Text); } catch { return []; }
  const lines = [];
  for (const event of Array.isArray(data?.events) ? data.events : []) {
    const words = squash((Array.isArray(event?.segs) ? event.segs : []).map(segment => (typeof segment?.utf8 === 'string' ? segment.utf8 : '')).join(''));
    if (words && words !== lines.at(-1)?.[1]) lines.push([seconds(Number(event.tStartMs) || 0), words]);
  }
  return lines;
}

function readVttLines(vtt) {
  const lines = [];
  let start = null;
  for (const raw of String(vtt ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const cue = line.match(/^((?:\d+:)?\d+:\d+(?:\.\d+)?)\s*-->/);
    if (cue) { start = seconds(cue[1].split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000); continue; }
    if (!line) { start = null; continue; }
    if (start === null) continue;
    const words = squash(decodeEntities(line.replace(/<[^>]*>/g, '')));
    if (words && words !== lines.at(-1)?.[1]) lines.push([start, words]);
  }
  return lines;
}

// Of the caption files a download left, the one in the original spoken language first, then the plain English one;
// of two in one language, the json3 one.
export function captionFileOrder(names) {
  const language = name => (name.includes('en-orig') ? 0 : name.includes('.en.') ? 1 : 2);
  const kind = name => (name.endsWith('.json3') ? 0 : 1);
  return names.filter(name => name.endsWith('.json3') || name.endsWith('.vtt'))
    .sort((a, b) => language(a) - language(b) || kind(a) - kind(b) || a.localeCompare(b));
}
