// src/waiting-nudge.mjs
//
// Purpose
//   Keeps telling the person what only they can do until it is done, louder the longer it waits: while anything in their
//   Waiting on you answer (src/waiting-on-you.json, read by src/card-sections.mjs) has waited `nudge.after_minutes`,
//   they are told how many things wait and which, through the notification owner (src/tell-the-person.mjs). The founder,
//   2026-10-06: "Hey, we are waiting on you", escalating until it's done, everywhere, one tap to the exact thing. The
//   rungs of `nudge.ladder` say how loud: a rung is reached when the oldest thing has waited its `after_minutes`, and
//   says its notice kind (which devices and how loudly), how often and how many times a day, whether the waiting
//   things stay on every live board (`board`: the iPhone's Live Activity and lock screen, the Mac menu bar, widgets,
//   as one running notice under `nudge.board`) and whether the open Trillion page is taken over by the thing itself
//   (`take_over`, tool:take-me-there). Each notice opens the oldest thing's own address, never a list.
//   Before anything is put in the person's face it is weighed (`weigh`, src/who-does-it.mjs): a thing an AI left on the
//   Waiting on you list with the `needs` it has, and no reason only the person can meet, that Trillion or the person's
//   AIs can do is handed to the AIs instead (`handOff`), and the person is never asked about it.
//   A thing that gives a `reason_id` (and `tried_doer`, the helper already stopped) is weighed on it too: a sign-in the person's AIs have
//   not yet tried with a saved login and a browser goes to them first, and reaches the person only after they were stopped.
//
// Non-negotiable invariants
//   1. It shares the store's wake where there is one (`alongside`, keep-running's next look) and never wakes sooner
//      than its rung's interval; with nothing waiting at the last look (`count`, kept by `noteCount` from every read of
//      Waiting on you) and nothing else to wake for, it asks for no wake at all.
//   2. Nothing here names a kind of waiting thing, a device or a channel; the rungs, words, times and kinds are DATA.
//   3. Each nudge has its own key (one per rung and interval), so a nudge retried after a failure is told once; a thing
//      is handed to the AIs once (`once_per` its card id).
//   4. The live board is one running notice changed in place while anything waits, and ended (quietly, `ended_kind`)
//      once nothing does, so a board never stays up after the person is done.
//   5. The hold asks the same doer gate before it shows one waiting thing: what Trillion can do is handed back to the AIs.
//   7. A thing with no working control (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs `controlOf`: nothing to press, no place in Trillion it is
//      done in, no steps) is a defect of whoever filed it: it goes back to the AIs (`hold.no_control.job`, once per card)
//      and is never nudged about or held, so the person is never asked to do what they cannot.
//   6. Each nudge names the oldest waiting thing in its refs (`card`), so an answer to the notice, typed or said aloud,
//      finishes that thing the way its own Finish does (records/tell-the-person.json action `finish`).
//

import { weighCards } from './waiting-weigh.mjs';
import { sameOrigin } from '../parts/http-client/do-work/same-origin.mjs';

const MINUTE = 60_000;
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

/** The cards waiting long enough to nudge about, by section, from a Waiting on you answer. */
export function waitingLongEnough(answer, { after_minutes }, now) {
  return (answer?.sections ?? []).filter(section => section.on_home !== false)
    .map(section => ({ section, cards: section.cards.filter(card => !card.at || Date.parse(card.at) <= now - after_minutes * MINUTE) }))
    .filter(row => row.cards.length);
}

/** The rungs of the ladder, the first built from the nudge's own fields when the DATA names no ladder. */
export function rungsOf(nudge) {
  const first = { id: 'tell', after_minutes: nudge.after_minutes, every_minutes: nudge.every_minutes, most_per_day: nudge.most_per_day, kind: nudge.notice_kind };
  return (Array.isArray(nudge.ladder) && nudge.ladder.length ? nudge.ladder : [first]).slice().sort((a, b) => a.after_minutes - b.after_minutes);
}

/** The loudest rung the oldest waiting thing has reached (`waited` minutes), or null when none. */
export const rungFor = (rungs, waited) => rungs.filter(rung => waited >= rung.after_minutes).at(-1) ?? null;

