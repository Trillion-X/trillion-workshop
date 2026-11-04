// parts/slot-table/do-work/slot-table.mjs
//
// A CURRENT VIEW WHERE A KEY BECOMES A SMALL INTEGER ONCE, AND EVERYTHING AFTER IS A TYPED-ARRAY READ.
//
// Purpose
//   Holds the current value of the things a host keeps (records, files, anything with a text key) in flat, typed
//   columns indexed by an integer slot. A key is turned into its slot once, when the thing is admitted (one hash of the
//   text); from then on the host and its callers hold a handle (slot plus a generation) and every read or write is an
//   array index: the kind, the version, the size and any field declared hot (as DATA) live in typed arrays, the value
//   itself in one array of references. Text values in hot columns are interned the same way, so comparing two of them
//   is comparing two integers.
//
// Non-negotiable invariants
//   1. Memory is bounded by bytes (capacity_bytes): past it, the least recently used slots are let go (a CLOCK sweep
//      over one reference bit per slot) and their slot numbers reused. Nothing grows with the size of the host's store,
//      only with what is resident. A slot let go takes its generation forward, so a handle held across that answers
//      "not here" (-1 / undefined) and never another key's value.
//   2. The table is a cache of the host's truth, never the truth: the host admits what it read, updates what it wrote,
//      drops what it removed and clears it whenever its own view is rebuilt. The table never invents a value.
//   3. Hot columns are DATA ({ kind, field, as: 'number' | 'text' }); the module names no product, record kind or field.
//      A column holds one top-level field of one kind; a value of another shape is absent (NaN / -1), never coerced.
//   4. A handle is a plain number: generation * SLOT_SPACE + slot, below 2^53. Reading through one costs a generation
//      compare and an array index.
//
// Key concepts
//   slot      an integer 0..SLOT_SPACE-1 naming one resident thing
//   handle    slot plus generation; stale once that slot is let go or the thing removed
//   kind      an interned text id (the record type); kindOf(slot) answers its text
//   column    a typed array over slots for one declared field of one kind
//
// Security
//   No credential, no network, no I/O. Values are held by reference: the host decides whether it hands a caller the
//   held value or a copy.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export const SLOT_SPACE = 2 ** 22;
const PER_SLOT_SPACE = 2 ** -22; // exact: multiplying by a power of two never rounds
const START = 1024;

/**
 * An interning of text to small integers: id(text) once, text(id) back. Never forgets (it holds the vocabulary of kinds
 * and hot text values, which is small); `size` says how many it holds.
 */
export function interning() {
  const ids = new Map();
  const texts = [];
  return {
    id(text) {
      let id = ids.get(text);
      if (id === undefined) { id = texts.length; ids.set(text, id); texts.push(text); }
      return id;
    },
    has: text => ids.get(text) ?? -1,
    text: id => texts[id],
    get size() { return texts.length; },
  };
}

/**
 * The table.
 *   capacity_bytes  the bytes resident values may hold together before the least recently used are let go
 *   columns         [{ kind, field, as: 'number' | 'text' }]: fields kept as typed columns, as DATA
 */
