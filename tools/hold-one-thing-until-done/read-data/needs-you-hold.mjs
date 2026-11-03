// src/needs-you-hold.mjs
//
// Purpose
//   The hold: when something truly needs the person, every Trillion page they open (the web, the Mac app and its menu
//   bar panel, the iPhone app, which all draw the same workspace page) shows that ONE thing and nothing else until it
//   is done or set aside with a reason. 2026-10-06: "Set up everything such that there is only one thing you can
//   do, so the river flows in that one direction... There is no escape." A list of 160 with the sidebar one click away
//   is an ocean; this is the river. Every way out of it is a row of src/escape-chain.json (escape → counter → next
//   escape), and the counters that live in software are here:
//     - another screen: the page under the hold is out of reach (the cover, src/workspace/needs-you-hold.tsx);
//     - "later" / snooze forever: setting a thing aside needs a reason in words (`aside.min_words`), lasts
//       `aside.minutes`, and is offered at most `aside.most_per_day` times a day; each reason is handed to the AIs to
//       do the thing instead or make it smaller (`aside.job`), so a reason is weighed, never just accepted;
//     - turning the hold off: possible, but it costs the stake the person chose in advance (`off.stakes`): it never
//       turns off at once, only `delay_minutes` after asking (the cooling-off the research found works: easing a
//       commitment only takes effect after a delay), and any other stake the person chose (someone they named is told,
//       money they named is given) is handed to the AIs to carry out when they ask;
//     - many small things of one kind (52 unnamed voices): a section marked `batch` is one thing, done in one pass
//       (a row is listed only when it has what `batch.requires` names, playable audio for voices; suggestions help name
//       a voice only after its recording can be heard. Unavailable rows are explained and left out);
//     - "I already did it" / "it does not work here": a held thing whose person's part is done, or whose screen does
//       not work for them, is handed back to the AIs with their words (`hand_back.ways`), leaves the hold, and is never
//       counted against the asides; the AIs check it the way Trillion checks it and finish it, fix it, or file one
//       smaller row, so handing back is never a way to skip what only the person can do. 2026-10-07: a person finished
//       setting up a camera, the rest was a receiver bug for the AIs, and the hold refused to let it go ("Nothing more
//       can be set aside today").
//
// Non-negotiable invariants
//   1. Blind: nothing here names a section, a source, a stake or a word shown; all are DATA (src/waiting-on-you.json
//      `hold`, `sections[].batch`, `sections[].hold`).
//   2. The held thing is the one that unblocks the most, by the DATA's `rank` rules in order (each a measure every
//      thing is scored on: `waited_on`, how many other waiting things name it in their `field`, directly or through
//      others; `has`, whether it carries `field`); ties keep the DATA's order (most urgent section first, then the
//      section's own order). Only a thing not set aside, whose section does not say `hold: false`, and that has waited
//      `after_minutes` holds; a batch section is one thing.
//   3. Off is never immediate and never for good: it starts the chosen stake's `delay_minutes` after asking and ends
//      `off.lasts_minutes` later, when the hold comes back by itself; asking again while an off is pending or running
//      changes nothing. Turning it back on is immediate and free.
//   4. Every change returns the next state and the jobs to hand to the AIs; this file never sends anything itself.
//   5. A stake chosen while another is in force waits that one's delay before it counts, so the stake can be raised
//      or lowered, but never lowered in the moment of wanting out.
//   6. Turning it off more than once within `off.escalate_days` multiplies the next wait by `off.escalate` each time.
//   7. Only a thing with a working control is held (`controlOf`): a press, the place in Trillion it is done in (a
//      `does_in` address that opens one of the page's screens, drawn in place on the held screen), or steps done by hand
//      beside what Trillion is watching for. A thing with none never reaches the person: it is refused when filed
//      (src/waiting-filing.mjs, asked by src/person-store.mjs on every write of the Waiting on you list) and handed back to the AIs as a defect when it waits
//      (src/waiting-nudge.mjs `weighed`). 2026-10-07: "Sign in to Facebook once" was held with only a Checking spinner
//      and no button to sign in, so it could never be done.
//   8. Several things holdable at once are walked in the rank order (`ranked`): the held thing first, then the next
//      by the same DATA rules, so the person can move to the next thing and back without leaving the hold.
//   9. Handing back is never limited by the asides (`aside.most_per_day` limits postponing only): it
//      moves the rest of the thing to the AIs, so a thing whose person's part is done, or that cannot be done where
//      they are, can always leave. A thing handed back stays out of the hold for `hand_back.keep_days`; the AIs mark it
//      done or put a new row in its place. Handing the same thing back again hands no second job (`once_per`).
//
// Key concepts
//   state  the person's fact `hold.fact`: { on?, stake?: { id, ...values }, off?: { requested_at, at, until, stake },
//          stake_next?: { stake, from }, offs?: [iso], aside?: { [thing key]: { until, reason } }, asides?: { day, count },
//          handed_back?: { [thing key]: { at, way, said } } }
//   held   { key, section, card } or null
//   ranked every thing that may hold, held first, as { key, title }
//

