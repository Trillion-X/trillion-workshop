// tools/take-me-there/read-data/take-me-there.mjs
//
// Takes a person to the thing that needs them, as data: one card of what waits on them (the answer of
// tool:what-is-waiting-on-me) becomes the arrangement that opens its screen as the main pane, the walkthrough whose step
// points at the thing's own control and the notice that links to both. Pure: it reads nothing, saves nothing, sends
// nothing and opens nothing; whoever owns saved arrangements, walkthroughs and notices keeps what it returns.
//
// Invariants:
//   1. Never a walkthrough over an empty screen: a thing that is not waiting now (not made yet, already done), or one whose
//      link leads outside the person's own origins or to no screen they have, answers { taken: false, said } with nothing
//      else.
//   2. Which control the walkthrough points at is DATA on the waiting row (`points_at`, a selector with the item's id in
//      {item}); a row without one points at the thing's own opened pane (`fallback_points_at`).
//   3. Nothing here names a screen, a source, a kind of work or a person. The screen an address opens comes from the
//      caller's `screens` rows (path_prefix, tool_id, which query names the screen takes as its own input); the origins that
//      count as the person's own come from `own_origins`; the notice kind, category, sizes and every word are
//      read-data/take-me-there.json.
//   4. The thing is a card's id, or the key a batch section is held under ("batch:" and the section's id): that section's
//      one batch card, which opens where its first card opens.
//   5. The same thing always names one arrangement, one walkthrough and one once key: the id of all three is the held key,
//      so opening it again changes them, never adds a copy.
//   6. Same input, same answer.
//
// waiting is { sections: [{ id?, title?, action?, points_at?, batch?: { title?, action?, requires? }, cards }] } or the flat
// { cards }. A card is { id, source?, title?, action?, address? (or opens), points_at? }.
import { readFileSync } from 'node:fs';

