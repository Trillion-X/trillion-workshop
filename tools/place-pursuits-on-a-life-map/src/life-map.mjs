// src/life-map.mjs
//
// Purpose: the map of a person's life every reader in Trillion places their pursuits on. What a pursuit serves (the
// greater good: finding what is true, testing it where it is hardest, changing things based on it) and which parts
// of a full life it lives along the way (inside you: body, mind, feelings, spirit if they want it; around you: people
// and living things, things, places and money). The starter map is DATA, handed in by whoever calls this
// (useLifeMapSettings: Trillion's own in-account run hands in its rows; the Workshop row reads them from the person's
// lists through their records door, do-work/place-pursuits-on-a-life-map.mjs); a person's own map is a
// list of their own (src/lists.mjs), made from the starter rows only when they choose it (or saved by them as any list
// with the map's id) and changed by them or any of their AIs like any list; an account that never chose one has none, so someone else's map (a coach's wheel, a faith's parts of life) runs the same readers.
//
// Non-Negotiable Invariants:
//   1. Nothing here names an area. Every area, its parent, label, meaning, sides and whether it is optional is a row:
//      a starter row of the handed-in map, or a row of the person's own map list (the list wins once it exists).
//   2. A row with shown: false shapes the judgement only: it is never written to a person's list, never offered to the
//      reading and never placed or reported.
//   3. Placing is pure and exact: an area's pursuits are the pursuits whose `areas` name it; an area is missing when it
//      is a leaf (no area is part of it), is not optional and no pursuit names it. Unknown ids are dropped, never kept.
//   4. Where an area's words came from (`words`, `sources`, `means_from`, `uses`) and the other names it goes by (`also_called`) stays in the repository; nothing here
//      hands them to a person or an AI.
//
// Shape placed (machine-readable, ids from the map):
//   { list_id, areas: [{ id, label, part_of, means, sides?, optional, pursuits: [title] }], missing: [{ id, label, part_of }] }
//
let lifeMapSettings = null;

/** Hand in the starter map ({ areas, list, reading, words, ... }) every function reads when it is given none. */
export function useLifeMapSettings(settings) {
  lifeMapSettings = settings;
  return lifeMapSettings;
}

export { lifeMapSettings };

const text = value => (typeof value === 'string' ? value.trim() : '');
const list = value => (Array.isArray(value) ? value : []);
const fill = (line, values) => line.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

/** The starter areas a person or AI may see: every shown row, its parent kept only when that parent is shown too. */
export function starterAreas(settings = lifeMapSettings) {
  const shown = settings.areas.filter(area => area.shown !== false);
  const ids = new Set(shown.map(area => area.id));
  return shown.map(area => ({
    id: area.id, label: area.label, part_of: ids.has(area.part_of) ? area.part_of : null, means: area.means,
    ...(area.sides?.length ? { sides: area.sides } : {}), optional: area.optional === true,
  }));
}

// One list row as an area: the row id is the area id; part_of is a link to another row of the same list.
const rowArea = row => {
  const values = row.values ?? {};
  const parent = Array.isArray(values.part_of) ? values.part_of[0] : values.part_of;
  const sides = text(values.sides) ? text(values.sides).split('/').map(side => side.trim()).filter(Boolean) : [];
  return { id: row.id, label: text(values.area) || text(row.title) || row.id, part_of: typeof parent === 'string' && parent ? parent : null,
    means: text(values.means), ...(sides.length ? { sides } : {}), optional: text(values.optional).toLowerCase() === 'yes' };
};

