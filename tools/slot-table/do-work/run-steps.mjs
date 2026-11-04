// tools/slot-table/do-work/run-steps.mjs
//
// The slot table as one run: a table is made from `capacity_bytes` and `columns`, the `steps` are applied to it in
// order, and what each step answered and what the table holds at the end come back. Nothing is kept after the run, so
// a caller that wants the same table again sends the same steps again.
//
// Steps (each { op, key, ... }):
//   set   { key, kind, value, bytes? }  admits or updates the key (bytes: what it costs the budget, the length of its
//                                       JSON when left out); answers { slot, version }
//   find  { key }                       answers { slot } (-1 when the key is not held)
//   read  { key }                       answers { held, kind?, value?, version?, bytes? }
//   drop  { key }                       lets the key go; answers { held: false }
//   kind  { kind }                      answers { keys }: every key of that kind still held
//   clear {}                            lets every key go
// A step that names no op this file knows is refused with the ops it does know.
import { slotTable } from './slot-table.mjs';

const OPS = ['set', 'find', 'read', 'drop', 'kind', 'clear'];

export function runSlotTableSteps({ capacity_bytes, columns = [], steps } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('Give steps: a list of { op, key, ... } (ops: set, find, read, drop, kind, clear).');
  const table = slotTable({ capacity_bytes, columns });
  const answers = steps.map((step, index) => {
    const op = step?.op;
    if (!OPS.includes(op)) throw new Error(`Step ${index} has op ${JSON.stringify(op)}; use one of ${OPS.join(', ')}.`);
    if (op !== 'clear' && op !== 'kind' && typeof step.key !== 'string') throw new Error(`Step ${index} (${op}) needs key: a string.`);
    if (op === 'set') {
      if (typeof step.kind !== 'string' || !step.kind) throw new Error(`Step ${index} (set) needs kind: a non-empty string.`);
      const bytes = Number.isFinite(step.bytes) ? step.bytes : (JSON.stringify(step.value) ?? '').length;
      const slot = table.set(step.key, step.kind, step.value, undefined, bytes);
      return { op, key: step.key, slot, version: table.versionOf(slot) };
    }
    if (op === 'find') return { op, key: step.key, slot: table.find(step.key) };
    if (op === 'read') {
      const slot = table.find(step.key);
      if (slot < 0) return { op, key: step.key, held: false };
      return { op, key: step.key, held: true, kind: table.kindOf(slot), value: table.value(slot), version: table.versionOf(slot), bytes: table.bytesOf(slot) };
    }
    if (op === 'drop') { table.drop(step.key); return { op, key: step.key, held: false }; }
    if (op === 'kind') {
      if (typeof step.kind !== 'string') throw new Error(`Step ${index} (kind) needs kind: a string.`);
      return { op, kind: step.kind, keys: [...table.slotsOfKind(step.kind)].map(slot => table.keyOf(slot)) };
    }
    table.clear();
    return { op };
  });
  return { answers, held: table.held() };
}
