// tools/lay-out-a-diagram/do-work/compare-diagrams.mjs
//
// What changed between two versions of a diagram. Nodes match by id. Edges match by id when they carry one, else by the triple
// (from, to, label). Everything is ordered by id; an edge without an id is named "from -> to" (or "from -> to : label").

const canonical = value => JSON.stringify(value, (_, inner) => (inner !== null && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : inner));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function changesBetween(before, after, fields) {
  return fields
    .map(field => ({ field, before: before[field] ?? null, after: after[field] ?? null }))
    .filter(change => canonical(change.before) !== canonical(change.after));
}

function compareNodes(before, after) {
  const was = new Map(before.map(node => [node.id, node]));
  const now = new Map(after.map(node => [node.id, node]));
  return {
    added: [...now.keys()].filter(id => !was.has(id)).sort(byText),
    removed: [...was.keys()].filter(id => !now.has(id)).sort(byText),
    changed: [...now.keys()].filter(id => was.has(id)).sort(byText)
      .map(id => ({ id, changes: changesBetween(was.get(id), now.get(id), ['label', 'lane', 'style', 'width', 'height']) }))
      .filter(entry => entry.changes.length),
  };
}

const nameOf = edge => edge.id ?? `${edge.from} -> ${edge.to}${edge.label === undefined ? '' : ` : ${edge.label}`}`;
const keyOf = edge => (edge.id === undefined ? `triple:${canonical([edge.from, edge.to, edge.label ?? null])}` : `id:${edge.id}`);

function compareEdges(before, after) {
  const group = edges => {
    const map = new Map();
    for (const edge of edges) map.set(keyOf(edge), [...(map.get(keyOf(edge)) ?? []), edge]);
    return map;
  };
  const [was, now] = [group(before), group(after)];
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, edges] of now) {
    const earlier = was.get(key) ?? [];
    edges.forEach((edge, at) => {
      if (at >= earlier.length) { added.push(nameOf(edge)); return; }
      const changes = edge.id === undefined ? [] : changesBetween(earlier[at], edge, ['label', 'from', 'to']);
      if (changes.length) changed.push({ id: edge.id, changes });
    });
  }
  for (const [key, edges] of was) edges.slice((now.get(key) ?? []).length).forEach(edge => removed.push(nameOf(edge)));
  return { added: added.sort(byText), removed: removed.sort(byText), changed: changed.sort((a, b) => byText(a.id, b.id)) };
}

/** Both arguments are { nodes, edges } already checked by requests.mjs. */
export function compareDiagrams(before, after) {
  return { nodes: compareNodes(before.nodes, after.nodes), edges: compareEdges(before.edges, after.edges) };
}
