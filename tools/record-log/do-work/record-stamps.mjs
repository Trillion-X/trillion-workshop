// parts/record-log/do-work/record-stamps.mjs
//
// EVERY FIELD OF EVERY RECORD CARRIES THE STAMP OF THE WRITE THAT SET IT, AND TWO COPIES MERGE BY KEEPING, FIELD BY
// FIELD, THE LATER STAMP: THE SAME ANSWER IN ANY ORDER, ANY NUMBER OF TIMES, ACROSS ANY NUMBER OF COPIES.
//
// Purpose
//   Copies of a record store that change apart (a device offline, a peer, a space's store) must end equal however
//   their changes cross. Comparing each change with what it replaced settles two copies, but not three: a change relayed
//   through a third copy looks new on one and stale on another, and the copies stay apart. A record's state here is a
//   join: each field is (value or removed, stamp), and the record has a floor (the stamp of its last whole write or
//   removal: fields stamped before it are gone) with the kind of write that set it. Merging two states keeps the later
//   stamp per field and the later floor, so it is commutative, associative and idempotent, and copies that have seen
//   the same changes hold the same state.
//
// Non-negotiable invariants
//   1. A stamp is text that sorts by when its write was made (a log row's time, then its own bits, then the envelope's
//      place in the row): the later write wins. A write made here is always stamped after everything the record holds
//      (stampAfter), so a copy whose clock runs behind another's never loses its own newer change.
//   2. Two different values with one stamp (two copies that each moved past the same stamp at once) are settled by
//      `tie`, the same rule on every copy.
//   3. One state keeps one stamps text (sorted). What is kept is compact: `meta` = { at (the latest stamp), f (the floor, when it is not `at`), k ('removed' when
//      the floor is a removal), s (fields stamped other than `at`), d (removed fields stamped after the floor) }. A
//      record written whole once keeps only { at }.
//   4. Nothing here reads storage or names a record kind: states in, states out.
//
// Key concepts
//   state   { floor, kind: 'whole' | 'removed' | null, type, typeAt, fields: Map(field -> { stamp, value, removed }) }
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const NONE = '';
const ownStamp = (stamps, field, fallback) => stamps && Object.hasOwn(stamps, field) ? stamps[field] : fallback;
const later = (a, b) => (a > b ? a : b);

/** A stamp after `held` and no earlier than `fresh`: a write made here wins over everything the record holds. */
export function stampAfter(fresh, held) {
  if (!held || fresh > held) return fresh;
  return `${held}${fresh.slice(-7)}`;
}

/** The state a kept record holds: { type, value, meta } (meta null for a record kept before stamps), a removed
 *  record's { type: null, meta }, or null. */
export function stateOf(kept) {
  const fields = new Map();
  if (!kept) return { floor: NONE, kind: null, type: null, typeAt: NONE, fields };
  const meta = kept.meta ?? null;
  const at = meta?.at ?? NONE;
  const floor = meta?.f ?? at;
  for (const [field, stamp] of Object.entries(meta?.d ?? {})) fields.set(field, { stamp, removed: true });
  if (kept.type !== null && kept.value) {
    for (const field of Object.keys(kept.value)) if (kept.value[field] !== undefined) fields.set(field, { stamp: ownStamp(meta?.s, field, at), value: kept.value[field] });
  }
  return { floor, kind: meta?.k === 'removed' || kept.type === null ? 'removed' : 'whole', type: kept.type, typeAt: at, fields };
}

/** The state one envelope carries: stamped `stamp` unless it names its own (`at`, and per field `stamps`, and `floor`
 *  with `floor_kind` for a change that included a whole write or a removal). */
