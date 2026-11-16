// A toolkit row's stack: the things a toolkit carries besides its tools (a database, files, screens, hosting, sign-in, payments),
// each a slot filled by a list of pointers. A pointer is where the thing is (door), the language it speaks (speaks), its name at
// that address (label) and the name of the vault entry that holds its key (credential); the key is never in a row. This is DATA
// the AI and a tool read once, beside the path to the thing and never in it: nothing here calls a pointer, orders attempts or
// edits a row. Changing a slot is the person or their AI editing the row.
//
//   stack     { <slot>: [ { id, door, speaks, label?, credential? }, ... ], ... }
//
// Slot names are the row's own words and every limit and pattern is read-data/stack-policy.json: nothing here names a slot, a
// vendor or a database. Nothing here reads storage, the network or the clock, and nothing is written.
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
    const repeated = read.map(pointer => pointer.id).find((id, at, all) => all.indexOf(id) !== at);
    if (repeated) throw new Error(`${where}.${slot} repeats the pointer id ${repeated}.`);
    return [slot, read];
  }));
}

/** The toolkit value's stack, checked. A value with no stack has none: a row of tools only reads as before. */
export function readToolkitStack(value, where = 'value') {
  if (value.stack === undefined) return null;
  return readStack(value.stack, `${where}.stack`);
}
