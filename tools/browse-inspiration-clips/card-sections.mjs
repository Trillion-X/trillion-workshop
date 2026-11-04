// src/card-sections.mjs
//
// Purpose
//   Named rows of cards read from named sources: each source is read once, a row keeps the items its tests pass, and
//   each kept item becomes one card (an id, a title, the words under it, when it happened, what pressing it opens, and
//   the words its action says). Which rows exist, where each reads, how a card reads, what the answer carries along
//   and the sentence that sums it up are all DATA, handed in as `config`. Inspiration (src/inspiration.json, what is
//   worth making from) and Waiting on you (src/waiting-on-you.json, what only the person can do) are two of them.
//
// Non-negotiable invariants
//   1. Real records only: every card is an item a source answered. A row with no cards is still listed, empty, so a
//      screen can leave it out; a source that failed marks only its own rows failed.
//   2. Each source is read once however many rows read it.
//   3. Nothing here names a source, a row, a field or a word shown: they are keys, paths and templates in the DATA.
//   4. A row's `distinct` path keeps the first item for each value there, so one thing seen many times is one card.
//   5. A card's `address` is where it opens as a web address: its own link when the item has one, otherwise the
//      source's `address` template filled from the item's fields, made whole with the caller's origin, so a card can be
//      followed from anywhere (a chat, an email), not only inside Trillion.
//   6. Every other key a row carries (beyond id, title, subtitle, read, limit, action) is handed through on the row, so
//      a screen can read its own settings from the same DATA without this file knowing them.
//   7. A source with `done_by_opening` is done with once the person opens one of its cards: its cards carry
//      `done_by_opening`, and a card whose id is in the caller's `done` set is left out before the row's limit.
//   8. A source's `opens` and `address` read the item's fields plus `card_id`, the card's own id, so a source whose
//      things are finished in the waiting queue itself (an unnamed voice: its clip and a name box) opens the queue on
//      that card rather than on some screen near it.
//   9. A source with `done_facts` is done where its item is kept, when every one of those facts holds on the item (any
//      case; doneByFacts). With `done_when_connected` too, an item whose value at that path names a service the person
//      has connected is done by itself (doneOnceConnected names them; the caller sets their done facts where they live).
//  10. A row's `read.unless_any` { group: { by, before? }, where } leaves out every item whose group (the value at `by`,
//      cut at `before`) holds an item passing `where`: a connection need is met when ANY account of its service is
//      connected, so a disconnected duplicate account (`x:account`) of a connected service (`x:account-2`) asks nothing.
//      Evaluated on every read, so the guard on notices (which reads the same row) agrees.
//  11. A source's opens.in_place draws its own current action surface at the exact item's address. Its completion
//      stays with that source; opening or dismissing the surface is never evidence that its work is finished.
//
// Key concepts
//   config  { sources: { <name>: { items, title?, subtitle?, card, opens: { link? | screen, input?, address? } (screen and
//                                   input may be paths read from each item, and `card_id` names the card's own id),
//                                   edit?, action?, done_by_opening? } },
//             sections: [{ id, title, subtitle?, read: { from, where?, newest?, distinct? }, limit?, action?, ... }],
//             carried?: [config key], said: { some, none, row, joiner? } }
//   value   a path list ([["values", "what"]], the first path holding a value wins) or { "value": <fixed value> }
//   card    { id, source, section, title?, detail?, at?, opens: { screen, input } | { link }, address?, action?, edit?,
//             done_by_opening? }
//   options { origin: the web origin addresses are made whole with, done: card ids the person is done with }
//

const at = (value, path) => path.reduce((held, key) => (held === null || held === undefined ? undefined : held[key]), value);
const present = value => value !== undefined && value !== null && value !== '';
const valueOf = (item, spec = []) => (Array.isArray(spec) ? spec.map(path => at(item, path)).find(present) : spec?.value);
const time = value => (typeof value === 'number' ? value : Date.parse(value ?? '')) || 0;
const fill = (template, item) => String(template).replace(/\{(\w+)\}/g, (_, name) => (present(item?.[name]) ? encodeURIComponent(String(item[name])) : ''));
const words = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const ROW_KEYS = new Set(['id', 'title', 'subtitle', 'read', 'limit', 'action']);

