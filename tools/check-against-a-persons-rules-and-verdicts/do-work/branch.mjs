// tools/check-against-a-persons-rules-and-verdicts/do-work/branch.mjs
//
// Purpose
//   One base with branches: a method row (the person's Methods list) may `extends` another, and a check row names the
//   branch (`method`) it belongs to. A branch's checks are its own rows and the rows of every branch it extends. Ported
//   from the old app's src/private-method.mjs:25 (`extends`) by way of tools/decide-with-a-method/read-data/method.mjs
//   (`methodLineage`), which now imports it from here, so the decision tools and the judge read one lineage.
//
// Non-negotiable invariants
//   1. A lineage is ordered nearest first: the branch itself, then what it extends, up to its base.
//   2. An unknown branch, an `extends` naming an unknown row, or a cycle is refused; nothing is judged under a lineage
//      that cannot be followed to its base.
//   3. Nothing here names a method or a check: the rows the caller passes do.
//
// Shapes
//   lineageOf(methodRows, id) -> [id, its base id, ..., the root id]     methodRows: [{ id, extends?, ... }]
//   checksOfBranch(rows, lineage) -> the rows whose `method` is absent or in the lineage, in their order
export class BranchRefusal extends Error {}

/** The branch `id` and every branch it extends, nearest first. Refuses an unknown id or a cycle. */
export function lineageOf(methodRows, id) {
  const byId = new Map((methodRows ?? []).map(row => [row?.id, row]));
  const lineage = [];
  for (let at = id; at !== undefined && at !== null && at !== ''; at = byId.get(at).extends) {
    if (!byId.has(at)) {
      throw new BranchRefusal(lineage.length
        ? `Method ${lineage.at(-1)} extends ${at}, which is not one of the method rows; fix its extends.`
        : `There is no method ${at}. The methods are: ${[...byId.keys()].join(', ') || 'none'}.`);
    }
    if (lineage.includes(at)) throw new BranchRefusal(`The methods ${[...lineage, at].join(' -> ')} extend each other in a cycle; one of them must extend nothing.`);
    lineage.push(at);
  }
  return lineage;
}

/** The rows that belong to a lineage: a row with no `method` belongs to every branch. */
export function checksOfBranch(rows, lineage) {
  const branches = new Set(lineage);
  return (rows ?? []).filter(row => !row?.method || branches.has(row.method));
}
