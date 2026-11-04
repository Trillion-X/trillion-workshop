// parts/work-map/read-data/join-records.mjs
//
// Purpose
//   Joins records read from several places into one tree of nodes and lines, the way an org chart joins teams, people
//   and seats: each source (DATA, work-map-sources.json) says where its rows are in an answer, which of a row's fields
//   is its id, its title, its state and its time, and which fields name the rows it hangs under. A row naming no parent
//   that is shown hangs under whoever does it when the source says `otherwise: "who"`, else under the one root. Nothing is copied or kept: the
//   tree is worked out again from the answers each time they are read.
//
// Non-negotiable invariants
//   1. Blind: no record kind, field name, screen or state is named here; every one is a source row's DATA. A new kind
//      of record in the tree is one source row.
//   2. Only real rows: a node is a row an answer held; a line joins two nodes that both exist; a parent that is not
//      shown is skipped and the row falls to the next parent named, then to whoever does it, then to the root.
//   3. Ids are kept apart by source (`<source>:<id>`), so two sources may use the same id without joining by mistake.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

/** The value at a path of keys in a row; `*` takes every item of a list. */
export function valueAt(row, path) {
  let values = [row];
  for (const key of path) {
    values = values.flatMap(value => {
      if (value === null || value === undefined) return [];
      if (key === '*') return Array.isArray(value) ? value : [];
      return [value[key]];
    });
  }
  return values.flatMap(value => (Array.isArray(value) ? value : [value])).filter(value => value !== null && value !== undefined && value !== '');
}

/** The first non-empty value of the first path that has one. */
const firstOf = (row, paths = []) => {
  for (const path of paths) {
    const [value] = valueAt(row, path);
    if (value !== undefined) return value;
  }
  return undefined;
};

/** Every id named at a reference's path: plain values, or each item's `key` when the items are objects. */
const namedIds = (row, reference) => valueAt(row, reference.path)
  .map(value => (value && typeof value === 'object' ? firstOf(value, [reference.key ?? ['id']]) : value))
  .filter(value => value !== undefined)
  .map(String);

/**
 * The rows of a source inside the answer read for it. With `each`, every value at that path of a row is a row of its
 * own, `{ value, of }`, so one row can stand for several (each name a list holds, under the row holding the list).
 */
export const rowsOf = (answer, source) => {
  const rows = valueAt(answer, source.read.path).filter(row => row && typeof row === 'object');
  return source.each ? rows.flatMap(of => valueAt(of, source.each).map(value => ({ value, of }))) : rows;
};

/**
 * The tree of the answers: `answers` maps each source's id to the answer read for it (a source sharing another's read
 * names the same answer). Returns nodes (each with `source`, `kind`, `title`, `status`, `who` and the row) and lines
 * from parent to child.
 */
export function joinRecords({ root, sources, answers }) {
  const nodes = new Map([[root.id, { id: root.id, source: 'root', kind: root.kind, icon: root.icon, title: root.title, detail: root.detail ?? '', root: true }]]);
  const rowsBySource = new Map();
  for (const source of sources) {
    const answer = answers[source.read.answer ?? source.id];
    if (!answer) continue;
    const rows = rowsOf(answer, source);
    rowsBySource.set(source.id, rows);
    for (const row of rows) {
      const own = firstOf(row, [source.fields.id]);
      if (own === undefined) continue;
      const id = `${source.id}:${own}`;
      if (nodes.has(id)) continue;
      const status = firstOf(row, source.fields.status);
      const shownStatus = status === undefined ? source.status_default : (source.status_values?.[String(status)] ?? String(status));
      nodes.set(id, {
        id, source: source.id, kind: source.kind, icon: source.icon,
        title: String(firstOf(row, source.fields.title) ?? own),
        detail: String(firstOf(row, source.fields.detail) ?? ''),
        at: String(firstOf(row, source.fields.at) ?? ''),
        ...(shownStatus !== undefined ? { status: shownStatus } : {}),
        row,
      });
    }
  }
  const lines = [];
  const seen = new Set();
  const join = (from, to) => {
    const key = `${from}␟${to}`;
    if (from === to || seen.has(key)) return;
    seen.add(key);
    lines.push({ id: key, from, to });
  };
  for (const source of sources) {
    for (const row of rowsBySource.get(source.id) ?? []) {
      const own = firstOf(row, [source.fields.id]);
      if (own === undefined) continue;
      const id = `${source.id}:${own}`;
      const node = nodes.get(id);
      // The same id may come from several rows (one person in several spaces): each row adds its own lines.
      if (!node) continue;
      const [who] = (source.who ?? []).flatMap(reference => namedIds(row, reference).map(value => `${reference.source}:${value}`)).filter(other => nodes.has(other));
      if (who && !node.who) node.who = who;
      const parents = (source.parents ?? []).flatMap(reference => namedIds(row, reference).map(value => `${reference.source}:${value}`).filter(other => nodes.has(other)));
      if (parents.length) { for (const parent of parents) join(parent, id); continue; }
      join(source.otherwise === 'who' && node.who ? node.who : root.id, id);
    }
  }
  return { nodes: [...nodes.values()], lines };
}

/**
 * One branch of a tree: the node `from` and every node under it (any depth), with the lines between them, so a person
 * can start from one goal and see only what it holds. An unknown `from` gives the whole tree back unchanged.
 */
export function branchOf({ nodes, lines }, from) {
  if (!from || !nodes.some(node => node.id === from)) return { nodes, lines };
  const children = new Map();
  for (const line of lines) children.set(line.from, [...(children.get(line.from) ?? []), line.to]);
  const kept = new Set([from]);
  const waiting = [from];
  while (waiting.length) for (const child of children.get(waiting.pop()) ?? []) if (!kept.has(child)) { kept.add(child); waiting.push(child); }
  return { nodes: nodes.filter(node => kept.has(node.id)), lines: lines.filter(line => kept.has(line.from) && kept.has(line.to)) };
}
