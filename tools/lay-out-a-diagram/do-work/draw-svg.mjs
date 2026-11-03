// tools/lay-out-a-diagram/do-work/draw-svg.mjs
//
// Writes a laid-out diagram as one standalone SVG: no script, no event attribute, no reference outside the file (the arrowhead
// marker is referenced by a local url(#id)). Colours exist only as CSS custom properties with fallbacks (from
// read-data/layout-settings.json) in one style block, so a page that sets --diagram-background, --diagram-ink and the others
// themes the whole drawing. Every node group carries data-node-id and every edge data-edge-id. Every attribute value and every
// label goes through one XML escape, in `element`.

const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** One XML element: attributes escaped, children already built (text children pass through `escapeXml` first). */
const element = (name, attributes, ...children) => {
  const written = Object.entries(attributes).filter(([, value]) => value !== undefined).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
  return children.length ? `<${name}${written}>${children.join('')}</${name}>` : `<${name}${written}/>`;
};

const themed = (settings, name) => `var(${settings.theme[name].variable},${settings.theme[name].fallback})`;

/** The point halfway along the middle segment of a route, where an arrow's label sits. */
function labelPoint(points) {
  const at = (points.length - 1) >> 1;
  return [(points[at][0] + points[at + 1][0]) / 2, (points[at][1] + points[at + 1][1]) / 2];
}

function styleSheet(settings) {
  const { font, drawing } = settings;
  return [
    `.diagram-background{fill:${themed(settings, 'background')}}`,
    `text{font-family:${font.family};font-size:${font.size}px;fill:${themed(settings, 'ink')}}`,
    `.node rect{fill:${themed(settings, 'node_fill')};stroke:${themed(settings, 'node_stroke')};stroke-width:${drawing.line_width}}`,
    '.node text{text-anchor:middle;dominant-baseline:central}',
    `.edge path{fill:none;stroke:${themed(settings, 'edge')};stroke-width:${drawing.line_width}}`,
    `.edge text{font-size:${font.edge_label_size}px;text-anchor:middle;dominant-baseline:central;paint-order:stroke;stroke:${themed(settings, 'background')};stroke-width:${drawing.halo_width}px;stroke-linejoin:round}`,
    `.arrow-head{fill:${themed(settings, 'edge')}}`,
  ].join('\n');
}

/** A node's style as the style attribute of its box and of its label (font properties go to the label). */
function styleAttributes(style, settings) {
  const entries = Object.entries(style ?? {});
  const textProperties = new Set(settings.style.text_properties);
  const attribute = rows => (rows.length ? rows.map(([name, value]) => `${name}:${value}`).join(';') : undefined);
  return { box: attribute(entries.filter(([name]) => !textProperties.has(name))), label: attribute(entries.filter(([name]) => textProperties.has(name))) };
}

/** `layout` is the answer of layOut; `nodes` the request's nodes (for their labels and styles). */
export function drawSvg(layout, nodes, settings) {
  const source = new Map(nodes.map(node => [node.id, node]));
  const { margin } = settings.spacing;
  const { marker_id: markerId, arrow_size: arrowSize, corner_radius: radius } = settings.drawing;
  const [width, height] = [layout.width + 2 * margin, layout.height + 2 * margin];
  const edges = layout.edges.map(edge => {
    const [x, y] = labelPoint(edge.points);
    return element('g', { class: 'edge', 'data-edge-id': edge.id },
      element('path', { d: `M${edge.points.map(([px, py]) => `${px} ${py}`).join(' L')}`, 'marker-end': `url(#${markerId})` }),
      ...(edge.label === null ? [] : [element('text', { x, y }, escapeXml(edge.label))]));
  });
  const boxes = layout.nodes.map(node => {
    const { label: text = node.id, style } = source.get(node.id);
    const attributes = styleAttributes(style, settings);
    return element('g', { class: 'node', 'data-node-id': node.id },
      element('rect', { x: node.x, y: node.y, width: node.width, height: node.height, rx: radius, style: attributes.box }),
      element('text', { x: node.x + node.width / 2, y: node.y + node.height / 2, style: attributes.label }, escapeXml(text)));
  });
  const marker = element('marker', { id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: arrowSize, markerHeight: arrowSize, orient: 'auto' },
    element('path', { class: 'arrow-head', d: 'M0 0 L10 5 L0 10 z' }));
  return element('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: `${-margin} ${-margin} ${width} ${height}`, width, height, role: 'img' },
    `\n${element('style', {}, `\n${styleSheet(settings)}\n`)}\n`,
    element('defs', {}, marker),
    `\n${element('rect', { class: 'diagram-background', x: -margin, y: -margin, width, height })}\n`,
    element('g', { class: 'edges' }, ...edges),
    element('g', { class: 'nodes' }, ...boxes));
}
