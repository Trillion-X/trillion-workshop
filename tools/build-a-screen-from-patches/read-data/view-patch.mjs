// src/view-patch.mjs
//
// PURPOSE
//   A screen drawn inside an AI app reads the person's Trillion again each time the store changes (src/workspace/store-changes.ts).
//   Most of what it reads again has not changed. This sends the changes against the answer the screen already holds instead of
//   the whole answer: RFC 6902 style operations over a JSON answer, named by the identity of the answer they apply to and the
//   identity of the answer they produce.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A patch is only made against an answer the Worker still holds for the same person and path whose identity (BLAKE3 of the
//      text) is the one the screen says it holds; anything else answers the whole text.
//   2. The screen checks the identity of what it rebuilt; a mismatch reads the whole answer again.
//   3. The limits are DATA (./view-patch.json). The cache key names the person, so one person's answer is never a base for another's.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import settings from './view-patch.json' with { type: 'json' };

const encoder = new TextEncoder();
/** The identity of an answer's text. */
export const identityOf = text => makeHashCodeHexFromBytes(encoder.encode(text)).slice(3);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = parts => parts.map(part => `/${String(part).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
const unpointer = path => (path === '' ? [] : path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The operations (add, remove, replace) that turn `before` into `after`. An array is compared by position. */
export function diff(before, after, path = []) {
  if (same(before, after)) return [];
  if (isObject(before) && isObject(after)) {
    const ops = [];
    for (const key of Object.keys(before)) if (!(key in after)) ops.push({ op: 'remove', path: pointer([...path, key]) });
    for (const key of Object.keys(after)) {
      if (!(key in before)) ops.push({ op: 'add', path: pointer([...path, key]), value: after[key] });
      else ops.push(...diff(before[key], after[key], [...path, key]));
    }
    return ops;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const ops = [];
    const common = Math.min(before.length, after.length);
    for (let at = 0; at < common; at += 1) ops.push(...diff(before[at], after[at], [...path, at]));
    for (let at = before.length - 1; at >= common; at -= 1) ops.push({ op: 'remove', path: pointer([...path, at]) });
    for (let at = common; at < after.length; at += 1) ops.push({ op: 'add', path: pointer([...path, at]), value: after[at] });
    return ops;
  }
  return [{ op: 'replace', path: pointer(path), value: after }];
}

// `node` with one operation applied at `parts` below it: each object or list on the way is copied, everything beside
// the way is kept as it was, so an unchanged branch keeps its identity (a screen redraws only what changed).
function changedAlong(node, parts, op, value, path) {
  if (node === undefined || node === null || typeof node !== 'object') throw new Error(`Nothing at ${path}`);
  const [key, ...rest] = parts;
  const copy = Array.isArray(node) ? node.slice() : { ...node };
  if (rest.length) { copy[key] = changedAlong(copy[key], rest, op, value, path); return copy; }
  if (Array.isArray(copy)) {
    const at = key === '-' ? copy.length : Number(key);
    if (!Number.isInteger(at) || at < 0 || at > copy.length) throw new Error(`Not a place in the list: ${path}`);
    if (op === 'remove') copy.splice(at, 1); else if (op === 'add') copy.splice(at, 0, structuredClone(value)); else copy[at] = structuredClone(value);
  } else if (op === 'remove') delete copy[key];
  else copy[key] = structuredClone(value);
  return copy;
}

/** `model` with the operations applied (a new model; the model given is not changed, and what no operation touched is
 * shared with it). */
export function applyPatch(model, ops) {
  let root = model;
  for (const { op, path, value } of ops) {
    const parts = unpointer(path);
    if (!parts.length) { if (op === 'remove') throw new Error('The whole answer cannot be removed.'); root = structuredClone(value); continue; }
    root = changedAlong(root, parts, op, value, path);
  }
  return root;
}

/** A bounded cache of the last answer per (person, path): the oldest goes first. */
export function makeAnswerCache(config = settings) {
  const held = new Map();
  return {
    get: key => held.get(key),
    set(key, entry) {
      held.delete(key);
      held.set(key, entry);
      while (held.size > config.entries) held.delete(held.keys().next().value);
    },
    size: () => held.size,
  };
}

/**
 * The answer to one read, as a patch when the screen's `have` is the answer held here and the patch is smaller, else whole.
 * `answer` is { status, content_type, text } (src/screen-view.mjs screenReadAnswer); the result keeps its fields, adds `identity`,
 * and when patched drops `text` and carries `patch: { from, to, ops }`.
 */
export function patchedAnswer({ answer, have, key, cache, config = settings }) {
  const text = answer?.text;
  if (answer?.status !== 200 || typeof text !== 'string' || text.length < config.least_chars || text.length > config.most_chars) return answer;
  // The identity is of the answer's canonical JSON text (what a screen rebuilds), so formatting never makes a rebuilt answer differ.
  let after;
  try { after = JSON.parse(text); } catch { return answer; }
  const canonical = JSON.stringify(after);
  const identity = identityOf(canonical);
  const base = typeof have === 'string' ? cache.get(key) : undefined;
  cache.set(key, { identity, text: canonical });
  if (!base || base.identity !== have || have === identity) return { ...answer, identity };
  const ops = diff(JSON.parse(base.text), after);
  if (JSON.stringify(ops).length >= canonical.length * config.patch_share) return { ...answer, identity };
  const { text: _whole, ...rest } = answer;
  return { ...rest, identity, patch: { from: have, to: identity, ops } };
}

/**
 * The text a screen shows after one answer. `held` is { identity, text } or undefined. Returns { text, held } (`held` is what to hold for the next ask, when the answer named an identity) or, when the
 * patch cannot be applied to what is held or does not rebuild its stated identity, { stale: true } so the screen reads the whole.
 */
export function textAfter(answer, held) {
  if (!answer?.patch) {
    // A whole answer that names an identity is held in its canonical form, when that form really has the identity.
    if (typeof answer?.identity !== 'string' || typeof answer.text !== 'string') return { text: answer?.text ?? '' };
    try {
      const canonical = JSON.stringify(JSON.parse(answer.text));
      return identityOf(canonical) === answer.identity ? { text: answer.text, held: { identity: answer.identity, text: canonical } } : { text: answer.text };
    } catch { return { text: answer.text }; }
  }
  if (!held || held.identity !== answer.patch.from) return { stale: true };
  try {
    const text = JSON.stringify(applyPatch(JSON.parse(held.text), answer.patch.ops));
    return identityOf(text) === answer.patch.to ? { text, held: { identity: answer.patch.to, text } } : { stale: true };
  } catch { return { stale: true }; }
}