// A list keeps no row order, so a map's order is its tree: each area followed by the areas part of it, siblings in the
// starter map's order and then by label, so every reader walks the same map the same way.
const treeOrder = (areas, settings) => {
  const rank = new Map(settings.areas.map((area, index) => [area.id, index]));
  const by = (a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.label.localeCompare(b.label);
  const children = parent => areas.filter(area => area.part_of === parent).sort(by);
  const walk = parent => children(parent).flatMap(area => [area, ...walk(area.id)]);
  const placed = walk(null);
  const reached = new Set(placed.map(area => area.id));
  // Areas that are part of each other in a loop never reach the top: kept, as areas of their own, never dropped.
  return [...placed, ...areas.filter(area => !reached.has(area.id)).sort(by).map(area => ({ ...area, part_of: null }))];
};

// An area as a list row (the inverse of rowArea).
const areaRow = area => ({ id: area.id, values: {
  area: area.label, ...(area.part_of ? { part_of: [area.part_of] } : {}), means: area.means,
  ...(area.sides?.length ? { sides: area.sides.join(' / ') } : {}), optional: area.optional ? 'Yes' : 'No',
} });

/**
 * A person's map over their lists (src/lists.mjs makeLists):
 *   areas()   their own map's areas once their list exists; null before they chose one and once they deleted it
 *             (nothing places pursuits on a map that is not theirs: the starter map is never read in their place)
 *   offered() true while they never had a map: the starter is offered to them, never made for them
 *   ensure()  makes their list from the starter areas when they choose it, never again after they deleted it; returns
 *             its list id, or null while their map is off. Saving a list with the map's id turns it back on.
 * made:     { read() → { made_at } or null, write(value) }: whether their map list was ever made, so a deleted list is
 *           told apart from one not made yet.
 */
export function lifeMap({ lists, made, settings = lifeMapSettings }) {
  const spec = settings.list;
  const exists = () => lists().has(spec.id);
  return {
    list_id: spec.id,
    areas() {
      if (!exists()) return null;
      const areas = lists().read(spec.id).rows.map(rowArea);
      const ids = new Set(areas.map(area => area.id));
      return treeOrder(areas.map(area => (area.part_of && !ids.has(area.part_of) ? { ...area, part_of: null } : area)), settings);
    },
    offered() { return !exists() && !made.read(); },
    ensure() {
      if (exists()) return spec.id;
      if (made.read()) return null;
      // A field linking to this same list can name it only once the list exists: kept without it first, then whole.
      const kept = { id: spec.id, label: spec.label, icon: spec.icon, about: spec.about, title_field: spec.title_field };
      lists().save({ ...kept, fields: spec.fields.filter(field => field.links_to !== spec.id) }, { actor: { by: 'life-map' } });
      lists().save({ ...kept, fields: spec.fields }, { actor: { by: 'life-map' } });
      lists().putRows(spec.id, { rows: starterAreas(settings).map(areaRow) }, { actor: { by: 'life-map' } });
      made.write({ made_at: new Date().toISOString() });
      return spec.id;
    },
  };
}

/** The area ids a pursuit may name: every area of the map. A reply's ids are kept only when they are among them. */
export function keptAreas(value, areas) {
  const ids = new Set(areas.map(area => area.id));
  return [...new Set(list(value).filter(id => typeof id === 'string' && ids.has(id)))];
}

/** Each area with the pursuits that name it, and the leaf areas no pursuit names that are not optional. */
export function placeOnMap(areas, pursuits, { list_id = lifeMapSettings.list.id } = {}) {
  const parents = new Set(areas.map(area => area.part_of).filter(Boolean));
  const placed = areas.map(area => ({ ...area, pursuits: list(pursuits).filter(pursuit => list(pursuit.areas).includes(area.id)).map(pursuit => pursuit.title).filter(Boolean) }));
  const missing = placed.filter(area => !parents.has(area.id) && !area.optional && !area.pursuits.length).map(({ id, label, part_of }) => ({ id, label, part_of }));
  return { list_id, areas: placed, missing };
}

/** What the reading is handed about the map: each area's id, label, what it means and what it is part of. */
export function mapForReading(areas) {
  return areas.map(area => ({ id: area.id, label: area.label, means: area.means, ...(area.part_of ? { part_of: area.part_of } : {}) }));
}

/** One sentence per missing area, in the map's words: what the person's pursuits leave out. */
export function missingLines(placed, settings = lifeMapSettings) {
  const { words } = settings;
  return placed.missing.length ? placed.missing.map(area => fill(words.missing_one, { label: area.label.toLowerCase() })) : [words.nothing_missing];
}

/**
 * Progress's section for the map (a guide description's section, parts/ui/show/coss/guide.tsx): every area as a row
 * with how many pursuits live it, the missing ones first, opening the person's map list to change it.
 */
export function lifeMapSection(placed, settings = lifeMapSettings) {
  const { words } = settings;
  const { columns } = words;
  const labels = new Map(placed.areas.map(area => [area.id, area.label]));
  const missing = new Set(placed.missing.map(area => area.id));
  const field = (id, label, icon, width, kind) => ({ id, label, icon, ruleKind: kind === 'tag' ? 'choice' : 'text', filterable: true, sortable: true, width, ...(kind ? { kind } : {}) });
  const ordered = [...placed.areas.filter(area => missing.has(area.id)), ...placed.areas.filter(area => !missing.has(area.id))];
  return {
    id: 'life-map', heading: words.heading, body: words.body,
    banner: { icon: 'Map', title: words.missing_heading, detail: missingLines(placed, settings).join('\n') },
    catalog: { label: words.heading, view: 'table', fields: [
      field('area', columns.area, 'Map', 220),
      field('part_of', columns.part_of, 'Shapes', 180, 'tag'),
      field('pursuits', columns.pursuits, 'Compass', 320),
      field('means', columns.means, 'MessageSquare', 320),
    ] },
    rows: ordered.map(area => ({
      id: `area-${area.id}`, title: area.label,
      detail: [area.means, area.pursuits.join(' · ')].filter(Boolean).join('\n'),
      status: missing.has(area.id) ? { label: words.untouched, tone: 'attention' }
        : area.optional && !area.pursuits.length ? { label: words.optional, tone: 'quiet' }
          : { label: area.pursuits.length === 1 ? words.touched_by_one : fill(words.touched_by, { count: String(area.pursuits.length) }), tone: 'good' },
      facts: { area: area.label, part_of: labels.get(area.part_of) ?? '', pursuits: area.pursuits.join(' · '), means: area.means },
    })),
    actions: [{ label: words.change_map, icon: 'Map', tone: 'quiet', open: `/lists/${encodeURIComponent(placed.list_id)}` }],
  };
}
