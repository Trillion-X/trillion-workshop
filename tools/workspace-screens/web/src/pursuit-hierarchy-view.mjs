// Order a person's private pursuits for display. Multiple parents still mean
// one record and one row; missing links and cycles stay visible. The first
// reachable parent in the displayed order determines the row's indentation.
const idsOf = value => Array.isArray(value) ? value.map(item => typeof item === 'string' ? item : item?.id).filter(id => typeof id === 'string') : [];

export function pursuitHierarchyRows(pursuits) {
  const records = Array.isArray(pursuits) ? pursuits.filter(item => item && typeof item.id === 'string') : [];
  const byId = new Map(records.map(item => [item.id, item]));
  const position = new Map(records.map((item, index) => [item.id, index]));
  const parentIds = new Map(records.map(item => [item.id, idsOf(item.parents).filter(id => id !== item.id && byId.has(id))]));
  for (const parent of records) for (const childId of idsOf(parent.children)) {
    const child = byId.get(childId);
    if (!child || Array.isArray(child.parents)) continue;
    const parents = parentIds.get(childId);
    if (!parents.includes(parent.id) && childId !== parent.id) parents.push(parent.id);
  }
  const children = new Map(records.map(item => [item.id, []]));
  for (const [id, parents] of parentIds) for (const parent of parents) children.get(parent).push(id);
  for (const ids of children.values()) ids.sort((a, b) => position.get(a) - position.get(b));
  const seen = new Set();
  const rows = [];
  const visit = (id, depth, displayParentId = null) => {
    if (seen.has(id)) return;
    seen.add(id);
    const record = byId.get(id);
    rows.push({ record, depth, displayParentId, parents: parentIds.get(id).map(parentId => byId.get(parentId)) });
    for (const child of children.get(id)) visit(child, depth + 1, id);
  };
  for (const item of records) if (!parentIds.get(item.id).length) visit(item.id, 0);
  for (const item of records) visit(item.id, 0);
  return rows;
}
