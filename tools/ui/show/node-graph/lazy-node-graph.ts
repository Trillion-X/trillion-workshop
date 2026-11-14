// packages/ui/show/node-graph/lazy-node-graph.ts
//
// Purpose: the graph canvas every list map, step graph and topology view draws through this folder's index. Its body
// (./NodeGraph.tsx with its layout, minimap and edge overlay, about 30 kB) arrives the first time a graph is drawn, so a
// screen that can show a map but opens as a list never carries it.
//
// Non-negotiable invariants:
// - It is ./NodeGraph.tsx's NodeGraph with the same props; until the body arrives it draws nothing (../load-later).
// - Callers reach it through the folder's (or the part's) index, so this is the one place it is deferred.
import { later } from '../load-later/later';

export const NodeGraph = later(() => import('./NodeGraph'), module => module.NodeGraph);
