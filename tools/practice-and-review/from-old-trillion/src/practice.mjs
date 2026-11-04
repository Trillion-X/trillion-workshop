// src/practice.mjs
//
// Purpose
//   Practice that comes back until it sticks. A card is anything a person wants to get right without thinking (a word
//   to say instead of another, a habit, a fact, a correction they keep giving): its prompt, its answer and why it
//   matters. Each card returns on a spaced repetition schedule; grading it moves the next return further out or brings
//   it back tomorrow, and mastery counts how far out it now holds. One account action (`practice`, tool:practice) with
//   operations add, due, grade, cards, remove and remind; one daily schedule runs remind by itself.
//
// Non-Negotiable Invariants
//   1. The schedule, the grades, mastery and every word said are DATA (src/practice.json); nothing here names a deck,
//      a subject or a person.
//   2. A card is one current value per id in this account's workshop facts; grading writes a new value, removing marks
//      it removed, so every past state stays readable.
//   3. A missed card (grade below `missed_below`) starts over at the first interval; ease never drops below
//      `lowest_ease`.
//   4. Trillion pays for no model here: the person's own AI decides what is worth practising and grades the answer;
//      this module only keeps cards, schedules them and counts.
//
import settings from './practice.json' with { type: 'json' };

export class PracticeError extends Error {
  constructor(message) { super(message); this.status = 400; }
}
const { schedule: S, grades: GRADES, words, limits, reminder } = settings;
const DAY_MS = 86_400_000;
const say = (key, values = {}) => words[key].replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const slug = value => String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const day = instant => new Date(instant).toISOString().slice(0, 10);

/** How far out a card now holds, from 0 to mastery_max. */
export const masteryOf = intervalDays => Math.min(S.mastery_max, Math.round(S.mastery_max * Math.max(0, intervalDays) / S.full_mastery_days));

/**
 * The card after one grade (SM-2): quality is the grade's worth from 0 to 1 (src/practice.json grades), read on the
 * classic 0-5 scale for the ease change. Returns the new state fields; the caller keeps the rest of the card.
 */
export function nextReview({ reps = 0, ease = S.starting_ease, interval_days: interval = 0 }, quality, now) {
  if (typeof quality !== 'number' || quality < 0 || quality > 1) throw new PracticeError('A grade is worth a number from 0 to 1.');
  const q5 = quality * 5;
  const nextEase = Math.max(S.lowest_ease, ease + (0.1 - (5 - q5) * (0.08 + (5 - q5) * 0.02)));
  const missed = quality < S.missed_below;
  const nextReps = missed ? 0 : reps + 1;
  const nextInterval = missed || nextReps === 1 ? S.first_interval_days
    : nextReps === 2 ? S.second_interval_days
      : Math.max(1, Math.round(interval * nextEase));
  return { reps: nextReps, ease: Math.round(nextEase * 1000) / 1000, interval_days: nextInterval, due_at: new Date(now + nextInterval * DAY_MS).toISOString(), mastery: masteryOf(missed ? 0 : nextInterval), missed };
}

/**
 * io: { list() -> [card], put(id, card), schedule(input), tell(notice), now() }
 */
