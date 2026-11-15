// src/link-page.mjs
//
// Purpose: a person's link-in-bio page. One public address (/l/<code>, drawn by src/link-page-pages.mjs) lists the
// links they chose and their published posts that carry a link. Every visit and every open is counted by where the
// visitor came from (the `from` place the address carries) and by what was opened, and each open leaves tagged with
// the same two facts, so a sign-up that came through the page says which post or link and which place. The choices are
// one record in the person's store; the counts are one small table beside it.
//
//   GET  /link-page     the page as the person and their AI read it: on, address, addresses by place, name, title,
//                       about, links, the posts shown, and the counts
//   POST /link-page     { on?, name?, title?, about?, links?, add_link?, remove_link? } changes it, answers the same;
//                       name claims the person's optional unique public name (null releases it)
//
// Non-Negotiable Invariants:
//   1. Nothing here names a place, a platform or a kind of post: places are whatever the address says (`place_param`),
//      posts are read from src/social-posts.mjs, and every word and tag is src/link-page.json.
//   2. A page that is off is not shown to anyone and its public code points nowhere; the code itself is kept, so the
//      address in someone's bio works again the moment they turn it back on.
//   3. The public side learns only the page: titles, labels and post words the person published. Counts, the record
//      and anything else of the person's never leave through it.
//   4. A count is one row per what, item, place and day, raised by one (and its total, kept beside it, so reading the page never adds up every day); a visit never rewrites the person's record.
//   5. Only https addresses are ever listed or opened, and an open goes only to an address the page itself lists.
//   6. A name (src/person-names.mjs makePersonNames) is only a readable alias: the page's address reads /l/<name> while
//      the person holds one, and /l/<code> keeps working; the store id stays the only key. Changing it releases the old.
//
// Key Concepts: the record { on, title, about, links: [{ link_id, label, url }], code }; an item is a link_id or a
//   post_id; a place is a plain word such as a platform's name.
//
// Security: the code is 20 random hex characters, unrelated to the person's id and to their progress share code, so a
//   bio address cannot be joined to anything else they share.
//

import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

export class LinkPageError extends Error {}

const CODE = /^[0-9a-f]{20}$/;
const PLACE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ITEM = /^[A-Za-z0-9:_-]{1,120}$/;
const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const https = value => typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:' && !new URL(value).username && !new URL(value).password;
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

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

/** The counts' table, made once when the store opens (a table made on every read would tell the open screen that
 *  something changed each time it read, and it would read again). */
// A day's count is kept in link_page_counts (what, item, place, day); the sum over every day of one (what, item, place) is
// kept beside it in link_page_totals, moved by the same statement pair that counts, so a read of the totals is one row
// for each thing counted and never one for each day it was counted. Totals counted before the table existed are taken in
// once, when it is first empty.
// The page change committed with the command's receipt; its answer is read() after it.
export const LINK_PAGE_RECEIPTED_WRITES = Object.freeze(['link-page:change']);

export function createLinkPageTable(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS link_page_counts (what TEXT NOT NULL, item TEXT NOT NULL, place TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (what, item, place, day))');
  sql.exec('CREATE INDEX IF NOT EXISTS link_page_counts_by_day ON link_page_counts (day)');
  sql.exec('CREATE TABLE IF NOT EXISTS link_page_totals (what TEXT NOT NULL, item TEXT NOT NULL, place TEXT NOT NULL, total INTEGER NOT NULL, PRIMARY KEY (what, item, place))');
  // Taken in only when there is something to take: a start that finds both empty writes nothing (a fenced store opens).
  if (!sql.exec('SELECT 1 AS held FROM link_page_totals LIMIT 1').toArray().length && sql.exec('SELECT 1 AS held FROM link_page_counts LIMIT 1').toArray().length) {
    sql.exec('INSERT INTO link_page_totals (what, item, place, total) SELECT what, item, place, SUM(count) FROM link_page_counts GROUP BY what, item, place');
  }
}

/**
 * The owner. `sql` answers `exec(query, ...binds)` (a Durable Object's storage.sql) and holds createLinkPageTable's table; `eeaf` is the person's record
 * store; `posts()` is their posts as src/social-posts.mjs lists them; `kv` is where a public code finds this store;
 * `storeId` is this store's own id; `origin` is the service's public address.
 */
