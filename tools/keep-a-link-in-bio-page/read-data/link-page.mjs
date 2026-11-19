// src/link-page.mjs
//
// Purpose: a person's link-in-bio page, as values. The page record and its visit and open rows are the person's own
// rows in their own store (workflow:keep-a-link-in-bio-page keeps and counts them); this module reads those values,
// decides what a change, a visit or an open does, and says what the host must write. It holds no store and no engine.
//
//   GET  /link-page     makeLinkPage({ page, counts, posts, ... }).read()
//   POST /link-page     .change(input) answers the steps the host runs, in order, and the page after them
//
// Non-Negotiable Invariants:
//   1. Nothing here names a place, a platform or a kind of post: places are whatever the address says (`place_param`),
//      posts are read from the caller's posts, and every word and tag is src/link-page.json.
//   2. A page that is off is shown to nobody and its public code points nowhere; the code is kept, so the address in
//      someone's bio works again the moment they turn it back on.
//   3. The public side learns only the page: titles, labels and post words the person published. Counts, the record
//      and anything else of the person's never leave through it.
//   4. Counts are rows of what, item, place and day. Totals and the recent window are sums over those rows.
//   5. Only https addresses are ever listed or opened, and an open goes only to an address the page itself lists.
//   6. A name is only a readable alias (`names`, the unique-name authority, is supplied by the host); the store id is
//      the only key. Changing the name releases the old one.
//
// Key Concepts: the page { on, title, about, links: [{ link_id, label, url }], code, pending_code };
//   an item is a link_id or a post_id; a place is a plain word such as a platform's name.
//
// Ordering for the host: change() returns `steps`, run in order. A `keep` step writes the page value. A `kv_put` step
//   makes the public code point at the store, and comes after the `keep` step that holds the pending code, so a retry
//   finds the same code. A `kv_delete` step comes after the `keep` that turns the page off.
//
// Security: the code is 20 random hex characters, unrelated to the person's id and to their progress share code.

export class LinkPageError extends Error {}

const CODE = /^[0-9a-f]{20}$/;
const PLACE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ITEM = /^[A-Za-z0-9:_-]{1,120}$/;
const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const https = value => typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:' && !new URL(value).username && !new URL(value).password;
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const DAY_MS = 86400000;

/** The place a visit came from: the address's own word when it is a plain one, else the settings' unknown place. */
export const placeOf = (value, settings) => {
  const word = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PLACE.test(word) ? word : settings.unknown_place;
};
export const isLinkPageCode = code => CODE.test(code);

/** The address an open leaves with: the item's address with the settings' tags set from the place and the item. */
export function taggedAddress(address, { place, item }, settings) {
  const url = new URL(address);
  const from = { place, item };
  for (const tag of settings.link_tags) url.searchParams.set(tag.param, tag.value ?? from[tag.from] ?? '');
  return url.href;
}

// The page change committed with the command's receipt; its answer is read() after it.
export const LINK_PAGE_RECEIPTED_WRITES = Object.freeze(['link-page:change']);

/** The page's address for its code, its name and each place it is shown from. */
export function pageAddresses({ origin, page, settings, places = [] }) {
  const record = pageOf(page);
  const codeAddress = record.on && record.code ? `${origin()}/l/${record.code}` : null;
  const base = codeAddress && record.name ? `${origin()}/l/${record.name}` : codeAddress;
  return {
    address: base,
    code_address: codeAddress,
    addresses_by_place: base ? Object.fromEntries(places.map(place => [place, `${base}?${settings.place_param}=${encodeURIComponent(place)}`])) : {},
    address_for_a_place: base ? `${base}?${settings.place_param}=<place>` : null,
  };
}

// The page as stored, with every field present.
function pageOf(value) {
  const kept = value ?? {};
  return { on: false, title: null, about: null, ...kept, links: Array.isArray(kept.links) ? kept.links : [] };
}

/** The shown posts: published ones carrying an https link, newest first, as the settings allow. */
export function shownPosts(posts, settings) {
  return posts
    .filter(post => settings.post_statuses.includes(post.status) && https(post.link))
    .slice(0, settings.max_posts)
    .map(post => ({
      post_id: post.post_id,
      words: (post.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, settings.caption_characters) || settings.words.post_without_words,
      url: post.link,
      places: [...new Set((post.destinations ?? []).map(destination => destination.platform).filter(Boolean))],
      published_at: post.approved_at ?? post.updated_at ?? null,
    }));
}

