// src/link-page-screen.mjs
//
// PURPOSE
//   The Link in bio screen's facts, opened from its Workshop tool (records/workshop-publishing-tool-records.json
//   tool:link-in-bio, screen app-entry `guide` { screen: "link-page" }): the page on or off, its address for each place,
//   its title and line, the person's own links, the posts it lists, and what people opened, by item and by place. The
//   Marketplace screen tool:link-page (records/marketplace-screens.json) draws them from tool:read-link-page, the
//   account action read-link-page, which answers `linkPageFacts` over src/link-page.mjs read(), the same answer
//   read_link_page gives their AI. Its buttons send /work/api/link-page/change, turned into the owner's changes by
//   `screenChange`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only real facts: every address, link, post and count is the owner's answer; an empty list says so.
//   2. Every word is src/link-page.json `words` (carried in the facts as `words`) or the person's own; the layout
//      writes none of its own.

import settings from './link-page.json' with { type: 'json' };

const { words } = settings;

/** The owner's change a screen button asks for (`body` as the guide sends it, with `values` when it has boxes). */
export function screenChange(body = {}) {
  const values = body.values && typeof body.values === 'object' ? body.values : {};
  const changes = {
    on: () => ({ on: body.on === true }),
    name: () => ({ name: String(values.value ?? '').trim() || null }),
    release_name: () => ({ name: null }),
    title: () => ({ title: String(values.value ?? '') }),
    about: () => ({ about: String(values.value ?? '') }),
    add: () => ({ add_link: { label: values.label, url: values.url } }),
    remove: () => ({ remove_link: String(body.link_id ?? '') }),
  };
  const make = changes[body.change];
  if (!make) throw new Error('This change is not one the page makes.');
  return make();
}

const byCountThenOrder = byPlace => Object.entries(byPlace).sort((a, b) => b[1] - a[1]).map(([place, count]) => ({ place, count }));

/**
 * The Link in bio screen's facts from src/link-page.mjs read(): whether the page is on, its address, name, title and
 * line, one address for each place (addresses, the first the page's own, place null), the person's links, the posts it
 * lists, the counts (opens by item with its places most-opened first, and visits and opens by place), and the words
 * (src/link-page.json). Each row carries the id it is drawn with.
 */
export function linkPageFacts(state) {
  const { counts } = state;
  return {
    on: Boolean(state.on),
    address: state.address ?? null,
    name: state.name || null,
    title: state.title ?? null,
    about: state.about || null,
    addresses: state.address ? [{ id: 'address-any', place: null, address: state.address },
      ...Object.entries(state.addresses_by_place).map(([place, address]) => ({ id: `address-${place || 'any'}`, place: place || null, address }))] : [],
    links: state.links.map(link => ({ link_id: link.link_id, label: link.label, url: link.url })),
    no_links: !state.links.length,
    posts: state.posts.map(post => ({ id: post.post_id, words: post.words, places: post.places.join(', ') || null, url: post.url || null })),
    no_posts: !state.posts.length,
    counts: {
      recent_days: counts.recent_days, visits: counts.visits, visits_recent: counts.visits_recent, opens: counts.opens, opens_recent: counts.opens_recent,
      counted: Boolean(counts.visits || counts.opens),
      by_item: counts.by_item.map(entry => ({ id: `opened-${entry.item}`, title: entry.label ?? entry.item, opens: entry.opens, recent: entry.recent, places: byCountThenOrder(entry.by_place) })),
      by_place: Object.entries(counts.by_place).map(([place, row]) => ({ id: `place-${place}`, place, visits: row.visits, opens: row.opens })),
    },
    words,
  };
}

const PATH = '/work/api/link-page/change';

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));

const placeLines = byPlace => Object.entries(byPlace).sort((a, b) => b[1] - a[1]).map(([place, count]) => fill(words.place_line, { place, count })).join(' · ');

