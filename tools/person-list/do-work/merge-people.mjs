// tools/person-list/do-work/merge-people.mjs
//
// Purpose: people from one source (a phone's contacts, a CSV, a signup form) merged into the rows of a list, so each
// person is one row however many sources or syncs bring them. Pure: it is handed the list's rows and answers the values
// to write; the caller keeps them (Trillion's src/list-people.mjs through the lists owner).
//
// Non-Negotiable Invariants:
//   1. A person is matched to a row by, in order: a row another source or the person made that shares a key value
//      (an email, a phone number); else such a row whose name is theirs alone (a `match: "unique"` fill: exactly one
//      such row has it, no other person of this source has it, and no key value on the row disagrees with theirs);
//      else the row this source made for them (id `<source>:<key>`); else a row of this source sharing a key; else a
//      new row. When a person's own row and another matched row both exist, the own row folds into the other and is
//      removed in the same write, unless something on it would be lost. What counts as a key or a name, how it is
//      compared, and how every other field merges are the fills' DATA (`merge`: fill | keys | union, `match`,
//      `normalize`); nothing here names a field.
//   2. Nothing a person typed is lost: key values only ever grow, a union only adds, and a filled field is replaced
//      only on a row this same source made (it is that source's copy of the person).
//   3. Only what changed is answered: a person whose row already holds everything this source knows is unchanged and
//      writes nothing, so a repeated sync costs no writes.
//   4. People in the same batch who share a key become one row, as if they had arrived one sync apart.
//
// fills:  [{ from, field_id, merge, match?, normalize?, join?, suffix_digits?, as_list? }]  `from` names the person's value,
//         `field_id` the list field it lands in; `as_list` keeps key values as a list instead of joined text.
// person: { key, <from>: value }  a text, or for `keys` a list of texts; `union` takes the source's label.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const text = value => (typeof value === 'string' ? value.trim() : '');
const texts = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).map(text).filter(Boolean);
const empty = value => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);

// How one key value is compared. A normalizer is chosen by the fill's DATA.
const NORMALIZE = {
  digits: value => value.replace(/[^0-9]/g, '').replace(/^00/, ''),
  lowercase: value => value.toLowerCase(),
  // Words only: "Ana (Lucia) Moreno" and "Ana “Lucia” Moreno" are the same name.
  words: value => value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
};

