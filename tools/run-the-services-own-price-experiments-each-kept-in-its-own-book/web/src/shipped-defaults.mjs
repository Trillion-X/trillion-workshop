// src/shipped-defaults.mjs
//
// Purpose: defaults that ship with the deploy and changes that stay with the person. A reader sees the shipped value of
// an id unless the person changed it; only the change is kept in their store. One layer over the two ways a store keeps
// values: records ({ read, typeOf, ids, write }, src/eeaf-sqlite-store.mjs or the record log) and facts
// ({ read, list, write, reset }, the newest value per name). The layer never knows what a default is about: which ids
// ship, and with which values, is handed in.
//
// Non-Negotiable Invariants:
//   1. Nothing lives in both: a shipped value is never written into the store. An untouched default costs no row, and a
//      changed shipped value reaches every person who never touched it on the next deploy, with no row written.
//   2. The person's own value wins. Their edit is kept under the default's own id, exactly as any value of theirs, so
//      every reader that reads that id reads it unchanged.
//   3. A removed default leaves one change record, `default-change:<id>` ({ id, removed: true, at }), so it stays gone;
//      writing it again takes the change record away.
//   4. A write equal to the shipped value (ignoring the fields named in `ignore`, such as when it was set) is a reset:
//      the person's own value and any change record go, and the shipped value is read again.
//   5. resetDefault(id) goes back to the shipped value; changesFromDefaults() lists every shipped id the person changed
//      ({ id, change: 'edited' | 'removed' }); changed(id) says whether one id was.
//   6. Change records are written unwatched: they are about the defaults, never a record anyone's rules look at.
//   7. The store's field reads pass through for kinds with no shipped values, and refuse a kind that has some, so a
//      reader never gets an answer that silently leaves the defaults out.
//   8. The store's write journal (changeSeq, changedSince, revisionOf) passes through unchanged when the store keeps one,
//      so a reader that keeps its own view over shipped and changed values (the alarm's clock, src/automations.mjs)
//      learns which ids were written, change records included, and reads only those again.
//

export const CHANGE_KIND = 'default-change';
const changeId = id => `${CHANGE_KIND}:${id}`;

// Equal as data whatever order the keys were kept in, leaving out the named fields at the top level.
const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const without = (value, ignore) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !ignore.includes(key))) : value;
export const sameValue = (left, right, ignore = []) => JSON.stringify(ordered(without(left ?? null, ignore))) === JSON.stringify(ordered(without(right ?? null, ignore)));

/**
 * records: { read(id), readMany(ids), typeOf(id), typesOf(ids) (optional), ids(type, options), write(entries, options) }
 * shipped: Map id → { type, value } (the defaults in this deploy)
 * ignore:  value fields left out when a write is compared with the shipped value
 * → the same interface (typesOf and readMany included), plus { resetDefault(id), changesFromDefaults(), changed(id), shipped(id) }, and the store's
 *   own field reads (`fields`) for kinds that ship no values
 */
