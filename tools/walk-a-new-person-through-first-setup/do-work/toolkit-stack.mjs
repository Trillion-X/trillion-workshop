// A toolkit row's stack: the things a toolkit carries besides its tools (a database, files, screens, hosting, sign-in, payments),
// each a slot filled by an ordered list of pointers. A pointer is where the thing is (door), the language it speaks (speaks), its
// name at that address (label) and the name of the vault entry that holds its key (credential); the key is never in a row. The
// first pointer of a slot that answers is used, so a failure moves to the next pointer and a swap is a reorder. A swap keeps its
// inverse (the order before, the order after) in the row's own `swaps`, and undo puts the earlier order back.
//
//   stack     { <slot>: [ { id, door, speaks, label?, credential? }, ... ], ... }
//   swaps     [ { slot, was: [pointer ids], now: [pointer ids] }, ... ]  oldest first; undo takes the last
//
// Slot names are the row's own words and every limit and pattern is read-data/stack-policy.json: nothing here names a slot, a
// vendor or a database. Nothing here reads storage, the network or the clock, and nothing is written; each function answers a new
// value and leaves the one handed in as it was.
import policy from '../read-data/stack-policy.json' with { type: 'json' };

const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const pattern = Object.fromEntries(Object.entries(policy.patterns).map(([name, source]) => [name, new RegExp(source)]));
const bytes = text => Buffer.byteLength(text, 'utf8');
const { required, optional } = policy.pointer_fields;

/** One pointer, checked: only its declared fields, each in its declared shape. A key value has no field to sit in, and a
 *  door address with a user, a password, a query or a fragment is refused (the places a key hides in an address). */
export function readPointer(pointer, where) {
  if (!object(pointer)) throw new Error(`${where} is a pointer: { ${required.join(', ')}${optional.length ? `, ${optional.map(name => `${name}?`).join(', ')}` : ''} }.`);
  const stray = Object.keys(pointer).filter(name => !required.includes(name) && !optional.includes(name));
  if (stray.length) throw new Error(`${where} holds ${stray.join(', ')}: a pointer holds only ${[...required, ...optional].join(', ')}. A key is kept in the vault and named by credential, never written in a row.`);
  for (const name of required) if (typeof pointer[name] !== 'string' || !pointer[name]) throw new Error(`${where} needs its ${name}.`);
  for (const [name, value] of Object.entries(pointer)) {
    if (typeof value !== 'string' || !pattern[name].test(value)) throw new Error(`${where}.${name} is not written in the shape ${name} takes (${policy.patterns[name]}).`);
  }
  if (bytes(pointer.door) > policy.most_door_bytes) throw new Error(`${where}.door is over ${policy.most_door_bytes} bytes.`);
  if (pointer.credential !== undefined && bytes(pointer.credential) > policy.most_credential_bytes) throw new Error(`${where}.credential is over ${policy.most_credential_bytes} bytes: it names a vault entry, it is not a key.`);
  return { ...pointer };
}

const ids = pointers => pointers.map(pointer => pointer.id);
const sameOrder = (a, b) => a.length === b.length && a.every((id, at) => id === b[at]);

/** A stack read from a toolkit row's value: every slot a non-empty ordered list of pointers, each id once in its slot. */
export function readStack(stack, where = 'stack') {
  if (!object(stack)) throw new Error(`${where} is { slot: [pointer, ...] }.`);
  const slots = Object.keys(stack);
  if (slots.length > policy.most_slots) throw new Error(`${where} has ${slots.length} slots; at most ${policy.most_slots}.`);
  return Object.fromEntries(slots.map(slot => {
    if (!pattern.slot.test(slot)) throw new Error(`${where} has the slot name ${JSON.stringify(slot)}; a slot name is written ${policy.patterns.slot}.`);
    const pointers = stack[slot];
    if (!Array.isArray(pointers) || pointers.length === 0) throw new Error(`${where}.${slot} is an ordered list of at least one pointer.`);
    if (pointers.length > policy.most_pointers_per_slot) throw new Error(`${where}.${slot} has ${pointers.length} pointers; at most ${policy.most_pointers_per_slot}.`);
    const read = pointers.map((pointer, at) => readPointer(pointer, `${where}.${slot}[${at}]`));
    const repeated = ids(read).find((id, at, all) => all.indexOf(id) !== at);
    if (repeated) throw new Error(`${where}.${slot} repeats the pointer id ${repeated}.`);
    return [slot, read];
  }));
}

