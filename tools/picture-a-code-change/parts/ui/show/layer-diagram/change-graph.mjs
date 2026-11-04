// parts/ui/show/layer-diagram/change-graph.mjs
//
// A LIST OF CHANGED FILES AS A GRAPH DOCUMENT THE PICTURE ENGINE DRAWS: A LANE PER FOLDER, A NODE PER FILE, WITH ITS CHANGE STATE.
//
// Purpose: the picture of "what a change touched" needs no model to be true: the files, their folders and whether each was added,
// changed or removed are facts the forge states. This makes that document, valid by the graph contract (parts/ui/show/layer-diagram/
// graph-contract.mjs), so it can be drawn by graph-svg.mjs, patched by graph-patch.mjs, or replaced by a richer one an AI writes
// from the same bounded input (author-input.mjs). Nothing leaves the machine to make it: only paths and counts are read.
//
// Non-negotiable invariants:
//   1. Pure and deterministic: the same files give the same document, ids derived from the path by BLAKE3 (never the path itself).
//   2. The document never exceeds the contract's limits (DATA `lane_most`, `node_most`): what does not fit is gathered into one
//      rest lane / rest node whose counts add up, so nothing is silently dropped.
//   3. Lanes are ordered by first appearance; nodes keep the files' order. Every status, depth and word is DATA (./change-graph.json).
//
// Key concept: `changeGraph(files, rules?)` -> a graph document. `files`: [{ filename, status, additions, deletions, previous_filename? }].
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import rules from './change-graph.json' with { type: 'json' };

const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));
const idOf = (prefix, text) => `${prefix}:${bytesToHex(blake3(new TextEncoder().encode(text))).slice(0, 12)}`;
const cut = (text, most) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

function kindOf(name, settings) {
  const parts = name.split('.');
  for (let start = 1; start < parts.length; start += 1) {
    const ending = parts.slice(start).join('.');
    if (Object.hasOwn(settings.kind_by_extension, ending)) return settings.kind_by_extension[ending];
  }
  return 'node';
}

export function changeGraph(files, settings = rules) {
  const list = Array.isArray(files) ? files.filter(file => typeof file?.filename === 'string' && file.filename) : [];
  const added = list.reduce((sum, file) => sum + (Number(file.additions) || 0), 0);
  const removed = list.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0);
  const laneOf = path => {
    const folders = path.split('/').slice(0, -1).slice(0, settings.lane_depth);
    return folders.length ? folders.join('/') : null;
  };
  const lanes = new Map();
  const place = (laneKey, node) => {
    if (!lanes.has(laneKey)) lanes.set(laneKey, []);
    lanes.get(laneKey).push(node);
  };
  const order = [];
  for (const file of list) { const key = laneOf(file.filename); if (!order.includes(key)) order.push(key); }
  const wholeLanes = new Set(order.slice(0, settings.lane_most - 1 < order.length ? settings.lane_most - 1 : settings.lane_most));
  let nodeCount = 0;
  const rest = { count: 0, added: 0, removed: 0 };
  for (const file of list) {
    const key = laneOf(file.filename);
    const name = file.filename.split('/').at(-1);
    if (!wholeLanes.has(key) || (nodeCount >= settings.node_most - 1 && list.length > settings.node_most)) {
      rest.count += 1; rest.added += Number(file.additions) || 0; rest.removed += Number(file.deletions) || 0;
      continue;
    }
    const delta = Object.hasOwn(settings.status_delta, file.status) ? settings.status_delta[file.status] : 'modified';
    const detail = [fill(settings.words.detail, { added: Number(file.additions) || 0, removed: Number(file.deletions) || 0 }),
      file.previous_filename ? fill(settings.words.renamed, { from: file.previous_filename.split('/').at(-1) }) : null].filter(Boolean).join(' · ');
    place(key, { id: idOf('f', file.filename), label: cut(name, settings.label_characters), detail, kind: kindOf(name, settings), delta });
    nodeCount += 1;
  }
  const lanesOut = [...lanes].map(([key, nodes]) => (key === null
    ? { id: settings.root_lane.id, label: settings.root_lane.label, nodes }
    : { id: idOf('d', key), label: cut(key, settings.label_characters), nodes }));
  if (rest.count) {
    lanesOut.push({ id: settings.rest_lane.id, label: settings.rest_lane.label, nodes: [{ id: settings.rest_node.id, label: fill(settings.rest_node.label, { count: rest.count }),
      detail: fill(settings.rest_node.detail, rest), kind: 'node', delta: 'modified' }] });
  }
  return {
    schema_version: 1, id: settings.id,
    label: list.length ? fill(settings.words.label, { count: list.length }) : settings.words.no_files,
    caption: fill(settings.words.caption, { added, removed }),
    lanes: lanesOut, edges: [],
  };
}