export function stateFrom(envelope, stamp) {
  const at = envelope.at ?? stamp;
  const fields = new Map();
  if (envelope.remove) {
    for (const [field, removedAt] of Object.entries(envelope.removed ?? {})) fields.set(field, { stamp: removedAt, removed: true });
    return { floor: envelope.floor ?? at, kind: 'removed', type: null, typeAt: NONE, fields };
  }
  if (envelope.value !== undefined) {
    for (const field of Object.keys(envelope.value)) if (envelope.value[field] !== undefined) fields.set(field, { stamp: ownStamp(envelope.stamps, field, at), value: envelope.value[field] });
    for (const [field, removedAt] of Object.entries(envelope.removed ?? {})) fields.set(field, { stamp: removedAt, removed: true });
    return { floor: envelope.floor ?? at, kind: envelope.floor_kind ?? 'whole', type: envelope.type, typeAt: at, fields };
  }
  for (const [field, value] of Object.entries(envelope.set ?? {})) fields.set(field, { stamp: ownStamp(envelope.stamps, field, at), value });
  for (const field of envelope.unset ?? []) fields.set(field, { stamp: ownStamp(envelope.stamps, field, at), removed: true });
  return { floor: envelope.floor ?? NONE, kind: envelope.floor === undefined ? null : (envelope.floor_kind ?? 'whole'), type: envelope.type, typeAt: at, fields };
}

const text = cell => (cell.removed ? '' : `~${JSON.stringify(cell.value)}`);
/** The later of two cells; one stamp on both is settled by `tie` (true: b wins). */
function laterCell(a, b, tie) {
  if (a.stamp !== b.stamp) return a.stamp > b.stamp ? a : b;
  return text(a) === text(b) || !tie(a, b) ? a : b;
}
/** Removed first, then the lower value text: the rule every copy runs for one stamp on two values. */
export const tieByContent = (a, b) => text(b) < text(a);

/** The join of two states. */
export function merge(a, b, tie = tieByContent) {
  const floor = later(a.floor, b.floor);
  const kind = a.floor === b.floor ? (a.kind === 'removed' || b.kind === 'removed' ? 'removed' : (a.kind ?? b.kind)) : (a.floor > b.floor ? a.kind : b.kind);
  const [type, typeAt] = b.typeAt > a.typeAt && b.type !== null ? [b.type, b.typeAt] : (a.type !== null ? [a.type, a.typeAt] : [b.type, b.typeAt]);
  const fields = new Map();
  for (const [field, cell] of a.fields) if (cell.stamp >= floor) fields.set(field, cell);
  for (const [field, cell] of b.fields) {
    if (cell.stamp < floor) continue;
    const held = fields.get(field);
    fields.set(field, held ? laterCell(held, cell, tie) : cell);
  }
  return { floor, kind, type, typeAt, fields };
}

/** Whether the state is a record: its floor is a whole write, or a field was written after a removal. */
export function exists(state) {
  if (state.kind === 'whole') return true;
  for (const cell of state.fields.values()) if (!cell.removed && cell.stamp > state.floor) return true;
  return false;
}

/** The state as kept: { type, value, meta } for a record, { type: null, value: null, meta } once removed, or null for
 *  a state that holds nothing. */
export function keptFrom(state) {
  if (state.floor === NONE && !state.fields.size) return null;
  let at = state.floor;
  for (const cell of state.fields.values()) at = later(at, cell.stamp);
  const meta = { at };
  if (state.floor !== at) meta.f = state.floor;
  if (state.kind === 'removed') meta.k = 'removed';
  const live = exists(state);
  const value = {};
  for (const [field, cell] of state.fields) if (live && !cell.removed) value[field] = cell.value;
  // Stamps in one order, so two copies holding one state keep the same stamps text (the value keeps its fields in the
  // order they were written; the checksum reads it field by field).
  for (const field of [...state.fields.keys()].sort()) {
    const cell = state.fields.get(field);
    if (cell.removed) { if (cell.stamp > state.floor) (meta.d ??= {})[field] = cell.stamp; continue; }
    if (live && cell.stamp !== at) (meta.s ??= {})[field] = cell.stamp;
  }
  return live ? { type: state.type, value, meta } : { type: null, value: null, meta };
}

/** The envelope that carries a kept state whole (a record, or what a removal left) to another copy: merged there, it
 *  gives that copy at least this state. */
export function envelopeOfKept(id, kept) {
  const { meta } = kept;
  const stamps = { at: meta.at, floor: meta.f ?? meta.at, ...(meta.k ? { floor_kind: meta.k } : {}), ...(meta.d ? { removed: meta.d } : {}) };
  return kept.type === null ? { id, remove: true, ...stamps } : { id, type: kept.type, value: kept.value, ...(meta.s ? { stamps: meta.s } : {}), ...stamps };
}

/** Whether two kept forms are the same state. */
export const sameKept = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
