// tools/field-values/do-work/row-paths.mjs
//
// Reading and writing one place in a row. A path is a list of keys and positions (the shape tools/formulas reads
// fields with); writing makes a new row and leaves the one handed in as it was. Emptiness and sameness are judged here
// once, for every tool of this folder.
import { canonicalJson } from '../../content-identity/read-data/identity.mjs';

/** A list of keys (text) and positions (whole numbers from 0). */
export const isPath = value => Array.isArray(value)
  && value.every(step => (typeof step === 'string' && step.length > 0) || (Number.isInteger(step) && step >= 0));

/** The value at `path` in `value`, or undefined when any step is missing. */
export function readAt(value, path) {
  let at = value;
  for (const step of path) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, step)) return undefined;
    at = at[step];
  }
  return at;
}

/** A copy of `value` with `next` at `path`; undefined removes what was there. Missing steps become objects. */
export function writeAt(value, path, next) {
  if (path.length === 0) return next;
  const [step, ...rest] = path;
  const copy = Array.isArray(value) ? [...value] : (value !== null && typeof value === 'object' ? { ...value } : {});
  const inner = writeAt(copy[step], rest, next);
  if (inner === undefined) delete copy[step];
  else copy[step] = inner;
  return copy;
}

/** Nothing there: missing, null, blank text, an empty list or an empty object. */
export const isEmpty = value => value === undefined || value === null
  || (typeof value === 'string' && value.trim() === '')
  || (Array.isArray(value) && value.length === 0)
  || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

/** The same JSON value, whatever order its keys were written in; missing and null are the same. */
export const sameValue = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
