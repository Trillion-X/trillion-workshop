// tools/triage-against-priorities/read-data/triage.mjs
//
// Purpose
//   Triage one incoming item (a message, a note, a finding, a run's result) against the priorities a person gave and
//   settle it on one disposition from the disposition rows the person gave. Two pure steps: briefFor() gives the AI the
//   item, the dispositions and the priorities with the rules for its answer; settleTriage() takes the AI's answer and
//   keeps it only if it holds, else fails closed to the person's fallback disposition. The tool asks no model itself:
//   the AI that called it is the one that judges.
//
// Non-negotiable invariants
//   1. The priorities, the dispositions (their refs, labels, which one is the fallback, which are blocked until
//      something else clears them, which need an objective) and the least confidence are the person's input. The code
//      holds none: no priority, no disposition word, no threshold.
//   2. Fail closed. No priorities, no answer, more than one answer, a confidence under the least, a disposition the
//      rows do not list, or a disposition that needs an objective and has none: the decision is the fallback
//      disposition, blocked, with every reason in words.
//   3. A decision never does anything. `blocked` says whether the disposition's own owner may act on it yet: it is
//      true unless the row says blocked_default is false, and always true for the fallback.
//   4. One decision has one id, made from the item's ref and version, so the same item at the same version settles
//      to the same record.
//
// Ported from bitfield-packages packages/commander-triage: its rubric, its five checks (answer completed, exactly one
// answer, confidence, disposition admitted, objective for the kind that needs one) and its fail-closed decision are the
// same. The rubric's guidance is carried: the objective is the smallest safe, reversible assignment that produces
// evidence; it may not authorize messages, spending, publishing, promises, credential changes, changes to a live
// system, anything illegal, deceiving or harassing anyone, or taking what is another party's; the rationale and the
// objective have word limits.
// Changed: the old engine's record queries, triggers, process-session launch and brief screen are gone, the rubric's
// role wording ("the founder's chief officer") is gone, and the numbers are the person's: the 0.6 floor is
// `min_confidence` and the old word limits (25 and 60) are `max_words`, with no default for either. The kind that
// needs an objective is a disposition row's `needs_objective`. The guidance wording is general and always in the brief;
// it has no per-person part, because a limit on what an objective may authorize is the same for everyone.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const wordCount = value => value.trim().split(/\s+/).filter(Boolean).length;
// The answer fields that may have a word limit (`max_words`), in the order they are checked.
const LIMITED = ['rationale', 'objective'];

export function checkRows({ item, priorities, dispositions, min_confidence, max_words }) {
  if (max_words !== undefined) {
    if (!isRecord(max_words) || Object.keys(max_words).some(key => !LIMITED.includes(key))
      || Object.values(max_words).some(limit => !Number.isInteger(limit) || limit < 1)) {
      throw new Error(`max_words limits the words of an answer's ${LIMITED.join(' and ')}: a whole number of 1 or more for each one named.`);
    }
  }
  if (!isRecord(item) || !nonEmpty(item.ref)) throw new Error('item needs a ref: the stable name of the thing being triaged.');
  if (item.version !== undefined && typeof item.version !== 'string') throw new Error('item.version must be text (a cursor or content identity) when given.');
  if (!Array.isArray(priorities) || priorities.some(row => !isRecord(row))) throw new Error('priorities must be a list of records; give an empty list to say there are none.');
  if (typeof min_confidence !== 'number' || !(min_confidence >= 0 && min_confidence <= 1)) throw new Error('min_confidence is the least confidence an answer may have, a number from 0 to 1; it is the person\'s to give.');
  if (!Array.isArray(dispositions) || dispositions.length === 0) throw new Error('dispositions must list what an item can be settled as.');
  const seen = new Set();
  for (const row of dispositions) {
    if (!isRecord(row) || !nonEmpty(row.ref) || !nonEmpty(row.label)) throw new Error('every disposition needs a ref and a label.');
    if (seen.has(row.ref)) throw new Error(`disposition ${row.ref} is listed twice.`);
    seen.add(row.ref);
  }
  const fallbacks = dispositions.filter(row => row.fallback === true);
  if (fallbacks.length !== 1) throw new Error(`exactly one disposition must be the fallback (fallback: true); found ${fallbacks.length}.`);
  return { fallback: fallbacks[0] };
}

const answerShape = (needsObjective, maxWords = {}) => {
  const limit = key => (maxWords[key] === undefined ? '' : `, at most ${maxWords[key]} words`);
  return {
    disposition_ref: 'one ref from dispositions',
    confidence: 'a number from 0 to 1',
    rationale: `one short sentence${limit('rationale')}`,
    target_ref: 'the ref of the thing it acts on, or empty',
    ...(needsObjective ? { objective: `one executable outcome${limit('objective')}`, acceptance_criteria: ['one observable proof'] } : {}),
  };
};

