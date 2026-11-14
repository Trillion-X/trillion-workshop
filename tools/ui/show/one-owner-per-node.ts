// One DOM node has at most one owner, and taking it over releases the last one.
//
// Why this exists
//   Two different mount helpers wrote into the same element. One created a
//   React root on it and remembered the children it had rendered; the other
//   called replaceChildren() and built its own root inside a host div. Neither
//   knew the other existed. The moment the surface swapped back — a loading
//   skeleton replacing a table after a search — React tried to remove children
//   that the other writer had already deleted, and threw
//   "removeChild: the node to be removed is not a child of this node".
//
//   The bug is not in either helper. Each one is correct on its own. It is in
//   the absence of anyone deciding who owns the element, so the fix belongs
//   here rather than as a defensive check in both.
//
// Why it is this small
//   It knows nothing about React, roots, skeletons, tables, or any package. It
//   holds a node and a function to call when someone else wants that node. Any
//   writer that cleans up after itself can use it, including ones written
//   later that have nothing to do with the two that prompted it.
//
// The rule it enforces
//   claim(node, release) runs the previous owner's release before recording the
//   new one. After it returns, the node is empty of anything the old owner put
//   there and the new owner can build freely. That ordering is the whole point:
//   the old owner tears down while its own view of the DOM is still true.

const owners = new WeakMap<HTMLElement, () => void>()

/**
 * Take ownership of `node`, releasing whoever held it first.
 *
 * `release` must undo everything this owner puts into the node: unmount roots,
 * remove hosts, drop registry entries. It is called at most once, and it is
 * called while the DOM still matches what this owner last rendered.
 */
export function claimNode(node: HTMLElement, release: () => void): void {
  releaseNode(node)
  owners.set(node, release)
}

/**
 * Release `node`'s owner, if it has one. Safe to call on an unowned node, and
 * safe to call from inside a release function: the entry is dropped before the
 * function runs, so a release that touches the same node cannot recurse.
 */
export function releaseNode(node: HTMLElement): void {
  const release = owners.get(node)
  if (!release) return
  owners.delete(node)
  release()
}

/** Whether this node currently has an owner. Used to decide reuse vs rebuild. */
export function nodeIsClaimed(node: HTMLElement): boolean {
  return owners.has(node)
}
