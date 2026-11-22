import { realpathSync } from 'node:fs';
// tools/research-a-creator-or-topic/do-work/prospects.mjs
//
// Research a prospect (a company, a business, a person to sell to) the way this folder researches a creator or a topic:
// gathering stays with the readers of this folder and tools/browse-public-page, the profile is written by the person's AI
// from the material, and the profile is answered as one row for the person's prospect list. Every rule (the fields, who
// fills each, the statuses, the words of the instruction) is DATA in prospect-list.json; nothing here names a company.
//
//   tool:brief-a-prospect  -> briefAProspect(input)             the profile requests, from write-a-profile-request.mjs
//   tool:keep-a-prospect   -> keepAProspect(input)              run by tools/workflows/do-work/run-a-function.mjs
//
// keepAProspect checks what it is given and answers the prospect row as `keep`, and keeps nothing: the person's AI reads
// the row it holds (`held`, its value) from the list and keeps the row this answers. The keep row carries `expected`, the
// row as it was handed in (null for a new prospect), so a store refuses the keep when the row moved since. Actions: keep
// (finder facts and/or the researched profile, over the row held) and mark (status and notes, the fields kept by hand,
// over the row held).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRows, refuse } from './harvest-parts.mjs';
import { writeAProfileRequest } from './write-a-profile-request.mjs';

const LIST = new URL('./prospect-list.json', import.meta.url);
export const readProspectList = () => JSON.parse(readFileSync(LIST, 'utf8'));

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const squash = text => String(text).toLowerCase().replace(/\s+/g, ' ').trim();
const fieldsFilledBy = (list, who) => list.fields.filter(field => field.filled_by === who);

// The prospect's key: the one name its row, its brief and every later action share.
function keyOf(input) {
  if (!nonempty(input?.key)) refuse('Send key: one short name for this prospect (for example its website address) that stays the same in every later action.');
  const key = input.key.trim();
  if (key.includes('/')) refuse('key may not hold a /: use the website address without its path, or a short name.');
  return key;
}

function criteriaOf(value) {
  const items = nonempty(value) ? [value] : Array.isArray(value) ? value : [];
  if (!items.length || !items.every(nonempty)) refuse('Send criteria: what makes a good prospect for you, as words or a list of words. The profile judges fit against them.');
  return items.map(item => item.trim()).join('; ');
}

const describe = field => `${field.id} (${field.kind === 'entries' ? `a list of ${field.entries_least ?? 0} to ${field.entries_most ?? 'any number of'} objects with ${field.entry_keys.join(', ')}` : field.kind}: ${field.says})`;

export function briefAProspect(input, list = readProspectList()) {
  const key = keyOf(input);
  const criteria = criteriaOf(input.criteria);
  const name = nonempty(input.name) ? input.name.trim() : key;
  const address = nonempty(input.url) ? input.url.trim() : key;
  const shape = Object.fromEntries(fieldsFilledBy(list, 'research').filter(field => field.id !== 'researched_at').map(field => [field.id, describe(field)]));
  const instruction = list.instruction.join('\n')
    .replace('{name}', () => name).replace('{address}', () => address).replace('{criteria}', () => criteria).replace('{fields}', () => Object.values(shape).join('; '));
  const made = writeAProfileRequest({
    subject_ref: name, instruction, material: input.material, evidence: input.evidence,
    profile_ref: nonempty(input.profile_ref) ? input.profile_ref : `prospect:${key}`, output_kind: 'prospect-profile',
  });
  return { key, row_id: `${list.records.id_start}${key}`, profile_shape: shape, ...made };
}

// Every problem with one value of a field, in plain words, or none. `material` (the words the profile was written from),
// when sent, must hold every quotation a "stated" entry gives as its evidence.
function valueProblems(field, value, list, material) {
  const where = field.id;
  if (field.kind === 'text') return typeof value === 'string' ? [] : [`${where} is words.`];
  if (field.kind === 'number') return Number.isFinite(value) ? [] : [`${where} is a number.`];
  if (!Array.isArray(value)) return [`${where} is a list of objects with ${field.entry_keys.join(', ')}.`];
  const problems = [];
  if (value.length < (field.entries_least ?? 0) || value.length > (field.entries_most ?? Infinity)) {
    problems.push(`${where} holds ${field.entries_least ?? 0} to ${field.entries_most ?? 'any number of'} entries, not ${value.length}.`);
  }
  value.forEach((entry, at) => {
    const name = `${where}[${at}]`;
    const missing = object(entry) ? field.entry_keys.filter(entryKey => !nonempty(String(entry[entryKey] ?? ''))) : field.entry_keys;
    if (missing.length) { problems.push(`${name} needs ${missing.join(', ')}.`); return; }
    if (field.entry_keys.includes('basis')) {
      if (!list.bases.includes(entry.basis)) problems.push(`${name}.basis is ${list.bases.map(word => `"${word}"`).join(' or ')}.`);
      else if (entry.basis === 'stated' && material !== undefined && !squash(material).includes(squash(entry.evidence))) {
        problems.push(`${name} is stated but its evidence is not in the material: quote the material word for word, or make it inferred.`);
      }
    }
  });
  return problems;
}

