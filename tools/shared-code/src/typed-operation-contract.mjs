// Shared typed-operation identity and schema contract; independent of execution placement or carrier.
import { blake3 } from '../../keep-and-wake-ai-sessions-on-this-computer/parts/live-namespace/do-work/blake3.mjs';
import { bytesToHex } from '@noble/hashes/utils.js';
import { NAMESPACE_FILE, NAMESPACE_IDENTITY } from './repo-explorer.mjs';
import { timeZoneName } from '../../run-work-later-or-on-a-repeat/do-work/wall-time.ts';
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// Sorted-key JSON, so the same input always has the same identity.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
// Inputs can contain borrowed or session-only private words. Keep identity
// calculation pure so no module cache retains canonical plaintext after its
// source or invocation ends; the current allocation-free BLAKE3 owner stays.
export const identityOf = value => bytesToHex(blake3(new TextEncoder().encode(canonical(value))));
// The same account-local request always names the same task. A computed identity is a lookup key, never proof
// that its task exists or that the tool ran; the task owner alone answers those questions.
export const operationTaskId = ({ tool_id, request_key } = {}) => nonempty(tool_id) && nonempty(request_key)
  ? 'task_' + identityOf({ tool_id, request_key }).slice(0, 32) : null;
// The version a Space grant pins is the immutable tool definition. Publication and account metadata are deliberately
// left out: a private saved row and the same row on the shared shelf must resolve to one version in every account.
const TOOL_DEFINITION_FIELDS = Object.freeze([
  'description', 'handler_ref', 'permission_capability_ref', 'id', 'input_schema', 'label', 'output_schema',
  'fixed_input', 'trusted_context', 'result_selector', 'surface_selector', 'cancellation_capability_ref', 'job',
  'bytes_fingerprint', 'invoke', 'needs', 'licence_class', 'placements', 'verify', 'result_saved_as_tool',
  'keeps_records', 'provenance', 'screen', 'billing', 'use_limits', 'observes', 'minimum_host_version',
]);
export const operationDefinition = tool => Object.fromEntries(TOOL_DEFINITION_FIELDS
  .filter(field => tool && tool[field] !== undefined)
  .map(field => [field, tool[field]]));
export const operationVersion = tool => `1f:${identityOf(operationDefinition(tool))}`;
export const workshopTaskId = operationTaskId;
export const workshopToolDefinition = operationDefinition;
export const workshopToolVersion = operationVersion;
const validCalendarDate = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return parsed.toISOString().slice(0, 10) === value;
};
export function schemaProblems(value, schema, path = 'value') {
  if (!object(schema)) return [];
  const problems = [];
  if (Array.isArray(schema.allOf)) {
    for (const alternative of schema.allOf) problems.push(...schemaProblems(value, alternative, path));
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(alternative => schemaProblems(value, alternative, path).length === 0)) {
    problems.push(`${path} must match at least one of the declared input alternatives`);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(alternative => schemaProblems(value, alternative, path).length === 0).length !== 1) {
    problems.push(`${path} must match exactly one of the declared input alternatives`);
  }
  if (object(schema.not) && schemaProblems(value, schema.not, path).length === 0) {
    problems.push(`${path} matches an excluded input alternative`);
  }
  const types = schema.type === undefined ? null : [].concat(schema.type);
  const typeOf = item => item === null ? 'null' : Array.isArray(item) ? 'array' : Number.isInteger(item) ? 'integer' : typeof item;
  if (types && !types.some(type => type === typeOf(value) || (type === 'number' && typeOf(value) === 'integer'))) return [`${path} must be ${types.join(' or ')}`];
  if (schema.enum && !schema.enum.some(item => canonical(item) === canonical(value))) problems.push(`${path} must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`);
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string') {
      let pattern;
      try { pattern = new RegExp(schema.pattern); }
      catch { problems.push(`${path} has an invalid declared pattern`); }
      if (pattern && !pattern.test(value)) problems.push(`${path} must match the declared pattern`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path} must have at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path} must have at most ${schema.maxLength} characters`);
    if (schema.format === 'uri' && !URL.canParse(value)) problems.push(`${path} must be a full web address`);
    if (schema.format === NAMESPACE_FILE && !NAMESPACE_IDENTITY.test(value)) problems.push(`${path} must be a file's identity in this account's files (1f: or 12: then 64 hex), as find_file and list_files return it`);
    if (schema.format === 'date') {
      if (!validCalendarDate(value)) problems.push(`${path} must be a valid calendar date (YYYY-MM-DD)`);
    }
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value)) || !validCalendarDate(value.slice(0, 10)))) {
      problems.push(`${path} must be a valid date-time with a time zone`);
    }
    if (schema.format === 'time-zone' && !timeZoneName(value)) problems.push(`${path} must name a time zone like America/New_York, not an offset`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path} must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path} must have at most ${schema.maxItems} items`);
    if (object(schema.items)) value.forEach((item, index) => problems.push(...schemaProblems(item, schema.items, `${path}[${index}]`)));
  }
  if (object(value)) {
    for (const field of schema.required ?? []) if (value[field] === undefined) problems.push(`${path}.${field} is required`);
    for (const [field, item] of Object.entries(value)) {
      if (object(schema.properties) && Object.hasOwn(schema.properties, field)) problems.push(...schemaProblems(item, schema.properties[field], `${path}.${field}`));
      else if (schema.additionalProperties === false) problems.push(`${path}.${field} is not an input this tool takes`);
    }
  }
  return problems;
}


// Privacy follows every schema composition supported by schemaProblems. Union
// matching branches so ambiguous alternatives can never disclose a private leaf.
const privacySchemas = (value, schemas) => schemas.flatMap(schema => {
  if (!object(schema)) return [];
  const selected = [...(schema.allOf ?? [])];
  for (const key of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[key])) continue;
    const matching = schema[key].filter(branch => schemaProblems(value, branch).length === 0);
    selected.push(...(matching.length ? matching : schema[key]));
  }
  return [schema, ...privacySchemas(value, selected)];
});
export function operationPrivateValue(value, schema, { reject = false } = {}) {
  const visit = (item, schemas) => {
    const active = privacySchemas(item, schemas);
    if (active.some(rule => rule.writeOnly === true)) {
      if (reject) throw Object.assign(new Error('Use an opaque held credential reference instead of a raw write-only input.'), { status: 400, code: 'capability_credential_reference_required' });
      return '[write-only]';
    }
    if (Array.isArray(item)) return item.map((child, index) => visit(child, active.flatMap(rule => {
      const shape = Array.isArray(rule.items) ? rule.items[index] : rule.items;
      return object(shape) ? [shape] : [];
    })));
    if (object(item)) return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, active.flatMap(rule => {
      const shape = rule.properties?.[key] ?? (object(rule.additionalProperties) ? rule.additionalProperties : null);
      return object(shape) ? [shape] : [];
    }))]));
    return item;
  };
  return visit(value, [schema]);
}
export const assertReplayableInput = (value, schema) => operationPrivateValue(value, schema, { reject: true });