/** Totals and the recent window for every item and place, from the count rows (one per what, item, place and day). */
export function countsOf({ record, rows, settings, now, known }) {
  const since = new Date(now().getTime() - settings.recent_days * DAY_MS).toISOString().slice(0, 10);
  const totals = new Map();
  for (const row of rows) {
    const key = `${row.what}\u0000${row.item}\u0000${row.place}`;
    const entry = totals.get(key) ?? { what: row.what, item: row.item, place: row.place, total: 0, recent: 0 };
    entry.total += Number(row.count);
    if (row.day >= since) entry.recent += Number(row.count);
    totals.set(key, entry);
  }
  const byItem = new Map();
  const byPlace = {};
  for (const row of totals.values()) {
    const place = byPlace[row.place] ?? (byPlace[row.place] = { visits: 0, opens: 0 });
    place[row.what === 'view' ? 'visits' : 'opens'] += row.total;
    if (row.what !== 'open') continue;
    const entry = byItem.get(row.item) ?? { item: row.item, label: known.get(row.item)?.label ?? null, still_shown: known.has(row.item), opens: 0, recent: 0, by_place: {} };
    entry.opens += row.total;
    entry.recent += row.recent;
    entry.by_place[row.place] = (entry.by_place[row.place] ?? 0) + row.total;
    byItem.set(row.item, entry);
  }
  const sum = what => [...totals.values()].filter(row => row.what === what).reduce((acc, row) => ({ total: acc.total + row.total, recent: acc.recent + row.recent }), { total: 0, recent: 0 });
  const views = sum('view');
  const opens = sum('open');
  return { recent_days: settings.recent_days, visits: views.total, visits_recent: views.recent, opens: opens.total, opens_recent: opens.recent,
    by_place: byPlace, by_item: [...byItem.values()].sort((a, b) => b.opens - a.opens) };
}

/**
 * The owner, as values. `page` is the stored page (or null); `counts` its count rows; `posts` the person's posts as
 * src/social-posts.mjs lists them. `names` is the unique-name authority (claim, point, release) when the host has one.
 */
