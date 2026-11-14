// parts/ui/show/node-graph/roll-up.ts
//
// PURPOSE
//   How much of the work under each node of a graph is done: the share of the nodes reachable below it (at any depth)
//   whose state the caller calls settled, counted only over nodes that have a state. A branch of an org chart, a goal
//   and the jobs under it, a folder and its files: one count for any graph.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Never a guessed number: a node with no stated node under it has no progress (absent from the answer).
//   2. Blind: which state is settled is the caller's `settled` answer; no state is named here.
//   3. A node reached by several paths, or a loop in the lines, is counted once.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

export type RollUpNode = {readonly id: string; readonly status?: string}
export type RollUpEdge = {readonly from: string; readonly to: string}
export type RollUp = {done: number; of: number; share: number}

export function rollUp(nodes: readonly RollUpNode[], edges: readonly RollUpEdge[], settled: (status: string) => boolean): Map<string, RollUp> {
  const children = new Map<string, string[]>()
  for (const edge of edges) {
    const list = children.get(edge.from)
    if (list) list.push(edge.to)
    else children.set(edge.from, [edge.to])
  }
  const statusOf = new Map(nodes.map(node => [node.id, node.status]))
  const answer = new Map<string, RollUp>()
  for (const node of nodes) {
    const seen = new Set<string>([node.id])
    const waiting = [...(children.get(node.id) ?? [])]
    let done = 0, of = 0
    while (waiting.length) {
      const id = waiting.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const status = statusOf.get(id)
      if (status !== undefined) { of++; if (settled(status)) done++ }
      for (const child of children.get(id) ?? []) waiting.push(child)
    }
    if (of) answer.set(node.id, {done, of, share: done / of})
  }
  return answer
}
