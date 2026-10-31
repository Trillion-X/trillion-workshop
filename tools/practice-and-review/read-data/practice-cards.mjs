// tools/practice-and-review/read-data/practice-cards.mjs
//
// tool:practice: a person's cards to get right every time, kept in their own records and brought back by the review
// schedule (review-schedule.mjs). One function, `practice(input, { door })`, with the operations add, due, grade, cards,
// remove and remind. The scheduling is the existing engine's; this file only keeps the cards and the grades through the
// records door and asks the engine when each is due.
//
// Invariants:
//   1. Nothing here names a subject, a grade word or a number that shapes spacing: the policy (starting ease, gaps,
//      lapse quality, the grade words and their quality) is the person's record, or comes with the request; there is no
//      default. Which record types hold the cards, the grades and the policy, and every sentence, are DATA (practice-cards.json).
//   2. A due time is never stored. Each grade is its own record, and a card's standing is folded from its grades each
//      time, so the grades are the only record and the queue cannot drift from them.
//   3. A card's id comes from its deck and its prompt (BLAKE3), so adding the same prompt again keeps its progress
//      and only refreshes its answer and why.
//   4. Nothing is sent: `remind` answers how many are due and the sentence; whoever runs it (a wake, a workflow) tells the person.
import { readFileSync } from 'node:fs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import { dueQueueFromResponses, parseTime, scheduleNextReview } from './review-schedule.mjs';

export const readSettings = () => JSON.parse(readFileSync(new URL('./practice-cards.json', import.meta.url), 'utf8'));
const OPERATIONS = ['add', 'due', 'grade', 'cards', 'remove', 'remind'];
const refuse = words => { throw new Error(words); };
const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));

const cardId = (deck, prompt, settings) => `${settings.card_id_start}${deck}:${makeHashCodeHexFromBytes(new TextEncoder().encode(`${deck}\u0000${prompt}`)).slice(3, 3 + settings.card_id_hex)}`;

async function readAll(door, type) {
  const rows = [];
  for await (const record of door.list({ type })) rows.push(record);
  return rows;
}

async function policyOf(input, door, settings) {
  if (input.policy) return input.policy;
  const held = await door.read(settings.types.policy, `${settings.types.policy}:${text(input.policy_id) ?? settings.default_policy_id}`);
  return held ?? refuse(settings.words.no_policy);
}

/** The cards of a deck (or all), each with its grades folded into where it stands. */
async function standings(input, door, settings, nowMs) {
  const deck = text(input.deck);
  const cards = (await readAll(door, settings.types.card)).map(record => ({ id: record.id, ...record.value })).filter(card => !deck || card.deck === deck);
  const grades = (await readAll(door, settings.types.grade)).map(record => record.value);
  const policy = await policyOf(input, door, settings);
  const queue = dueQueueFromResponses({ prompts: cards.map(card => ({ ...card, text: card.prompt })), responses: grades, nowMs, policy });
  return { policy, queue };
}

const masteryOf = (state, policy, settings) => {
  const full = policy[settings.mastery_field];
  if (!state || typeof full !== 'number' || full <= 0) return null;
  return Math.round(Math.min(1, state.interval_days / full) * settings.mastery_scale);
};

const shown = (standing, policy, settings) => ({
  card_id: standing.prompt.id, prompt: standing.prompt.prompt, answer: standing.prompt.answer, ...(standing.prompt.why ? { why: standing.prompt.why } : {}),
  deck: standing.prompt.deck, due: standing.is_due, due_at: standing.due_at, reviews: standing.review_count, mastery: masteryOf(standing.state, policy, settings),
});

export async function practice(input, { door, now = () => new Date() } = {}) {
  const settings = readSettings();
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('Send an object.');
  const operation = input.operation;
  if (!OPERATIONS.includes(operation)) refuse(`operation is one of: ${OPERATIONS.join(', ')}.`);
  const at = now();

  if (operation === 'add') {
    const prompt = text(input.prompt) ?? refuse('add needs a prompt.');
    const answer = text(input.answer) ?? refuse('add needs an answer.');
    const deck = text(input.deck) ?? settings.default_deck;
    if (/[^\w.-]/.test(deck)) refuse('deck is made of letters, numbers, dots, dashes and underscores.');
    const id = cardId(deck, prompt, settings);
    const held = await door.read(settings.types.card, id);
    const value = { ...(held ?? { added_at: at.toISOString() }), prompt, answer, deck, ...(text(input.why) ? { why: text(input.why) } : {}), ...(text(input.source_ref) ? { source_ref: text(input.source_ref) } : {}) };
    await door.write([{ id, type: settings.types.card, value }], { key: `practice-add-${id}-${makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(value))).slice(3, 19)}` });
    return { card_id: id, deck, kept_progress: held !== null };
  }

  if (operation === 'grade') {
    const id = text(input.card_id) ?? refuse('grade needs a card_id.');
    const grade = text(input.grade) ?? refuse('grade needs a grade.');
    const card = await door.read(settings.types.card, id) ?? refuse(fill(settings.words.no_card, { card_id: id }));
    const policy = await policyOf(input, door, settings);
    const grades = (await readAll(door, settings.types.grade)).map(record => record.value).filter(row => row.prompt_id === id);
    const before = dueQueueFromResponses({ prompts: [{ id }], responses: grades, nowMs: at.getTime(), policy })[0];
    const next = scheduleNextReview({ prior: before.state ?? undefined, grade, reviewedAtMs: at.getTime(), policy });
    const gradeId = `${settings.grade_id_start}${id.slice(settings.card_id_start.length)}:${at.getTime()}`;
    await door.write([{ id: gradeId, type: settings.types.grade, value: { prompt_id: id, grade, at: at.toISOString() } }], { key: `practice-grade-${gradeId}` });
    return {
      card_id: id, prompt: card.prompt, grade, grade_in_policy: next.grade_in_policy, lapsed: next.lapsed, due_at: new Date(next.dueAtMs).toISOString(),
      mastery: masteryOf(next.state, policy, settings),
    };
  }

  if (operation === 'remove') {
    const id = text(input.card_id) ?? refuse('remove needs a card_id.');
    await door.write([{ id, type: settings.types.card, value: null }], { key: `practice-remove-${id}` });
    return { card_id: id, removed: true };
  }

  const { policy, queue } = await standings(input, door, settings, at.getTime());
  const due = queue.filter(standing => standing.is_due);
  if (operation === 'cards') return { cards: queue.map(standing => shown(standing, policy, settings)) };
  if (operation === 'due') {
    const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : settings.due_limit_default;
    return { due_count: due.length, cards: due.slice(0, limit).map(standing => shown(standing, policy, settings)) };
  }
  return {
    due_count: due.length,
    said: due.length ? fill(due.length === 1 ? settings.words.remind_one : settings.words.remind_many, { count: due.length }) : settings.words.remind_none,
  };
}