const MINUTE = 60_000;
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const wordCount = text => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
const dayOf = at => new Date(at).toISOString().slice(0, 10);

/** The thing key a card is held under: a batch section is one thing whatever cards it holds. */
export const thingKeyOf = (section, card) => (section.batch ? `batch:${section.id}` : card.id);

/** Whether the hold is on now: the person's own choice (else the DATA's default), until an off they asked for takes
 *  effect. */
export function isOn(state, settings, now) {
  const chosen = typeof state?.on === 'boolean' ? state.on : settings.default_on !== false;
  if (!chosen) return false;
  const off = state?.off;
  return !(off && Date.parse(off.at) <= now && !(Date.parse(off.until ?? '') <= now));
}

/** The answer after the doer gate handed AI-doable cards away; sections and counts follow the cards still waiting. */
export function withoutHanded(answer, handed = []) {
  const excluded = new Set(handed);
  return { ...answer, sections: (answer?.sections ?? []).map(section => {
    const cards = section.cards.filter(card => !excluded.has(card.id));
    return cards.length === section.cards.length ? section : { ...section, total: cards.length, cards };
  }) };
}

/** A thing's numbered lines, each a step the person does by hand (the waiting screen draws them as a checklist). */
export const STEP_LINE = /^\s*\d+[.)]\s+(.+)$/;
const hasSteps = detail => String(detail ?? '').split('\n').some(line => STEP_LINE.test(line));
const responseKind = value => {
  if (!value) return null;
  try { return (typeof value === 'string' ? JSON.parse(value) : value)?.kind ?? null; } catch { return null; }
};

/** The control the person acts on for `card`, or null when it has none (invariant 7): its finish row (the card's, else
 *  its section's, among the answer's `finishes`) offers a press; its own `response` offers one; it names the place in
 *  Trillion it is done in (`does_in`, when `opensScreen` says that address opens a screen); its words are steps done by
 *  hand; or its section names no finish, so the card opens its own place (an approval, a decision); a batch is its own
 *  form. */
export function controlOf(answer, section, card, opensScreen = () => true) {
  if (section?.batch) return { kind: 'batch' };
  const choice = card?.finish ?? section?.finish;
  const row = (answer?.finishes ?? []).find(finish => finish.choice === choice);
  if (row?.press) return { kind: 'press', press: row.press };
  const response = responseKind(card?.response);
  if (response && response !== 'checked') return { kind: 'response', response };
  const doesIn = typeof card?.does_in === 'string' ? card.does_in.trim() : '';
  if (doesIn && opensScreen(doesIn)) return { kind: 'screen', address: doesIn };
  if (hasSteps(card?.detail)) return { kind: 'steps' };
  if (!choice) return { kind: 'opens' };
  return null;
}