export const readSettings = () => JSON.parse(readFileSync(new URL('./take-me-there.json', import.meta.url), 'utf8'));
const refuse = words => { throw new Error(words); };
const text = value => (typeof value === 'string' ? value.trim() : '');
const words = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
// A value placed inside a quoted CSS attribute selector.
const quoted = value => String(value).replace(/["\\]/g, '\\$&');
// A relative address only needs a base to be read; the base is never part of an answer.
const relativeBase = 'https://relative.invalid';

const heldKey = (section, card) => (section.batch ? `batch:${section.id}` : card.id);

// A batch section's cards that can be named in one pass: those holding the field the batch requires first.
const batchRows = (batch, cards) => {
  if (!batch.requires) return cards;
  return [...cards.filter(card => card[batch.requires]), ...cards.filter(card => !card[batch.requires])];
};

// The one card a batch section is shown as: it opens where its first card opens.
function batchCard(section) {
  const { batch, cards } = section;
  const count = batch.requires ? cards.filter(card => card[batch.requires]).length : Math.max(section.total ?? 0, cards.length);
  const first = cards[0];
  return {
    id: heldKey(section, first), source: first.source,
    title: words(batch.title ?? section.title ?? '', { count }),
    action: batch.action ?? section.action,
    address: first.address ?? first.opens,
    points_at: first.points_at,
  };
}

/** The card `thing` names among what waits, with its section, or null: a card's id, or a batch section's held key. */
function cardOf(waiting, thing) {
  const sections = Array.isArray(waiting.sections) ? waiting.sections : [{ cards: waiting.cards }];
  for (const section of sections) {
    const cards = Array.isArray(section.cards) ? section.cards.filter(card => card && typeof card === 'object' && text(card.id)) : [];
    if (section.batch && cards.length) {
      const held = { ...section, cards };
      if (heldKey(held, cards[0]) === thing) return { section: held, card: batchCard(held), done: batchRows(section.batch, cards).map(card => card.id) };
    }
    const card = cards.find(one => one.id === thing);
    if (card) return { section: { ...section, cards }, card, done: [card.id] };
  }
  return null;
}

/** The path and query an address opens inside the person's own origins, or null when it opens outside them. */
function placeOf(address, origins) {
  const raw = text(address);
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { return null; }
    return origins.includes(url.origin) ? { path: url.pathname, query: url.searchParams } : null;
  }
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  const url = new URL(raw, relativeBase);
  return { path: url.pathname, query: url.searchParams };
}

// The caller's row for the longest path_prefix that holds the path, whole segments only.
const rowFor = (screens, path) => screens
  .filter(row => path === row.path_prefix || path.startsWith(row.path_prefix.endsWith('/') ? row.path_prefix : `${row.path_prefix}/`))
  .sort((a, b) => b.path_prefix.length - a.path_prefix.length)[0] ?? null;

function readScreens(screens, said) {
  if (!Array.isArray(screens) || !screens.length) refuse(said.needs_screens);
  return screens.map((row, index) => {
    const names = row?.route_input_from_query ?? [];
    if (!row || typeof row !== 'object' || !text(row.path_prefix).startsWith('/') || !text(row.tool_id)
      || !Array.isArray(names) || names.some(name => !text(name))) refuse(words(said.bad_screen, { index }));
    return { path_prefix: text(row.path_prefix), tool_id: text(row.tool_id), names: names.map(text) };
  });
}

function readOrigins(origins, said) {
  if (origins === undefined) return [];
  if (!Array.isArray(origins)) refuse(words(said.bad_origin, { origin: JSON.stringify(origins) }));
  return origins.map(origin => {
    try { return new URL(origin).origin; } catch { return refuse(words(said.bad_origin, { origin })); }
  });
}

/**
 * input { thing, waiting, screens, own_origins?, beside?, name?, category?, say?, steps?, key?, fallback_points_at? }
 *   -> { taken: false, said } or { taken: true, screen, arrangement, tour, notice, open, said }
 */
export function takeMeThere(input) {
  const settings = readSettings();
  const said = settings.words;
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('Send an object.');
  const thing = text(input.thing);
  if (!thing) refuse(said.needs_thing);
  if (!input.waiting || typeof input.waiting !== 'object') refuse(said.needs_waiting);
  const screens = readScreens(input.screens, said);
  const origins = readOrigins(input.own_origins, said);

  const found = cardOf(input.waiting, thing);
  if (!found) return { taken: false, said: words(said.not_waiting, { thing }) };
  const { section, card, done } = found;
  const place = placeOf(card.address ?? card.opens, origins);
  const row = place ? rowFor(screens, place.path) : null;
  if (!row) return { taken: false, said: words(said.outside, { thing, address: text(card.address ?? card.opens) }) };

  const routeInput = Object.fromEntries(row.names.filter(name => place.query.has(name)).map(name => [name, place.query.get(name)]));
  const title = text(card.title) || text(section.title);
  const held = heldKey(section, card);
  const name = text(input.name) || title;
  const category = text(input.category) || settings.category;
  // The pane names only what the address adds; a screen with nothing added is named by its id alone.
  const pane = { kind: 'pane', surfaces: [Object.keys(routeInput).length ? { id: row.tool_id, input: routeInput, title } : row.tool_id] };
  const beside = input.beside && typeof input.beside === 'object' && !Array.isArray(input.beside) ? input.beside : null;
  const arrangement = {
    id: held, held, replaces: [name], name, category,
    root: beside ? { kind: 'split', dir: 'row', sizes: settings.focus_sizes, children: [pane, beside] } : pane,
  };

  const action = text(card.action) || text(section.action) || said.your_part;
  const item = card.source && card.id.startsWith(`${card.source}:`) ? card.id.slice(card.source.length + 1) : card.id;
  const pointsAt = text(card.points_at) || text(section.points_at);
  const control = {
    target_ref: { from: 'selector', query: pointsAt ? words(pointsAt, { item: quoted(item) }) : text(input.fallback_points_at) || settings.fallback_points_at },
    target_preparation: { surface: { id: row.tool_id, surface_input: routeInput } },
    centered_when_target_missing: true,
    placement: settings.step_placement,
  };
  const given = Array.isArray(input.steps) ? input.steps.filter(step => step && typeof step === 'object' && !Array.isArray(step)) : [];
  // A task's own control is already what the person must use: no generated tour covers it, only guidance the caller wrote.
  const steps = given.map((step, index) => (step.target_ref ? step : { ...control, ...step, id: text(step.id) || `${settings.step_id}-${index + 1}` }));
  const tour = steps.length ? {
    id: held, category,
    title: words(said.tour_title, { action, title }),
    steps,
    triggers: [{
      reason: settings.trigger.reason,
      on_event: { event_kind: settings.trigger.start_event },
      once_key: `${settings.trigger.once_key}${held}`,
      consume_on: [{ event_kind: settings.trigger.done_event, match_all: { completed_ids: done } }],
    }],
  } : null;

  const query = new URLSearchParams({ [settings.link.layout]: held, ...(tour ? { [settings.link.tour]: held } : {}) });
  const open = `/?${query}`;
  const say = input.say && typeof input.say === 'object' && text(input.say.title) ? input.say : null;
  const notice = say ? { title: text(say.title), body: say.body ?? null, kind: settings.notice_kind, refs: { open, card: card.id }, key: text(input.key) || null } : null;

  return {
    taken: true,
    screen: { tool_id: row.tool_id, route_input: routeInput },
    arrangement, tour, notice, open,
    said: [words(said.ready, { title }), tour ? words(said.tour, { action }) : null, notice ? said.notice : null].filter(Boolean).join(' '),
  };
}
