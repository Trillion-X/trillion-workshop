// parts/ui/show/layer-diagram/layer-diagram.mjs
//
// A PICTURE OF WHO CONNECTS TO WHAT, FROM DATA.
//
// Purpose: lay out a diagram of labelled nodes in ordered layers (for example people, then their AIs,
// then the spaces those AIs may enter) joined by edges, once, for every renderer. The layout is pure
// geometry: the React part (LayerDiagram.tsx) and pages a server sends (layerDiagramHtml, used by
// ../document-page) draw the same boxes and curves from it, so a page drawn in the browser and the
// readable copy a crawler reads show the same picture.
//
// Non-negotiable invariants:
//   1. Knows no product. Every word, mark and tone arrives in the diagram DATA. A tone is a plain word a
//      look may style; `strong`, `refused` and `highlighted` are styled here, any other word draws plain.
//   2. Two orientations from one diagram: `across` (layers left to right, for a wide screen) and `down`
//      (layers top to bottom, nodes wrapping into rows, for a phone). Each is sized in its own units so
//      its words stay readable at the width it is shown; LAYER_DIAGRAM_CSS shows the one that fits.
//   3. Total and deterministic: every node gets one box; an edge naming a missing node is dropped; a
//      repeated node id keeps its first place; the same input always gives the same numbers.
//   4. Every caller value is escaped before it reaches markup, and a picture address is used only when
//      it is same-site (`/...`) or `https://`.
//   5. No colour is written here. LAYER_DIAGRAM_CSS reads theme role tokens, with the landing's names
//      first and the document page's names as the fallback, so one look serves both.
//
// Key concepts: `layerDiagramLayout(diagram, orientation)`, `layerDiagramAtlas(layout)`, `layerDiagramNodeParts(node, orientation)`,
// `layerDiagramHtml(diagram)`, `LAYER_DIAGRAM_CSS`. Typed graph documents are read by ./graph-contract.mjs; this stays
// the one layout and drawing.

import { escapeHtml } from '../../../../../write-a-post-for-each-place/read-data/escape-html.mjs';

const GEOMETRY = {
  across: { node_w: 204, node_h: 58, column_gap: 128, row_gap: 16, pad: 24, head: 34 },
  down: { width: 340, node_w: 96, wide_w: 150, node_h: 62, column_gap: 14, row_gap: 16, layer_gap: 56, pad: 12, head: 40 },
};

// A layer heading is a heading in the page's type: sentence case as the data has it, drawn at the look's
// heading size (`--font-size-heading-lg`, 1.125rem) in its semibold weight. Widths are estimated at this size.
const HEAD_SIZE = 18;
export const HEAD_BOX = { above: 17, height: 26, pad_x: 28 };
const EDGE_LABEL_SIZE = 12;

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const word = (value) => {
  const found = text(value);
  return found && /^[a-z][a-z0-9_-]*$/.test(found) ? found : null;
};
const list = (value) => (Array.isArray(value) ? value : []);
const round = (value) => Math.round(value * 10) / 10;

