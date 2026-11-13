// tools/gather-words-from-people/read-data/gathered-words.mjs
//
// What it means for an ordinary list to gather words from people, read from the list's own definition. The list says, as
// data, which of its fields hold the words, the speaker, the consent and the state, which consents allow showing and how
// the speaker's name may appear, and what each state is called. The code knows roles, never a list, a consent or a state.
// Pure: no record, file or network operation.
import { makeHashCodeHexFromJson } from '../../content-identity/read-data/identity.mjs';

const ROLES = ['words', 'who', 'person', 'consent', 'consent_note', 'status', 'case', 'win', 'asked_at', 'approved_identity'];
const STATES = ['asked', 'received', 'approved', 'declined', 'withdrawn'];
const NAME_USES = ['full', 'first', 'none'];

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const word = value => typeof value === 'string' && value.trim() !== '';

/**
 * The list's `gathers` block, checked against the list's own fields: every problem in one refusal, never the first alone.
 * Returns { fields, consents, anonymous_heading, states, ask }.
 */
export function readGathers(list) {
  const block = object(list) ? list.gathers : undefined;
  if (!object(block)) throw new Error('This list does not say it gathers words: its definition has no `gathers` block (fields, consents, states).');
  const problems = [];
  const declared = new Set((Array.isArray(list.fields) ? list.fields : []).map(field => field?.id));
  const fields = object(block.fields) ? block.fields : {};
  for (const role of ROLES) {
    if (!word(fields[role])) problems.push(`gathers.fields.${role} names no field`);
    else if (!declared.has(fields[role])) problems.push(`gathers.fields.${role} is ${fields[role]}, which is not a field of the list`);
  }
  const used = new Map();
  for (const role of ROLES) {
    if (word(fields[role])) used.set(fields[role], [...(used.get(fields[role]) ?? []), role]);
  }
  for (const [field, roles] of used) if (roles.length > 1) problems.push(`gathers.fields ${roles.join(' and ')} both use ${field}`);
  const consents = Array.isArray(block.consents) ? block.consents : [];
  if (!consents.length) problems.push('gathers.consents lists no consent');
  const seen = new Set();
  consents.forEach((consent, index) => {
    const at = `gathers.consents[${index}]`;
    if (!object(consent) || !word(consent.id)) return problems.push(`${at} needs an id`);
    if (seen.has(consent.id)) problems.push(`${at} (${consent.id}) repeats an id`);
    seen.add(consent.id);
    if (typeof consent.may_show !== 'boolean') problems.push(`${at} (${consent.id}) needs may_show true or false`);
    else if (consent.may_show && !NAME_USES.includes(consent.name_use)) problems.push(`${at} (${consent.id}) shows words, so name_use must be one of ${NAME_USES.join(', ')}`);
  });
  if (consents.some(consent => object(consent) && consent.may_show === true && consent.name_use === 'none') && !word(block.anonymous_heading)) {
    problems.push('gathers.anonymous_heading is missing: a consent that shows words with no name needs the heading to show instead');
  }
  const states = object(block.states) ? block.states : {};
  for (const state of STATES) if (!word(states[state])) problems.push(`gathers.states.${state} names no value`);
  if (new Set(STATES.map(state => states[state]).filter(word)).size !== STATES.filter(state => word(states[state])).length) problems.push('gathers.states give two states one value');
  if (block.ask !== undefined && !(object(block.ask) && word(block.ask.subject) && word(block.ask.body))) problems.push('gathers.ask needs a subject and a body');
  if (problems.length) throw new Error(`The list's gathers block is not whole: ${problems.join('; ')}.`);
  return { fields, consents, anonymous_heading: block.anonymous_heading, states, ask: block.ask };
}

/** The consent option with this id, or null. */
export const consentOf = (gathers, id) => gathers.consents.find(consent => consent.id === id) ?? null;

/** The ids of the consents, in the order the list gives them. */
export const consentIds = gathers => gathers.consents.map(consent => consent.id).join(', ');

/**
 * What a reviewer approves and a page may show: the speaker, the words and the consent. The identity of these three pins an
 * approval, so a change to any of them (by a tool or by hand) leaves the row unapproved.
 */
export function shownIdentity(gathers, value) {
  const { who, words, consent } = gathers.fields;
  return makeHashCodeHexFromJson({ who: value[who] ?? null, words: value[words] ?? null, consent: value[consent] ?? null });
}

/** The name a page shows under a consent: the whole name, the first word of it, or the list's own anonymous heading. */
export function headingFor(gathers, consent, who) {
  const name = typeof who === 'string' ? who.trim() : '';
  if (consent.name_use === 'full' && name) return name;
  if (consent.name_use === 'first' && name) return name.split(/\s+/)[0];
  return gathers.anonymous_heading ?? '';
}

/** The row id for a person asked about a case: the same person and case always give the same id, so a second ask finds the first. */
export const askedRowId = (rowType, caseKey, person) => `record:${rowType}:${makeHashCodeHexFromJson({ case: caseKey, person }).slice(3, 35)}`;

/** The row id for words nobody asked for: the same speaker and words always give the same id. */
export const volunteeredRowId = (rowType, who, words) => `record:${rowType}:${makeHashCodeHexFromJson({ who, words }).slice(3, 35)}`;

/** A state's name in this list, by role. */
export const stateOf = (gathers, role) => gathers.states[role];