/** Every thing that may hold the page now, in the DATA's order: { key, section, card } (a batch section is one). */
function holdable(answer, state, settings, now, opensScreen) {
  const aside = state?.aside ?? {};
  const handed = handedBack(state, settings, now);
  const free = key => !(Date.parse(aside[key]?.until ?? '') > now) && !handed[key];
  return (answer?.sections ?? []).flatMap(section => {
    if (section.on_home === false || section.hold === false || !section.cards?.length) return [];
    // A batch that requires a playable field (DATA: `requires: clip`) has no
    // independently holdable items when every suggestion is unavailable.
    const eligible = section.batch ? batchRows(section.batch, section.cards) : section.cards;
    const old = eligible.filter(card => !card.at || Date.parse(card.at) <= now - (settings.after_minutes ?? 0) * MINUTE);
    if (!old.length) return [];
    if (section.batch) {
      const key = thingKeyOf(section, old[0]);
      return free(key) ? [{ key, section: { ...section, total: old.length }, card: batchCard({ ...section, total: old.length }, old), cards: old }] : [];
    }
    return old.filter(card => controlOf(answer, section, card, opensScreen))
      .map(card => ({ key: thingKeyOf(section, card), section, card, cards: [card] })).filter(thing => free(thing.key));
  });
}

/** The things a card names in `field` as waiting on, each as the card ids it may be: a name is a card's own id, or an
 *  id of the same source (`asks:` + a row id). */
const namedIn = (card, field) => (Array.isArray(card?.[field]) ? card[field] : String(card?.[field] ?? '').split(','))
  .map(name => String(name).trim()).filter(Boolean).flatMap(name => [name, `${card.source}:${name}`]);

/** How many other waiting cards wait on any of `cards`, directly or through other waiting cards (rule `waited_on`). */
function waitedOn(answer, cards, field) {
  const all = (answer?.sections ?? []).flatMap(section => section.cards ?? []);
  const reached = new Set(cards.map(card => card.id));
  const counted = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const card of all) {
      if (counted.has(card.id) || reached.has(card.id) || !namedIn(card, field).some(name => reached.has(name))) continue;
      counted.add(card.id); reached.add(card.id); grew = true;
    }
  }
  return counted.size;
}

// Each rank rule's measure of one thing; a rule names a measure and the card field it reads.
const MEASURES = {
  waited_on: (thing, rule, answer) => waitedOn(answer, thing.cards, rule.field),
  has: (thing, rule) => (thing.cards.some(card => String(card[rule.field] ?? '').trim()) ? 1 : 0),
};

/** Every thing that may hold now, in rank order by the DATA's `rank` rules (invariants 2 and 8): the first is held.
 *  `opensScreen(address)` says whether a `does_in` address opens one of the page's screens (invariant 7). */
export function rankedThings(answer, state, settings, now, { opensScreen } = {}) {
  if (!isOn(state, settings, now)) return [];
  const things = holdable(answer, state, settings, now, opensScreen);
  const rules = (settings.rank ?? []).filter(rule => MEASURES[rule.by]);
  const scored = things.map((thing, order) => ({ thing, order, score: rules.map(rule => MEASURES[rule.by](thing, rule, answer)) }));
  scored.sort((a, b) => {
    for (let index = 0; index < rules.length; index += 1) if (a.score[index] !== b.score[index]) return b.score[index] - a.score[index];
    return a.order - b.order;
  });
  return scored.map(({ thing: { key, section, card } }) => ({ key, section, card }));
}

/** The one thing the hold shows, or null when nothing truly needs the person now (invariant 2). */
export const heldThing = (answer, state, settings, now, options) => rankedThings(answer, state, settings, now, options)[0] ?? null;

/** A batch section's cards as one card: its `batch` words filled with how many wait, carrying every card and opening
 *  where its first card opens. */