/** The id a source's own row for one person has: `<source>:<key>`, with no "/" and at most 200 characters. */
export const sourceRowId = (sourceId, key) => `${sourceId}:${String(key)}`.replace(/\//g, '_').slice(0, 200);

/** The key values a row's field holds: its list, or its text split where the fill joins values. */
function valuesIn(fill, value) {
  if (Array.isArray(value)) return texts(value);
  return text(value).split((fill.join ?? ',').trim() || ',').map(text).filter(Boolean);
}

// Whether two normalized key values are the same person's: equal, or (for suffix matching) one ends with the other
// and the shorter has at least `suffix_digits` characters, so "+1 (555) 123-4567" and "555 123 4567" match.
const sameKey = (fill, left, right) => left === right
  || (fill.suffix_digits > 0 && Math.min(left.length, right.length) >= fill.suffix_digits && (left.endsWith(right) || right.endsWith(left)));

/**
 * rows:   [{ id, values }] the list's current rows
 * fills:  as above
 * source: { id, label }
 * people: [{ key, ... }]
 * → { writes: [{ id, values }] (only the changed field values), removes: [row id] (own rows folded into another),
 *     added, updated, unchanged }
 */
export function mergePeople({ rows, fills, source, people }) {
  const current = new Map(rows.map(row => [row.id, { ...row.values }]));
  const kept = new Set(current.keys());
  const keyFills = fills.filter(fill => fill.merge === 'keys');
  const normalOf = (fill, value) => NORMALIZE[fill.normalize](value);
  // Every key value of every row, bucketed by its tail so a lookup reads a handful of rows, never all of them.
  const buckets = new Map();
  const bucketOf = (fill, normal) => `${fill.field_id}\u0000${fill.suffix_digits > 0 ? normal.slice(-fill.suffix_digits) : normal}`;
  const index = (rowId, values) => {
    for (const fill of keyFills) {
      for (const value of valuesIn(fill, values[fill.field_id])) {
        const normal = normalOf(fill, value);
        if (!normal) continue;
        const bucket = bucketOf(fill, normal);
        if (!buckets.has(bucket)) buckets.set(bucket, new Map());
        buckets.get(bucket).set(rowId, normal);
      }
    }
  };
  for (const [rowId, values] of current) index(rowId, values);

  const ownPrefix = sourceRowId(source.id, '');
  const isOwn = rowId => rowId.startsWith(ownPrefix);
  const removed = new Set();
  const keyRows = person => {
    const found = [];
    for (const fill of keyFills) {
      for (const value of texts(person[fill.from])) {
        const normal = normalOf(fill, value);
        if (!normal) continue;
        for (const [rowId, held] of buckets.get(bucketOf(fill, normal)) ?? []) if (!removed.has(rowId) && sameKey(fill, held, normal) && !found.includes(rowId)) found.push(rowId);
      }
    }
    return found;
  };
  // A name's rows and people, counted once: a name matches only where it names one row and one person.
  const nameFills = fills.filter(fill => fill.match === 'unique');
  const nameKey = (fill, value) => `${fill.field_id}\u0000${normalOf(fill, text(value))}`;
  const rowsNamed = new Map();
  for (const [rowId, values] of current) {
    for (const fill of nameFills) {
      const name = normalOf(fill, text(values[fill.field_id]));
      if (name) rowsNamed.set(nameKey(fill, name), [...(rowsNamed.get(nameKey(fill, name)) ?? []), rowId]);
    }
  }
  const peopleNamed = new Map();
  for (const person of people) for (const fill of nameFills) { const name = normalOf(fill, text(person[fill.from])); if (name) peopleNamed.set(nameKey(fill, name), (peopleNamed.get(nameKey(fill, name)) ?? 0) + 1); }
  // Whether a row holds a key value of a kind the person has, none of which is theirs: then it is someone else.
  const disagrees = (values, person) => keyFills.some(fill => {
    const held = valuesIn(fill, values[fill.field_id]).map(value => normalOf(fill, value)).filter(Boolean);
    const given = texts(person[fill.from]).map(value => normalOf(fill, value)).filter(Boolean);
    return held.length > 0 && given.length > 0 && !given.some(normal => held.some(heldNormal => sameKey(fill, heldNormal, normal)));
  });
  const nameRow = (person, own) => {
    for (const fill of nameFills) {
      const name = normalOf(fill, text(person[fill.from]));
      if (!name || peopleNamed.get(nameKey(fill, name)) !== 1) continue;
      const named = (rowsNamed.get(nameKey(fill, name)) ?? []).filter(rowId => rowId !== own && !removed.has(rowId));
      if (named.length === 1 && !isOwn(named[0]) && !disagrees(current.get(named[0]), person)) return named[0];
    }
    return null;
  };
  // Whether folding an own row into another loses nothing: each of its values is a key or union (carried over), is
  // what this source sends for the person now (sent again every sync), is the same there, or fills a field that is
  // empty there.
  const foldsCleanly = (ownValues, otherValues, person) => Object.entries(ownValues).every(([fieldId, value]) => {
    const fill = fills.find(item => item.field_id === fieldId);
    if (fill && (fill.merge === 'keys' || fill.merge === 'union')) return true;
    if (fill && text(value) === text(person[fill.from])) return true;
    const there = otherValues[fieldId];
    return empty(value) || empty(there) || JSON.stringify(value) === JSON.stringify(there);
  });

  // → { rowId: the row this person lands in, or null for a new one; fold: their own row, to fold into it }
  const findRow = person => {
    const own = sourceRowId(source.id, person.key);
    const byKey = keyRows(person).filter(rowId => rowId !== own);
    const other = byKey.find(rowId => !isOwn(rowId)) ?? nameRow(person, own);
    if (current.has(own) && !removed.has(own)) {
      return other && foldsCleanly(current.get(own), current.get(other), person) ? { rowId: other, fold: own } : { rowId: own, fold: null };
    }
    return { rowId: other ?? byKey[0] ?? null, fold: null };
  };

  const writes = new Map();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const person of people) {
    const { rowId: found, fold } = findRow(person);
    const rowId = found ?? sourceRowId(source.id, person.key);
    const folded = fold ? current.get(fold) : {};
    // A folded row's own values (anything typed on it) come across where this row has nothing.
    const carried = Object.fromEntries(Object.entries(folded).filter(([fieldId, value]) => {
      const fill = fills.find(item => item.field_id === fieldId);
      return !empty(value) && !(fill && (fill.merge === 'keys' || fill.merge === 'union' || text(value) === text(person[fill.from]))) && empty(current.get(found)?.[fieldId]);
    }));
    const before = found ? current.get(found) : {};
    const ownRow = isOwn(rowId);
    const changes = { ...carried };
    for (const fill of fills) {
      const had = before[fill.field_id];
      if (fill.merge === 'union') {
        // A list field holds the labels as a list; a text field holds them joined, as a person would type them.
        const join = fill.join ?? ', ';
        const list = fill.as_list ? texts(had) : text(had).split(join).map(text).filter(Boolean);
        if (!list.includes(source.label)) changes[fill.field_id] = fill.as_list ? [...list, source.label] : [...list, source.label].join(join);
      } else if (fill.merge === 'keys') {
        const held = valuesIn(fill, had);
        const normals = held.map(value => normalOf(fill, value));
        const more = [];
        for (const value of texts(person[fill.from])) {
          const normal = normalOf(fill, value);
          if (!normal || normals.some(heldNormal => sameKey(fill, heldNormal, normal))) continue;
          normals.push(normal);
          more.push(value);
        }
        if (more.length) changes[fill.field_id] = fill.as_list ? [...held, ...more] : [...held, ...more].join(fill.join ?? ', ');
      } else {
        const given = text(person[fill.from]);
        const shown = Array.isArray(had) ? texts(had).join(', ') : had;
        if (given && (empty(had) || (ownRow && shown !== given))) changes[fill.field_id] = given;
      }
    }
    if (fold) {
      removed.add(fold);
      current.delete(fold);
      writes.delete(fold);
    }
    if (!Object.keys(changes).length && !fold) { unchanged += 1; continue; }
    if (!found) added += 1; else if (!writes.has(rowId)) updated += 1;
    const after = { ...before, ...changes };
    current.set(rowId, after);
    if (Object.keys(changes).length) writes.set(rowId, { ...(writes.get(rowId) ?? {}), ...changes });
    index(rowId, after);
  }
  return { writes: [...writes].map(([id, values]) => ({ id, values })), removes: [...removed].filter(rowId => kept.has(rowId)), added, updated, unchanged };
}
