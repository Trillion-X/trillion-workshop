// tools/gather-words-from-people/do-work/gather-words.mjs
//
// The four tools that ask people for their words, keep each answer with the consent that came with it, approve the words
// exactly as they were reviewed, and read back only what may be shown. Each export is called by
// tools/workflows/do-work/run-a-function.mjs as fn(input), with no records door: a tool reads nothing and keeps
// nothing. The caller's AI reads the list's definition and rows from a store and hands them in as `list` (the list's
// definition) and `rows` ([{ id, value }], the list's rows); a tool that changes a row answers `keep`, the records
// ({ id, type, value, expected }) for the AI to put in the store, each conditional on the row as it was handed in. The list
// is an ordinary list: its own definition (`gathers`) says which fields hold what (read-data/gathered-words.mjs); no tool
// here names a list, a consent or a state.
//
//   askPeopleForWords          one row per person asked, in the asked state, and each person's draft; sends nothing
//   keepTheWordsAPersonGave    the words and consent a person gave, on their asked row or as a new row
//   approveWordsToShow         approve (exactly the words reviewed), decline or withdraw one row
//   readWordsThatMayShow       the approved, consented words whose pin still matches, as page proof items
import { askedRowId, consentIds, consentOf, headingFor, readGathers, shownIdentity, stateOf, volunteeredRowId } from '../read-data/gathered-words.mjs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
};

// The list's own gathers words, its row type and the rows handed in by id.
function openList(input) {
  if (!object(input) || !object(input.list)) throw new Error('Give list (the list\'s definition) and what to do.');
  // A missing rows is refused, never read as an empty list: a tool that shows or changes words checks the rows it is given.
  if (!Array.isArray(input.rows)) throw new Error('Give rows (the list\'s rows as [{ id, value }], [] when it has none).');
  const gathers = readGathers(input.list);
  const rowType = text(input.list.row_type, 'list.row_type');
  const rows = new Map();
  for (const [index, row] of input.rows.entries()) {
    if (!object(row) || typeof row.id !== 'string' || !object(row.value)) throw new Error(`rows[${index}] needs an id and a value.`);
    rows.set(row.id, row.value);
  }
  return { gathers, type: `record:${rowType}`, rowType, rows };
}

function rowOf(rows, rowId) {
  const id = text(rowId, 'row_id');
  const value = rows.get(id);
  if (!value) throw new Error(`No row ${id} in rows.`);
  return { id, value };
}

// A keep that changes one row only if it is still as it was handed in: a row that moved underneath refuses the keep.
const changeRow = (type, id, before, after) => ({ id, type, value: after, expected: { type, value: before } });

const without = (value, field) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));

export function askPeopleForWords(input) {
  const { gathers, type, rowType, rows } = openList(input);
  const { fields } = gathers;
  if (!gathers.ask) throw new Error('This list has no gathers.ask words (a subject and a body) to ask with.');
  const caseKey = text(input.case, 'case');
  if (!Array.isArray(input.people) || !input.people.length) throw new Error('people must list who to ask, each with an id, a name and win.');
  const now = typeof input.now === 'string' && input.now ? input.now : new Date().toISOString();
  const asked = [];
  const skipped = [];
  const keep = [];
  const taken = new Set();
  for (const [index, person] of input.people.entries()) {
    if (!object(person) || typeof person.id !== 'string' || !person.id.trim() || typeof person.name !== 'string' || !person.name.trim()) throw new Error(`people[${index}] needs an id and a name.`);
    const id = askedRowId(rowType, caseKey, person.id);
    if (taken.has(id) || rows.has(id)) {
      skipped.push({ person: person.id, reason: 'already_asked' });
      continue;
    }
    // Asked only after the person's own positive word: the reference says where it is, and nothing here can check it.
    if (typeof person.win !== 'string' || !person.win.trim()) {
      skipped.push({ person: person.id, reason: 'no_win' });
      continue;
    }
    taken.add(id);
    const name = person.name.trim();
    const value = {
      [fields.who]: name,
      [fields.person]: person.id,
      [fields.status]: stateOf(gathers, 'asked'),
      [fields.case]: caseKey,
      [fields.win]: person.win.trim(),
      [fields.asked_at]: now,
    };
    keep.push({ id, type, value, expected: null });
    asked.push({
      row_id: id,
      person: person.id,
      draft: { to: typeof person.address === 'string' && person.address.trim() ? person.address.trim() : null, subject: gathers.ask.subject.replaceAll('{name}', name), body: gathers.ask.body.replaceAll('{name}', name) },
    });
  }
  return { asked, skipped, keep };
}