// The words are HTML inside the picture (foreignObject) and wrap by themselves, but the boxes are laid out before any font loads. Estimate widths the same way in both renderers, without
// depending on a loaded font or a DOM measurement during server rendering.
const letterWidth = (letter) => {
  if (/\s/u.test(letter)) return .32;
  if (/[ilI1.,:;|!'`]/u.test(letter)) return .34;
  if (/[mwMW@%]/u.test(letter)) return .9;
  if (/[A-Z]/u.test(letter)) return .72;
  if (/[^\u0000-\u00ff]/u.test(letter)) return 1;
  return .61;
};
const estimatedWidth = (value, size) => [...value].reduce((width, letter) => width + letterWidth(letter) * size, 0) * 1.05;

function wrapWords(value, maxWidth, size) {
  const lines = [];
  let line = '';
  const push = () => { if (line) lines.push(line); line = ''; };
  for (const word of value.split(/\s+/u)) {
    if (!word) continue;
    const joined = line ? `${line} ${word}` : word;
    if (estimatedWidth(joined, size) <= maxWidth) { line = joined; continue; }
    push();
    if (estimatedWidth(word, size) <= maxWidth) { line = word; continue; }
    // Keep long unbroken names bounded too.
    for (const letter of [...word]) {
      if (line && estimatedWidth(line + letter, size) > maxWidth) push();
      line += letter;
    }
  }
  push();
  return lines.length ? lines : [''];
}

function nodeWords(node, width, orientation) {
  const down = orientation === 'down';
  const sideMark = down && node.mark && width >= 136;
  const left = down ? (sideMark ? 40 : 8) : node.mark ? 54 : 16;
  const available = Math.max(12, width - left - (down ? 8 : 14));
  return {
    label: wrapWords(node.label, available, down ? 13 : 15),
    detail: node.detail ? wrapWords(node.detail, available, down ? 11 : 12) : null,
  };
}

function nodeHeight(node, width, orientation) {
  const lines = nodeWords(node, width, orientation);
  if (orientation === 'down') {
    const content = lines.label.length * 16 + (lines.detail ? 2 + lines.detail.length * 14 : 0);
    const sideMark = node.mark && width >= 136;
    return Math.max(GEOMETRY.down.node_h, content + (node.mark && !sideMark ? 44 : 18), node.min_height ?? 0);
  }
  const content = lines.label.length * 18 + (lines.detail ? 3 + lines.detail.length * 15 : 0);
  return Math.max(GEOMETRY.across.node_h, content + 20, node.min_height ?? 0);
}

/** A picture address the diagram may draw: same-site or https only. */
export function diagramImageSrc(value) {
  const src = text(value);
  if (!src) return null;
  if (src.startsWith('/') && !src.startsWith('//')) return src;
  return /^https:\/\/[^\s"'<>]+$/i.test(src) ? src : null;
}

/** The diagram's own words, cleaned: layers of nodes and the edges between them. */
export function layerDiagramParts(diagram) {
  const seen = new Set();
  const layers = list(diagram?.layers).map((layer, layerIndex) => ({
    id: text(layer?.id) ?? `layer-${layerIndex}`,
    label: text(layer?.label),
    nodes: list(layer?.nodes).map((node) => {
      const id = text(node?.id);
      const label = text(node?.label);
      if (!id || !label || seen.has(id)) return null;
      seen.add(id);
      const image = diagramImageSrc(node?.mark?.image);
      const letters = text(node?.mark?.letters)?.slice(0, 3) ?? null;
      // A document may request a minimum height, never a position; graph-contract.mjs validates the floor.
      const floor = Number.isSafeInteger(node?.min_height) && node.min_height > 0 ? { min_height: node.min_height } : {};
      return { id, label, detail: text(node?.detail), mark: image || letters ? { image, letters } : null, tone: word(node?.tone), delta: word(node?.delta), ...floor };
    }).filter(Boolean),
  })).filter((layer) => layer.nodes.length);
  const edges = list(diagram?.edges)
    .map((edge) => ({ from: text(edge?.from), to: text(edge?.to), tone: word(edge?.tone), delta: word(edge?.delta), label: text(edge?.label) }))
    .filter((edge) => seen.has(edge.from) && seen.has(edge.to) && edge.from !== edge.to);
  return { id: word(diagram?.id) ?? 'diagram', label: text(diagram?.label) ?? '', caption: text(diagram?.caption), layers, edges };
}

// A point on a cubic curve, where an edge's label sits.
const bezier = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
};

function placeAcross(layers) {
  const g = GEOMETRY.across;
  const layerHeights = layers.map((layer) => layer.nodes.map((node) => nodeHeight(node, g.node_w, 'across')));
  const body = Math.max(...layerHeights.map((heights) => heights.reduce((sum, height) => sum + height, 0) + (heights.length - 1) * g.row_gap));
  const width = g.pad * 2 + layers.length * g.node_w + (layers.length - 1) * g.column_gap;
  const top = g.pad + (layers.some((layer) => layer.label) ? g.head : 0);
  const boxes = new Map();
  const heads = [];
  layers.forEach((layer, layerIndex) => {
    const x = g.pad + layerIndex * (g.node_w + g.column_gap);
    if (layer.label) heads.push({ id: layer.id, label: layer.label, x: x + g.node_w / 2, y: g.pad + 17, w: Math.min(g.node_w + g.column_gap - 16, Math.ceil(estimatedWidth(layer.label, HEAD_SIZE) + HEAD_BOX.pad_x)) });
    const heights = layerHeights[layerIndex];
    const occupied = heights.reduce((sum, height) => sum + height, 0) + (heights.length - 1) * g.row_gap;
    const gap = heights.length > 1 ? g.row_gap + (body - occupied) / (heights.length - 1) : 0;
    let y = top + (heights.length === 1 ? (body - heights[0]) / 2 : 0);
    layer.nodes.forEach((node, index) => {
      boxes.set(node.id, { ...node, x, y, w: g.node_w, h: heights[index] });
      y += heights[index] + gap;
    });
  });
  return { width, height: top + body + g.pad, boxes, heads };
}

function placeDown(layers) {
  const g = GEOMETRY.down;
  const maxPerRow = Math.max(1, Math.floor((g.width - g.pad * 2 + g.column_gap) / (g.node_w + g.column_gap)));
  const boxes = new Map();
  const heads = [];
  let y = g.pad;
  for (const layer of layers) {
    // A layer with long names takes fewer columns instead of compressing its type.
    let perRow = 1;
    for (let count = Math.min(maxPerRow, layer.nodes.length); count >= 1; count--) {
      const width = Math.min(g.wide_w, (g.width - g.pad * 2 - (count - 1) * g.column_gap) / count);
      if (layer.nodes.every((node) => {
        const lines = nodeWords(node, width, 'down');
        return lines.label.length <= 2 && (!lines.detail || lines.detail.length <= 3);
      })) { perRow = count; break; }
    }
    if (layer.label) {
      heads.push({ id: layer.id, label: layer.label, x: g.width / 2, y: y + 17, w: Math.min(g.width - g.pad * 2, Math.ceil(estimatedWidth(layer.label, HEAD_SIZE) + HEAD_BOX.pad_x)) });
      y += g.head;
    }
    const top = y;
    const placed = [];
    for (let start = 0; start < layer.nodes.length; start += perRow) {
      const row = layer.nodes.slice(start, start + perRow);
      // A short row widens its boxes (up to wide_w) so longer words still fit.
      const w = Math.min(g.wide_w, (g.width - g.pad * 2 - (row.length - 1) * g.column_gap) / row.length);
      const left = (g.width - (row.length * w + (row.length - 1) * g.column_gap)) / 2;
      const rowHeight = Math.max(...row.map((node) => nodeHeight(node, w, 'down')));
      row.forEach((node, index) => {
        placed.push({ ...node, x: left + index * (w + g.column_gap), y, w, h: rowHeight });
      });
      y += rowHeight + g.row_gap;
    }
    const bottom = y - g.row_gap;
    for (const box of placed) boxes.set(box.id, { ...box, layer_top: top, layer_bottom: bottom });
    y += g.layer_gap - g.row_gap;
  }
  return { width: g.width, height: y - g.layer_gap + g.pad, boxes, heads };
}

const curve = (x1, y1, x2, y2, x3, y3) => `C${round(x1)} ${round(y1)} ${round(x2)} ${round(y2)} ${round(x3)} ${round(y3)}`;

// Downward connectors travel in the outside gutter while passing a layer heading or an intervening
// row. Their only horizontal moves happen in the clear row gap below the source and above the target.
// This keeps a connection visible without running it through a heading or an unrelated node.
function downEdge(from, to, width) {
  const [a, b] = from.y <= to.y ? [from, to] : [to, from];
  const half = GEOMETRY.down.row_gap / 2;
  const ax = a.x + a.w / 2;
  const bx = b.x + b.w / 2;
  const lane = ax + bx <= width ? GEOMETRY.down.pad / 2 : width - GEOMETRY.down.pad / 2;
  const startY = a.y + a.h;
  const leaveY = startY + half;
  const arriveY = b.y - half;
  if (arriveY <= leaveY) {
    // A connection within one row has no intervening heading or row to bypass.
    const bend = Math.max(18, (b.y - startY) / 2);
    return { d: `M${round(ax)} ${round(startY)}` + curve(ax, startY + bend, bx, b.y - bend, bx, b.y), label_x: round((ax + bx) / 2), label_y: round((startY + b.y) / 2) };
  }
  const d = `M${round(ax)} ${round(startY)}`
    + curve(ax, leaveY, lane, leaveY, lane, leaveY)
    + `L${round(lane)} ${round(arriveY)}`
    + curve(lane, arriveY, bx, arriveY, bx, b.y);
  return { d, label_x: round((lane + bx) / 2), label_y: round(arriveY - 3) };
}

// The curve from one box to another in the across drawing: out of the earlier box's right side into the
// later box's left side, whichever way the edge is written.
function edgePoints(from, to) {
  const forward = from.x <= to.x;
  const [a, b] = forward ? [from, to] : [to, from];
  const x0 = a.x + a.w; const y0 = a.y + a.h / 2; const x3 = b.x; const y3 = b.y + b.h / 2;
  const bend = Math.max(36, (x3 - x0) / 2);
  const points = [x0, y0, x0 + bend, y0, x3 - bend, y3, x3, y3];
  return forward ? points : [points[6], points[7], points[4], points[5], points[2], points[3], points[0], points[1]];
}

/**
 * diagram: { id, label, caption, layers: [{ id, label?, nodes: [{ id, label, detail?, mark?: { image? | letters? }, tone? }] }],
 *            edges: [{ from, to, tone?, label? }] }
 * orientation: 'across' | 'down'
 * -> { id, label, caption, orientation, width, height, heads: [{ id, label, x, y }],
 *      nodes: [{ id, label, detail, mark, tone, x, y, w, h }], edges: [{ from, to, tone, label, d, label_x, label_y }] }
 */
export function layerDiagramLayout(diagram, orientation = 'across') {
  const parts = layerDiagramParts(diagram);
  const way = orientation === 'down' ? 'down' : 'across';
  if (!parts.layers.length) return { id: parts.id, label: parts.label, caption: parts.caption, orientation: way, width: 0, height: 0, heads: [], nodes: [], edges: [] };
  const placed = way === 'down' ? placeDown(parts.layers) : placeAcross(parts.layers);
  const edges = parts.edges.map((raw) => {
    const edge = { ...raw, label_w: raw.label ? Math.ceil(estimatedWidth(raw.label, EDGE_LABEL_SIZE) + 12) : 0 };
    if (way === 'down') return { ...edge, ...downEdge(placed.boxes.get(edge.from), placed.boxes.get(edge.to), placed.width) };
    const [x0, y0, x1, y1, x2, y2, x3, y3] = edgePoints(placed.boxes.get(edge.from), placed.boxes.get(edge.to));
    return {
      ...edge,
      d: `M${round(x0)} ${round(y0)}C${round(x1)} ${round(y1)} ${round(x2)} ${round(y2)} ${round(x3)} ${round(y3)}`,
      label_x: round(bezier(x0, x1, x2, x3, 0.5)),
      label_y: round(bezier(y0, y1, y2, y3, 0.5)),
    };
  });
  const nodes = [...placed.boxes.values()].map(({ layer_top: _top, layer_bottom: _bottom, ...node }) => ({ ...node, x: round(node.x), y: round(node.y), w: round(node.w) }));
  return { id: parts.id, label: parts.label, caption: parts.caption, orientation: way, width: Math.ceil(placed.width), height: Math.ceil(placed.height), heads: placed.heads, nodes, edges };
}

/** Geometry sidecar for one layout: every heading and node box plus every edge path in drawing order. */
export function layerDiagramAtlas(layout) {
  return {
    id: layout.id,
    orientation: layout.orientation,
    width: layout.width,
    height: layout.height,
    boxes: [
      ...layout.heads.map((head) => ({ id: head.id, role: 'heading', x: round(head.x - head.w / 2), y: round(head.y - HEAD_BOX.above), w: round(head.w), h: HEAD_BOX.height })),
      ...layout.nodes.map((node) => ({ id: node.id, role: 'node', x: node.x, y: node.y, w: node.w, h: node.h })),
    ],
    edges: layout.edges.map((edge) => ({ from: edge.from, to: edge.to, d: edge.d, label_x: edge.label_x, label_y: edge.label_y })),
  };
}

/** Where a node's mark, words and detail sit inside its box, the same for every renderer. */
export function layerDiagramNodeParts(node, orientation) {
  const size = orientation === 'down' ? 22 : 30;
  const lines = nodeWords(node, node.w, orientation);
  if (orientation === 'down') {
    const sideMark = node.mark && node.w >= 136;
    if (sideMark) {
      const content = lines.label.length * 16 + (lines.detail ? 2 + lines.detail.length * 14 : 0);
      const top = (node.h - content) / 2;
      return {
        mark: { size, x: 10, y: (node.h - size) / 2 },
        label: { x: 40, y: round(top + 12), anchor: 'start', lines: lines.label, line_height: 16 },
        detail: lines.detail ? { x: 40, y: round(top + lines.label.length * 16 + 12), anchor: 'start', lines: lines.detail, line_height: 14 } : null,
      };
    }
    const markY = 7;
    const content = lines.label.length * 16 + (lines.detail ? 2 + lines.detail.length * 14 : 0);
    const top = node.mark ? markY + size + 7 : (node.h - content) / 2;
    return {
      mark: node.mark ? { size, x: (node.w - size) / 2, y: markY } : null,
      label: { x: node.w / 2, y: round(top + 12), anchor: 'middle', lines: lines.label, line_height: 16 },
      detail: lines.detail ? { x: node.w / 2, y: round(top + lines.label.length * 16 + 12), anchor: 'middle', lines: lines.detail, line_height: 14 } : null,
    };
  }
  const left = node.mark ? 14 + size + 10 : 16;
  const content = lines.label.length * 18 + (lines.detail ? 3 + lines.detail.length * 15 : 0);
  const top = (node.h - content) / 2;
  return {
    mark: node.mark ? { size, x: 14, y: (node.h - size) / 2 } : null,
    label: { x: left, y: round(top + 13), anchor: 'start', lines: lines.label, line_height: 18 },
    detail: lines.detail ? { x: left, y: round(top + lines.label.length * 18 + 14), anchor: 'start', lines: lines.detail, line_height: 15 } : null,
  };
}

/** The class names a node or edge wears: its base name plus one per tone word. */
export function layerDiagramClass(base, tone) {
  return tone ? `${base} ${base}--${tone}` : base;
}

// A surface is drawn as an HTML box inside a foreignObject, never as an SVG fill: a colour-adapting extension (Dark
// Reader) reads an SVG `fill` as a text colour, so it keeps a light card light while turning its words light too. An
// HTML background is recognised as a ground and darkened with its words changed to match. Only the connectors are SVG.
export const NODE_TEXT = { across: { label: 15, detail: 12 }, down: { label: 13, detail: 11 } };

/** Where a block of a node's words sits inside its card as a box (HTML text is placed by its top, SVG text by its baseline). */
export function layerDiagramSpotBox(spot, size, nodeW) {
  const centred = spot.anchor === 'middle';
  return {
    left: centred ? 0 : spot.x,
    top: round(spot.y - spot.line_height / 2 - .355 * size),
    width: centred ? round(nodeW) : round(nodeW - spot.x),
    line_height: spot.line_height,
    align: centred ? 'center' : 'left',
  };
}

const spotStyle = (box) => `left:${box.left}px;top:${box.top}px;width:${box.width}px;line-height:${box.line_height}px;text-align:${box.align}`;
const rectAttrs = (x, y, w, h) => `x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}"`;

function svgHtml(layout) {
  const way = layout.orientation;
  const edges = layout.edges.map((edge) => `<path class="${layerDiagramClass('layer-diagram__edge', edge.tone)}"${edge.delta ? ` data-delta="${escapeHtml(edge.delta)}"` : ''} d="${edge.d}"/>`).join('');
  const labels = layout.edges.filter((edge) => edge.label).map((edge) => `<foreignObject ${rectAttrs(edge.label_x - edge.label_w / 2, edge.label_y - 10, edge.label_w, 20)}><span class="${layerDiagramClass('layer-diagram__edge-label', edge.tone)}">${escapeHtml(edge.label)}</span></foreignObject>`).join('');
  const heads = layout.heads.map((head) => `<foreignObject ${rectAttrs(head.x - head.w / 2, head.y - HEAD_BOX.above, head.w, HEAD_BOX.height)}><h3 class="layer-diagram__head">${escapeHtml(head.label)}</h3></foreignObject>`).join('');
  const lines = (spot, className, size, w) => `<span class="${className}" style="${spotStyle(layerDiagramSpotBox(spot, size, w))}">${spot.lines.map((line) => `<span class="layer-diagram__line">${escapeHtml(line)}</span>`).join('')}</span>`;
  const nodes = layout.nodes.map((node) => {
    const at = layerDiagramNodeParts(node, way);
    const place = at.mark ? `left:${round(at.mark.x)}px;top:${round(at.mark.y)}px;width:${at.mark.size}px;height:${at.mark.size}px` : '';
    const mark = at.mark ? (node.mark.image
      ? `<span class="layer-diagram__mark layer-diagram__mark--image" style="${place}"><img src="${escapeHtml(node.mark.image)}" alt=""></span>`
      : `<span class="layer-diagram__mark layer-diagram__mark--letters" style="${place}">${escapeHtml(node.mark.letters)}</span>`) : '';
    return `<foreignObject ${rectAttrs(node.x, node.y, node.w, node.h)}><div class="${layerDiagramClass('layer-diagram__node', node.tone)}"${node.delta ? ` data-delta="${escapeHtml(node.delta)}"` : ''}>${mark}`
      + lines(at.label, 'layer-diagram__label', NODE_TEXT[way].label, node.w)
      + (at.detail ? lines(at.detail, 'layer-diagram__detail', NODE_TEXT[way].detail, node.w) : '')
      + '</div></foreignObject>';
  }).join('');
  return `<svg class="layer-diagram__svg layer-diagram__svg--${way}" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" aria-hidden="true">${edges}${heads}${nodes}${labels}</svg>`;
}

/**
 * The same picture as the React part, as markup for a page a server sends. The label is read by screen
 * readers (the drawing itself is aria-hidden); the caption is shown under it. An empty diagram is ''.
 */
export function layerDiagramHtml(diagram) {
  const across = layerDiagramLayout(diagram, 'across');
  if (!across.nodes.length) return '';
  const down = layerDiagramLayout(diagram, 'down');
  return `<figure class="layer-diagram" role="img" aria-label="${escapeHtml(across.label)}">${svgHtml(across)}${svgHtml(down)}`
    + (across.caption ? `<figcaption class="layer-diagram__caption">${escapeHtml(across.caption)}</figcaption>` : '') + '</figure>';
}

export const LAYER_DIAGRAM_CSS = `
/* Every surface and the words on it take a declared pair from the look (parts/screen-look/paired-surfaces.json):
   a --ld-ground-* variable is only ever a background, a --ld-words-* variable is only ever a text colour and a
   --ld-mark-* variable is only ever a line. A colour-adapting extension (Dark Reader) decides from how a variable is
   used whether it is a background or a text colour, so one variable never plays both parts. */
.layer-diagram{--ld-words-card:var(--words-on-card,var(--text-primary,var(--ink)));--ld-words-card-quiet:var(--words-on-card-quiet,var(--words-secondary,var(--text-secondary,var(--grey-strong))));--ld-words-page:var(--words-on-page,var(--words-secondary,var(--text-secondary,var(--grey-strong))));--ld-words-accent:var(--words-accent,var(--thread-line,var(--thread,var(--button-primary-bg-hover))));--ld-words-on-accent:var(--words-on-accent,var(--on-accent,var(--button-text,var(--button-primary-text))));--ld-ground-page:var(--ground-page,var(--paper,var(--surface-base,var(--bg-primary))));--ld-ground-card:var(--ground-card,var(--paper-tint,var(--surface-base,var(--bg-surface))));--ld-ground-accent:var(--ground-accent,var(--thread-line,var(--thread,var(--button-primary-bg-hover))));--ld-ground-light:var(--ground-light,var(--paper,var(--surface-base,var(--bg-primary))));--ld-mark-line:var(--mark-line,var(--ink-line,var(--grey-strong,var(--text-primary))));--ld-mark-accent:var(--mark-accent,var(--thread-line,var(--thread,var(--button-primary-bg-hover))));--ld-mark-quiet:var(--mark-quiet,var(--grey-strong,var(--text-secondary)));margin:8px 0 28px;display:grid;justify-items:center;gap:14px}
.layer-diagram__svg{display:block;width:100%;height:auto;overflow:visible;font-family:var(--font-body,'SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif)}
.layer-diagram__svg foreignObject{overflow:visible}
.layer-diagram__svg--down{display:none}
.layer-diagram__edge{fill:none;stroke:var(--ld-mark-line);stroke-width:1.6;stroke-linecap:round;opacity:.5}
.layer-diagram__edge--strong{stroke:var(--ld-mark-accent);stroke-width:2.2;opacity:1;stroke-dasharray:6 7;animation:layer-diagram-flow 1.4s linear infinite}
.layer-diagram__edge--refused{stroke:var(--ld-mark-quiet);stroke-width:1.8;stroke-dasharray:2 6;opacity:.9}
.layer-diagram__edge-label{display:block;box-sizing:border-box;width:100%;height:100%;border-radius:5px;background:var(--ld-ground-page);color:var(--ld-words-page);font-size:12px;font-weight:600;line-height:20px;text-align:center;white-space:nowrap}
.layer-diagram__edge-label--refused{color:var(--ld-words-accent)}
.layer-diagram__head{display:block;box-sizing:border-box;width:100%;height:100%;margin:0;border-radius:6px;background:var(--ld-ground-page);color:var(--ld-words-page);font-family:var(--font-headline,var(--font-display,var(--font-body)));font-size:var(--font-size-heading-lg,1.125rem);font-weight:600;line-height:26px;letter-spacing:normal;text-align:center;text-transform:none;white-space:nowrap}
.layer-diagram__node{position:relative;box-sizing:border-box;width:100%;height:100%;border-radius:12px;background:var(--ld-ground-card);color:var(--ld-words-card)}
.layer-diagram__node::before{content:'';position:absolute;inset:0;box-sizing:border-box;border:1.2px solid var(--ld-mark-line);border-radius:inherit;pointer-events:none}
.layer-diagram__node--highlighted{background:var(--ld-ground-accent);color:var(--ld-words-on-accent)}
.layer-diagram__node--highlighted::before{border-color:var(--ld-ground-accent)}
.layer-diagram__label,.layer-diagram__detail{position:absolute;display:block;margin:0;white-space:nowrap}
.layer-diagram__line{display:block}
.layer-diagram__label{font-size:15px;font-weight:600;color:var(--ld-words-card)}
.layer-diagram__detail{font-size:12px;color:var(--ld-words-card-quiet)}
.layer-diagram__node--highlighted .layer-diagram__label,.layer-diagram__node--highlighted .layer-diagram__detail{color:var(--ld-words-on-accent)}
.layer-diagram__svg--down .layer-diagram__label{font-size:13px}.layer-diagram__svg--down .layer-diagram__detail{font-size:11px}
.layer-diagram__mark{position:absolute;box-sizing:border-box;display:grid;place-items:center;border-radius:50%}
.layer-diagram__mark--letters{background:var(--ld-ground-accent);color:var(--ld-words-on-accent);font-size:12px;font-weight:700;line-height:1}
.layer-diagram__mark--image{background:var(--ld-ground-page)}
.layer-diagram__mark--image::before{content:'';position:absolute;inset:0;box-sizing:border-box;border:1px solid var(--ld-mark-line);border-radius:50%}
.layer-diagram__mark--image img{display:block;width:calc(100% - 6px);height:calc(100% - 6px);object-fit:contain}
.layer-diagram__node--highlighted .layer-diagram__mark--image::before{border:0}
.layer-diagram__node--highlighted .layer-diagram__mark--letters{background:var(--ld-ground-light);color:var(--ld-words-accent)}
.layer-diagram__caption{max-width:680px;margin:0;text-align:center;font-size:15px;line-height:1.55;color:var(--ld-words-page)}
@keyframes layer-diagram-flow{to{stroke-dashoffset:-26}}
@media (max-width:760px){.layer-diagram__svg--across{display:none}.layer-diagram__svg--down{display:block;max-width:420px}}
@media (prefers-reduced-motion:reduce){.layer-diagram__edge--strong{animation:none}}
/* Forced colours replace every colour with the person's system palette: cards are Canvas with a CanvasText line, words are CanvasText, the lit card is Highlight with HighlightText, and lines stay visible. */
@media (forced-colors:active){
.layer-diagram__node::before,.layer-diagram__mark--image::before{border-color:CanvasText}
.layer-diagram__edge,.layer-diagram__edge--strong,.layer-diagram__edge--refused{stroke:CanvasText;opacity:1}
.layer-diagram__node--highlighted{forced-color-adjust:none;background:Highlight;color:HighlightText}
.layer-diagram__node--highlighted .layer-diagram__label,.layer-diagram__node--highlighted .layer-diagram__detail{color:HighlightText}
.layer-diagram__node--highlighted::before{border-color:Highlight}
.layer-diagram__mark--letters{forced-color-adjust:none;background:CanvasText;color:Canvas}
.layer-diagram__node--highlighted .layer-diagram__mark--letters{background:HighlightText;color:Highlight}
}
`;
