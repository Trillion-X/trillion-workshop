// src/take-me-there.mjs
//
// Purpose
//   Takes the person to the thing that needs them, instead of telling them about it: one step any schedule, rule,
//   workflow, live speech or AI runs (tool:take-me-there, placement:this-account). The thing is one card of what is
//   waiting on them (src/waiting-on-you.json, the answer tool:what-is-waiting-on-me gives: a drafted post to approve,
//   stuck work, a decision to answer, anything a source there names). It opens the screen on that exact thing as the
//   main pane (what else the caller wants beside it goes beside it), starts a walkthrough whose step points at the
//   thing's own control (its Approve, its Send, its answer), and tells them with a notice whose link opens the same
//   arrangement and walkthrough on any device they pick it up on.
//
// Non-negotiable invariants
//   1. It composes the owners and copies none of them: what waits is read from the person's own Waiting on you answer,
//      the address a card opens is turned into a screen by the one address resolver the page and Worker use
//      (src/workspace/addresses.mjs screensAtAddress), arrangements are kept and opened by src/layouts.mjs, tours by
//      src/tours.mjs, notices by src/tell-the-person.mjs. A layout, tour or words any of them refuses is refused here
//      with that owner's words.
//   2. Never a tour over an empty screen: a thing that is not waiting on them now (not made yet, already done), or one
//      that opens outside Trillion, is refused in plain words with nothing opened and nothing told (taken: false).
//   3. Which control the walkthrough points at is DATA on the Waiting on you row (`points_at`, a selector filled with
//      the item's id); a row without one points at the thing's own opened pane (`fallback_points_at` here).
//   4. Whether the open page lets it take the screen now is the person's own show rules, decided on the page where
//      the ask lands (parts/ui/show/asked-now: subject `layout` and `tour`): a held ask waits there, and the notice
//      still reaches them, so nothing is lost and nothing interrupts against their rules.
//   5. Nothing here names a screen, a source, a kind of work or a person; the link words, the notice kind, the default
//      category, the pane sizes and every word said are DATA (src/take-me-there.json).
//   6. The thing is a card's id, or the key the hold holds a batch row under (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs `thingKeyOf`):
//      that row's one batch card, which opens where its first card opens.
//   7. Opening the same thing again changes its one layout (src/layouts.mjs invariant 6, keyed by the thing's key), never adds a copy.
//

import settings from './take-me-there.json' with { type: 'json' };
import surfaces from './workspace/screens.mjs';
import { screensAtAddress } from './workspace/addresses.mjs';
import { batchCard, batchRows, thingKeyOf } from '../hold-one-thing-until-done/read-data/needs-you-hold.mjs';
import { openOf } from './waiting-nudge.mjs';
import itemLinks from './item-links.json' with { type: 'json' };

