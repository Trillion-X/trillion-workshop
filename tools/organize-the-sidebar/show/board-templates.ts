// packages/group/show/board-templates.ts
//
// =============================================================================
// PURPOSE — the board TEMPLATE CATALOG: Society DATA in the feature package.
// =============================================================================
//
// Each template is a pure DATA row (a `BoardTemplate`): an array of self-describing
// item descriptors. The generic `applyTemplate` (read-data/board-template-apply)
// stamps any of them onto a fresh board via the existing placeItem/placeSection
// primitives — it never names a template. Adding a template = ONE row HERE, ZERO
// engine/handler change (L069/L090, same shape as filter-presets.ts /
// CUSTOM_SHAPE_PRESETS). The gallery renders each template's thumbnail by feeding
// its `items` through `boardToSvg` (#142) — thumbnails are GENERATED from this
// DATA, never separate assets.
//
// Catalog grounded in the FigJam / ClickUp / Zoom whiteboard template libraries
// (Brainstorm, Kanban, Retrospective, 2×2 Matrix, Weekly plan, Mind map).
// =============================================================================

import type { BoardTemplate } from '../read-data/board-template-apply';

const NOTE_W = 200;
const NOTE_H = 120;

/** A soft sticky-note fill applied via the appearance frame DATA (extra). */
function sticky(fill: string): Record<string, unknown> {
  return { visualLayerStack: { frame: { cornerRadius: 10, border: { color: fill, width: 1 } } } };
}

/** cont.26 (E5) — a HAND-DRAWN sticky: the sticky fill + the per-item sketch appearance keys
 *  (`borderRoughness` pencil outline + a handwritten `fontFamily`) the cascade renders. Pure DATA —
 *  NO template-engine change; per-item appearance simply wins at the item tier (proof the cont.26
 *  axes are usable anywhere DATA flows). */
const HANDWRITTEN = "'Comic Sans MS', 'Comic Neue', 'Chalkboard SE', 'Patrick Hand', cursive";
function sketchBox(fill: string): Record<string, unknown> {
  return { ...sticky(fill), borderRoughness: 1.6, fontFamily: HANDWRITTEN };
}

/** cont.26 — the board-level SKETCH LOOK a template can pre-configure: pencil connectors + pencil note
 *  borders + handwritten font (the same cascade keys the "Sketch" appearance preset sets). Paired with
 *  `background:'paper'` on a template, a new board opens as a full hand-drawn whiteboard in one click. */
const SKETCH_LOOK: Readonly<Record<string, unknown>> = {
  containerVariant: 'surface',
  connectorStrokeStyle: 'pencil',
  borderStrokeStyle: 'pencil',
  connectorRouting: 'straight',
  fontFamily: HANDWRITTEN,
};