// One test on an item's field (`where` rows in the DATA).
const TESTS = {
  equals: (value, wanted) => value === wanted,
  not: (value, wanted) => value !== wanted,
  one_of: (value, wanted) => Array.isArray(wanted) && wanted.includes(value),
  none_of: (value, wanted) => Array.isArray(wanted) && !wanted.includes(value),
  at_least: (value, wanted) => Number(value ?? 0) >= wanted,
  at_most: (value, wanted) => Number(value ?? 0) <= wanted,
  present: (value, wanted) => present(value) === wanted,
};
const passes = (item, test) => Object.entries(test).every(([name, wanted]) => name === 'field' || !TESTS[name] || TESTS[name](at(item, test.field), wanted));

/** The card fields one item of `source` carries, read through the source's `card` paths (the first holding a value). */
export const cardFieldsOf = (source, item) => Object.fromEntries(Object.entries(source.card).map(([field, spec]) => [field, valueOf(item, spec)]).filter(([, value]) => present(value)));

function cardOf(name, source, section, item, origin) {
  const card = cardFieldsOf(source, item);
  const id = `${name}:${card.id ?? card.title}`;
  // Where a card opens may name the card itself (`card_id`), as a source with no place of its own does: the waiting
  // queue opened on that card (invariant 8).
  item = { ...item, card_id: id };
  const link = source.opens.link ? valueOf(item, source.opens.link) : undefined;
  const opens = present(link)
    ? { link }
    : {
      // A screen and input may be fixed, or paths read from the item (an item that names its own screen).
      screen: Array.isArray(source.opens.screen) ? valueOf(item, source.opens.screen) : source.opens.screen,
      input: Array.isArray(source.opens.input) ? (valueOf(item, source.opens.input) ?? {})
        : Object.fromEntries(Object.entries(source.opens.input ?? {}).map(([field, spec]) => [field, valueOf(item, spec)]).filter(([, value]) => present(value))),
    };
  const place = present(link) ? String(link) : source.opens.address ? fill(source.opens.address, item) : null;
  const address = place ? (place.startsWith('/') ? `${origin}${place}` : place) : null;
  const action = section.action ?? source.action;
  return {
    ...card, id, source: name, section: section.id, opens,
    ...(address ? { address } : {}), ...(action ? { action } : {}),
    ...(source.opens.in_place === true && !present(link) && address ? { does_in: address, finishes_in_place: true } : {}),
    ...(source.edit && present(card.duration) ? { edit: true } : {}),
    ...(source.done_by_opening && !source.opens.in_place ? { done_by_opening: true } : {}),
  };
}

/** A row's `unless_any` ({ group: { by: path, before?: separator }, where: [tests] }): an item is left out when ANY item
 *  of its group (the value at `by`, cut at `before`: `x:account-2` is in group `x`) passes every test, so a need that
 *  any one account of a service meets is not asked of that service's other accounts (invariant 10). */
const groupOf = (item, group) => { const value = at(item, group.by); return present(value) ? (group.before ? String(value).split(group.before)[0] : String(value)) : undefined; };
function unlessAny(items, rule) {
  const met = new Set(items.filter(item => (rule.where ?? []).every(test => passes(item, test))).map(item => groupOf(item, rule.group)).filter(present));
  return items.filter(item => !met.has(groupOf(item, rule.group)));
}