export function makePractice(io) {
  const now = () => io.now?.() ?? Date.now();
  const current = () => io.list().filter(card => card && typeof card.id === 'string' && !card.removed_at);
  const find = id => {
    const card = current().find(row => row.id === text(id));
    if (!card) throw new PracticeError('No card with that card_id. Read them with operation cards.');
    return card;
  };
  const shown = card => ({ card_id: card.id, prompt: card.prompt, answer: card.answer, why: card.why ?? null, deck: card.deck ?? null, source_ref: card.source_ref ?? null, due_at: card.due_at, mastery: card.mastery ?? 0, reps: card.reps ?? 0, lapses: card.lapses ?? 0 });
  const dueNow = deck => current()
    .filter(card => (!deck || card.deck === deck) && Date.parse(card.due_at) <= now())
    .sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at) || a.id.localeCompare(b.id));
  const ensureReminder = time_zone => io.schedule({
    schedule_id: reminder.schedule_id,
    label: reminder.label,
    every: { unit: 'day', at: reminder.at, time_zone },
    then: { tool_id: 'tool:practice', input: { operation: 'remind' } },
  });

  const operations = {
    async add({ prompt, answer, why, deck, source_ref, time_zone }) {
      if (!text(prompt) || !text(answer)) throw new PracticeError('A card needs a prompt and its answer.');
      if (current().length >= limits.cards) throw new PracticeError(`An account practises at most ${limits.cards} cards. Remove one first.`);
      const id = slug(`${text(deck) ?? 'card'}-${prompt}`) || `card-${now()}`;
      const earlier = current().find(card => card.id === id);
      const card = {
        ...(earlier ?? { reps: 0, ease: S.starting_ease, interval_days: 0, lapses: 0, mastery: 0, due_at: new Date(now()).toISOString(), added_at: new Date(now()).toISOString() }),
        id, prompt: text(prompt), answer: text(answer), why: text(why), deck: text(deck), source_ref: source_ref === undefined ? earlier?.source_ref ?? null : text(source_ref),
      };
      io.put(id, card);
      if (text(time_zone)) await ensureReminder(time_zone.trim());
      return { ...shown(card), said: say('added', { prompt: card.prompt, due: earlier ? `on ${day(card.due_at)}` : 'today' }) };
    },

    async due({ deck, limit }) {
      const cards = dueNow(text(deck)).slice(0, Math.min(limits.due_per_read, Number(limit) || limits.due_per_read));
      if (cards.length) return { cards: cards.map(shown), said: say('due', { count: cards.length, prompt: cards[0].prompt }) };
      const next = current().sort((a, b) => Date.parse(a.due_at) - Date.parse(b.due_at))[0];
      return { cards: [], said: next ? say('none_next', { next: `on ${day(next.due_at)}` }) : say('none') };
    },

    async grade({ card_id: cardId, grade }) {
      const card = find(cardId);
      if (!Object.hasOwn(GRADES, grade)) throw new PracticeError(`grade is one of ${Object.keys(GRADES).join(', ')}.`);
      const next = nextReview(card, GRADES[grade], now());
      const updated = { ...card, reps: next.reps, ease: next.ease, interval_days: next.interval_days, due_at: next.due_at, mastery: next.mastery, lapses: (card.lapses ?? 0) + (next.missed ? 1 : 0), last_grade: grade, last_at: new Date(now()).toISOString() };
      io.put(card.id, updated);
      const said = next.missed
        ? say('missed', { prompt: card.prompt, answer: card.answer })
        : say('graded', { grade: grade[0].toUpperCase() + grade.slice(1), prompt: card.prompt, due: `on ${day(next.due_at)}`, mastery: next.mastery, max: S.mastery_max });
      return { ...shown(updated), said };
    },

    async cards({ deck }) {
      const cards = current().filter(card => !text(deck) || card.deck === text(deck)).map(shown);
      return { cards, mastery: cards.length ? Math.round(cards.reduce((sum, card) => sum + card.mastery, 0) / cards.length) : 0 };
    },

    async remove({ card_id: cardId }) {
      const card = find(cardId);
      io.put(card.id, { ...card, removed_at: new Date(now()).toISOString() });
      return { card_id: card.id, said: say('removed', { prompt: card.prompt }) };
    },

    async remind() {
      const cards = dueNow(null);
      if (!cards.length) return { cards: [], said: say('none') };
      const said = say('due', { count: cards.length, prompt: cards[0].prompt });
      await io.tell({ title: words.remind_title, body: said, kind: 'practice', key: `practice:${day(now())}`, open: settings.open }).catch(() => null);
      return { cards: cards.slice(0, limits.due_per_read).map(shown), said };
    },
  };

  return {
    async run({ operation, ...input } = {}) {
      const run = operations[operation];
      if (!run) throw new PracticeError(`operation is one of ${Object.keys(operations).join(', ')}.`);
      return run(input);
    },
  };
}

export const practiceActions = store => ({
  practice: input => makePractice({
    list: () => store.workshopValues('practice-card:'),
    put: (id, card) => store.addWorkshopValue(`practice-card:${id}`, card),
    schedule: input => store.automations().setSchedule(input),
    tell: notice => store.tellThePerson().tell(notice),
  }).run(input ?? {}),
});
