// parts/ui/show/layer-diagram/graph-svg.mjs
//
// A GRAPH DOCUMENT AS ONE STANDALONE SVG FILE: NO SCRIPT, NO OUTSIDE REFERENCE, COLOURS BAKED IN, NAMED BY ITS BYTES.
//
// Purpose: ./graph-contract.mjs draws a valid document as page markup that reads the page's theme. A place that can show a
// picture but not a page (an email, a chat, a pull request, a README) needs a file. This draws the same layout, the same
// wrapped words and the same geometry as that markup into a single SVG whose colours are literals from one palette, with
// moving dots along the edges whose look asks for them as declarative SMIL (no script, no runtime). The atlas beside it
// is the same id -> box sidecar the page drawing has, so a surface can ring a node without measuring the picture.
//
// The drawing is built as a tree of plain elements (../server-rendered-page/markup-tree.mjs) and serialised once, so escaping
// has one owner and no markup is assembled by hand.
//
// Non-negotiable invariants:
//   1. Same document, palette and options give the same bytes: no clock, random number, file or network. Every number goes
//      through one rounding.
//   2. The file holds no script, no event attribute and no reference to anything outside it. An image mark is not drawn
//      (it would be an outside reference); a letters mark is.
//   3. Where a file lands is a capability row (`surfaces`), asked for by name; nothing here branches on a surface's name.
//      Every colour, size and look is DATA (./graph-svg.json). This file names no palette, no tone and no colour.
//   4. Text sits where the page drawing puts it (layerDiagramNodeParts); every word on the neutral palette sits on its own
//      filled ground, so the file reads on a light page and a dark one.
//   5. A drawing is named by the declared BLAKE3 identity of its bytes (first `hash_characters` hex), and a manifest says
//      which document, which renderer version and which bytes each file is.
//
// Key concepts: `graphDocumentSvg(document, { palette, orientation, animated })`, `graphSvgAssets(document)`.

import svgRules from './graph-svg.json' with { type: 'json' };
import contract from './graph-contract.json' with { type: 'json' };
import { element, serialise, textOf } from '../server-rendered-page/markup-tree.mjs';
import { graphIdentity, identityOf, validateGraphDocument } from './graph-contract.mjs';
import { HEAD_BOX, layerDiagramAtlas, layerDiagramLayout, layerDiagramNodeParts } from './layer-diagram.mjs';
import { screenLookFontFamily } from '../../../../../screen-looks/read-data/resolve-screen-look-palette.js';

const round = (value) => Math.round(value * 10) / 10;
const fill = (template, values) => template.replace(/\{(\w+)\}/gu, (whole, name) => (name in values ? String(values[name]) : whole));

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const label = (value, attributes) => element('text', attributes, [textOf(value)]);

function drawNode(node, way, rules, palette) {
  const look = rules.node_looks[node.tone] ?? rules.node_looks.default;
  const at = layerDiagramNodeParts(node, way);
  const size = rules.text[way];
  const parts = [element('rect', {
    x: node.x, y: node.y, width: node.w, height: node.h, rx: 12, fill: palette[look.fill], stroke: palette[look.line], 'stroke-width': look.width, 'stroke-dasharray': look.dash,
  })];
  if (at.mark && node.mark?.letters) {
    const cx = node.x + at.mark.x + at.mark.size / 2;
    const cy = node.y + at.mark.y + at.mark.size / 2;
    parts.push(element('circle', { cx, cy, r: at.mark.size / 2, fill: palette[look.mark] }));
    parts.push(label(node.mark.letters, { x: cx, y: cy + rules.text.mark * 0.355, 'font-size': rules.text.mark, 'font-weight': 700, fill: palette[look.mark_words], 'text-anchor': 'middle' }));
  }
  const block = (spot, fontSize, weight, colour) => spot.lines.map((line, index) => label(line, {
    x: spot.anchor === 'middle' ? node.x + node.w / 2 : node.x + spot.x,
    y: node.y + spot.y + index * spot.line_height,
    'font-size': fontSize, 'font-weight': weight, fill: colour, 'text-anchor': spot.anchor,
  }));
  parts.push(...block(at.label, size.label, 600, palette[look.words]));
  if (at.detail) parts.push(...block(at.detail, size.detail, 400, palette[look.detail]));
  return element('g', { 'data-id': node.id, 'data-delta': node.delta }, parts);
}

function drawEdge(edge, index, rules, palette, animated, reveal) {
  const look = rules.edge_looks[edge.tone] ?? rules.edge_looks.default;
  const begin = `${round(index * rules.reveal.stagger_seconds)}s`;
  // A solid line draws itself in along its length; a dashed one (its dashes are its look) fades in instead.
  const drawn = reveal && !look.dash;
  const grown = reveal && look.dash;
  const path = element('path', {
    d: edge.d, fill: 'none', 'stroke-linecap': 'round', stroke: palette[look.line], 'stroke-width': look.width,
    'stroke-opacity': grown ? 0 : look.opacity, 'stroke-dasharray': drawn ? 1 : look.dash, 'stroke-dashoffset': drawn ? 1 : undefined, pathLength: drawn ? 1 : undefined,
    'data-from': edge.from, 'data-to': edge.to,
  }, [
    ...(drawn ? [element('animate', { attributeName: 'stroke-dashoffset', from: 1, to: 0, dur: `${rules.reveal.seconds}s`, begin, fill: 'freeze' })] : []),
    ...(grown ? [element('animate', { attributeName: 'stroke-opacity', from: 0, to: look.opacity, dur: `${rules.reveal.seconds}s`, begin, fill: 'freeze' })] : []),
  ]);
  const parts = [path];
  if (animated && look.pulse) {
    parts.push(element('circle', { r: rules.pulse.radius, fill: palette[look.line] }, [
      element('animateMotion', { dur: `${rules.pulse.seconds}s`, repeatCount: 'indefinite', begin: `-${round((index * rules.pulse.spread_seconds) % rules.pulse.seconds)}s`, path: edge.d }),
    ]));
  }
  return parts;
}

