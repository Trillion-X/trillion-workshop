// harness/answer-shape.mjs
//
// Purpose
//   Checks an answer against the JSON schema a waiting step declares (its `asks.submit`): the runner's own check before a
//   task is finished. The keywords a step's schema uses are checked: type, enum, const, properties, required, items and
//   additionalProperties (false only). A schema that names any other keyword is refused by name, never passed through
//   unchecked, so an answer is only ever accepted on what this module really checked.
//
// Non-negotiable invariants
//   1. The answer is checked against every keyword present; an unknown keyword makes the check refuse (UnsupportedSchema).
//   2. Pure: no I/O, no network.
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const KNOWN = new Set(['type', 'enum', 'const', 'properties', 'required', 'items', 'additionalProperties']);

export class UnsupportedSchema extends Error {
  constructor(keyword) {
    super(`the step's submit names the keyword "${keyword}", which this computer does not check`);
    this.name = 'UnsupportedSchema';
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeOf = value => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value);
const matchesType = (value, type) => (type === 'number' ? typeof value === 'number' : type === 'integer' ? Number.isInteger(value) : typeOf(value) === type);

/**
 * The first place the answer breaks the schema, as "<where>: <why>", or null when it satisfies it. `where` names the path
 * of the value inside the answer ("result" at the top).
 */
export function answerIssue(value, schema, where = 'result') {
  if (!isObject(schema)) throw new UnsupportedSchema('(schema is not an object)');
  for (const keyword of Object.keys(schema)) if (!KNOWN.has(keyword)) throw new UnsupportedSchema(keyword);
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
