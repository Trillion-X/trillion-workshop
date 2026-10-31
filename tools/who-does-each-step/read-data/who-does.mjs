// tools/who-does-each-step/read-data/who-does.mjs
//
// The one gate between a plan and a person: for every step of a plan, protocol, checklist or workflow, say who should do
// it. The side that does the work (a tool, a workflow or the person's AIs), that side after one tap (it spends money or
// reaches someone), the person (only for a reason they alone can meet, with every helping doer attached), or nobody yet
// (a doer to build, never a to-do). tool:who-does-each-step runs it and tool:what-can-trillion-do lists the doers.
//
// Invariants
//   1. Blind: nothing here names a doer, a need, a reason or a vendor. Doers, reasons, words and ranking are DATA that
//      come with the request (the words and the ranking also have defaults in words.json); a new doer is a row in the
//      caller's list.
//   2. A step is the person's only when it gives a reason from `only_a_person`; a step nobody can do yet is
//      `nobody-yet`, so no step ever silently lands on the person.
//   2a. A reason the person meets once (`given_once`, such as their consent) is not asked again: a step that names the
//      person's own message that already gave it (`given_in`) is done for them, so already-authorized work never comes
//      back as an approval ask, through any retry, hand-off or new session that carries the step.
//   3. Spending money or reaching someone outside the account is one tap the first time (`approved` lists doers the
//      person already said yes to); nothing here spends or sends, it only says who and what would run.
//   2b. A reason that names a `first_try` doer (a sign-in only the person can give) is the person's only after that doer
//      was tried on the step and failed (`past`, on the call or on the step); until then the step goes to that doer
//      (`first_try` in the answer), so an AI that could sign in with a saved login and a browser is never skipped.
//   4. Past outcomes rank doers that cover the same need (`past`), deterministically, so equal inputs give equal answers.
//
// Key concepts
//   step   { id?, words, needs?: [words], only_a_person_because?: reason id, given_in?: person message id, past?: [{ doer, result }], input?: object }
//   doer   { id, label, does: [words], tool_id?, purpose?, hand_off?, how?, cost?: { usd, per }, spends?, reaches_others? }
//   reason { id, words, given_once?, first_try?: doer id }
//   answer { steps: [{ id, words, who, doers: [{ id, label, tool_id?, purpose?, hand_off?, cost, spends, reaches_others, needs_a_tap }],
//            uncovered, reason?, said }], counts, said }
import { readFileSync } from 'node:fs';

const defaults = JSON.parse(readFileSync(new URL('./words.json', import.meta.url), 'utf8'));

const LITTLE = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'for', 'at', 'in', 'on', 'it', 'its', 'this', 'that', 'with', 'by', 'up', 'out', 'our', 'your', 'their', 'some', 'any']);
const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const wordsOf = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(word => word && !LITTLE.has(word));
const stem = word => word.replace(/(ing|ed|es|s)$/, '') || word;
const stems = text => new Set(wordsOf(text).map(stem));

/** How closely a phrase covers a need: 0 when not, else how many words the shorter shares with the longer (every word
 *  of the shorter must be in the longer, both reduced to their stems), so the most specific phrase wins. */
export function covers(phrase, need) {
  const a = stems(phrase); const b = stems(need);
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const word of small) if (!big.has(word)) return 0;
  return small.size;
}

const scoreOf = (doer, past, ranking) => (past ?? []).filter(row => row?.doer === doer.id)
  .reduce((sum, row) => sum + (ranking[row.result] ?? 0), 0);

const costWords = (doers, words) => {
  const paid = doers.filter(doer => doer.cost?.usd > 0);
  if (!paid.length) return words.free;
  return paid.map(doer => fill(words.cost, { usd: doer.cost.usd, per: doer.cost.per ?? '' }).trim()).join(words.joiner);
};

const refuse = words => { throw new Error(words); };

/** The doers, the reasons, the words and the ranking of one request, checked whole: a doer or reason that is not plainly
 *  shaped is refused, never guessed. */
function readData(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('Send an object.');
  const { doers, only_a_person: reasons = [] } = input;
  if (!Array.isArray(doers) || !doers.length) refuse('doers is a list of the doers that can do steps: { id, label, does: [words], ... }.');
  for (const doer of doers) {
    if (!doer || typeof doer.id !== 'string' || !doer.id || typeof doer.label !== 'string' || !Array.isArray(doer.does) || doer.does.some(phrase => typeof phrase !== 'string')) refuse('Each doer is { id, label, does: [words], ... }.');
  }
  if (!Array.isArray(reasons) || reasons.some(reason => !reason || typeof reason.id !== 'string' || typeof reason.words !== 'string')) refuse('only_a_person is a list of reasons: { id, words, given_once?, first_try? }.');
  return {
    doers,
    only_a_person: reasons,
    words: { ...defaults.words, ...(input.words && typeof input.words === 'object' ? input.words : {}) },
    ranking: { ...defaults.ranking, ...(input.ranking && typeof input.ranking === 'object' ? input.ranking : {}) },
  };
}

/**
 * input { steps, doers, only_a_person?, approved?, past?, words?, ranking? }: the doers and the reasons come with the request.
 */
