// src/graph-board-source.mjs
//
// PURPOSE
//   A graph a Trillion screen builds (steps, each with a title, what it does or a caption, a state and the actions it
//   offers; edges, each saying what flows along it and what kind of value) as the records the board draws
//   (parts/group/do-work/board-source.ts). The one translation for every such graph, read by the server (a workflow,
//   a run, a trigger or schedule, the small picture a hover card shows) and by the workspace (the AI on a job), so a
//   graph reads the same on every board.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A card says the step's title, then its first sentence (`summaryOf`) or its caption; the whole words stay with
//      the step, and a card's second line edited back to exactly `summaryOf` keeps them.
//   2. A state shows only where `showsState(step)` says it means something, in the words and tone `stateLooks` gives.
//   3. Names no kind of step, screen or product.
//

/** How long a card's line about what a step does may be before it is cut at a word. */
const SUMMARY_MOST = 140;

/** What a step does, as its card says it: its first sentence, at most a line or two. */
export const summaryOf = words => {
  const first = String(words).trim().split(/(?<=[.!?])\s/)[0];
  return first.length <= SUMMARY_MOST ? first : `${first.slice(0, SUMMARY_MOST - 1).replace(/\s+\S*$/, '')}…`;
};

/** `graph` ({ steps, edges }) as a board source keyed `key`. */
export function graphAsBoardSource(key, graph, stateLooks = {}, showsState = () => true) {
  const stateOf = step => {
    const look = showsState(step) ? stateLooks[step.state] : null;
    return look ? { label: look.label, ...(look.tone ? { tone: look.tone } : {}), ...(look.pulse ? { pulse: true } : {}) } : null;
  };
  return {
    key,
    cards: graph.steps.map(step => ({
      id: step.id,
      text: [step.title, step.does ? summaryOf(step.does) : step.caption && step.caption !== step.title ? step.caption : null].filter(Boolean).join('\n'),
      state: stateOf(step),
      ...(step.actions?.length ? { actions: step.actions.map(({ id, label }) => ({ id, label })) } : {}),
      ...(step.group ? { group: step.group } : {}),
    })),
    lines: graph.edges.map(edge => ({ from: edge.from, to: edge.to, ...(edge.label ? { label: edge.label } : {}), ...(edge.kind ? { kind: edge.kind } : {}) })),
  };
}
