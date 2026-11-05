// src/waiting-weigh.mjs
//
// Purpose
//   The one rule for which waiting things are the person's. Every card of every section of Waiting on you
//   (src/waiting-on-you.json, read by src/card-sections.mjs) is weighed here by src/who-does-it.mjs before anyone sees
//   it: the reader (person-store waitingOnYou) shows only what is left, and the reminder (src/waiting-nudge.mjs) and the
//   hold (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs) hand the rest to the AIs. 2026-10-11: drafts the person already approved, files from AI tests,
//   AI jobs that were stuck and decisions their AIs opened from their own words were all shown to them as theirs.
//
// Non-negotiable invariants
//   1. The AIs are the default doer. A card stays the person's only when who-does-it says `you` (a reason from its
//      `only_a_person` rows) or `one-tap` (it spends or reaches someone the person has not said yes to yet).
//   2. What a card needs and why only the person could do it come from the card itself (an ask an AI filed: `needs`,
//      `reason_id`, `tried_doer`) or else from its section's `step` (DATA): no section, kind of thing or vendor is named
//      here. A card that gives only free words for why it is theirs (`only_you_because` with no `reason_id`) stays theirs.
//   3. Consent given once (`step.given_in`, resolved by the caller to the record that gave it) sends the thing to the AIs
//      without asking again.
//   4. A card with no working control (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs controlOf) is a defect of whoever filed it and goes back to
//      the AIs (`hold.no_control`), never to the person.
//   5. Nothing leaves the person's view without an AI holding it: every card not kept for them is returned with its
//      hand-off (a section's `step.job` and `step.said`, else `nudge.weigh`), handed in the one order (`inOrder`). A section
//      whose `step.already_ais` is true lists things that already are hand-offs to the AIs (stuck work: each card is a
//      job of theirs), so its cards leave the person's view with no second job: a helper job for every job nobody took
//      doubled the jobs a store keeps per arrival (store-month, 2026-10-11).
//   6. Pure: nothing is read or written here; hand-offs are returned for the caller, each `once_per` its card.
//
import { controlOf } from 'trillion-workshop/tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs';

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const listOf = value => (Array.isArray(value) ? value : String(value ?? '').split(',')).map(item => String(item).trim()).filter(Boolean);

/** The step a card is weighed as: its own needs and reason first, else its section's (DATA `step`). */
export function stepOf(card, section, given = {}) {
  const own = listOf(card?.needs);
  const step = section?.step ?? {};
  const reason = card?.reason_id ?? (own.length ? null : step.only_a_person_because ?? null);
  const needs = own.length ? own : listOf(step.needs);
  const past = card?.tried_doer ? [{ doer: card.tried_doer, result: 'failed' }] : Array.isArray(card?.past) ? card.past : [];
  const givenIn = !card?.reason_id && !own.length ? given[section?.id] ?? null : null;
  return { needs, reason, past, given_in: givenIn };
}

/**
 * rows     [{ section, cards }] (a Waiting on you answer's sections, or the part of them that waited long enough)
 * options  { settings (waiting-on-you.json), weigh (who-does-it whoDoesEachStep), opensScreen, given: { [section id]: record id } }
 * → { rows: [{ section, cards }] the person's, toAis: [{ card, section, handOff | null }] }
 */
export function weighCards(rows, { settings, weigh = null, opensScreen = () => true, given = {} }) {
  const toAis = [];
  const kept = [];
  for (const row of rows) {
    const cards = [];
    for (const card of row.cards) {
      if (!controlOf(settings, row, card, opensScreen)) {
        const words = settings.hold.no_control;
        toAis.push({ card, section: row.section, handOff: { job: fill(words.job, { title: card.title ?? '', detail: card.detail ?? '' }), said: fill(words.said, { title: card.title ?? '' }).slice(0, 300), once_per: `no-control:${card.id}`, input: { card_id: card.id } } });
        continue;
      }
      if (!weigh || (card.only_you_because && !card.reason_id)) { cards.push(card); continue; }
      const step = stepOf(card, row.section, given);
      if (!step.needs.length && !step.reason) { cards.push(card); continue; }
      const [answer] = weigh({ steps: [{ id: card.id, words: card.title ?? '', needs: step.needs, ...(step.reason ? { only_a_person_because: step.reason, past: step.past } : {}), ...(step.given_in ? { given_in: step.given_in } : {}) }] }).steps;
      if (answer.who === 'you' || answer.who === 'one-tap') { cards.push(card); continue; }
      // A section may say what its things are to the AIs (`step.job`, `step.said`), in place of the general words.
      const words = { ...settings.nudge.weigh, ...(row.section?.step?.job ? { job: row.section.step.job } : {}), ...(row.section?.step?.said ? { said: row.section.step.said } : {}) };
      toAis.push({ card, section: row.section, handOff: row.section?.step?.already_ais === true ? null : {
        job: fill(words.job, { title: card.title ?? '', detail: card.detail ?? '', id: card.id, said: answer.said, doers: answer.doers.map(doer => doer.tool_id ?? doer.purpose ?? doer.id).join(', '), needs: answer.uncovered.join(', ') }),
        said: fill(words.said, { title: card.title ?? '' }).slice(0, 300), once_per: `weighed:${card.id}`, input: { card_id: card.id, weighed: answer },
      } });
    }
    kept.push({ ...row, cards });
  }
  return { rows: kept, toAis };
}

const sameKey = card => String(card?.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
/** The cards of one section with the same thing said twice kept once (the first, which is the newest the section read). */
export function sameOnce(cards) {
  const seen = new Set();
  return cards.filter(card => {
    const key = sameKey(card);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const blocksOf = (card, order) => { const list = order.blocks.reduce((inner, key) => inner?.[key], card); return Array.isArray(list) ? list.length : 0; };
const newestOf = (card, order) => Date.parse(order.newest.reduce((inner, key) => inner?.[key], card) ?? '') || 0;
const firstFirst = order => (a, b) => (blocksOf(b, order) - blocksOf(a, order)) || (newestOf(b, order) - newestOf(a, order));

/** The hand-offs `weighCards` returns, in the same one order the person's own things are shown in. */
export function inOrder(toAis, order = { blocks: ['unlocks'], newest: ['at'] }) {
  const compare = firstFirst(order);
  return toAis.slice().sort((a, b) => compare(a.card, b.card));
}

/**
 * One order over every section the person sees on Home (`on_home` not false): what holds up the most of theirs first
 * (`order.blocks`, the length of the list at that path on a card), then the newest (`order.newest`). → [{ section, card }]
 */
export function oneOrder(sections, order = { blocks: ['unlocks'], newest: ['at'] }) {
  const compare = firstFirst(order);
  const rows = [];
  for (const section of sections ?? []) {
    if (section.on_home === false) continue;
    for (const card of section.cards ?? []) rows.push({ section: section.id, card });
  }
  return rows.sort((a, b) => compare(a.card, b.card)).map(({ section, card }) => ({ section, card: card.id }));
}
