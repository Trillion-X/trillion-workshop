// tools/lay-out-a-diagram/do-work/requests.mjs
//
// One function per Workshop row. Each takes the request object a person's AI sent, refuses what it cannot run with a sentence that
// says what to send, and returns the answer. Every limit, spacing and colour is DATA (read-data/layout-settings.json).
import { compareDiagrams } from './compare-diagrams.mjs';
import { drawSvg } from './draw-svg.mjs';
import { layOut } from './layout.mjs';
import settings from '../read-data/layout-settings.json' with { type: 'json' };

const { limits, style: styleRules } = settings;
const refusedValue = new RegExp(styleRules.refused_value_pattern, styleRules.refused_value_flags);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const need = (ok, sentence) => { if (!ok) throw new Error(sentence); };

function checkText(value, where, what, limit, { required }) {
  need(typeof value === 'string' && (value.length > 0 || !required), `${where}: ${what} must be ${required ? 'non-empty ' : ''}text.`);
  need([...value].length <= limit, `${where}: ${what} is over the limit of ${limit} characters; send a shorter one.`);
}

function checkStyle(style, where) {
  need(isObject(style), `${where}.style must be an object of style properties, such as { "fill": "#ffffff" }.`);
  for (const [property, value] of Object.entries(style)) {
    need(styleRules.allowed_properties.includes(property), `${where}.style.${property} is not a style property a node may carry; the ones allowed are ${styleRules.allowed_properties.join(', ')}.`);
    need((typeof value === 'string' || typeof value === 'number') && String(value).length <= styleRules.max_value_characters && !refusedValue.test(String(value)),
      `${where}.style.${property} must be a plain value of at most ${styleRules.max_value_characters} characters, with no url(, expression, javascript:, <, > or ;.`);
  }
}

function checkSize(value, where, what) {
  need(value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= limits.max_node_size), `${where}: ${what} must be a number above 0 and at most ${limits.max_node_size}.`);
}

/** The shape every diagram request shares: nodes with unique ids, edges between known nodes with unique ids, within the limits. */
function checkDiagram(diagram, prefix) {
  need(isObject(diagram) && Array.isArray(diagram.nodes) && Array.isArray(diagram.edges), `Send ${prefix || 'an object with '}nodes (a list of { id, label? }) and edges (a list of { from, to, label? }).`);
  need(diagram.nodes.length <= limits.max_nodes, `${prefix}nodes: send at most ${limits.max_nodes} nodes; this has ${diagram.nodes.length}.`);
  need(diagram.edges.length <= limits.max_edges, `${prefix}edges: send at most ${limits.max_edges} edges; this has ${diagram.edges.length}.`);
  const ids = new Set();
  diagram.nodes.forEach((node, at) => {
    const where = `${prefix}nodes[${at}]`;
    need(isObject(node), `${where} must be an object { id, label? }.`);
    checkText(node.id, where, 'id', limits.max_id_characters, { required: true });
    need(!ids.has(node.id), `${where}: two nodes share the id "${node.id}"; each node id must be its own.`);
    ids.add(node.id);
    if (node.label !== undefined) checkText(node.label, where, 'label', limits.max_label_characters, { required: false });
    if (node.lane !== undefined) checkText(node.lane, where, 'lane', limits.max_id_characters, { required: true });
    checkSize(node.width, where, 'width');
    checkSize(node.height, where, 'height');
    if (node.style !== undefined) checkStyle(node.style, where);
  });
  const edgeIds = new Set();
  diagram.edges.forEach((edge, at) => {
    const where = `${prefix}edges[${at}]`;
    need(isObject(edge), `${where} must be an object { from, to, label? }.`);
    for (const end of ['from', 'to']) need(ids.has(edge[end]), `${where} names ${JSON.stringify(edge[end])} in ${end}, which is not the id of a node; send an edge between two nodes in nodes.`);
    if (edge.id !== undefined) checkText(edge.id, where, 'id', limits.max_id_characters, { required: true });
    if (edge.label !== undefined) checkText(edge.label, where, 'label', limits.max_label_characters, { required: false });
    const id = edge.id ?? `e${at}`;
    need(!edgeIds.has(id), `${where}: two edges share the id "${id}"; give each edge its own id.`);
    edgeIds.add(id);
  });
}

function checkLanes(request) {
  if (request.lanes === undefined) return;
  need(Array.isArray(request.lanes) && request.lanes.length > 0 && request.lanes.every(lane => typeof lane === 'string') && new Set(request.lanes).size === request.lanes.length,
    'lanes must be a list of different lane ids, in the order they sit, such as ["Customer", "Warehouse"].');
  request.nodes.forEach((node, at) => {
    need(node.lane !== undefined, `nodes[${at}] has no lane; when lanes are sent, give every node one of them (${request.lanes.join(', ')}).`);
    need(request.lanes.includes(node.lane), `nodes[${at}] names the lane "${node.lane}", which is not in lanes (${request.lanes.join(', ')}).`);
  });
}

/** Where the boxes sit, how the arrows run, how many cross, and a standalone SVG of it. */
export function layOutDiagram(request) {
  need(isObject(request), 'Send an object with nodes and edges.');
  checkDiagram(request, '');
  need(request.nodes.length > 0, 'Send at least one node.');
  need(request.direction === undefined || ['down', 'right'].includes(request.direction), 'direction must be "down" or "right".');
  need(request.draw === undefined || typeof request.draw === 'boolean', 'draw must be true or false.');
  checkLanes(request);
  const layout = layOut(request, settings);
  const answer = request.draw === false ? layout : { ...layout, svg: drawSvg(layout, request.nodes, settings) };
  need(JSON.stringify(answer).length <= limits.max_output_characters, `The answer would be longer than ${limits.max_output_characters} characters; send fewer nodes and edges, or draw: false.`);
  return answer;
}

/** Boxes and arrows added, removed or changed between two versions of a diagram. */
export function compareTwoDiagrams(request) {
  need(isObject(request), 'Send an object with before and after, each { nodes, edges }.');
  for (const side of ['before', 'after']) need(isObject(request[side]), `${side} must be an object { nodes, edges }.`);
  checkDiagram(request.before, 'before.');
  checkDiagram(request.after, 'after.');
  return compareDiagrams(request.before, request.after);
}