export function keepTheWordsAPersonGave(input) {
  const { gathers, type, rowType, rows } = openList(input);
  const { fields } = gathers;
  const words = text(input.words, 'words');
  const consent = consentOf(gathers, input.consent);
  if (!consent) throw new Error(`consent must be one of: ${consentIds(gathers)}.`);
  const note = text(input.consent_note, 'consent_note (the person\'s own words that gave this consent, or where they are)');
  let id;
  let before = null;
  let who;
  if (input.row_id === undefined) {
    who = text(input.who, 'who (the speaker, when the words were not asked for)');
    id = volunteeredRowId(rowType, who, words);
    before = rows.get(id) ?? null;
  } else {
    ({ id, value: before } = rowOf(rows, input.row_id));
  }
  if (before?.[fields.status] === stateOf(gathers, 'withdrawn')) throw new Error(`Row ${id} is withdrawn: the person took their consent back, so it takes no more words.`);
  // A replay of words already kept changes nothing, so a retried call never takes an approval away.
  if (before && before[fields.words] === words && before[fields.consent] === consent.id && before[fields.consent_note] === note) return { row_id: id, status: before[fields.status], changed: false, keep: [] };
  const next = {
    ...without(before ?? {}, fields.approved_identity),
    ...(who === undefined ? {} : { [fields.who]: who }),
    [fields.words]: words,
    [fields.consent]: consent.id,
    [fields.consent_note]: note,
    [fields.status]: stateOf(gathers, 'received'),
  };
  return { row_id: id, status: next[fields.status], changed: true, keep: [before ? changeRow(type, id, before, next) : { id, type, value: next, expected: null }] };
}

export function approveWordsToShow(input) {
  const { gathers, type, rows } = openList(input);
  const { fields } = gathers;
  const decision = input.decision;
  if (!['approve', 'decline', 'withdraw'].includes(decision)) throw new Error('decision must be approve, decline or withdraw.');
  const { id, value: before } = rowOf(rows, input.row_id);
  const status = before[fields.status];
  const settle = next => ({ row_id: id, status: next[fields.status], keep: [changeRow(type, id, before, next)] });
  if (decision === 'withdraw') return settle({ ...without(before, fields.approved_identity), [fields.status]: stateOf(gathers, 'withdrawn') });
  if (status !== stateOf(gathers, 'received')) throw new Error(`Row ${id} is ${status ?? 'not kept'}, not ${stateOf(gathers, 'received')}: only received words are approved or declined.`);
  if (decision === 'decline') return settle({ ...without(before, fields.approved_identity), [fields.status]: stateOf(gathers, 'declined') });
  const consent = consentOf(gathers, before[fields.consent]);
  if (!consent?.may_show) throw new Error(`Row ${id} has consent ${before[fields.consent] ?? 'none'}, which does not allow showing: it is not approved.`);
  if (typeof input.reviewed_words !== 'string' || input.reviewed_words !== before[fields.words]) throw new Error(`reviewed_words is not the words now in row ${id}: approve the words exactly as reviewed.`);
  return settle({ ...before, [fields.status]: stateOf(gathers, 'approved'), [fields.approved_identity]: shownIdentity(gathers, before) });
}

export function readWordsThatMayShow(input) {
  const { gathers, rows } = openList(input);
  const { fields } = gathers;
  const limit = input.limit === undefined ? undefined : input.limit;
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) throw new Error('limit must be a whole number of 1 or more.');
  const held = {};
  const holdBack = reason => { held[reason] = (held[reason] ?? 0) + 1; };
  const showing = [];
  for (const [id, value] of [...rows].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (value[fields.status] !== stateOf(gathers, 'approved')) { holdBack('not_approved'); continue; }
    if (value[fields.approved_identity] !== shownIdentity(gathers, value)) { holdBack('changed_since_approved'); continue; }
    const consent = consentOf(gathers, value[fields.consent]);
    if (!consent?.may_show) { holdBack('consent_does_not_allow_showing'); continue; }
    showing.push({ heading: headingFor(gathers, consent, value[fields.who]), body: value[fields.words], row_id: id });
  }
  return { items: limit === undefined ? showing : showing.slice(0, limit), shown: limit === undefined ? showing.length : Math.min(limit, showing.length), may_show_total: showing.length, held_back: held };
}
