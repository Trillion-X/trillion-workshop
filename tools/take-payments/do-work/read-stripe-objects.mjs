// tools/take-payments/do-work/read-stripe-objects.mjs
//
// A read of Stripe that answers a list of things, run from one row of read-data/stripe-read-shapes.json. The row names
// the Stripe operation, the inputs and what each may be, what to expand, and the shape of each thing returned; this
// file names no provider, address, id shape or field. Only GET requests are ever sent (the sender handed in is wrapped
// so a request of any other method is refused before it leaves), and the key stays in the sender: it is never here.
import { call } from './build-provider-request.mjs';
import readShapes from '../read-data/stripe-read-shapes.json' with { type: 'json' };

export class StripeReadError extends Error {}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const paths = from => [from].flat();
const at = (source, path) => String(path).split('.').reduce((node, key) => (isObject(node) ? node[key] : undefined), source);
const firstFound = (source, from) => paths(from).map(path => at(source, path)).find(value => value !== undefined && value !== null);

/** The sender, made to refuse anything that is not a read. */
export function readOnly(send) {
  return async request => {
    if (request?.method !== 'GET') throw new StripeReadError(`A read sends GET requests only; this one was ${request?.method ?? 'not a request'}.`);
    return send(request);
  };
}

/** What a shape picks out of one thing Stripe sent. A leaf is a path (or paths); a field not sent answers null. */
export function project(source, shape) {
  return Object.fromEntries(Object.entries(shape).map(([name, field]) => {
    if (typeof field === 'string' || Array.isArray(field)) return [name, firstFound(source, field) ?? null];
    if (!('from' in field)) return [name, project(source, field)];
    const nested = firstFound(source, field.from);
    return [name, isObject(nested) ? project(nested, field.shape) : null];
  }));
}

function readOf(readId) {
  const row = readShapes.reads.find(candidate => candidate.read_id === readId);
  if (!row) throw new StripeReadError(`There is no read named ${readId}.`);
  return row;
}

// The query the input asks for, in the row's own order: only the inputs the row names, each of the type the row says.
function queryOf(row, input) {
  const asked = isObject(input) ? input : {};
  const unknown = Object.keys(asked).filter(name => !(name in row.inputs));
  if (unknown.length) throw new StripeReadError(`This read takes ${Object.keys(row.inputs).join(', ')}; it does not take ${unknown.join(', ')}.`);
  const query = {};
  for (const [name, rule] of Object.entries(row.inputs)) {
    const value = asked[name];
    if (value === undefined || value === null) continue;
    const typeOk = rule.type === 'integer' ? Number.isSafeInteger(value) : typeof value === rule.type;
    if (!typeOk || (typeof value === 'number' && (value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity)))) {
      throw new StripeReadError(`${name} must be ${rule.type === 'integer' ? 'a whole number' : `a ${rule.type}`}${rule.minimum === undefined ? '' : ` from ${rule.minimum} to ${rule.maximum}`}.`);
    }
    query[rule.query] = value;
  }
  return row.expand?.length ? { ...query, expand: row.expand } : query;
}

/**
 * @param {string} readId a read_id of read-data/stripe-read-shapes.json
 * @param {object} input the inputs the row names
 * @param {{ send: (request: object) => Promise<object> }} options send delivers one built request and answers Stripe's decoded reply
 * @returns the things Stripe listed, each in the row's shape, and whether Stripe has more beyond them
 */
export async function readStripeObjects(readId, input, { send }) {
  const row = readOf(readId);
  const reply = await call(readOnly(send), row.operation_id, queryOf(row, input));
  const things = reply?.[row.list_key];
  if (!Array.isArray(things)) throw new StripeReadError('Stripe answered no list for this read.');
  return { [row.result_key]: things.map(thing => project(thing, row.shape)), has_more: reply[row.more_key] === true };
}
