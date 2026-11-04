// Input fields a tool's input_schema marks `writeOnly` (a key, a password) are taken out of the input before
// anything is written, and handed to the run only in memory: splitWriteOnly(value, schema) -> { kept, held }, joinHeld
// puts them back together for the one call that uses them, and heldTexts lists the held values to scrub from anything
// a run answers or throws.
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function splitWriteOnly(value, schema) {
  if (!object(value) || !object(schema?.properties)) return { kept: value, held: undefined };
  const kept = {};
  const held = {};
  for (const [field, item] of Object.entries(value)) {
    const property = schema.properties[field];
    if (property?.writeOnly === true) { held[field] = item; continue; }
    const inner = splitWriteOnly(item, property);
    kept[field] = inner.kept;
    if (inner.held !== undefined) held[field] = inner.held;
  }
  return { kept, held: Object.keys(held).length ? held : undefined };
}
export const joinHeld = (kept, held) => (held === undefined ? kept : object(kept) && object(held)
  ? Object.fromEntries([...new Set([...Object.keys(kept), ...Object.keys(held)])].map(key => [key, joinHeld(kept[key], held[key])]))
  : held);
export const heldTexts = held => (held === undefined ? [] : typeof held === 'string' ? [held] : object(held) || Array.isArray(held) ? Object.values(held).flatMap(heldTexts) : [String(held)])
  .filter(text => text.length > 0).sort((a, b) => b.length - a.length);