export const BOARD_TEMPLATES: readonly BoardTemplate[] = [
  {
    id: 'brainstorm',
    name: 'Brainstorm',
    category: 'Ideation',
    description: 'Rapid idea dump — capture everything, filter later.',
    tags: ['ideas', 'divergent', 'stickies', 'workshop'],
    items: [
      { id: 't', kind: 'note', x: 40, y: 0, w: 420, h: 70, text: 'Brainstorm — drop every idea, no filter' },
      { id: 'a', kind: 'note', x: 40, y: 110, w: NOTE_W, h: NOTE_H, text: 'Idea', extra: sticky('#f4c84a') },
      { id: 'b', kind: 'note', x: 260, y: 110, w: NOTE_W, h: NOTE_H, text: 'Idea', extra: sticky('#f4c84a') },
      { id: 'c', kind: 'note', x: 40, y: 250, w: NOTE_W, h: NOTE_H, text: 'Idea', extra: sticky('#7cc6fb') },
      { id: 'd', kind: 'note', x: 260, y: 250, w: NOTE_W, h: NOTE_H, text: 'Idea', extra: sticky('#7cc6fb') },
    ],
  },
  {
    id: 'kanban',
    name: 'Kanban',
    category: 'Planning',
    description: 'Track work across To do · Doing · Done columns.',
    tags: ['tasks', 'workflow', 'columns', 'agile'],
    items: [
      {
        id: 'todo', kind: 'section', x: 40, y: 0, w: 260, h: 460, text: 'To do',
        children: [
          { id: 'k1', kind: 'note', x: 70, y: 70, w: NOTE_W, h: 96, text: 'Task', extra: sticky('#f4c84a') },
          { id: 'k2', kind: 'note', x: 70, y: 190, w: NOTE_W, h: 96, text: 'Task', extra: sticky('#f4c84a') },
        ],
      },
      {
        id: 'doing', kind: 'section', x: 330, y: 0, w: 260, h: 460, text: 'Doing',
        children: [{ id: 'k3', kind: 'note', x: 360, y: 70, w: NOTE_W, h: 96, text: 'Task', extra: sticky('#7cc6fb') }],
      },
      {
        id: 'done', kind: 'section', x: 620, y: 0, w: 260, h: 460, text: 'Done',
        children: [{ id: 'k4', kind: 'note', x: 650, y: 70, w: NOTE_W, h: 96, text: 'Task', extra: sticky('#86d98f') }],
      },
    ],
  },
  {
    id: 'retro',
    name: 'Retrospective',
    category: 'Meetings',
    description: 'Start · Stop · Continue team reflection.',
    tags: ['team', 'reflection', 'agile', 'meeting'],
    items: [
      {
        id: 'start', kind: 'section', x: 40, y: 0, w: 280, h: 420, text: 'Start',
        children: [{ id: 'r1', kind: 'note', x: 70, y: 70, w: NOTE_W, h: 96, text: '', extra: sticky('#86d98f') }],
      },
      {
        id: 'stop', kind: 'section', x: 350, y: 0, w: 280, h: 420, text: 'Stop',
        children: [{ id: 'r2', kind: 'note', x: 380, y: 70, w: NOTE_W, h: 96, text: '', extra: sticky('#f08a8a') }],
      },
      {
        id: 'continue', kind: 'section', x: 660, y: 0, w: 280, h: 420, text: 'Continue',
        children: [{ id: 'r3', kind: 'note', x: 690, y: 70, w: NOTE_W, h: 96, text: '', extra: sticky('#7cc6fb') }],
      },
    ],
  },
  {
    id: 'matrix-2x2',
    name: '2×2 Matrix',
    category: 'Ideation',
    description: 'Prioritise by impact vs effort across four quadrants.',
    tags: ['prioritisation', 'decision', 'quadrants', 'strategy'],
    items: [
      { id: 'q1', kind: 'note', x: 40, y: 40, w: 240, h: 200, text: 'High impact · low effort', extra: sticky('#86d98f') },
      { id: 'q2', kind: 'note', x: 300, y: 40, w: 240, h: 200, text: 'High impact · high effort', extra: sticky('#f4c84a') },
      { id: 'q3', kind: 'note', x: 40, y: 260, w: 240, h: 200, text: 'Low impact · low effort', extra: sticky('#7cc6fb') },
      { id: 'q4', kind: 'note', x: 300, y: 260, w: 240, h: 200, text: 'Low impact · high effort', extra: sticky('#f08a8a') },
    ],
  },
  {
    id: 'weekly-plan',
    name: 'Weekly plan',
    category: 'Planning',
    description: 'Lay out the week Mon–Fri in columns.',
    tags: ['schedule', 'week', 'planning', 'calendar'],
    items: [
      { id: 'mon', kind: 'section', x: 0, y: 0, w: 200, h: 420, text: 'Mon' },
      { id: 'tue', kind: 'section', x: 220, y: 0, w: 200, h: 420, text: 'Tue' },
      { id: 'wed', kind: 'section', x: 440, y: 0, w: 200, h: 420, text: 'Wed' },
      { id: 'thu', kind: 'section', x: 660, y: 0, w: 200, h: 420, text: 'Thu' },
      { id: 'fri', kind: 'section', x: 880, y: 0, w: 200, h: 420, text: 'Fri' },
    ],
  },
  {
    id: 'mind-map',
    name: 'Mind map',
    category: 'Ideation',
    description: 'Radiate connected branches from a central idea.',
    tags: ['ideas', 'branches', 'connectors', 'divergent'],
    items: [
      { id: 'center', kind: 'note', x: 360, y: 200, w: 220, h: 100, text: 'Central idea', extra: sticky('#f4c84a') },
      { id: 'n1', kind: 'note', x: 40, y: 40, w: NOTE_W, h: 96, text: 'Branch', extra: sticky('#7cc6fb') },
      { id: 'n2', kind: 'note', x: 720, y: 40, w: NOTE_W, h: 96, text: 'Branch', extra: sticky('#7cc6fb') },
      { id: 'n3', kind: 'note', x: 40, y: 380, w: NOTE_W, h: 96, text: 'Branch', extra: sticky('#86d98f') },
      { id: 'n4', kind: 'note', x: 720, y: 380, w: NOTE_W, h: 96, text: 'Branch', extra: sticky('#86d98f') },
      { id: 'e1', kind: 'connector', x: 0, y: 0, w: 0, h: 0, from: 'center', to: 'n1' },
      { id: 'e2', kind: 'connector', x: 0, y: 0, w: 0, h: 0, from: 'center', to: 'n2' },
      { id: 'e3', kind: 'connector', x: 0, y: 0, w: 0, h: 0, from: 'center', to: 'n3' },
      { id: 'e4', kind: 'connector', x: 0, y: 0, w: 0, h: 0, from: 'center', to: 'n4' },
    ],
  },
  {
    // cont.26 (E5) — the "Infra we build on" abstraction-stack diagram in the hand-drawn WHITEBOARD
    // look (the user's reference image). It's a ready-made SKETCH board: every box carries the
    // per-item sketch appearance (pencil border + handwritten font) via `sketchBox`, layered by
    // abstraction. Pure DATA — the whole sketch aesthetic ships as a template row, ZERO engine code,
    // because cont.26's roughness/font axes flow through the same per-item extra every template uses.
    id: 'infra-stack',
    name: 'Infra we build on',
    category: 'Diagram',
    description: 'A hand-drawn abstraction-stack diagram — layered platforms in a sketch style.',
    tags: ['sketch', 'diagram', 'stack', 'architecture', 'hand-drawn'],
    // cont.26 — opens as a full hand-drawn whiteboard: paper canvas + board-level sketch defaults.
    background: 'paper',
    appearance: SKETCH_LOOK,
    items: [
      { id: 'title', kind: 'note', x: 40, y: 0, w: 460, h: 60, text: 'The Infra we build on', extra: { fontFamily: HANDWRITTEN } },
      { id: 'axis', kind: 'note', x: 40, y: 150, w: 150, h: 60, text: 'Abstraction ↑', extra: { fontFamily: HANDWRITTEN } },
      // Row 1 — highest abstraction (managed platforms).
      { id: 'convex', kind: 'note', x: 220, y: 90, w: 150, h: 76, text: 'Convex', extra: sketchBox('#f7a8a8') },
      { id: 'vercel', kind: 'note', x: 390, y: 90, w: 150, h: 76, text: 'Vercel', extra: sketchBox('#8fd99a') },
      { id: 'supabase', kind: 'note', x: 560, y: 90, w: 150, h: 76, text: 'Supabase', extra: sketchBox('#f2b6d3') },
      { id: 'netlify', kind: 'note', x: 730, y: 90, w: 150, h: 76, text: 'Netlify', extra: sketchBox('#8fb8f0') },
      // Row 2 — cloud providers.
      { id: 'aws', kind: 'note', x: 220, y: 200, w: 150, h: 76, text: 'AWS', extra: sketchBox('#f4d06a') },
      { id: 'gcp', kind: 'note', x: 390, y: 200, w: 150, h: 76, text: 'GCP', extra: sketchBox('#f4d06a') },
      { id: 'azure', kind: 'note', x: 560, y: 200, w: 150, h: 76, text: 'Azure', extra: sketchBox('#f4d06a') },
      { id: 'cloudflare', kind: 'note', x: 730, y: 200, w: 150, h: 76, text: 'Cloudflare', extra: sketchBox('#f4d06a') },
      // Row 3 — bare metal (the foundation).
      { id: 'metal', kind: 'note', x: 220, y: 310, w: 660, h: 70, text: 'Metal', extra: sketchBox('#e3ddd1') },
    ],
  },
  {
    id: 'sketch-whiteboard',
    name: 'Sketch whiteboard',
    category: 'Ideation',
    description: 'A hand-drawn whiteboard — paper canvas, pencil notes, handwritten font. Start sketching.',
    tags: ['sketch', 'whiteboard', 'hand-drawn', 'brainstorm', 'excalidraw'],
    // cont.26 — the whole board look is board-level DATA: a paper surface + the SKETCH appearance
    // defaults, so every note/connector added later inherits the pencil-and-handwriting style for free.
    background: 'paper',
    appearance: SKETCH_LOOK,
    items: [
      { id: 'title', kind: 'note', x: 40, y: 0, w: 460, h: 60, text: 'Sketch it out ✍️' },
      { id: 'idea', kind: 'note', x: 60, y: 120, w: NOTE_W, h: NOTE_H, text: 'Idea', extra: sticky('#f4c84a') },
      { id: 'why', kind: 'note', x: 340, y: 120, w: NOTE_W, h: NOTE_H, text: 'Why it matters', extra: sticky('#8fd99a') },
      { id: 'next', kind: 'note', x: 200, y: 300, w: NOTE_W, h: NOTE_H, text: 'Next step', extra: sticky('#7cc6fb') },
      { id: 'c1', kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'idea', toMemberId: 'why' } },
      { id: 'c2', kind: 'connector', x: 0, y: 0, w: 0, h: 0, extra: { fromMemberId: 'idea', toMemberId: 'next' } },
    ],
  },
];