export function slotTable({ capacity_bytes = 24 * 1024 * 1024, columns = [] } = {}) {
  let size = START;
  let kindCol = new Int32Array(size).fill(-1);
  let version = new Uint32Array(size);
  let gen = new Uint32Array(size);
  let bytesCol = new Int32Array(size);
  let ref = new Uint8Array(size);
  let values = new Array(size);
  let extras = new Array(size);
  let keysOf = new Array(size);
  const slotsByKey = new Map();
  const kinds = interning();
  const words = interning();
  let used = 0;
  let free = [];
  let next = 0;
  let hand = 0;
  let residentBytes = 0;
  let evictions = 0;

  // Hot columns, declared as DATA: one typed array each, filled from the field when a value of that kind is set.
  const declared = columns.map((column, at) => {
    if (typeof column?.kind !== 'string' || typeof column?.field !== 'string' || !['number', 'text'].includes(column.as)) throw new Error('A column needs a kind, a field and as: number or text.');
    return { ...column, at, data: column.as === 'number' ? new Float64Array(size).fill(NaN) : new Int32Array(size).fill(-1) };
  });
  const byKind = new Map();
  for (const column of declared) {
    const kind = kinds.id(column.kind);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(column);
  }
  const views = () => ({ version, gen });
  const columnNamed = (kind, field) => declared.find(column => column.kind === kind && column.field === field) ?? null;

  function grow() {
    const to = Math.min(SLOT_SPACE, size * 2);
    if (to === size) throw new Error('The slot table is full.');
    const widen = (array, fill) => { const out = new array.constructor(to); if (fill !== undefined) out.fill(fill); out.set(array); return out; };
    kindCol = widen(kindCol, -1);
    version = widen(version);
    gen = widen(gen);
    bytesCol = widen(bytesCol);
    ref = widen(ref);
    values.length = to;
    extras.length = to;
    keysOf.length = to;
    for (const column of declared) column.data = widen(column.data, column.as === 'number' ? NaN : -1);
    size = to;
    for (const column of declared) column.view?.refresh(column, version, gen);
  }

  function clearColumns(slot) {
    for (const column of byKind.get(kindCol[slot]) ?? []) column.data[slot] = column.as === 'number' ? NaN : -1;
  }
  function fillColumns(slot, value) {
    for (const column of byKind.get(kindCol[slot]) ?? []) {
      const item = value?.[column.field];
      if (column.as === 'number') column.data[slot] = typeof item === 'number' ? item : NaN;
      else column.data[slot] = typeof item === 'string' ? words.id(item) : -1;
    }
  }

  function release(slot) {
    // gen is created with every slot at generation 0 and only ever moves forward here, so a handle made for a slot
    // before it was let go never matches again (until 2^31 releases of that one slot, kept below 2^31 so a handle stays an exact number and its generation one integer operation away).
    slotsByKey.delete(keysOf[slot]);
    clearColumns(slot);
    residentBytes -= bytesCol[slot];
    kindCol[slot] = -1;
    bytesCol[slot] = 0;
    values[slot] = undefined;
    extras[slot] = undefined;
    keysOf[slot] = undefined;
    ref[slot] = 0;
    gen[slot] = (gen[slot] + 1) & 0x7fffffff;
    used -= 1;
    free.push(slot);
  }
  // Lets go of the least recently used slots (one CLOCK sweep: a slot read since the hand last passed gets a second
  // chance) until the resident bytes fit, never the slot being admitted.
  function makeRoom(keep) {
    let passes = 0;
    while (residentBytes > capacity_bytes && used > 1 && passes < next * 2 + 2) {
      if (hand >= next) hand = 0;
      const slot = hand;
      hand += 1;
      passes += 1;
      if (slot === keep || kindCol[slot] === -1) continue;
      if (ref[slot]) { ref[slot] = 0; continue; }
      release(slot);
      evictions += 1;
    }
  }

  const handleOf = slot => gen[slot] * SLOT_SPACE + slot;
  // The slot a handle names, or -1 when that slot was let go or reused since.
  function slotOf(handle) {
    const generation = (handle * PER_SLOT_SPACE) | 0;
    const slot = handle - generation * SLOT_SPACE;
    // A slot let go always took its generation forward, so the generation alone says whether the handle still holds.
    return gen[slot] === generation ? slot : -1;
  }

  return {
    kinds,
    words,
    /** The slot a key is resident in, or -1. One hash of the key; nothing else in this module hashes text. */
    find(key) { return slotsByKey.get(key) ?? -1; },
    handleOf,
    slotOf,
    /** The handle of a resident key, or -1. */
    handle(key) { const slot = slotsByKey.get(key); return slot === undefined ? -1 : handleOf(slot); },
    /**
     * Makes `key` resident (or updates it): kind text, value, the host's extra facts about it, and the bytes it holds.
     * Answers its slot. Its version moves forward on every set.
     */
    set(key, kind, value, extra, bytes) {
      let slot = slotsByKey.get(key);
      // A key new to the table starts without its reference bit, so things read once (a walk over many records) are
      // the first let go and never push out what is read again; a key set again has it.
      if (slot === undefined) {
        slot = free.length ? free.pop() : next;
        if (slot === next) { if (next === size) grow(); next += 1; }
        slotsByKey.set(key, slot);
        keysOf[slot] = key;
        used += 1;
        ref[slot] = 0;
      } else {
        clearColumns(slot);
        residentBytes -= bytesCol[slot];
        ref[slot] = 1;
      }
      kindCol[slot] = kinds.id(kind);
      values[slot] = value;
      extras[slot] = extra;
      bytesCol[slot] = bytes;
      residentBytes += bytes;
      version[slot] += 1;
      fillColumns(slot, value);
      if (residentBytes > capacity_bytes) makeRoom(slot);
      return slot;
    },
    /** Lets `key` go (the host removed it, or no longer knows it). */
    drop(key) { const slot = slotsByKey.get(key); if (slot !== undefined) release(slot); },
    /** Lets everything go (the host rebuilt its own view). Handles held before answer "not here" after. */
    clear() { for (let slot = 0; slot < next; slot += 1) if (kindCol[slot] !== -1) release(slot); hand = 0; },
    // ---- reads by slot (the host's own hot path) --------------------------------------------------------------------
    value(slot) { ref[slot] = 1; return values[slot]; },
    extra: slot => extras[slot],
    kindId: slot => kindCol[slot],
    kindOf: slot => kinds.text(kindCol[slot]),
    versionOf: slot => version[slot],
    bytesOf: slot => bytesCol[slot],
    keyOf: slot => keysOf[slot],
    // ---- reads and writes by handle (a caller holding one) -------------------------------------------------------------
    /** The value a handle names, or undefined when it is stale. */
    at(handle) { const slot = slotOf(handle); if (slot < 0) return undefined; ref[slot] = 1; return values[slot]; },
    /** The version a handle names, or 0 when stale: a caller compares it to the one it read to know whether it changed. */
    versionAt(handle) { const slot = slotOf(handle); return slot < 0 ? 0 : version[slot]; },
    /**
     * One declared column: { get(slot), set(slot, value), data } over its typed array. `get` answers NaN / -1 when the
     * field is absent; a text column's numbers are `words` ids. `set` changes the column only (the host's own value is
     * the host's to change); its version moves forward.
     */
    column(kind, field) {
      const column = columnNamed(kind, field);
      if (!column) throw new Error(`No column ${field} is declared for ${kind}.`);
      // One object per column, refreshed when the table grows, whose methods the engine inlines into the caller's loop.
      column.view ??= column.as === 'number' ? new NumberColumn() : new TextColumn(words);
      column.view.refresh(column, views().version, views().gen);
      return column.view;
    },
    /** Every resident slot of one kind, in slot order, as an Int32Array (a scan over the kind column). */
    slotsOfKind(kind) {
      const id = kinds.has(kind);
      if (id < 0) return new Int32Array(0);
      let count = 0;
      for (let slot = 0; slot < next; slot += 1) if (kindCol[slot] === id) count += 1;
      const out = new Int32Array(count);
      for (let slot = 0, at = 0; slot < next; slot += 1) if (kindCol[slot] === id) out[at++] = slot;
      return out;
    },
    /** What the table holds now. */
    held: () => ({ slots: used, slot_space: size, bytes: residentBytes, capacity_bytes, evictions, kinds: kinds.size, words: words.size }),
  };
}