/** Where a card opens inside Trillion: its own address made relative, or null when it opens outside Trillion. A link
 *  on one of Trillion's own origins (`own_origins`) opens inside Trillion too. */
export function openOf(card, ownOrigins = []) {
  const address = String(card?.address ?? '');
  if (card?.opens?.link && !ownOrigins.some(origin => sameOrigin(address, origin))) return null;
  const path = address.replace(/^https?:\/\/[^/]+/, '');
  return path.startsWith('/') && !path.startsWith('//') ? path : null;
}

/** The needs a card names (a list, or words split on commas), or none. */
const needsOf = card => (Array.isArray(card?.needs) ? card.needs : String(card?.needs ?? '').split(',')).map(need => String(need).trim()).filter(Boolean);

/**
 * read      async () → the person's Waiting on you answer
 * tell      async input → a notice (tell-the-person)
 * report    async input → a running notice changed in place (tell-the-person report), for the live board
 * takeOver  async card → takes the open page to the card (tool:take-me-there)
 * weigh     input → src/who-does-it.mjs whoDoesEachStep's answer
 * handOff   async input → a handed-off job (agents handOff)
 * walkedAway named → the job a chosen stake carries when the person walks away, or null
 * kept      { read() → { last_at, day, today, count, every, board } | null, write(value) }
 * alongside async () → epoch ms the store already wakes at, or null
 * opensScreen address → whether a thing's `does_in` address opens one of the page's screens (invariant 7)
 * settings  waiting-on-you.json (its `nudge`)
 */
