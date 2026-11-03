// src/keyed-parts.mjs
//
// Purpose: one way to carry a streamed answer: keyed parts, each merged into place by its type, with a patch part for
// changing a part already sent, a snapshot for re-attaching an interrupted stream, and a bounded count of attempts that
// brought nothing. A source list is a part of its own (it may say where its next page is) and so are related questions,
// so the words of the answer are never held up by them.
//
// Non-negotiable invariants
//   1. Part types, how each merges and the stall limit are DATA (src/keyed-parts.json); this file names no type.
//   2. A patch that does not apply never loses the answer: it is recorded under `drift` and kept as a part of its own
//      (`<target>~patch`), and the entry carries on. An event of a type the table does not know is kept as it came.
//   3. Events carry a sequence number; one at or below the entry's is already held and is ignored, so a replayed stream
//      adds nothing twice.
//   4. A snapshot replaces every part and sets the sequence, so a re-attach continues from there.
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import rules from './keyed-parts.json' with { type: 'json' };

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const clone = value => structuredClone(value);

/** A new, empty entry. */
export const newEntry = () => ({ seq: 0, order: [], parts: {}, drift: [], stalls: 0 });

function pointer(root, path) {
  const keys = path.split('/').slice(1).map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
  let holder = root;
  for (const key of keys.slice(0, -1)) { holder = holder?.[key]; if (holder === undefined || holder === null || typeof holder !== 'object') throw new Error(`nothing at ${path}`); }
  return { holder, key: keys.at(-1) };
}

/** The value after the ops: add, replace, remove at JSON pointers. Throws on an op that cannot apply. */
export function applyOps(value, ops, allowed = rules.patch_ops) {
  const next = clone(value);
  for (const op of ops) {
    if (!allowed.includes(op?.op) || typeof op.path !== 'string') throw new Error(`op ${op?.op} is not allowed`);
    if (op.path === '') { if (op.op === 'remove') throw new Error('cannot remove the whole value'); return clone(op.value); }
    const { holder, key } = pointer(next, op.path);
    if (Array.isArray(holder)) {
      const index = key === '-' ? holder.length : Number(key);
      if (!Number.isInteger(index) || index < 0 || index > holder.length || (op.op !== 'add' && index >= holder.length)) throw new Error(`no item at ${op.path}`);
      if (op.op === 'add') holder.splice(index, 0, clone(op.value)); else if (op.op === 'replace') holder[index] = clone(op.value); else holder.splice(index, 1);
    } else {
      if (op.op !== 'add' && !Object.hasOwn(holder, key)) throw new Error(`no value at ${op.path}`);
      if (op.op === 'remove') delete holder[key]; else holder[key] = clone(op.value);
    }
  }
  return next;
}

/** The entry with one event merged in (a new object; the one given is not changed). */
export function mergeEvent(entry, event, data = rules) {
  if (Number.isInteger(event.seq) && event.seq <= entry.seq) return entry;
  const next = { ...entry, order: [...entry.order], parts: { ...entry.parts }, drift: [...entry.drift], stalls: 0, seq: Number.isInteger(event.seq) ? event.seq : entry.seq };
  if (event.type === data.resume.snapshot_type) return { ...next, order: [...(event.order ?? Object.keys(event.parts ?? {}))], parts: clone(event.parts ?? {}) };
  const spec = data.types[event.type];
  const put = (key, part) => { if (!(key in next.parts)) next.order.push(key); next.parts[key] = part; };
  if (!spec) { next.drift.push({ key: event.key, why: fill(data.words.unknown_type, { type: event.type }) }); put(event.key, event); return next; }
  const held = next.parts[event.key];
  if (spec.merge === 'append') put(event.key, { type: event.type, text: `${held?.text ?? ''}${event.text ?? ''}` });
  else if (spec.merge === 'replace') put(event.key, { type: event.type, value: clone(event.value), ...(event.more ? { more: event.more } : {}) });
  else {
    const target = next.parts[event.target];
    try {
      if (!target) throw new Error(`no part ${event.target}`);
      put(event.target, { ...target, value: applyOps(target.value, event.ops ?? []) });
    } catch (error) {
      next.drift.push({ key: event.target, why: fill(data.words.patch_failed, { target: event.target, why: error.message }) });
      put(`${event.target}~patch`, { type: event.type, ops: clone(event.ops ?? []) });
    }
  }
  return next;
}

/** What a client keeps to re-attach: the sequence it holds and the BLAKE3 of its parts, so the sender can tell it is whole. */
export const resumeToken = entry => ({ seq: entry.seq, identity: bytesToHex(blake3(new TextEncoder().encode(JSON.stringify([entry.order, entry.parts])))) });

/** After a re-attach attempt: whether it brought anything new. → { entry, give_up, words? } */
export function afterAttempt(entry, before, data = rules) {
  const progressed = entry.seq > before.seq;
  const stalls = progressed ? 0 : entry.stalls + 1;
  const giveUp = stalls >= data.resume.max_stalls;
  return { entry: { ...entry, stalls }, give_up: giveUp, ...(giveUp ? { words: fill(data.words.gave_up, { count: stalls }) } : {}) };
}