export function whoDoesEachStep(input) {
  const data = readData(input);
  const { doers, only_a_person: reasons, words, ranking } = data;
  const approved = new Set(input?.approved ?? []);
  const reasonById = new Map(reasons.map(reason => [reason.id, reason]));
  const steps = (Array.isArray(input?.steps) ? input.steps : []).map((step, index) => {
    const text = typeof step === 'string' ? step : step?.words ?? '';
    const claimed = reasonById.get(step?.only_a_person_because) ?? null;
    const given = claimed?.given_once && typeof step?.given_in === 'string' && step.given_in.trim() ? step.given_in.trim() : null;
    // A reason with a `first_try` doer is not the person's until that doer has been tried on this step and failed (a
    // `past` row), so what an AI could have done is never put on the person for want of trying.
    const firstTry = claimed?.first_try ? doers.find(doer => doer.id === claimed.first_try) ?? null : null;
    const tried = (past => firstTry && past.some(row => row?.doer === firstTry.id && row.result === 'failed'))([...(input?.past ?? []), ...(Array.isArray(step?.past) ? step.past : [])]);
    const waived = !!firstTry && !tried && !given;
    const reason = waived ? null : claimed;
    // A step that gives its needs is weighed on them; one that gives none is weighed on its words, unless it is the
    // person's for a reason, when only the needs it names get helping doers.
    const named = typeof step === 'object' && Array.isArray(step?.needs) && step.needs.length ? step.needs : null;
    const needs = (named ?? (claimed ? [] : [text])).filter(Boolean);
    const chosen = []; const uncovered = [];
    for (const need of needs) {
      const able = doers.map((doer, order) => ({ doer, order, fit: Math.max(0, ...doer.does.map(phrase => covers(phrase, need))) }))
        .filter(row => row.fit > 0)
        .map(row => ({ ...row, free: !row.doer.spends && !row.doer.reaches_others || approved.has(row.doer.id), score: scoreOf(row.doer, input?.past, ranking) }))
        .sort((x, y) => (y.fit - x.fit) || (y.score - x.score) || (Number(y.free) - Number(x.free)) || ((x.doer.cost?.usd ?? 0) - (y.doer.cost?.usd ?? 0)) || (x.order - y.order));
      if (!able.length) { uncovered.push(need); continue; }
      if (!chosen.some(row => row.doer.id === able[0].doer.id)) chosen.push(able[0]);
    }
    if (waived && !chosen.some(row => row.doer.id === firstTry.id)) chosen.unshift({ doer: firstTry, free: true });
    const shown = chosen.map(({ doer, free }) => ({
      id: doer.id, label: doer.label, ...(doer.tool_id ? { tool_id: doer.tool_id } : {}), ...(doer.purpose ? { purpose: doer.purpose } : {}),
      ...(doer.hand_off ? { hand_off: true } : {}), ...(doer.how ? { how: doer.how } : {}), cost: doer.cost ?? { usd: 0 }, spends: !!doer.spends, reaches_others: !!doer.reaches_others, needs_a_tap: !free,
    }));
    const labels = shown.map(doer => doer.label).join(words.joiner);
    let who; let said;
    if (given) {
      who = 'trillion';
      said = fill(words.already_given, { given_in: given, with: shown.length ? fill(words.already_given_with, { doers: labels }) : '' });
    } else if (waived) {
      who = 'trillion';
      said = fill(words.try_first, { doers: labels });
    } else if (reason) {
      who = 'you';
      said = shown.length ? fill(words.you, { reason: reason.words, doers: labels }) : fill(words.you_alone, { reason: reason.words });
    } else if (uncovered.length) {
      who = 'nobody-yet';
      said = fill(words.nobody_yet, { needs: uncovered.join(words.joiner) });
    } else if (shown.some(doer => doer.needs_a_tap)) {
      who = 'one-tap';
      said = fill(words.one_tap, { doers: labels, cost: costWords(shown.filter(doer => doer.needs_a_tap), words) });
    } else {
      who = 'trillion';
      said = fill(words.trillion, { doers: labels });
    }
    return { id: String(step?.id ?? index + 1), words: text, who, doers: shown, uncovered, ...(reason ? { reason: reason.id } : {}), ...(waived ? { first_try: firstTry.id } : {}), ...(given ? { given_in: given } : {}), ...(step?.input ? { input: step.input } : {}), said };
  });
  const counts = { trillion: 0, 'one-tap': 0, you: 0, 'nobody-yet': 0 };
  for (const step of steps) counts[step.who] += 1;
  return { steps, counts, said: fill(words.summary, { trillion: counts.trillion, one_tap: counts['one-tap'], you: counts.you, nobody_yet: counts['nobody-yet'] }) };
}

/** What can do steps and the reasons a step may stay the person's, for a caller choosing `needs` words. */
export function whoCanDo(input) {
  const data = readData(input);
  return {
    doers: data.doers.map(({ id, label, does, cost, spends, reaches_others }) => ({ id, label, does, cost: cost ?? { usd: 0 }, spends: !!spends, reaches_others: !!reaches_others })),
    only_a_person: data.only_a_person,
  };
}
