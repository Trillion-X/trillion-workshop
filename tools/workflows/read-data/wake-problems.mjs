// The validator for a recipe's `wakes` list: every problem at once, judged by the rows of recipe-wake-causes.json, so a
// wake that passes is one the engine's wake primitive takes. No cause, shape-free field or budget dimension is named in
// this code: causes, their fields, the resources, the host event kinds and the ledgers are all rows of that file.

import { readFileSync } from 'node:fs';

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const whole = value => Number.isInteger(value) && value >= 0;

// The wake vocabulary: what the engine takes, as DATA.
export const WAKE_VOCABULARY = JSON.parse(readFileSync(new URL('../recipe-wake-causes.json', import.meta.url), 'utf8'));

// Whether a name is an IANA time zone the time zone database knows (Intl reads the same database the engine does).
const knownZone = value => {
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone.length > 0; } catch { return false; }
};

// The closed set of JSON value forms a cause field may take.
const SHAPES = {
  text: value => typeof value === 'string' && value.length > 0,
  texts: value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0),
  flag: value => typeof value === 'boolean',
  object,
  zone: value => typeof value === 'string' && value.length > 0 && knownZone(value),
  whole,
  positive: value => Number.isInteger(value) && value > 0,
  strings: value => object(value) && Object.values(value).every(item => typeof item === 'string'),
  'true-or-names': value => value === true || (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0) && new Set(value).size === value.length),
};

// The values a field's `in` or `keys_in` names: a list's items, or an object's keys.
const listed = (vocabulary, name) => {
  const value = vocabulary[name];
  return Array.isArray(value) ? value : object(value) ? Object.keys(value) : [];
};