export function batchCard(section, cards = section.cards) {
  const batch = section.batch ?? {};
  const count = batch.requires ? batchRows(batch, cards).length : Math.max(section.total ?? 0, cards.length);
  const unavailableCount = batch.requires ? cards.filter(card => !card[batch.requires]).length : 0;
  const detail = [fill(batch.detail ?? '', { count }), unavailableCount && batch.unavailable ? fill(batch.unavailable, { count: unavailableCount }) : ''].filter(Boolean).join('\n\n');
  // The one thing opens where its first card opens (the queue on that pass), so a link, a notice or take-me-there
  // given the batch's key reaches it like any card.
  const first = cards[0] ?? {};
  return { id: `batch:${section.id}`, title: fill(batch.title ?? section.title, { count }), detail, action: batch.action ?? section.action,
    ...(first.opens ? { opens: first.opens } : {}), ...(first.address ? { address: first.address } : {}), batch: cards, count };
}

/** Rows that can actually be named in one pass: a suggestion never replaces required audio. */
export function batchRows(batch, cards) {
  const listed = batch.requires ? cards.filter(card => Boolean(card[batch.requires])) : cards;
  return batch.requires ? [...listed.filter(card => card[batch.requires]), ...listed.filter(card => !card[batch.requires])] : listed;
}

/** How many times the thing may still be set aside today. */
export function asidesLeft(state, settings, now) {
  const used = state?.asides?.day === dayOf(now) ? state.asides.count ?? 0 : 0;
  return Math.max(0, (settings.aside?.most_per_day ?? 0) - used);
}

/** Sets the held thing aside for `aside.minutes` with the person's reason, which is handed to the AIs to weigh. */
export function setAside(state, settings, { key, title, reason }, now) {
  const said = settings.words ?? {};
  if (!key) throw new Error(said.no_thing ?? 'Say which thing to set aside.');
  if (wordCount(reason) < (settings.aside?.min_words ?? 1)) throw new Error(fill(said.reason_short ?? 'Say why in at least {words} words.', { words: settings.aside?.min_words ?? 1 }));
  if (!asidesLeft(state, settings, now)) throw new Error(said.no_asides_left ?? 'Nothing more can be set aside today.');
  const day = dayOf(now);
  const until = new Date(now + (settings.aside?.minutes ?? 60) * MINUTE).toISOString();
  const next = {
    ...state,
    aside: { ...Object.fromEntries(Object.entries(state?.aside ?? {}).filter(([, row]) => Date.parse(row.until) > now)), [key]: { until, reason: String(reason).slice(0, 1000) } },
    asides: { day, count: (state?.asides?.day === day ? state.asides.count ?? 0 : 0) + 1 },
  };
  const job = { job: fill(settings.aside?.job, { title, reason, key }), said: fill(settings.aside?.said, { title }).slice(0, 300), once_per: `hold-aside:${key}:${until}`, input: { thing: key, reason } };
  return { state: next, until, jobs: [job] };
}

/** The things handed back to the AIs that still stay out of the hold (invariant 9), by thing key. */
function handedBack(state, settings, now) {
  const keep = (settings.hand_back?.keep_days ?? 1) * 1440 * MINUTE;
  return Object.fromEntries(Object.entries(state?.handed_back ?? {}).filter(([, row]) => Date.parse(row.at) > now - keep));
}

/** Hands the rest of the held thing to the AIs by one of `hand_back.ways` with the person's words (invariant 9): it
 *  leaves the hold, the asides are untouched, and the way's job is handed once per thing. */
export function handBack(state, settings, { key, title, way, reason }, now) {
  const said = settings.words ?? {};
  if (!key) throw new Error(said.no_thing ?? 'Say which thing to hand back.');
  const row = (settings.hand_back?.ways ?? []).find(item => item.id === way);
  if (!row) throw new Error(said.no_way ?? 'Choose one of the ways to hand it to your AIs.');
  const words = settings.hand_back?.min_words ?? 1;
  if (wordCount(reason) < words) throw new Error(fill(said.hand_back_short ?? 'Say what happened in at least {words} words.', { words }));
  const at = new Date(now).toISOString();
  const text = String(reason).slice(0, 1000);
  const next = { ...state, handed_back: { ...handedBack(state, settings, now), [key]: { at, way: row.id, said: text } } };
  const values = { title, reason: text, key };
  const job = { job: fill(row.job, values), said: fill(row.said, { title }).slice(0, 300), once_per: `hold-hand-back:${key}`, input: { thing: key, way: row.id, reason: text } };
  return { state: next, jobs: [job] };
}