const text = value => (typeof value === 'string' ? value.trim() : '');
const words = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
// A value placed inside a quoted CSS attribute selector.
const quoted = value => String(value).replace(/["\\]/g, '\\$&');

/** The address that opens this arrangement and tour on any device: the link the notice carries. */
export function openAddress({ layoutId = null, tourId = null } = {}) {
  const query = new URLSearchParams();
  if (layoutId) query.set(settings.link.layout, layoutId);
  if (tourId) query.set(settings.link.tour, tourId);
  const said = query.toString();
  return said ? `/?${said}` : settings.link.fallback;
}

/** The card `thing` names among what waits on the person, with the row it sits in, or null: a card's id, or the key
 *  a batch row is held under (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs `thingKeyOf`), which names the row's one batch card. */
function cardOf(waiting, thing) {
  for (const section of waiting.sections ?? []) {
    if (section.batch && section.cards?.length && thingKeyOf(section, section.cards[0]) === thing) return { section, card: batchCard(section) };
    // A card's own queue key names it too (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs thingKeyOf), as the hold does.
    const card = (section.cards ?? []).find(one => one.id === thing || thingKeyOf(section, one) === thing);
    if (card) return { section, card };
  }
  return null;
}

/**
 * owners: { layouts: makeLayouts(...), tours: makeTours(...), tell: input → notice, waiting: () → Waiting on you answer }
 * screens: the screen rows an address resolves among (the app's catalog unless given)
 * Returns { take(input) }.
 */
export function makeTakeMeThere({ layouts, tours, tell, waiting, screens = surfaces.surfaces }) {
  const refused = said => ({ taken: false, layout_id: null, tour_id: null, open: null, told: false, said });

  async function take(input = {}) {
    const thing = text(input.thing);
    if (!thing) throw new Error(settings.words.needs_thing);
    const found = cardOf(await waiting(), thing);
    if (!found) return refused(words(settings.words.not_waiting, { thing }));
    const { section, card } = found;
    // A card whose own link leads elsewhere opens outside Trillion; a link on one of Trillion's own origins
    // (src/item-links.json own_origins, the list every answer's links are made from) opens inside it.
    // The address opens what the page opens for it (its path's screen, with what its query asks of that screen).
    const path = openOf(card, itemLinks.own_origins);
    const address = path ? new URL(path, settings.link.base) : null;
    const [screen] = address ? screensAtAddress(screens, address.pathname, address.search) : [];
    if (!screen) return refused(words(settings.words.outside, { thing, address: card.address ?? '' }));

    const by = text(input.by) || null;
    const category = text(input.category) || settings.category;
    const title = text(card.title) || text(section.title);
    const opened = { ...(screen.row.surface_input ?? {}), ...(screen.input ?? {}) };
    // The pane names only what the address adds (the one thing it opens on): the screen's own input comes with its row,
    // so a whole screen (Connections) is named by its id alone, as every layout names it.
    // The address answers an input object even when it adds nothing, and an empty one still names no thing.
    const adds = screen.input && Object.keys(screen.input).length > 0;
    const pane = { kind: 'pane', surfaces: [adds ? { id: screen.row.id, input: screen.input, title } : screen.row.id] };
    const beside = input.beside && typeof input.beside === 'object' ? input.beside : null;
    // One layout per held thing: its id and `held` come from the thing's key, so opening it again changes that layout, and
    // the copies kept before (under the id its name made) are replaced with it.
    const held = thingKeyOf(section, card);
    const name = text(input.name) || title;
    const layout = {
      id: held, held, replaces: [name], name,
      arrangement: beside ? { kind: 'split', dir: 'row', sizes: settings.focus_sizes, children: [pane, beside] } : pane,
    };
    const layoutId = (await layouts.save({ layout, category, open_now: true, by })).layout.layout_id;

    const item = card.id.startsWith(`${card.source}:`) ? card.id.slice(card.source.length + 1) : card.id;
    const control = {
      target_ref: { from: 'selector', query: section.points_at ? words(section.points_at, { item: quoted(item) }) : settings.fallback_points_at },
      target_preparation: { surface: { id: screen.row.id, surface_input: opened } },
      centered_when_target_missing: true,
      placement: settings.step_placement,
    };
    const action = text(card.action) || text(section.action) || settings.words.your_part;
    const given = Array.isArray(input.steps) ? input.steps.filter(step => step && typeof step === 'object') : [];
    const steps = given.map((step, index) => (step.target_ref ? step : { ...control, ...step, id: text(step.id) || `${settings.step_id}-${index + 1}` }));
    // The linked task is already the control the person must use. Do not cover
    // it with a generated one-card tour that only repeats "Do it"; authored
    // guidance remains available when the caller supplies meaningful steps.
    const tourId = steps.length ? (await tours.save({ tour: {
      title: words(settings.words.tour_title, { action, title }),
      steps,
      // The guided-overlay host uses this DATA association to finish the task's
      // own tour when the waiting row is completed, including after reload.
      triggers: [{
        reason: 'asked-by-name',
        on_event: { event_kind: 'walkthrough-requested' },
        once_key: `waiting-item:${held}`,
        consume_on: [{
          event_kind: 'waiting-item-completed',
          match_all: { completed_ids: section.batch ? batchRows(section.batch, section.cards).map(row => row.id) : [card.id] },
        }],
      }],
    }, category, show_now: true, by })).tour.tour_id : null;

    const open = openAddress({ layoutId, tourId });
    const say = input.say && typeof input.say === 'object' && text(input.say.title) ? input.say : null;
    // Told only when a channel took the notice or the person read it (tell-the-person deliveryReceipt), never because
    // a tell was asked for.
    // The card rides in refs, so every later rung of the kind's ordered reach is checked against what still waits first.
    const receipt = say ? await tell({ title: text(say.title), body: say.body ?? null, kind: settings.notice_kind, refs: { open, card: card.id }, key: text(input.key) || null }) : null;
    const told = Boolean(receipt?.told);

    return {
      taken: true,
      layout_id: layoutId,
      tour_id: tourId,
      open,
      told,
      ...(receipt ? { delivery: { channels: (receipt.channels ?? []).map(row => ({ channel: row.channel, sent: Boolean(row.sent), stage: row.stage ?? null })), awareness: receipt.awareness ?? 'unknown' } } : {}),
      said: [words(settings.words.opened, { title }), words(settings.words.tour, { action }), told ? settings.words.told : say ? receipt?.said ?? null : null].filter(Boolean).join(' '),
    };
  }
  return { take };
}