function kept(all, read) {
  const items = read.unless_any ? unlessAny(all, read.unless_any) : all;
  const passing = items.filter(item => (read.where ?? []).every(test => passes(item, test)));
  const ordered = read.newest ? [...passing].sort((a, b) => time(at(b, read.newest)) - time(at(a, read.newest))) : passing;
  if (!read.distinct) return ordered;
  const seen = new Set();
  return ordered.filter(item => {
    const value = at(item, read.distinct);
    if (!present(value)) return true;
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/** Whether every one of a source's `done_facts` holds on an item (invariant 9). */
export const doneByFacts = (item, facts = {}) => Object.entries(facts).every(([name, value]) => String(at(item, ['facts', name]) ?? '').toLowerCase() === String(value).toLowerCase());

/** The items not done yet whose `done_when_connected` path names a service connected now (invariant 9); `connected()`
 *  answers those services and is asked only when some item names one. */
export async function doneOnceConnected(items, source, connected) {
  const path = source?.done_when_connected;
  if (!path) return [];
  const waiting = items.filter(item => present(at(item, path)) && !doneByFacts(item, source.done_facts));
  if (!waiting.length) return [];
  const services = new Set(await connected());
  return waiting.filter(item => services.has(at(item, path)));
}

// Project every section sharing a source while its answer is local to that completed read.
// The join below retains sections rather than full answers from faster sibling readers.
function sectionsFromAnswer(section, config, answer, failed, origin, done, sift) {
  const name = section.read.from;
  const source = config.sources[name];
  const title = (answer && source.title && at(answer, source.title)) || section.title;
  const subtitle = (answer && source.subtitle && at(answer, source.subtitle)) || section.subtitle;
  const own = Object.fromEntries(Object.entries(section).filter(([key]) => !ROW_KEYS.has(key)));
  const base = { id: section.id, title, ...(subtitle ? { subtitle } : {}), ...own };
  if (failed) return { ...base, cards: [], failed };
  const items = kept(at(answer, source.items) ?? [], section.read);
  const read = items.map(item => cardOf(name, source, section, item, origin)).filter(card => !(source.done_by_opening && done.has(card.id)));
  // The current owner decides which cards belong to this person before paging and limits.
  const cards = sift ? sift({ ...base, read: section.read }, read) : read;
  // `total` is how many the section holds, so a reader shows a true count past the cards it was sent.
  // A paged source owns its cursor. Keep it beside the projected cards so callers
  // never infer exhaustion from a short (or fully filtered) page.
  const page = section.supplemental && source.page ? {
    cursor: valueOf(answer, source.page.cursor),
    has_more: valueOf(answer, source.page.has_more) === true,
  } : null;
  return {
    ...base, total: cards.length, cards: cards.slice(0, section.limit ?? 16),
    ...(page ? { cursor: page.cursor ?? null, has_more: page.has_more === true } : {}),
  };
}

/**
 * read:   { <source name>: async () => answer } for each source the config names.
 * config: the rows, sources and words (see Key concepts).
 * origin: the web address cards' relative addresses are made whole with ('' leaves them relative).
 * sift:   optional (section, cards) → cards to keep before the section's limit.
 * Answers { sections: [{ id, title, subtitle?, total, cards, failed?, ...the row's own other keys }], said, ...carried }.
 */
export async function readCardSections(read, config, { origin = '', done = new Set(), sift = null } = {}) {
  const sections = new Array(config.sections.length);
  const sourceSections = new Map();
  for (const [index, section] of config.sections.entries()) {
    const name = section.read.from;
    if (!sourceSections.has(name)) sourceSections.set(name, []);
    sourceSections.get(name).push(index);
  }
  await Promise.all(Array.from(sourceSections, async ([name, indexes]) => {
    let answer, failed;
    // Only source-read failures become failed sections. Projection errors still reject the reader.
    try { answer = await read[name](); } catch (error) { failed = error.message; }
    for (const index of indexes) {
      sections[index] = sectionsFromAnswer(config.sections[index], config, answer, failed, origin, done, sift);
    }
  }));
  const filled = sections.filter(section => section.cards.length);
  const count = filled.reduce((sum, section) => sum + section.cards.length, 0);
  const rows = filled.map(section => words(config.said.row, { title: section.title, count: section.cards.length })).join(config.said.joiner ?? ', ');
  return {
    ...Object.fromEntries((config.carried ?? []).map(key => [key, config[key]])),
    sections,
    said: filled.length ? words(config.said.some, { count, sections: filled.length, rows }) : config.said.none,
  };
}
