// tools/check-against-a-persons-rules-and-verdicts/do-work/branch.mjs
//
// Purpose
//   One tree in one list: every node of a person's one Checks list (list:checks) names the one node it is part of in
//   one link field (`part_of`, the caller's DATA). A branch is a node of kind branch; a branch's checks are the nodes
//   part of it and of every branch it is part of, up to the root. The link replaces a leaf's `method` and a branch's
//   `extends`. Ported from the old app's src/private-method.mjs:25 (`extends`) by way of
//   tools/decide-with-a-method/read-data/method.mjs (`methodLineage`), which imports it from here, so the decision tools
//   and the judge read one lineage.
//
// Non-negotiable invariants
//   1. A lineage is ordered nearest first: the branch itself, then the branch it is part of, up to the root.
//   2. An unknown branch, a link naming an unknown branch, or a cycle is refused; nothing is judged under a lineage
//      that cannot be followed to its root.
//   3. Nothing here names a branch, a check or the link field: the rows and the field the caller passes do.
//
// Shapes
//   lineageOf(branchRows, id, link) -> [id, its parent id, ..., the root id]     branchRows: [{ id, [link]?, ... }]
//   checksOfBranch(rows, lineage, link) -> the rows whose link is absent or in the lineage, in their order
export class BranchRefusal extends Error {}

/** The branch `id` and every branch it is part of through `link`, nearest first. Refuses an unknown id or a cycle. */
export function lineageOf(branchRows, id, link) {
  if (typeof link !== 'string' || !link) throw new TypeError('lineageOf needs the link field its rows are joined by.');
  const byId = new Map((branchRows ?? []).map(row => [row?.id, row]));
  const lineage = [];
  for (let at = id; at !== undefined && at !== null && at !== ''; at = byId.get(at)[link]) {
    if (!byId.has(at)) {
      throw new BranchRefusal(lineage.length
        ? `Branch ${lineage.at(-1)} is ${link} ${at}, which is not one of the branch rows; fix its ${link}.`
        : `There is no branch ${at}. The branches are: ${[...byId.keys()].join(', ') || 'none'}.`);
    }
    if (lineage.includes(at)) throw new BranchRefusal(`The branches ${[...lineage, at].join(' -> ')} are ${link} each other in a cycle; the root must be ${link} nothing.`);
    lineage.push(at);
  }
  return lineage;
}

/** The rows that belong to a lineage: a row with no link belongs to every branch. */
export function checksOfBranch(rows, lineage, link) {
  if (typeof link !== 'string' || !link) throw new TypeError('checksOfBranch needs the link field its rows are joined by.');
  const branches = new Set(lineage);
  return (rows ?? []).filter(row => !row?.[link] || branches.has(row[link]));
}