export function makeLinkPage({ sql, eeaf, settings, posts, kv, storeId, origin, names = null, namesWords, commit = change => change(), now = () => new Date(), random = n => crypto.getRandomValues(new Uint8Array(n)) }) {
  const recordOf = () => { const kept = eeaf.read(settings.record_id) ?? {}; return { on: false, title: null, about: null, ...kept, links: Array.isArray(kept.links) ? kept.links : [] }; };
  const keep = async value => { await eeaf.write([{ id: settings.record_id, type: settings.record_type, value }]); return value; };
  const address = code => `${origin()}/l/${code}`;
  const count = (what, item, place) => {
    sql.exec(
      'INSERT INTO link_page_counts (what, item, place, day, count) VALUES (?, ?, ?, ?, 1) ON CONFLICT (what, item, place, day) DO UPDATE SET count = count + 1',
      what, item, place, now().toISOString().slice(0, 10),
    );
    sql.exec('INSERT INTO link_page_totals (what, item, place, total) VALUES (?, ?, ?, 1) ON CONFLICT (what, item, place) DO UPDATE SET total = total + 1', what, item, place);
  };

  // The posts the page lists: published ones carrying a link, newest first.
  function shownPosts() {
    return posts()
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

  // Every item the page can open, by its id.
  const items = record => new Map([
    ...record.links.map(link => [link.link_id, { label: link.label, url: link.url }]),
    ...shownPosts().map(post => [post.post_id, { label: post.words, url: post.url }]),
  ]);

  function counts(record) {
    const since = new Date(now().getTime() - settings.recent_days * 86400000).toISOString().slice(0, 10);
    // reads-ok: the totals are one row for each thing counted (a link or a place), and only the recent days are read, through the day index.
    const recently = new Map(sql.exec('SELECT what, item, place, SUM(count) AS recent FROM link_page_counts WHERE day >= ? GROUP BY what, item, place', since).toArray()
      .map(row => [`${row.what}\u0000${row.item}\u0000${row.place}`, row.recent]));
    const rows = sql.exec('SELECT what, item, place, total FROM link_page_totals').toArray()
      .map(row => ({ ...row, recent: recently.get(`${row.what}\u0000${row.item}\u0000${row.place}`) ?? 0 }));
    const known = items(record);
    const byItem = new Map();
    const byPlace = {};
    const sum = what => rows.filter(row => row.what === what).reduce((total, row) => ({ total: total.total + Number(row.total), recent: total.recent + Number(row.recent) }), { total: 0, recent: 0 });
    for (const row of rows) {
      const place = byPlace[row.place] ?? (byPlace[row.place] = { visits: 0, opens: 0 });
      place[row.what === 'view' ? 'visits' : 'opens'] += Number(row.total);
      if (row.what !== 'open') continue;
      const entry = byItem.get(row.item) ?? { item: row.item, label: known.get(row.item)?.label ?? null, still_shown: known.has(row.item), opens: 0, recent: 0, by_place: {} };
      entry.opens += Number(row.total);
      entry.recent += Number(row.recent);
      entry.by_place[row.place] = (entry.by_place[row.place] ?? 0) + Number(row.total);
      byItem.set(row.item, entry);
    }
    const views = sum('view');
    const opens = sum('open');
    return { recent_days: settings.recent_days, visits: views.total, visits_recent: views.recent, opens: opens.total, opens_recent: opens.recent,
      by_place: byPlace, by_item: [...byItem.values()].sort((a, b) => b.opens - a.opens) };
  }

  /** The page as its owner reads it. */
  function read() {
    const record = recordOf();
    const shown = shownPosts();
    const counted = counts(record);
    const places = [...new Set([...shown.flatMap(post => post.places), ...Object.keys(counted.by_place).filter(place => place !== settings.unknown_place)])];
    const codeAddress = record.on && record.code ? address(record.code) : null;
    const base = codeAddress && record.name ? address(record.name) : codeAddress;
    return {
      on: Boolean(record.on),
      address: base,
      code_address: codeAddress,
      name: record.name ?? null,
      addresses_by_place: base ? Object.fromEntries(places.map(place => [place, `${base}?${settings.place_param}=${encodeURIComponent(place)}`])) : {},
      address_for_a_place: base ? `${base}?${settings.place_param}=<place>` : null,
      title: record.title ?? null,
      about: record.about ?? null,
      links: record.links,
      posts: shown,
      counts: counted,
      said: record.on ? `Your page is at ${base}. Put it in your bio; add ?${settings.place_param}=<place> for each place so its visits are counted apart.` : 'Your page is off. Turn it on to get its address.',
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

  /** Changes the page, then answers what read() answers. Turning it on makes its code the first time. */
  async function change(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LinkPageError('Give the changes as an object: on, name, title, about, links, add_link or remove_link.');
    const earlier = recordOf();
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
    // A page's first code is kept (as pending_code, until the page itself is kept) before anything points at it, so a
    // change asked again reuses it, never leaving a second code pointing here.
    if (next.on && !next.code) next.code = earlier.pending_code ?? (await keep({ ...earlier, pending_code: hex(random(10)) })).pending_code;
    delete next.pending_code;
    // The name is claimed before the page is kept, so a page never names what its person does not hold; the name points
    // at the code only while the page is on (invariant 2).
    const pointsAt = next.on ? next.code : null;
    if (input.name !== undefined) {
      if (!names) throw new LinkPageError(namesWords.not_here);
      try { next.name = input.name === null || input.name === '' ? null : await names.claim(input.name, pointsAt); }
      catch (error) { throw new LinkPageError(error.message); }
    } else if (next.name && next.on !== Boolean(earlier.on)) await names?.point(next.name, pointsAt);
    // The public code points at this store only while the page is on (invariant 2): pointed before the page is kept on,
    // and pointed nowhere after it is kept off (a page that is off shows nothing whatever its code points at). The page
    // itself is kept through `commit` (LINK_PAGE_RECEIPTED_WRITES), and the answer read after it.
    if (next.on && !earlier.on) await kv.put(`${settings.kv_prefix}${next.code}`, storeId);
    await commit(() => keep(next), { operation: 'link-page:change' });
    if (!next.on && earlier.on && earlier.code) await kv.delete(`${settings.kv_prefix}${earlier.code}`);
    if (earlier.name && earlier.name !== next.name) await names?.release(earlier.name);
    return read();
  }

  /** The page as a visitor sees it, counted as one visit from `place` unless `counted` is false (a link checker's
   *  look); null when it is off (invariant 3). */
  function visit(place, { counted = true } = {}) {
    const record = recordOf();
    if (!record.on) return null;
    if (counted) count('view', '', place);
    return {
      code: record.code, name: record.name ?? null, title: record.title ?? null, about: record.about ?? null,
      links: record.links.map(link => ({ item: link.link_id, label: link.label })),
      posts: shownPosts().map(post => ({ item: post.post_id, label: post.words })),
    };
  }

  /** Where one open goes, counted as one open of `item` from `place` unless `counted` is false; null when the page
   *  does not list it. */
  function open(item, place, { counted = true } = {}) {
    const record = recordOf();
    if (!record.on || typeof item !== 'string' || !ITEM.test(item)) return null;
    const found = items(record).get(item);
    if (!found) return null;
    if (counted) count('open', item, place);
    return taggedAddress(found.url, { place, item }, settings);
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

/**
 * The page choices through the selected account's existing records door. Count SQL, public-code lookup and unique
 * names remain explicit host facilities; this bridge neither claims a name locally nor starts a storage engine.
 * Make a fresh owner for each serialized host request, so visits observe the latest on/off state.
 */
export async function linkPageOverDoor({ door, ...host }) {
  const { record_type: type, record_id: id } = host.settings;
  const read = await door.readRecord(type, id);
  let snapshot = read ? { type: read.type, value: structuredClone(read.value) } : null;
  const eeaf = {
    read(asked) {
      if (asked !== id) throw new Error('The link page may read only its declared record.');
      return structuredClone(snapshot?.value ?? null);
    },
    async write(rows) {
      if (rows.length !== 1 || rows[0].id !== id || rows[0].type !== type) throw new Error('The link page may write only its declared record.');
      const value = structuredClone(rows[0].value);
      const writes = [{ id, type, value, expected: snapshot }];
      await door.write(writes, { key: `link-page:${makeHashCodeHexFromJson(writes)}` });
      snapshot = { type, value };
    },
  };
  return makeLinkPage({ ...host, eeaf });
}