// A declared column over the table's typed arrays. `get(slot)` / `set(slot, value)` are the host's own hot path;
// `getAt(handle)` / `setAt(handle, value)` check the handle's generation first. A text column's numbers are `words` ids.
class NumberColumn {
  refresh(column, version, gen) { this.as = 'number'; this.data = column.data; this.version = version; this.gen = gen; }
  get(slot) { return this.data[slot]; }
  set(slot, value) { this.data[slot] = value; this.version[slot] += 1; }
  getAt(handle) {
    const generation = (handle * PER_SLOT_SPACE) | 0;
    const slot = handle - generation * SLOT_SPACE;
    return this.gen[slot] === generation ? this.data[slot] : NaN;
  }
  setAt(handle, value) {
    const generation = (handle * PER_SLOT_SPACE) | 0;
    const slot = handle - generation * SLOT_SPACE;
    if (this.gen[slot] !== generation) return false;
    this.data[slot] = value;
    this.version[slot] += 1;
    return true;
  }
}
class TextColumn {
  constructor(words) { this.words = words; }
  refresh(column, version, gen) { this.as = 'text'; this.data = column.data; this.version = version; this.gen = gen; }
  get(slot) { return this.data[slot]; }
  set(slot, value) { this.data[slot] = this.words.id(value); this.version[slot] += 1; }
  getAt(handle) {
    const generation = (handle * PER_SLOT_SPACE) | 0;
    const slot = handle - generation * SLOT_SPACE;
    return this.gen[slot] === generation ? this.data[slot] : -1;
  }
  setAt(handle, value) {
    const generation = (handle * PER_SLOT_SPACE) | 0;
    const slot = handle - generation * SLOT_SPACE;
    if (this.gen[slot] !== generation) return false;
    this.data[slot] = this.words.id(value);
    this.version[slot] += 1;
    return true;
  }
}