export function overlayRecords(records, shipped, { ignore = [], now = () => Date.now() } = {}) {
  const bootstrap=shipped;
  let removedIds = null;
  const removed = () => (removedIds ??= new Set(records.ids(CHANGE_KIND).map(id => records.read(id)).filter(change => change?.removed).map(change => change.id)));
  const shippedOf = id => (shipped.has(id) && !removed().has(id) ? shipped.get(id) : null);
  const typesShipped = new Set([...shipped.values()].map(entry => entry.type));

  function writeChange(id, value) {
    if (value === null && !records.typeOf(changeId(id))) return;
    records.write([{ id: changeId(id), type: CHANGE_KIND, value }], { actor: { by: 'trillion' }, unwatched: true });
    if (value?.removed) removed().add(id); else removed().delete(id);
  }

  return {
    // Replace only shared definitions. The account's edits, removals and journal
    // stay in the same store; callers invalidate their existing derived indexes.
    replaceDefaults(next) {
      if (!(next instanceof Map)) throw new TypeError('Defaults must be a map.');
      if (sameValue([...shipped], [...next])) return false;
      shipped = next;
      typesShipped.clear();
      for (const entry of shipped.values()) typesShipped.add(entry.type);
      return true;
    },
    // A surrounding native mutation/receipt transaction can fail after this
    // overlay changed its removal view. Re-read both from committed state.
    forgetCached(error = null, mark = null) { removedIds = null; records.forgetCached?.(error, mark); },
    changeMark: () => records.changeMark?.() ?? null,
    read: id => records.read(id) ?? shippedOf(id)?.value ?? null,
    // The same answer as read for each id, the store's own records read together.
    readMany(ids) {
      const own = records.readMany(ids);
      return new Map([...new Set(ids)].map(id => [id, own.get(id) ?? shippedOf(id)?.value ?? null]));
    },
    typeOf: id => records.typeOf(id) ?? shippedOf(id)?.type ?? null,
    // The same answer as typeOf for each id, the store's own kinds read together: a shipped default the account never
    // changed is not in the store, and asked one at a time each cost a read of every run of it.
    typesOf(ids) {
      const own = typeof records.typesOf === 'function' ? records.typesOf(ids) : new Map([...new Set(ids)].map(id => [id, records.typeOf(id)]));
      return new Map([...new Set(ids)].map(id => [id, own.get(id) ?? shippedOf(id)?.type ?? null]));
    },
    ids(type, options) {
      const own = records.ids(type, options);
      if (!typesShipped.has(type) || options) return own;
      const seen = new Set(own);
      return [...own, ...[...shipped].filter(([id, entry]) => entry.type === type && !seen.has(id) && !removed().has(id)).map(([id]) => id)];
    },
    write(entries, options) {
      const passed = [];
      for (const entry of entries) {
        const original = shipped.get(entry.id);
        if (!original) { passed.push(entry); continue; }
        const own = Boolean(records.typeOf(entry.id));
        if (entry.value === null) {
          if (own) passed.push(entry);
          writeChange(entry.id, { id: entry.id, removed: true, at: new Date(now()).toISOString() });
        } else if (sameValue(entry.value, original.value, ignore)) {
          if (own) passed.push({ ...entry, value: null });
          writeChange(entry.id, null);
        } else {
          passed.push(entry);
          writeChange(entry.id, null);
        }
      }
      return passed.length ? records.write(passed, options) : undefined;
    },
    resetDefault(id) {
      if (!shipped.has(id)) return false;
      if (records.typeOf(id)) records.write([{ id, type: shipped.get(id).type, value: null }], { actor: { by: 'person' } });
      writeChange(id, null);
      return true;
    },
    changed: id => shipped.has(id) && (removed().has(id) || Boolean(records.typeOf(id))),
    changesFromDefaults: () => [...shipped.keys()].filter(id => removed().has(id) || records.typeOf(id)).map(id => ({ id, change: removed().has(id) ? 'removed' : 'edited' })),
    shipped: id => shipped.get(id)?.value ?? null,
    bootstrap: id => bootstrap.get(id)?.value ?? null,
    hasOwn: id => Boolean(records.typeOf(id)),
    // The store's field reads (each names the kind first) answer what the store keeps. A kind with shipped values is
    // refused, since its defaults are never in the store and a field read would leave them out without saying so.
    fields: Object.fromEntries(Object.entries(records.fields ?? {}).map(([name, read]) => [name, (type, ...rest) => {
      if (typesShipped.has(type)) throw new Error(`${type} has shipped values, so read it with ids and read, not ${name}.`);
      return read(type, ...rest);
    }])),
    ...(typeof records.changeSeq === 'function' ? {
      changeSeq: () => records.changeSeq(),
      changedSince: seq => records.changedSince(seq),
      revisionOf: prefixes => records.revisionOf?.(prefixes),
    } : {}),
    // Reads the removals again (after they were written past this layer).
    refresh() { removedIds = null; },
  };
}

/**
 * facts:   { read(name), list(prefix, options), write(name, value), reset(name) } (the newest value per name; reset forgets a name;
 *          options narrow a list to the newest or the open ones, src/workshop-facts.mjs)
 * shipped: async () → Map name → value (the defaults in this deploy, worked out from what this person has connected)
 * prefix:  the names the shipped values live under; a value names itself by `nameOf(value)`
 * ignore:  value fields left out when a write is compared with the shipped value
 * A removal is the person's own value (whatever the reader writes for it), so it needs no change record.
 */
export function overlayFacts(facts, shipped, { prefix, nameOf, ignore = [] }) {
  return {
    async read(name) {
      const own = await facts.read(name);
      if (own !== null && own !== undefined) return own;
      return name.startsWith(prefix) ? (await shipped()).get(name) ?? null : null;
    },
    async list(asked, options) {
      const own = (await facts.list(asked, options)).filter(Boolean);
      if (asked !== prefix) return own;
      const named = new Set(own.map(nameOf));
      return [...own, ...[...(await shipped())].filter(([name]) => !named.has(name)).map(([, value]) => value)];
    },
    async write(name, value) {
      const original = name.startsWith(prefix) ? (await shipped()).get(name) : undefined;
      if (original !== undefined && value !== null && sameValue(value, original, ignore)) return facts.reset(name);
      return facts.write(name, value);
    },
    async resetDefault(name) {
      if (!(await shipped()).has(name)) return false;
      await facts.reset(name);
      return true;
    },
    async changesFromDefaults() {
      const changes = [];
      for (const name of (await shipped()).keys()) {
        const own = await facts.read(name);
        if (own !== null && own !== undefined) changes.push({ id: name, change: own.removed ? 'removed' : 'edited' });
      }
      return changes;
    },
  };
}