/** The ways a held thing can be handed back, as the held screen offers them. The "I did my part" way shows the held row's own
 *  setup words when the row carries them (a device row's words, src/waiting-on-you.json `hand_back`'s placeholder otherwise). */
const handBackWays = (settings, setupWords) => (settings.hand_back?.ways ?? []).map(({ id, label, icon, title, placeholder, submit }) => ({ id, label, ...(icon ? { icon } : {}), title, placeholder: id === 'done' && setupWords ? setupWords : placeholder, submit }));

/** The stake in force now: a newly chosen stake only replaces the one before once the one before's delay has passed
 *  since it was chosen (invariant 5), so a stake is never lowered just before asking off. */
export function stakeNow(state, settings, now) {
  const next = state?.stake_next;
  if (next && Date.parse(next.from) <= now) return next.stake;
  return state?.stake ?? null;
}
const stakeRow = (settings, id) => (settings.off?.stakes ?? []).find(item => item.id === id) ?? null;
const delayOf = (settings, stake) => (stakeRow(settings, stake?.id ?? settings.off?.default_stake)?.delay_minutes ?? 0);

/** The stakes the person may choose, each with whether it is the one in force and whether one chosen waits. */
export const stakesOf = (state, settings, now) => {
  const inForce = stakeNow(state, settings, now)?.id ?? settings.off?.default_stake;
  const waiting = state?.stake_next && Date.parse(state.stake_next.from) > now ? state.stake_next : null;
  // Only what the person chooses between: the stake's AI jobs and their words stay in the settings (stakeJob reads them).
  return (settings.off?.stakes ?? []).map(({ id, label, delay_minutes: delay, fields }) => ({ id, label, delay_minutes: delay, ...(fields ? { fields } : {}), chosen: inForce === id, ...(waiting?.stake.id === id ? { from: waiting.from } : {}) }));
};

/** Chooses, in advance, what turning the hold off costs: one of `off.stakes`, with the values its `fields` ask for. It
 *  is in force once the stake in force now has run its delay (invariant 5); the first stake chosen is in force at once. */
export function chooseStake(state, settings, { stake, values = {} }, now) {
  const row = stakeRow(settings, stake);
  if (!row) throw new Error(settings.words?.no_stake ?? 'Choose one of the stakes offered.');
  const missing = (row.fields ?? []).filter(field => !String(values[field.name] ?? '').trim());
  if (missing.length) throw new Error(fill(settings.words?.stake_needs ?? 'This needs {fields}.', { fields: missing.map(field => field.label).join(', ') }));
  // A record field keeps the chosen row's title (what the stake's words say) and, beside it, the row's id when one was chosen.
  const kept = { id: row.id, ...Object.fromEntries((row.fields ?? []).flatMap(field => [[field.name, String(values[field.name]).slice(0, 300)], ...(field.kind === 'record' && values[`${field.name}_id`] ? [[`${field.name}_id`, String(values[`${field.name}_id`]).slice(0, 300)]] : [])])) };
  const current = stakeNow(state, settings, now);
  const settled = { ...state, stake: current ?? undefined, stake_next: undefined };
  if (!current) return { state: { ...settled, stake: kept }, from: new Date(now).toISOString() };
  const from = new Date(now + delayOf(settings, current) * MINUTE).toISOString();
  return { state: { ...settled, stake_next: { stake: kept, from } }, from };
}

/** Asks for the hold to turn off: it turns off only after the chosen stake's delay (invariant 3), and the stake's job,
 *  when it has one, is handed to the AIs now. */