/** The screen. state: src/link-page.mjs read(). */
export function linkPageScreen(state) {
  const title = state.title ?? words.default_title;
  const addresses = state.address ? [['', state.address], ...Object.entries(state.addresses_by_place)] : [];
  const { counts } = state;
  return {
    title: words.screen_title,
    lead: words.screen_lead,
    sections: [
      {
        heading: words.address_heading,
        body: state.on ? words.address_body : words.screen_off,
        actions: [
          { label: words.switch_label, switch: { on: state.on }, send: { path: PATH, body: { change: 'on', on: !state.on } } },
          ...(state.address ? [{ label: words.open_page, tone: 'quiet', href: state.address }] : []),
          { label: words.name_label, tone: 'quiet', send: { path: PATH, body: { change: 'name' }, with_fields: true, ask: { name: 'value', label: words.name_label, value: state.name ?? '' } } },
          ...(state.name ? [{ label: words.release_name, tone: 'quiet', send: { path: PATH, body: { change: 'release_name' }, confirm: words.release_name_confirm } }] : []),
        ],
        rows: addresses.map(([place, address]) => ({ id: `address-${place || 'any'}`, title: place || title, detail: address, actions: [{ label: words.copy, tone: 'quiet', copy: address }] })),
      },
      {
        heading: title,
        ...(state.about ? { body: state.about } : {}),
        actions: [
          { label: words.title_label, tone: 'quiet', send: { path: PATH, body: { change: 'title' }, with_fields: true, ask: { name: 'value', label: words.title_label, value: state.title ?? '' } } },
          { label: words.about_label, tone: 'quiet', send: { path: PATH, body: { change: 'about' }, with_fields: true, ask: { name: 'value', label: words.about_label, value: state.about ?? '' } } },
        ],
      },
      {
        heading: words.links_heading,
        body: words.links_lead,
        rows: [
          ...state.links.map(link => ({
            id: link.link_id, title: link.label, detail: link.url,
            actions: [{ label: words.remove, tone: 'quiet', send: { path: PATH, body: { change: 'remove', link_id: link.link_id }, confirm: words.remove_confirm } }],
          })),
          {
            id: 'add-a-link', title: words.add_heading, starts_open: !state.links.length, open_label: words.add,
            ...(state.links.length ? {} : { detail: words.no_links }),
            fields: [{ name: 'label', label: words.label_label, placeholder: '' }, { name: 'url', label: words.url_label, placeholder: 'https://' }],
            actions: [{ label: words.add, tone: 'primary', send: { path: PATH, body: { change: 'add' }, with_fields: true } }],
          },
        ],
      },
      {
        heading: words.posts_heading,
        body: words.posts_lead,
        rows: state.posts.map(post => ({ id: post.post_id, title: post.words, detail: [post.places.join(', '), post.url].filter(Boolean).join(' · '), actions: [{ label: words.open_page, tone: 'quiet', href: post.url }] })),
        ...(state.posts.length ? {} : { note: words.no_posts }),
      },
      {
        heading: words.counts_heading,
        body: words.counts_lead,
        stats: [
          { id: 'visits', label: words.views, value: String(counts.visits), detail: `${fill(words.recent, { days: counts.recent_days })}: ${counts.visits_recent}` },
          { id: 'opens', label: words.clicks, value: String(counts.opens), detail: `${fill(words.recent, { days: counts.recent_days })}: ${counts.opens_recent}` },
        ],
        rows: [
          ...counts.by_item.map(entry => ({ id: `opened-${entry.item}`, title: entry.label ?? entry.item, detail: [fill(words.count_line, { clicks: entry.opens, recent: entry.recent, days: counts.recent_days }), placeLines(entry.by_place)].join(' · ') })),
          ...Object.entries(counts.by_place).map(([place, row]) => ({ id: `place-${place}`, title: place, detail: `${words.views}: ${row.visits} · ${words.clicks}: ${row.opens}` })),
        ],
        ...(counts.visits || counts.opens ? {} : { note: words.no_counts }),
      },
    ],
  };
}