// The fields of one kind of filler that the caller sent, each checked; a field this list does not give that filler is refused.
function checked(sent, list, who, name, material) {
  if (sent === undefined) return {};
  if (!object(sent)) refuse(`${name} is an object of fields.`);
  const allowed = new Map(fieldsFilledBy(list, who).map(field => [field.id, field]));
  const problems = Object.entries(sent).flatMap(([id, value]) => (allowed.has(id)
    ? valueProblems(allowed.get(id), value, list, material).map(problem => `${name}.${problem}`)
    : [`${name}.${id} is not a field ${who === 'person' ? 'to set here' : `a ${who} fills`}: the fields are ${[...allowed.keys()].join(', ')}.`]));
  if (problems.length) refuse(problems.join(' '));
  return sent;
}

const specsFor = (list, ids) => ({ id: { fact: 'key' }, fields: Object.fromEntries(ids.map(id => [id, { fact: id }])) });

// The prospect row built over the row held (its value, when the person holds one), as { id, type, value, expected }.
function rowFrom(list, held, facts) {
  const ids = Object.keys(facts).filter(id => id !== 'key');
  const rowId = `${list.records.id_start}${facts.key}`;
  const { keep, refused } = buildRows(specsFor(list, ids), [facts], 'key', held === undefined ? [] : [{ id: rowId, value: held }], { records: list.records });
  if (refused.length) refuse(`The prospect row was refused: ${refused[0].reason}.`);
  return keep[0];
}

function heldOf(input) {
  if (input.held === undefined || input.held === null) return undefined;
  if (!object(input.held)) refuse('held is the prospect row you already hold: its fields as an object.');
  return input.held;
}

export function keepAProspect(input, list = readProspectList()) {
  const action = input?.action ?? 'keep';
  const rowId = key => `${list.records.id_start}${key}`;
  const held = heldOf(input ?? {});
  if (action === 'keep') {
    const key = keyOf(input);
    const found = checked(input.found, list, 'finder', 'found');
    const profile = checked(input.profile, list, 'research', 'profile', typeof input.material === 'string' ? input.material : undefined);
    if (!Object.keys(found).length && !Object.keys(profile).length) refuse('Send found (the facts a finder gave) or profile (what the research wrote): there is nothing to keep.');
    const researching = Object.keys(profile).length > 0;
    const facts = { key, ...found, ...profile };
    if (researching) facts.researched_at = nonempty(input.now) ? input.now : new Date().toISOString().slice(0, 10);
    if (researching && !Object.hasOwn(profile, 'problems')) refuse('profile needs problems: the biggest problems the material shows, each with its basis and evidence.');
    // A new row starts at the first status; research moves a row still at the first status to the second. Later statuses are the person's.
    const [first, researched] = list.statuses;
    const status = !held?.status ? (researching ? researched : first) : researching && held.status === first ? researched : undefined;
    return { action, key, row_id: rowId(key), keep: [rowFrom(list, held, { ...facts, ...(status === undefined ? {} : { status }) })], created: held === undefined };
  }
  if (action === 'mark') {
    const key = keyOf(input);
    if (input.status === undefined && input.notes === undefined) refuse('Send status or notes to mark.');
    if (input.status !== undefined && !list.statuses.includes(input.status)) refuse(`status is one of ${list.statuses.join(', ')}.`);
    if (input.notes !== undefined && typeof input.notes !== 'string') refuse('notes is words.');
    if (held === undefined) refuse(`No prospect is held under ${key}: send held, the row you hold, or keep it first.`);
    return { action, key, row_id: rowId(key), keep: [rowFrom(list, held, { key, ...(input.status === undefined ? {} : { status: input.status }), ...(input.notes === undefined ? {} : { notes: input.notes }) })] };
  }
  return refuse('action is keep or mark.');
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    process.stdout.write(`${JSON.stringify(briefAProspect(JSON.parse(readFileSync(0, 'utf8') || '{}')))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 2;
  }
}