function readSwaps(swaps, stack, where) {
  if (!Array.isArray(swaps) || !swaps.every(swap => object(swap) && typeof swap.slot === 'string' && Array.isArray(swap.was) && Array.isArray(swap.now))) {
    throw new Error(`${where} is a list of { slot, was: [pointer ids], now: [pointer ids] }.`);
  }
  if (swaps.length > policy.most_swaps_kept) throw new Error(`${where} keeps ${swaps.length} swaps; at most ${policy.most_swaps_kept}.`);
  for (const swap of swaps) {
    if (!stack[swap.slot]) throw new Error(`${where} names the slot ${swap.slot}, which the stack does not hold.`);
  }
  return swaps;
}

/** The toolkit value's stack and its swaps, checked. A value with no stack has none: a row of tools only reads as before. */
export function readToolkitStack(value, where = 'value') {
  if (value.stack === undefined) {
    if (value.swaps !== undefined) throw new Error(`${where} keeps swaps but holds no stack.`);
    return null;
  }
  const stack = readStack(value.stack, `${where}.stack`);
  const swaps = value.swaps === undefined ? [] : readSwaps(value.swaps, stack, `${where}.swaps`);
  return { stack, swaps };
}

/** A swap: slot `slot` reordered to `order`, which names every pointer the slot holds once. The new value keeps the order before
 *  and the order after in `swaps`, so the swap can be taken back. The value handed in is left as it was. */
export function swapSlot(value, { slot, order }) {
  const read = readToolkitStack(value);
  if (!read) throw new Error('This toolkit holds no stack to swap in.');
  const pointers = read.stack[slot];
  if (!pointers) throw new Error(`The stack has no slot ${slot}; its slots are ${Object.keys(read.stack).join(', ')}.`);
  if (!Array.isArray(order) || !order.every(id => typeof id === 'string')) throw new Error('order is the list of the slot\'s pointer ids, first choice first.');
  const was = ids(pointers);
  if (order.length !== was.length || new Set(order).size !== order.length || !order.every(id => was.includes(id))) {
    throw new Error(`A swap reorders the pointers a slot holds and names each once: ${slot} holds ${was.join(', ')}.`);
  }
  if (sameOrder(was, order)) throw new Error(`${slot} is already in that order.`);
  if (read.swaps.length >= policy.most_swaps_kept) throw new Error(`${policy.most_swaps_kept} swaps are kept already; take one back before another.`);
  const byId = new Map(pointers.map(pointer => [pointer.id, pointer]));
  return {
    ...value,
    stack: { ...read.stack, [slot]: order.map(id => byId.get(id)) },
    swaps: [...read.swaps, { slot, was, now: [...order] }],
  };
}

/** Takes back the last swap: the slot goes back to the order before it, and the swap leaves the log (the log leaves the value
 *  when it is empty), so swap then undo is the value that was handed to the swap, byte for byte. */
export function undoSwap(value) {
  const read = readToolkitStack(value);
  const last = read?.swaps.at(-1);
  if (!last) throw new Error('There is no swap to take back.');
  const pointers = read.stack[last.slot];
  if (!sameOrder(ids(pointers), last.now)) throw new Error(`${last.slot} was reordered after that swap was kept; it cannot be taken back over a later order.`);
  const byId = new Map(pointers.map(pointer => [pointer.id, pointer]));
  const { swaps, ...rest } = value;
  const kept = read.swaps.slice(0, -1);
  return { ...rest, stack: { ...read.stack, [last.slot]: last.was.map(id => byId.get(id)) }, ...(kept.length ? { swaps: kept } : {}) };
}

/** The pointer a slot uses: the first, in order, that `answers` says is up. A probe that throws counts as not answering.
 *  Answers { pointer, tried } with pointer null when none answers; `tried` names each pointer asked, in order. */
export async function firstAnswering(pointers, answers) {
  const tried = [];
  for (const pointer of pointers) {
    tried.push(pointer.id);
    let up = false;
    try { up = (await answers(pointer)) === true; } catch { up = false; }
    if (up) return { pointer, tried };
  }
  return { pointer: null, tried };
}
