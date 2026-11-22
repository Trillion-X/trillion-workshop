// harness/answer-shape.mjs
//
// Purpose
//   Checks an answer against the JSON schema a waiting step declares (its `asks.submit`): the runner's own check before a
//   task is finished. The keywords steps' schemas use are checked as JSON Schema means them: type, enum, const,
//   properties, required, items, additionalProperties (true or false), minLength, maxLength, pattern, minItems, maxItems,
//   minimum, maximum, anyOf and oneOf; the annotations description, title, examples, default and $comment constrain nothing
//   and are passed over. A schema that names any other keyword is refused by name, never passed through unchecked, so an
//   answer is only ever accepted on what this module really checked; uncheckable() says so from the schema alone, before
//   anyone answers (Nov 22 2026: an inventory step's answer was refused for minItems after its AI run had been spent, and
//   minLength, description, minItems or pattern are in most open steps' schemas).
//
// Non-negotiable invariants
//   1. The answer is checked against every keyword present; an unknown keyword makes the check refuse (UnsupportedSchema).
//   2. Pure: no I/O, no network.
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const KNOWN = new Set(['type', 'enum', 'const', 'properties', 'required', 'items', 'additionalProperties', 'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf']);
const ANNOTATIONS = new Set(['description', 'title', 'examples', 'default', '$comment']);

export class UnsupportedSchema extends Error {
  constructor(keyword) {
    super(`the step's submit names the keyword "${keyword}", which this computer does not check`);
    this.name = 'UnsupportedSchema';
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeOf = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value);
const matchesType = (value, type) => (type === 'number' ? typeof value === 'number' : type === 'integer' ? Number.isInteger(value) : typeOf(value) === type);
// A pattern as JSON Schema reads it (an ECMA-262 expression, matched anywhere in the string), or a refusal when it is not one.
const patternOf = pattern => {
  try { return new RegExp(pattern, 'u'); } catch { throw new UnsupportedSchema(`pattern ${JSON.stringify(pattern)} (not an expression this computer reads)`); }
};

// Every keyword at every depth is one answerIssue checks or an annotation, else UnsupportedSchema names the first that is not.
function walkSchema(schema) {
  if (!isObject(schema)) throw new UnsupportedSchema('(schema is not an object)');
  for (const keyword of Object.keys(schema)) if (!KNOWN.has(keyword) && !ANNOTATIONS.has(keyword)) throw new UnsupportedSchema(keyword);
  for (const type of [schema.type ?? []].flat()) if (!TYPES.has(type)) throw new UnsupportedSchema(`type ${type}`);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new UnsupportedSchema('enum (not a list)');
  if (schema.pattern !== undefined) patternOf(schema.pattern);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw new UnsupportedSchema('additionalProperties (a schema)');
  for (const sub of Object.values(schema.properties ?? {})) walkSchema(sub);
  if (schema.items !== undefined) walkSchema(schema.items);
  for (const key of ['anyOf', 'oneOf']) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key])) throw new UnsupportedSchema(`${key} (not a list)`);
    schema[key].forEach(walkSchema);
  }
}

/** Why no answer could be checked against `schema` here (the words of the first keyword this module does not check), or
 *  null when every keyword at every depth is checked: read before anyone answers, so no work is spent on an answer that
 *  would be refused whatever it says. Pure. */
export function uncheckable(schema) {
  try { walkSchema(schema); return null; } catch (error) { if (error instanceof UnsupportedSchema) return error.message; throw error; }
}

/**
 * The first place the answer breaks the schema, as "<where>: <why>", or null when it satisfies it. `where` names the path
 * of the value inside the answer ("result" at the top).
 */
export function answerIssue(value, schema, where = 'result') {
  if (!isObject(schema)) throw new UnsupportedSchema('(schema is not an object)');
  for (const keyword of Object.keys(schema)) if (!KNOWN.has(keyword) && !ANNOTATIONS.has(keyword)) throw new UnsupportedSchema(keyword);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const type of types) if (!TYPES.has(type)) throw new UnsupportedSchema(`type ${type}`);
    if (!types.some(type => matchesType(value, type))) return `${where} must be ${types.join(' or ')}, not ${typeOf(value)}`;
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) return `${where} must be ${JSON.stringify(schema.const)}`;
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) throw new UnsupportedSchema('enum (not a list)');
    if (!schema.enum.some(one => JSON.stringify(one) === JSON.stringify(value))) return `${where} must be one of ${schema.enum.map(one => JSON.stringify(one)).join(', ')}`;
  }
  for (const key of ['anyOf', 'oneOf']) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key])) throw new UnsupportedSchema(`${key} (not a list)`);
    const fits = schema[key].filter(sub => answerIssue(value, sub, where) === null).length;
    if (key === 'anyOf' && fits === 0) return `${where} must fit one of its ${schema[key].length} allowed shapes`;
    if (key === 'oneOf' && fits !== 1) return `${where} must fit exactly one of its ${schema[key].length} shapes, not ${fits}`;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) return `${where} must be at least ${schema.minLength} characters, not ${length}`;
    if (schema.maxLength !== undefined && length > schema.maxLength) return `${where} must be at most ${schema.maxLength} characters, not ${length}`;
    if (schema.pattern !== undefined && !patternOf(schema.pattern).test(value)) return `${where} must match ${schema.pattern}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${where} must be at least ${schema.minimum}, not ${value}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${where} must be at most ${schema.maximum}, not ${value}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${where} must hold at least ${schema.minItems} items, not ${value.length}`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${where} must hold at most ${schema.maxItems} items, not ${value.length}`;
  }
  if (isObject(value)) {
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) return `${where}.${name} is required`;
    const properties = schema.properties ?? {};
    for (const [name, sub] of Object.entries(properties)) {
      if (!Object.hasOwn(value, name)) continue;
      const issue = answerIssue(value[name], sub, `${where}.${name}`);
      if (issue) return issue;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find(name => !Object.hasOwn(properties, name));
      if (extra !== undefined) return `${where}.${extra} is not allowed`;
    } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) throw new UnsupportedSchema('additionalProperties (a schema)');
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let at = 0; at < value.length; at += 1) {
      const issue = answerIssue(value[at], schema.items, `${where}[${at}]`);
      if (issue) return issue;
    }
  }
  return null;
}