export function askOff(state, settings, now) {
  if (state?.off?.at && !(Date.parse(state.off.until ?? '') <= now)) return { state, at: state.off.at, until: state.off.until, jobs: [] };
  const stake = stakeNow(state, settings, now);
  const row = stakeRow(settings, stake?.id ?? settings.off?.default_stake) ?? (settings.off?.stakes ?? [])[0];
  if (!row) throw new Error(settings.words?.no_stake ?? 'Choose one of the stakes offered.');
  // Each off asked within `escalate_days` makes the next wait longer (`escalate` times), so turning it off never
  // becomes a price paid without noticing (invariant 6).
  const recent = (state?.offs ?? []).filter(when => Date.parse(when) > now - (settings.off?.escalate_days ?? 0) * 1440 * MINUTE);
  const delay = (row.delay_minutes ?? 0) * (settings.off?.escalate ?? 1) ** recent.length;
  const at = new Date(now + delay * MINUTE).toISOString();
  const until = new Date(Date.parse(at) + (settings.off?.lasts_minutes ?? 1440) * MINUTE).toISOString();
  const values = { ...(stake ?? {}), at, until };
  const jobs = row.job ? [{ job: fill(row.job, values), said: fill(row.said ?? '', values).slice(0, 300), once_per: `hold-off:${now}`, input: { stake: row.id } }] : [];
  return { state: { ...state, on: true, off: { requested_at: new Date(now).toISOString(), at, until, stake: row.id }, offs: [...recent, new Date(now).toISOString()] }, at, until, jobs };
}

/** The job the stake in force carries out, filled with its values, for a reminder rung that carries it when the
 *  person has walked away from what waits (src/waiting-nudge.mjs `carries_stake`); null when the stake has none. */
export function stakeJob(state, settings, now, values = {}) {
  const stake = stakeNow(state, settings, now);
  const row = stakeRow(settings, stake?.id ?? settings.off?.default_stake);
  if (!row?.walked_away) return null;
  const filled = { ...(stake ?? {}), ...values };
  return { job: fill(row.walked_away, filled), said: fill(row.said ?? '', filled).slice(0, 300), input: { stake: row.id } };
}

/** A `devices` run's input for the thing held now: every text's `{key}` and `{title}` are the held thing's, so a run
 *  names the thing itself (src/waiting-on-you.json `hold.devices`). */
export function heldInput(input, held) {
  const fill = value => (typeof value === 'string' ? value.replace(/\{(key|title)\}/g, (_, name) => String(held?.[name] ?? ''))
    : Array.isArray(value) ? value.map(fill)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, fill(item)])) : value);
  return fill(input ?? {});
}

/** Turns the hold on now, free, cancelling an off that has not taken effect. */
export const turnOn = state => ({ state: { ...state, on: true, off: undefined } });

/** Everything the cover draws: whether it holds, the one thing, how many asides are left, the stakes and the off time. */
export function holdView(answer, state, settings, now, options) {
  const ranked = rankedThings(answer, state, settings, now, options);
  const held = ranked[0] ?? null;
  const off = state?.off && !(Date.parse(state.off.until ?? '') <= now) ? state.off : null;
  return {
    on: isOn(state, settings, now),
    // The section goes with its card, without its other cards, so the cover finishes it the way Home and the queue do.
    held: held ? { key: held.key, section: { ...held.section, cards: [] }, card: held.card } : null,
    // Every thing that may hold, in rank order (invariant 8): the held screen moves through them, next and back.
    ranked: ranked.map(thing => ({ key: thing.key, title: thing.card.title ?? thing.section.title })),
    ...(held && answer?.finishes ? { finishes: answer.finishes } : {}),
    every_seconds: settings.every_seconds ?? 90,
    asides_left: asidesLeft(state, settings, now),
    hand_back: handBackWays(settings, held?.card?.setup_words),
    stakes: stakesOf(state, settings, now),
    ...(off ? { off_at: off.at, ...(off.until ? { back_at: off.until } : {}) } : {}),
  };
}