export function makeWaitingNudge({ read, tell, report = null, takeOver = null, weigh = null, handOff = null, walkedAway = null, kept, alongside, settings, opensScreen = () => true, now = () => Date.now() }) {
  const nudge = settings.nudge;
  const rungs = rungsOf(nudge);

  // Which cards go to the AIs instead of the person, decided without any hand-off, by the one rule the reader also uses
  // (src/waiting-weigh.mjs): `toAis` is each such card with the exact arguments its hand-off takes; `rows` are the
  // cards the person is asked.
  const sorted = rows => weighCards(rows, { settings, weigh, opensScreen });

  // Things an AI left with what they need and no reason only the person can meet go back to the AIs (weighing): each card
  // `sorted` sends to the AIs is handed off once, and the person is shown the rest.
  // `already` are the cards the reader already took out of the answer for the AIs (its hidden `toAis`), handed off here.
  async function weighed(rows, already = []) {
    if (!handOff) return { rows, handed: [], taken: 0 };
    const decided = sorted(rows);
    const handed = [];
    for (const { card, handOff: job } of [...decided.toAis, ...already]) {
      if (job) await handOff(job);
      handed.push(card.id);
    }
    return { rows: decided.rows, handed, taken: decided.toAis.length };
  }

  return {
    async nextAt() {
      const held = kept.read();
      const shared = await alongside();
      // Nothing was waiting at the last look and the store wakes for nothing else: no wake of its own (invariant 1).
      if ((shared === null || shared === undefined) && held && !held.count) return null;
      const last = Date.parse(held?.last_at ?? '') || 0;
      return Math.max(shared ?? now(), last + (held?.every ?? rungs[0].every_minutes) * MINUTE);
    },
    /** What waits now, as the person's Waiting on you read just counted it; true when it went from nothing to some, so
     *  the caller arms its wake again. */
    async prepareForHold(answer, after_minutes = settings.hold?.after_minutes ?? nudge.after_minutes) {
      return weighed(waitingLongEnough(answer, { after_minutes }, now()));
    },
    /** The ids of the cards prepareForHold hands to the AIs for this answer, decided the same way and handed off by no
     *  one: what the hold must not name to the person or any AI as the thing that needs them. */
    async goesToAis(answer, after_minutes = settings.hold?.after_minutes ?? nudge.after_minutes) {
      if (!handOff) return [];
      return sorted(waitingLongEnough(answer, { after_minutes }, now())).toAis.map(({ card }) => card.id);
    },
    noteCount(count) {
      const held = kept.read() ?? {};
      if ((held.count ?? null) === count) return false;
      kept.write({ ...held, count });
      return !held.count && count > 0;
    },
    // An addressed assignment arrived without the person opening a screen. Arm the existing nudge with a lower
    // bound; its next due read computes the actual count. Never scan a whole account for every space repaint.
    noteAtLeast(count) {
      const held = kept.read() ?? {};
      return this.noteCount(Math.max(held.count ?? 0, count));
    },
    async runDue() {
      const at = now();
      const held = kept.read() ?? {};
      const day = new Date(at).toISOString().slice(0, 10);
      const today = held.day === day ? held.today ?? {} : {};
      const counts = typeof today === 'number' ? { [rungs[0].id]: today } : today;
      const answer = await read();
      const { rows, handed, taken } = await weighed(waitingLongEnough(answer, nudge, at), answer?.toAis ?? []);
      // What the AIs take counts as waiting too (as the reader notes it), so the wake that hands it to them keeps coming.
      const waiting = (answer?.sections ?? []).filter(section => section.on_home !== false).reduce((sum, section) => sum + section.cards.length, 0) - taken + (answer?.toAis?.length ?? 0);
      const cards = rows.flatMap(row => row.cards.map(card => ({ card, section: row.section })));
      const count = cards.length;
      const oldest = cards.slice().sort((a, b) => (Date.parse(a.card.at ?? '') || 0) - (Date.parse(b.card.at ?? '') || 0))[0] ?? null;
      const waited = oldest ? (at - (Date.parse(oldest.card.at ?? '') || at)) / MINUTE : 0;
      const rung = count ? rungFor(rungs, Math.max(waited, nudge.after_minutes)) : null;
      const open = (oldest && openOf(oldest.card, nudge.own_origins)) || nudge.open;
      const words = rows.map(row => fill(settings.said.row, { title: row.section.title, count: row.cards.length })).join(settings.said.joiner ?? ', ');
      let told = false;
      if (rung && (counts[rung.id] ?? 0) < rung.most_per_day) {
        const receipt = await tell({
          key: `needs-you:${rung.id}:${Math.floor(at / (rung.every_minutes * MINUTE))}`, kind: rung.kind,
          title: fill(rung.title ?? nudge.title, { count, first: oldest?.card.title ?? '' }),
          body: fill(rung.body ?? nudge.body, { rows: words, count, first: oldest?.card.title ?? '' }), refs: { open, ...(oldest ? { card: oldest.card.id } : {}) }, open,
        });
        counts[rung.id] = (counts[rung.id] ?? 0) + 1;
        // The daily count bounds attempts even if no provider accepted them. A recorded notice is not a telling.
        told = receipt?.delivery_accepted === true || receipt?.awareness === 'read-receipt';
        if (rung.take_over && takeOver && oldest && open !== nudge.open) await takeOver(oldest.card, rung).catch(() => null);
        // Walked away long enough: what the person chose in advance happens, at most once each day.
        if (rung.carries_stake && walkedAway && handOff && oldest) {
          const job = walkedAway({ first: oldest.card.title ?? '', count, waited: Math.round(waited / 60) });
          if (job) await handOff({ ...job, once_per: `hold-walked-away:${day}` }).catch(() => null);
        }
      }
      // The live board: up while anything waits at a rung that asks for it, ended once nothing does (invariant 4).
      let board = held.board ?? false;
      if (report && nudge.board) {
        if (rung?.board) {
          const named = { count, first: oldest?.card.title ?? '', section: oldest?.section.title ?? '' };
          await report({ key: nudge.board.key, kind: rung.kind, state: 'running', title: fill(nudge.board.title, named), body: fill(nudge.board.body, { ...named, rows: words }), open, source: nudge.board.source }).catch(() => null);
          board = true;
        } else if (board && !count) {
          await report({ key: nudge.board.key, kind: nudge.board.ended_kind, state: 'done', title: nudge.board.ended_title, open: nudge.open }).catch(() => null);
          board = false;
        }
      }
      kept.write({ last_at: new Date(at).toISOString(), day, today: counts, count: waiting, every: (rung ?? rungs[0]).every_minutes, board });
      return { told, count, ...(rung ? { rung: rung.id } : {}), ...(handed.length ? { handed } : {}) };
    },
  };
}