// Every problem with one cause's fields, as its row says.
function causeProblems(row, fields, where, vocabulary) {
  const problems = [];
  const known = new Map(row.fields.map(field => [field.field, field]));
  const what = row.cause ? `a ${row.cause} cause` : `${row.setting}`;
  for (const key of Object.keys(fields)) if (!known.has(key)) problems.push(`${where}.${key} is not a field of ${what}; it takes ${[...known.keys()].join(', ')}.`);
  for (const field of row.fields) {
    const value = fields[field.field];
    const at = `${where}.${field.field}`;
    if (value === undefined) { if (field.required) problems.push(`${at} is required.`); continue; }
    if (!SHAPES[field.shape](value)) { problems.push(`${at} ${field.refusal ?? `must be ${field.shape}.`}`); continue; }
    if (field.in && ![value].flat().every(item => listed(vocabulary, field.in).includes(item))) problems.push(`${at} must be one of: ${listed(vocabulary, field.in).join(', ')}.`);
    if (field.only_with && fields[field.only_with] === undefined) problems.push(`${at} is taken only beside ${field.only_with}.`);
    if (field.at_least && whole(fields[field.at_least]) && value < fields[field.at_least]) problems.push(`${at} must be at least ${field.at_least}.`);
    if (field.at_most && value > vocabulary[field.at_most]) problems.push(`${at} must be at most ${vocabulary[field.at_most]} (${field.at_most}).`);
    if (field.keys_in) {
      const allowed = vocabulary[field.keys_in]?.[fields[field.by]] ?? [];
      for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${at}.${key} is not a field ${fields[field.by]} reports; it reports ${allowed.join(', ') || 'nothing'}.`);
    }
  }
  if (row.exactly_one_of && row.exactly_one_of.filter(field => fields[field] !== undefined).length !== 1) problems.push(`${where} needs exactly one of ${row.exactly_one_of.join(', ')}.`);
  return problems;
}

// Every problem with a wake's optional settings (`settings` rows): a setting is either one shape, or an object of fields
// judged as a cause's are, and only on a cause its row's `only_on` names.
function settingProblems(wake, where, cause, vocabulary) {
  const problems = [];
  for (const row of vocabulary.settings ?? []) {
    const value = wake[row.setting];
    if (value === undefined) continue;
    const at = `${where}.${row.setting}`;
    if (cause && row.only_on && !row.only_on.includes(cause)) problems.push(`${at} is taken only on a ${row.only_on.join(' or ')} wake.`);
    if (row.shape) { if (!SHAPES[row.shape](value)) problems.push(`${at} must be ${row.shape}.`); continue; }
    if (!object(value)) { problems.push(`${at} must be an object of ${row.fields.map(field => field.field).join(', ')}.`); continue; }
    problems.push(...causeProblems(row, value, at, vocabulary));
  }
  return problems;
}

// The ledgers a wake's budget may be drawn from: its cause's `draws`, or for a cause that draws by a field (a fact, by
// who told it) the ledger each value of that field names, else `otherwise`.
function ledgersOf(row, fields) {
  const draws = row?.draws;
  if (typeof draws === 'string') return [draws];
  if (!object(draws)) return [];
  const values = [fields?.[draws.by]].flat().filter(value => value !== undefined);
  return [...new Set(values.map(value => draws.ledgers?.[value] ?? draws.otherwise))];
}

// Every problem with a budget: only ledger dimensions, whole numbers, at least the least budget a run needs and at most
// every ledger its cause may draw from.
function budgetProblems(budget, where, ledgers, vocabulary) {
  if (!object(budget)) return [`${where} must be an object of dimension: whole number.`];
  const problems = [];
  const dimensions = Object.keys(vocabulary.least_budget);
  for (const [dimension, value] of Object.entries(budget)) {
    if (!dimensions.includes(dimension)) problems.push(`${where}.${dimension} is not a budget dimension; they are ${dimensions.join(', ')}.`);
    else if (!whole(value)) problems.push(`${where}.${dimension} must be a whole number.`);
  }
  for (const [dimension, least] of Object.entries(vocabulary.least_budget)) {
    if ((budget[dimension] ?? 0) < least) problems.push(`${where}.${dimension} must be at least ${least}, or no firing is ever funded.`);
    for (const ledger of ledgers) {
      const most = vocabulary.ledgers[ledger]?.[dimension];
      if (most !== undefined && budget[dimension] > most) problems.push(`${where}.${dimension} must be at most ${most}, the ${ledger} ledger for a whole period.`);
    }
  }
  return problems;
}

// What is wrong with a recipe's wakes list: each wake's shape, cause, budget and start step, and repeated ids.
// `stepIds` are the recipe's step ids; `inputFields` the properties of its input_schema.
export function wakeProblems(wakes, { stepIds, inputFields }, vocabulary = WAKE_VOCABULARY) {
  if (wakes === undefined) return [];
  const field = vocabulary.field;
  if (!Array.isArray(wakes) || wakes.length === 0) return [`${field} must list at least one wake, or be left out.`];
  const causes = new Map(vocabulary.causes.map(row => [row.cause, row]));
  const problems = [];
  const ids = new Set();
  wakes.forEach((wake, index) => {
    const where = `${field}[${index}]`;
    const taken = [...vocabulary.declaration_fields, ...(vocabulary.settings ?? []).map(row => row.setting)];
    if (!object(wake)) { problems.push(`${where} must be { ${vocabulary.declaration_fields.join(', ')} }.`); return; }
    for (const key of Object.keys(wake)) if (!taken.includes(key)) problems.push(`${where}.${key} is not part of a wake; it takes ${taken.join(', ')}.`);
    if (!SHAPES.text(wake.id)) problems.push(`${where}.id must name the wake.`);
    else if (ids.has(wake.id)) problems.push(`${where}.id "${wake.id}" is used twice.`);
    ids.add(wake.id);
    const named = object(wake.on) ? Object.keys(wake.on) : [];
    const row = named.length === 1 ? causes.get(named[0]) : undefined;
    if (!row) problems.push(`${where}.on must name exactly one cause: ${[...causes.keys()].join(', ')}.`);
    else if (!object(wake.on[row.cause])) problems.push(`${where}.on.${row.cause} must be an object of its fields.`);
    else problems.push(...causeProblems(row, wake.on[row.cause], `${where}.on.${row.cause}`, vocabulary));
    problems.push(...settingProblems(wake, where, row?.cause, vocabulary));
    problems.push(...budgetProblems(wake.budget, `${where}.budget`, ledgersOf(row, object(wake.on) ? wake.on[row?.cause] : undefined), vocabulary));
    if (!object(wake.input)) { problems.push(`${where}.input must be an object holding ${vocabulary.start_field}.`); return; }
    if (!stepIds.includes(wake.input[vocabulary.start_field])) problems.push(`${where}.input.${vocabulary.start_field} must name a step of this recipe: ${stepIds.join(', ')}.`);
    for (const key of Object.keys(wake.input)) if (key !== vocabulary.start_field && !inputFields.includes(key)) problems.push(`${where}.input.${key} is not a field of this recipe's input_schema.`);
  });
  return problems;
}
