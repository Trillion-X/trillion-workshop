// tools/match-picks/read-data/pick-records.mjs
//
// The records a free match pick is made of, built and checked before they are kept. The three kinds are the ones
// read-data/match-picks.mjs reads (so a record built here is read there):
//   pick-match         { kind, matchId, label, startsAt?, choices: [{ choiceId, label }], status: 'open' }
//   match-pick         { kind, pickId, matchId, pickerId, choiceId, createdAt }
//   match-pick-result  { kind, resultId, matchId, winningChoiceId, summary, resolvedAt }
// Each is built from the fields named in RECORDS below: which fields are required, which text is checked against the
// person's banned words, and where the id comes from. A record is never written here: the caller keeps it in the
// person's own store. The time is the request's `now`, else the clock; an id the request does not give is made new.
// This is the old package's three builders (create-pick-prompt.ts, submit-match-pick.ts, resolve-match-pick.ts), with
// the person's word list in place of the shipped one and one more refusal: two choices with the same id.
import { randomUUID } from 'node:crypto';
import { findBannedCopy } from './pick-copy.mjs';

const text = value => (typeof value === 'string' ? value.trim() : '');
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function need(input, field, what) {
  const value = text(input[field]);
  if (!value) throw new Error(`${what} needs ${field}.`);
  return value;
}

function choicesOf(input) {
  if (!Array.isArray(input.choices) || input.choices.length < 2) throw new Error('A pick prompt needs at least two choices.');
  const seen = new Set();
  return input.choices.map((choice, index) => {
    if (!isObject(choice)) throw new Error(`choices[${index}] must be { choiceId, label }.`);
    const choiceId = text(choice.choiceId);
    const label = text(choice.label);
    if (!choiceId) throw new Error(`choices[${index}] needs choiceId.`);
    if (!label) throw new Error(`choices[${index}] needs label.`);
    if (seen.has(choiceId)) throw new Error(`choiceId ${choiceId} is given twice; each choice needs its own.`);
    seen.add(choiceId);
    return { choiceId, label };
  });
}

// what: the name the request gives it; idField: where the record keeps its id; checked: the texts to hold to the
// person's banned words; build: the record from the checked input and the time.
const RECORDS = {
  prompt: {
    idField: 'matchId',
    idPrefix: 'pick-match',
    build: (input, id) => {
      const label = need(input, 'label', 'A pick prompt');
      const choices = choicesOf(input);
      const startsAt = text(input.startsAt);
      return { record: { kind: 'pick-match', matchId: id, label, ...(startsAt ? { startsAt } : {}), choices, status: 'open' }, checked: [{ field: 'label', text: label }, ...choices.map((choice, index) => ({ field: `choices[${index}].label`, text: choice.label }))] };
    },
  },
  pick: {
    idField: 'pickId',
    idPrefix: 'match-pick',
    build: (input, id, now) => ({ record: { kind: 'match-pick', pickId: id, matchId: need(input, 'matchId', 'A pick'), pickerId: need(input, 'pickerId', 'A pick'), choiceId: need(input, 'choiceId', 'A pick'), createdAt: now }, checked: [] }),
  },
  result: {
    idField: 'resultId',
    idPrefix: 'match-pick-result',
    build: (input, id, now) => {
      const summary = need(input, 'summary', 'A result');
      return { record: { kind: 'match-pick-result', resultId: id, matchId: need(input, 'matchId', 'A result'), winningChoiceId: need(input, 'winningChoiceId', 'A result'), summary, resolvedAt: now }, checked: [{ field: 'summary', text: summary }] };
    },
  },
};

export const recordNames = Object.keys(RECORDS);

export function prepareMatchPickRecord(request) {
  if (!isObject(request)) throw new Error('The request must be an object with what and the record\'s fields.');
  const spec = RECORDS[request.what];
  if (!spec) throw new Error(`what must be one of ${recordNames.join(', ')}.`);
  const nowMs = request.now === undefined ? Date.now() : Date.parse(request.now);
  if (Number.isNaN(nowMs)) throw new Error('now must be a time such as 2026-01-31T09:00:00Z.');
  const id = text(request[spec.idField]) || `${spec.idPrefix}:${randomUUID()}`;
  const { record, checked } = spec.build(request, id, new Date(nowMs).toISOString());
  if (Array.isArray(request.banned_terms) && request.banned_terms.length) {
    const { findings } = findBannedCopy(checked, request.banned_terms);
    if (findings.length) throw new Error(findings.map(item => item.message).join(' '));
  } else if (request.banned_terms !== undefined && !Array.isArray(request.banned_terms)) {
    throw new Error('banned_terms must be a list of words or phrases the person does not want used.');
  }
  return { id, record };
}
