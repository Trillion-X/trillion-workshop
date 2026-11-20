// src/life-map.mjs
//
// Purpose: the map of a person's life that the readers place their pursuits on. Each area of the map is a row of the
// person's own map (whatever form their store keeps it in); the caller reads those rows with its own SQL and hands them
// in. This module turns rows into areas, keeps only the area ids a reading names that are on the map, places pursuits on
// the areas they name, and says what the map is handed to a reading.
//
// Non-Negotiable Invariants:
//   1. Nothing here names an area. An area's id, label, parent, meaning, sides and whether it is optional come from the
//      row it is read from.
//   2. Placing is pure and exact: an area's pursuits are the pursuits whose `areas` name it. An area is missing when it
//      is a leaf (no area is part of it), is not optional and no pursuit names it. Unknown ids are dropped, never kept.
//   3. A row whose parent is not on the map is placed at the top, never dropped; areas that are part of each other in a
//      loop are kept as areas of their own.
//   4. Reads are the caller's: this file runs no SQL and writes nothing.
//
// Shapes:
//   area   { id, label, part_of, means, sides?, optional }
//   placed { list_id, areas: [{ ...area, pursuits: [title] }], missing: [{ id, label, part_of }] }

const text = value => (typeof value === 'string' ? value.trim() : '');
const list = value => (Array.isArray(value) ? value : []);

// One map row as an area: the row id is the area id; part_of links to another row of the same map.
// `row` is { id, title, values } where values are the column values of the map row.
export function mapAreaOfRow(row) {
  const values = row.values ?? {};
  const parent = Array.isArray(values.part_of) ? values.part_of[0] : values.part_of;
  const sides = text(values.sides) ? text(values.sides).split('/').map(side => side.trim()).filter(Boolean) : [];
  return {
    id: row.id,
    label: text(values.area) || text(row.title) || row.id,
    part_of: typeof parent === 'string' && parent ? parent : null,
    means: text(values.means),
    ...(sides.length ? { sides } : {}),
    optional: text(values.optional).toLowerCase() === 'yes',
  };
}

// The map's areas in tree order: each area followed by the areas part of it, siblings by label, so every reader walks
// the same map the same way. A row whose parent is not on the map is placed at the top.
export function mapAreas(rows) {
  const areas = list(rows).map(mapAreaOfRow);
  const ids = new Set(areas.map(area => area.id));
  const parented = areas.map(area => (area.part_of && !ids.has(area.part_of) ? { ...area, part_of: null } : area));
  const by = (a, b) => a.label.localeCompare(b.label);
  const children = parent => parented.filter(area => area.part_of === parent).sort(by);
  const walk = (parent, seen) => children(parent).filter(area => !seen.has(area.id)).flatMap(area => {
    seen.add(area.id);
    return [area, ...walk(area.id, seen)];
  });
  const seen = new Set();
  const placed = walk(null, seen);
  // Areas that are part of each other in a loop never reach the top: kept, as areas of their own.
  return [...placed, ...parented.filter(area => !seen.has(area.id)).sort(by).map(area => ({ ...area, part_of: null }))];
}

/** The area ids a pursuit may name: every area of the map. A reply's ids are kept only when they are among them. */
export function keptAreas(value, areas) {
  const ids = new Set(list(areas).map(area => area.id));
  return [...new Set(list(value).filter(id => typeof id === 'string' && ids.has(id)))];
}

/** Each area with the pursuits that name it, and the leaf areas no pursuit names that are not optional. */
export function placeOnMap(areas, pursuits, { list_id }) {
  if (!list_id) throw new TypeError('placeOnMap needs the list_id of the person\'s map.');
  const parents = new Set(list(areas).map(area => area.part_of).filter(Boolean));
  const placed = list(areas).map(area => ({ ...area, pursuits: list(pursuits).filter(pursuit => list(pursuit.areas).includes(area.id)).map(pursuit => pursuit.title).filter(Boolean) }));
  const missing = placed.filter(area => !parents.has(area.id) && !area.optional && !area.pursuits.length).map(({ id, label, part_of }) => ({ id, label, part_of }));
  return { list_id, areas: placed, missing };
}

/** What a reading is handed about the map: each area's id, label, what it means and what it is part of. */
export function mapForReading(areas) {
  return list(areas).map(area => ({ id: area.id, label: area.label, means: area.means, ...(area.part_of ? { part_of: area.part_of } : {}) }));
}