function drawEdgeLabel(edge, rules, palette) {
  const look = rules.edge_looks[edge.tone] ?? rules.edge_looks.default;
  return [
    element('rect', { x: edge.label_x - edge.label_w / 2, y: edge.label_y - 10, width: edge.label_w, height: 20, rx: 5, fill: palette.chip }),
    label(edge.label, { x: edge.label_x, y: edge.label_y + rules.text.edge_label * 0.355, 'font-size': rules.text.edge_label, 'font-weight': 600, fill: palette[look.label], 'text-anchor': 'middle' }),
  ];
}

function drawHead(head, rules, palette) {
  return [
    element('rect', { x: head.x - head.w / 2, y: head.y - HEAD_BOX.above, width: head.w, height: HEAD_BOX.height, rx: 6, fill: palette.chip }),
    label(head.label, { x: head.x, y: head.y + rules.text.head * 0.355, 'font-size': rules.text.head, 'font-weight': 600, fill: palette.words, 'text-anchor': 'middle' }),
  ];
}

const refusal = (errors, warnings = []) => ({ ok: false, errors, warnings, svg: '', atlas: null, identity: null, name: null });

/**
 * `document` validated and drawn as one standalone SVG. `options.surface` names a place the file will land (a row of the
 * DATA's `surfaces`) and supplies the palette, whether dots move and whether lines draw themselves in; `palette`, `animated`,
 * `reveal` and `orientation` ('across' or 'down') given beside it win. `font` is the person's look face; without it the look's own default stack (screenLookFontFamily) is used. -> { ok, errors, warnings, svg, atlas, identity, name }
 */
export function graphDocumentSvg(document, options = {}, rules = svgRules, contractRules = contract) {
  const checked = validateGraphDocument(document, contractRules);
  if (!checked.ok) return refusal(checked.errors, checked.warnings);
  if (options.surface !== undefined && !Object.hasOwn(rules.surfaces, options.surface)) {
    return refusal([{ code: 'UNKNOWN_SURFACE', path: 'surface', message: fill(rules.words.errors.UNKNOWN_SURFACE, { found: options.surface, surfaces: Object.keys(rules.surfaces).join(', ') }) }]);
  }
  const surface = rules.surfaces[options.surface] ?? {};
  const { palette = surface.palette ?? Object.keys(rules.palettes)[0], orientation = 'across', animated = surface.animated ?? true, reveal = surface.reveal ?? false } = options;
  if (!Object.hasOwn(rules.palettes, palette)) {
    return refusal([{ code: 'UNKNOWN_PALETTE', path: 'palette', message: fill(rules.words.errors.UNKNOWN_PALETTE, { found: palette, palettes: Object.keys(rules.palettes).join(', ') }) }]);
  }
  const colours = rules.palettes[palette];
  const layout = layerDiagramLayout(checked.diagram, orientation);
  const tree = element('svg', {
    xmlns: SVG_NAMESPACE, viewBox: `0 0 ${layout.width} ${layout.height}`, width: layout.width, height: layout.height, role: 'img', 'aria-label': layout.label, 'font-family': screenLookFontFamily(options.font),
  }, [
    element('title', {}, [textOf(layout.label)]),
    ...(layout.caption ? [element('desc', {}, [textOf(layout.caption)])] : []),
    ...(colours.page ? [element('rect', { width: layout.width, height: layout.height, fill: colours.page })] : []),
    ...layout.edges.flatMap((edge, index) => drawEdge(edge, index, rules, colours, animated, reveal)),
    ...layout.heads.flatMap((head) => drawHead(head, rules, colours)),
    ...layout.nodes.map((node) => drawNode(node, layout.orientation, rules, colours)),
    ...layout.edges.filter((edge) => edge.label).flatMap((edge) => drawEdgeLabel(edge, rules, colours)),
  ]);
  const svg = serialise(tree);
  const identity = identityOf(svg);
  const name = `${checked.diagram.id}-${palette}-${identity.slice(3, 3 + rules.hash_characters)}.svg`;
  return { ok: true, errors: [], warnings: checked.warnings, svg, atlas: layerDiagramAtlas(layout), identity, name };
}

/**
 * Every palette's drawing of `document`, each named by its bytes, with the manifest that says what they are.
 * -> { ok, errors, files: { [name]: svg }, manifest: { graph, renderer_version, orientation, assets: [{ palette, name, identity, bytes }] } }
 */
export function graphSvgAssets(document, { orientation = 'across', animated = true, reveal = false } = {}, rules = svgRules, contractRules = contract) {
  const files = {};
  const assets = [];
  for (const palette of Object.keys(rules.palettes)) {
    const drawn = graphDocumentSvg(document, { palette, orientation, animated, reveal }, rules, contractRules);
    if (!drawn.ok) return { ok: false, errors: drawn.errors, files: {}, manifest: null };
    files[drawn.name] = drawn.svg;
    assets.push({ palette, name: drawn.name, identity: drawn.identity, bytes: new TextEncoder().encode(drawn.svg).length });
  }
  return { ok: true, errors: [], files, manifest: { graph: graphIdentity(document), renderer_version: rules.renderer_version, orientation, assets } };
}