export function makeLinkPage({ page = null, counts = [], posts = [], settings, origin, names = null, namesWords, now = () => new Date(), random = n => crypto.getRandomValues(new Uint8Array(n)) }) {
  const record = pageOf(page);
  const shown = () => shownPosts(posts, settings);

  // Every item the page can open, by its id.
  const items = () => new Map([
    ...record.links.map(link => [link.link_id, { label: link.label, url: link.url }]),
    ...shown().map(post => [post.post_id, { label: post.words, url: post.url }]),
  ]);

  /** The page as its owner reads it. */
  function read() {
    const shownNow = shown();
    const counted = countsOf({ record, rows: counts, settings, now, known: items() });
    const places = [...new Set([...shownNow.flatMap(post => post.places), ...Object.keys(counted.by_place).filter(place => place !== settings.unknown_place)])];
    const addresses = pageAddresses({ origin, page: record, settings, places });
    return {
      on: Boolean(record.on),
      ...addresses,
      name: record.name ?? null,
      title: record.title ?? null,
      about: record.about ?? null,
      links: record.links,
      posts: shownNow,
      counts: counted,
      said: record.on ? `Your page is at ${addresses.address}. Put it in your bio; add ?${settings.place_param}=<place> for each place so its visits are counted apart.` : 'Your page is off. Turn it on to get its address.',
    };
  }

  function linkRow(link, index) {
    const label = text(link?.label, settings.max_label_characters);
    const url = text(link?.url, 2000);
    if (!label) throw new LinkPageError(`Link ${index + 1} needs a label: the words people see.`);
    if (!https(url)) throw new LinkPageError(`Link ${index + 1} needs a full https address, like https://example.com/page.`);
    const id = typeof link.link_id === 'string' && ITEM.test(link.link_id) ? link.link_id : `link-${hex(random(6))}`;
    return { link_id: id, label, url };
  }

  /**
   * Changes the page. Answers { page, steps }: the page to keep, and the steps the host runs in order (see the header).
   * Name claims run here, through the host's authority, before any step is answered.
   */
  async function change(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LinkPageError('Give the changes as an object: on, name, title, about, links, add_link or remove_link.');
    const earlier = record;
    const next = { ...earlier, links: [...earlier.links] };
    if (input.title !== undefined) next.title = text(input.title, settings.max_title_characters);
    if (input.about !== undefined) next.about = text(input.about, settings.max_about_characters);
    if (input.links !== undefined) {
      if (!Array.isArray(input.links)) throw new LinkPageError('links is the whole list of links: each { label, url }.');
      next.links = input.links.map(linkRow);
    }
    if (input.add_link !== undefined) next.links.push(linkRow(input.add_link, next.links.length));
    if (input.remove_link !== undefined) {
      const kept = next.links.filter(link => link.link_id !== input.remove_link);
      if (kept.length === next.links.length) throw new LinkPageError(`There is no link ${input.remove_link} on the page.`);
      next.links = kept;
    }
    if (new Set(next.links.map(link => link.link_id)).size !== next.links.length) throw new LinkPageError('Two links have the same link_id.');
    if (next.links.length > settings.max_links) throw new LinkPageError(`A page holds at most ${settings.max_links} links.`);
    if (input.on !== undefined) next.on = input.on === true;
    else if (!earlier.code && (input.links !== undefined || input.add_link !== undefined)) next.on = true;
    // The first code is made before anything points at it, and reused by a change asked again.
    if (next.on && !next.code) next.code = earlier.pending_code ?? hex(random(10));
    delete next.pending_code;
    const pointsAt = next.on ? next.code : null;
    if (input.name !== undefined) {
      if (!names) throw new LinkPageError(namesWords?.not_here ?? 'Names are not available here.');
      try { next.name = input.name === null || input.name === '' ? null : await names.claim(input.name, pointsAt); }
      catch (error) { throw new LinkPageError(error.message); }
    } else if (next.name && next.on !== Boolean(earlier.on)) await names?.point(next.name, pointsAt);
    const steps = [];
    // The pending code is kept before the pointer; the page itself is kept with its on state after the pointer moves.
    if (next.on && !earlier.code) steps.push({ keep: { ...next, on: false, code: null, pending_code: next.code } });
    if (next.on && !earlier.on) steps.push({ kv_put: `${settings.kv_prefix}${next.code}` });
    steps.push({ keep: next });
    if (!next.on && earlier.on && earlier.code) steps.push({ kv_delete: `${settings.kv_prefix}${earlier.code}` });
    if (earlier.name && earlier.name !== next.name) await names?.release(earlier.name);
    return { page: next, steps };
  }

  /** A visit: the page as a visitor sees it, and the count row to keep (null when `counted` is false). null when off. */
  function visit(place, { counted = true } = {}) {
    if (!record.on) return null;
    return {
      view: {
        code: record.code, name: record.name ?? null, title: record.title ?? null, about: record.about ?? null,
        links: record.links.map(link => ({ item: link.link_id, label: link.label })),
        posts: shown().map(post => ({ item: post.post_id, label: post.words })),
      },
      count: counted ? { what: 'view', item: '', place, day: now().toISOString().slice(0, 10) } : null,
    };
  }

  /** An open: the tagged address and the count row to keep; null when the page does not list the item. */
  function open(item, place, { counted = true } = {}) {
    if (!record.on || typeof item !== 'string' || !ITEM.test(item)) return null;
    const found = items().get(item);
    if (!found) return null;
    return {
      url: taggedAddress(found.url, { place, item }, settings),
      count: counted ? { what: 'open', item, place, day: now().toISOString().slice(0, 10) } : null,
    };
  }

  return { read, change, visit, open };
}

export async function handleLinkPageRequest(owner, request, { failureOf }) {
  try {
    if (request.method === 'GET') return Response.json(owner.read());
    if (request.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 });
    const raw = await request.text();
    if (raw.length > 100_000) throw new LinkPageError('Request too large');
    return Response.json(await owner.change(JSON.parse(raw || '{}')));
  } catch (error) {
    // Busy, interrupted or out-of-budget is the shared HTTP failure owner's to answer, never a refusal here.
    if (failureOf(error).tries_again_later) throw error;
    const known = error instanceof LinkPageError || error instanceof SyntaxError;
    return Response.json({ error: error.message }, { status: known ? 400 : 500 });
  }
}
