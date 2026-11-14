// tools/workflows/read-data/answer-schema.mjs
//
// Judges a step's answer against the step's `submit` JSON schema. Generic: it knows the schema keywords, never a recipe.
//   schemaProblems(schema, value) -> [{ path, why }]   (empty when the value fits)
// `path` is the field path from the answer (`this.branches[2].id`). Keywords judged: type, properties, required, items,
// enum, const, additionalProperties, oneOf, anyOf, minItems, maxItems, minLength, maxLength, minimum, maximum, pattern.
// A keyword it does not know is ignored, never read as a pass of something it did not judge.

const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
const isType = (value, type) => type === 'number' ? typeof value === 'number' && Number.isFinite(value) : type === 'integer' ? Number.isInteger(value) : typeOf(value) === type || (type === 'object' && typeOf(value) === 'object');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function schemaProblems(schema, value, path = 'this') {
  if (schema === null || typeof schema !== 'object') return [];
  const found = [];
  const bad = why => found.push({ path, why });
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some(type => isType(value, type))) { bad(`must be ${types.join(' or ')}, is ${typeOf(value)}`); return found; }
  }
  if (schema.const !== undefined && !same(schema.const, value)) bad(`must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some(item => same(item, value))) bad(`must be one of ${JSON.stringify(schema.enum)}, is ${JSON.stringify(value)}`);
  if (Array.isArray(schema.oneOf)) {
    const fits = schema.oneOf.filter(one => schemaProblems(one, value, path).length === 0).length;
    if (fits !== 1) bad(`must fit exactly one of ${schema.oneOf.length} alternatives, fits ${fits}`);
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(one => schemaProblems(one, value, path).length === 0)) bad(`must fit one of ${schema.anyOf.length} alternatives`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) bad(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) bad(`must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) bad(`must match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) bad(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) bad(`must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) bad(`must have at least ${schema.minItems} items, has ${value.length}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) bad(`must have at most ${schema.maxItems} items, has ${value.length}`);
    if (schema.items && typeof schema.items === 'object') value.forEach((item, at) => found.push(...schemaProblems(schema.items, item, `${path}[${at}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) found.push({ path: `${path}.${key}`, why: 'is required and missing' });
    const properties = schema.properties ?? {};
    for (const [key, sub] of Object.entries(properties)) if (Object.hasOwn(value, key)) found.push(...schemaProblems(sub, value[key], `${path}.${key}`));
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) found.push({ path: `${path}.${key}`, why: 'is not a field this step takes' });
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) found.push(...schemaProblems(schema.additionalProperties, value[key], `${path}.${key}`));
  }
  return found;
}