export function briefFor(input) {
  const { fallback } = checkRows(input);
  const { item, priorities, dispositions, min_confidence, max_words } = input;
  const needing = dispositions.filter(row => row.needs_objective === true).map(row => row.ref);
  const rules = [
    'Judge the item against the priorities and pick the disposition that serves them best; weigh your confidence by how strongly the item matches a priority.',
    `Answer with exactly one JSON object shaped like answer_shape; disposition_ref must be one of the listed refs.`,
    `Fail closed: if the priorities are empty, the item matches none of them, your confidence is under ${min_confidence} or you are unsure, answer ${fallback.ref}.`,
  ];
  for (const key of LIMITED) {
    if (max_words?.[key] !== undefined) rules.push(`The ${key} is at most ${max_words[key]} words; an answer over that fails closed.`);
  }
  if (needing.length) {
    rules.push(`For ${needing.join(', ')} an objective and acceptance_criteria are mandatory. Turn the signal into the smallest safe, reversible assignment that produces evidence. The objective must not authorize sending messages, spending, publishing, promises to others, credential changes, changes to a live system, anything illegal, deceiving or harassing anyone, or taking what belongs to another party. Those stay with whoever owns them.`);
  }
  return {
    item,
    priorities,
    dispositions: dispositions.map(({ ref, label, note }) => ({ ref, label, ...(note === undefined ? {} : { note }) })),
    min_confidence,
    ...(max_words === undefined ? {} : { max_words }),
    rules,
    answer_shape: answerShape(needing.length > 0, max_words),
    priorities_given: priorities.length > 0,
  };
}

const idOf = item => `triage-decision:${encodeURIComponent(item.ref)}:${encodeURIComponent(item.version ?? '')}`;

function problems({ priorities, dispositions, min_confidence, max_words = {} }, answers) {
  const reasons = [];
  if (priorities.length === 0) reasons.push('There are no priorities to judge against.');
  if (!Array.isArray(answers) || answers.length === 0) reasons.push('There is no answer.');
  else if (answers.length > 1) reasons.push(`There are ${answers.length} answers; exactly one is needed.`);
  const answer = Array.isArray(answers) && answers.length === 1 && isRecord(answers[0]) ? answers[0] : undefined;
  if (Array.isArray(answers) && answers.length === 1 && !answer) reasons.push('The answer is not a record.');
  if (!answer) return { reasons };
  if (typeof answer.confidence !== 'number' || Number.isNaN(answer.confidence)) {
    reasons.push('Confidence is missing: it is a number from 0 to 1.');
  } else if (answer.confidence > 1 || answer.confidence < 0) {
    reasons.push(`Confidence ${answer.confidence} is ${answer.confidence > 1 ? 'over 1' : 'under 0'}: it is a number from 0 to 1.`);
  } else if (answer.confidence < min_confidence) {
    reasons.push(`Confidence ${answer.confidence} is under the least, ${min_confidence}.`);
  }
  for (const key of LIMITED) {
    if (max_words[key] !== undefined && typeof answer[key] === 'string' && wordCount(answer[key]) > max_words[key]) {
      reasons.push(`The ${key} has ${wordCount(answer[key])} words; at most ${max_words[key]}.`);
    }
  }
  const row = dispositions.find(one => one.ref === answer.disposition_ref);
  if (!row) reasons.push(`Disposition ${JSON.stringify(answer.disposition_ref ?? null)} is not one of the listed refs.`);
  else if (row.needs_objective === true) {
    if (!nonEmpty(answer.objective)) reasons.push(`${row.ref} needs an objective.`);
    if (!Array.isArray(answer.acceptance_criteria) || answer.acceptance_criteria.length === 0 || !answer.acceptance_criteria.every(nonEmpty)) {
      reasons.push(`${row.ref} needs acceptance_criteria: a list of observable proofs.`);
    }
  }
  return { reasons, answer, row };
}

export function settleTriage(input) {
  const { fallback } = checkRows(input);
  const { item, priorities, dispositions } = input;
  const { reasons, answer, row } = problems({ priorities, dispositions, min_confidence: input.min_confidence, max_words: input.max_words }, input.answers);
  const base = { type: 'triage-decision', id: idOf(item), item: { ref: item.ref, ...(item.version === undefined ? {} : { version: item.version }) }, priorities_seen: priorities.length };
  if (reasons.length) {
    return { ...base, disposition_ref: fallback.ref, confidence: 0, blocked: true, fail_closed: true, reasons };
  }
  const kept = { disposition_ref: row.ref, confidence: answer.confidence, blocked: row.fallback === true || row.blocked_default !== false, fail_closed: false, reasons: [] };
  for (const key of ['rationale', 'objective', 'acceptance_criteria', 'target_ref']) {
    if (answer[key] !== undefined && answer[key] !== '') kept[key] = answer[key];
  }
  return { ...base, ...kept };
}
