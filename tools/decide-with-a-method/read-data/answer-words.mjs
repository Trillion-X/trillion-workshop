// tools/decide-with-a-method/read-data/answer-words.mjs
//
// PURPOSE
//   The words a person reads for what a decision answered at each row of its method: workedSteps (each row the decision
//   has an answer for, in the view's order, with its question, its labelled answer rows and how the answer was checked),
//   answerRows (one answer's labelled rows) and checkRows (how one answer was checked, by its row's strictness).
//   Ported from the old app's src/answer-words.mjs (answerRows, workedSteps, checkRows; at b6ae0ebf8). The old file read
//   its steps, field labels and observers from methods/methods.json. A method is now a saved view over the person's method
//   rows (method-rows/view.mjs), so the steps are the view's rows, the question is the row's own `question`, and the
//   labels are the words of read-data/answer-words.json. The old value and observer templates and decisionWords are not
//   ported: no caller reads them, and a method row carries neither field labels nor templates.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Every word comes from read-data/answer-words.json or is the person's own text (a row's question, the answer). No
//      internal name, evidence ref, record id or strictness source name is shown as text.
//   2. Reading writes nothing. Answers are read from the store the caller handed in, and the rows and strictness come
//      from the view's own reader (method-rows/view.mjs), never from a copy of them here.
//   3. Who answered is said only when answer-words.json has a word for it; an answerer with no word is not named.
import settings from '../method-rows/settings.json' with { type: 'json' };
import words from './answer-words.json' with { type: 'json' };
import { rowsOfMethod, strictnessOf } from '../method-rows/view.mjs';
import { isLegacyDecision, legacyAnswers, legacyMethodRows } from './legacy-decision.mjs';

const blank = value => value === null || value === undefined || (typeof value === 'string' && !value.trim());
// One answer's key, as method-rows/answers.mjs writes it (its answerKey is not exported there).
const answerKey = (decision, row) => `${settings.answers.type}:${decision}:${encodeURIComponent(row)}`;
const answerer = by => (Object.hasOwn(words.answerers, by) ? ` (${words.answerers[by]})` : '');

// The labelled rows of one answer: the answer itself, labelled with who answered when there is a word for it, then one row
// for each cited row that has a question. Evidence the answer cites is not shown as text: it is a ref, not words.
export function answerRows(answer, rowsById) {
  if (!answer || typeof answer !== 'object') return [];
  const label = words.label + (typeof answer.by === 'string' ? answerer(answer.by) : '');
  const cited = (answer.cites ?? [])
    .map(id => rowsById.get(id)?.values.question)
    .filter(question => !blank(question))
    .map(question => ({ label: words.cites, text: String(question).trim() }));
  return [...(blank(answer.answer) ? [] : [{ label, text: String(answer.answer).trim() }]), ...cited];
}

// How one answer was checked: the strictness of its row (its own, the view's or the default). The strictness's own `says`
// sentence wins over the shipped word for its source; a review it asked for is said too.
export function checkRows(answer, strictness) {
  const from = Object.hasOwn(words.checked_from, strictness?.from) ? words.checked_from[strictness.from] : null;
  const rows = [
    { label: words.checked_by, text: strictness?.says ?? from },
    answer?.review === settings.strictness.review_asked ? { label: words.review, text: words.review_asked } : null,
  ];
  return rows.filter(row => row && !blank(row.text));
}

// One worked step: the row's question, the labelled rows of its answer and how the answer was checked.
const workedStep = (row, answer, byId, strictness) => ({
  step_id: row.id,
  question: row.values.question ?? null,
  rows: answerRows(answer, byId),
  checks: checkRows(answer, strictness),
});

// The worked steps of the saved view's answers: each row of the view that has an answer, in the view's order. A row with no
// answer is left out.
function viewWorkedSteps(held, decision, method) {
  const { record, rows } = rowsOfMethod(held, method);
  const byId = new Map(rows.map(row => [row.id, row]));
  return rows.flatMap(row => {
    const answer = held.get(settings.answers.type, answerKey(decision, row.id));
    if (!answer || typeof answer !== 'object') return [];
    return [workedStep(row, answer, byId, strictnessOf(row.values, record))];
  });
}

// The worked steps of a decision: a decision made before method rows first, its answers as they were written, read with
// the method it was made with (read-data/legacy-decision.mjs); then the saved view's answers. The two are kept apart: a
// legacy step id is not a method row id, so an answer to a view row is shown even beside a legacy answer. A legacy decision
// needs no saved view, so none is read for it unless `method` is named.
export function workedSteps(held, decision, method) {
  const root = held.get('decision', decision);
  const legacy = isLegacyDecision(root) ? legacyWorkedSteps(root) : [];
  const view = isLegacyDecision(root) && method === undefined ? [] : viewWorkedSteps(held, decision, method);
  return [...legacy, ...view];
}

// The worked steps of a legacy root: its answers as legacy-decision.mjs reads them, each row checked by the strictness the
// snapshot's own row carries (the default, which says so).
function legacyWorkedSteps(root) {
  const rows = legacyMethodRows(root);
  const byId = new Map(rows.map(row => [row.id, row]));
  return legacyAnswers(root).map(({ row, answer }) => workedStep(byId.get(row), answer, byId, byId.get(row).strictness));
}
