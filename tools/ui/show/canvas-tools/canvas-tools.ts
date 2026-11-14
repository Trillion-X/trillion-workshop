// packages/ui/show/canvas-tools/canvas-tools.ts
//
// The DEFAULT tool registry (Society DATA) + the pure resolvers (Physics).
// A consumer can pass its own registry; this default is the maximally-capable
// one (L083) so a board "just works" with the full tool set out of the box.
//
// The dense-board marquee gap is dissolved here as ONE data row:
//   marquee-select.gestures.node.drag = selection.marquee
// i.e. dragging across an object rubber-bands instead of moving it — no modifier,
// no special case, no empty space required.

import type {
  CanvasHitKind,
  CanvasIntent,
  CanvasToolDescriptor,
  GestureChord,
  GesturePhase,
  TemporaryToolRule,
} from './canvas-tool-types';

/** Default tool set. Each row is pure DATA — adding a tool adds a row. */
export const CANVAS_TOOLS: readonly CanvasToolDescriptor[] = [
  {
    id: 'move',
    label: 'Move',
    icon: 'MousePointer2',
    cursor: 'default',
    shortcuts: ['v', '1'],
    order: 10,
    gestures: {
      empty: { drag: { kind: 'selection.marquee', hitPolicy: 'intersect', additive: 'shift' } },
      node: {
        click: { kind: 'selection.click', additive: 'shift', deep: 'metaOrCtrl' },
        drag: { kind: 'node.move', selectionPolicy: 'replaceOrMoveSelection' },
      },
      resizeHandle: { drag: { kind: 'node.resize' } },
    },
  },
  {
    id: 'marquee-select',
    label: 'Select area',
    icon: 'Scan',
    cursor: 'crosshair',
    shortcuts: ['m'],
    order: 20,
    gestures: {
      empty: { drag: { kind: 'selection.marquee', hitPolicy: 'intersect', additive: 'shift' } },
      // THE dense-board dissolution: drag over an object = marquee, not move.
      node: { drag: { kind: 'selection.marquee', hitPolicy: 'intersect', additive: 'shift' } },
      resizeHandle: { drag: { kind: 'selection.marquee', hitPolicy: 'intersect', additive: 'shift' } },
    },
  },
  {
    id: 'hand',
    label: 'Hand',
    icon: 'Hand',
    cursor: 'grab',
    activeCursor: 'grabbing',
    shortcuts: ['h'],
    order: 30,
    gestures: {
      empty: { drag: { kind: 'viewport.pan' } },
      node: { drag: { kind: 'viewport.pan' } },
      resizeHandle: { drag: { kind: 'viewport.pan' } },
    },
  },
  {
    id: 'draw',
    label: 'Draw',
    icon: 'Pencil',
    cursor: 'crosshair',
    shortcuts: ['d', 'p'],
    order: 40,
    gestures: {
      empty: { drag: { kind: 'marks.stroke', toolRef: 'mark-tool:pen' } },
      node: { drag: { kind: 'marks.stroke', toolRef: 'mark-tool:pen' } },
    },
  },
  {
    id: 'text',
    label: 'Text',
    icon: 'Type',
    cursor: 'text',
    shortcuts: ['t'],
    order: 50,
    gestures: {
      empty: { click: { kind: 'text.place', draftKind: 'note' } },
      node: { click: { kind: 'text.place', draftKind: 'note' } },
    },
  },
  {
    id: 'connector',
    label: 'Connector',
    icon: 'Spline',
    cursor: 'crosshair',
    shortcuts: ['c'],
    order: 60,
    gestures: {
      // Press an object and drag onto another → draw a relationship between them.
      // `connector.start` is a Physics intent kind (a pointer CAN relate two
      // objects); a new tool reuses it, it is never a per-tool code branch.
      node: { drag: { kind: 'connector.start', connectorKind: 'line' } },
    },
  },
];

/** Default modifier overrides. Hold Space (outside a text input) or middle-drag → hand. */
export const TEMPORARY_TOOLS: readonly TemporaryToolRule[] = [
  { toolId: 'hand', while: { key: ' ', outsideTextInput: true } },
  { toolId: 'hand', while: { button: 'middle' } },
];

/** Index a registry by id for O(1) lookup. */
export function indexTools(
  tools: readonly CanvasToolDescriptor[],
): Map<string, CanvasToolDescriptor> {
  const map = new Map<string, CanvasToolDescriptor>();
  for (const t of tools) map.set(t.id, t);
  return map;
}

/** The tool a single key activates, or null. Case-insensitive, single keys only. */
export function toolForShortcut(
  key: string,
  tools: readonly CanvasToolDescriptor[],
): CanvasToolDescriptor | null {
  const k = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  for (const t of tools) {
    if (t.shortcuts.some((s) => s.toLowerCase() === k)) return t;
  }
  return null;
}

/**
 * Resolve the EFFECTIVE tool given keys/buttons held: a temporary-tool rule wins
 * over the persistent active tool while its predicate holds.
 */
export function resolveTemporaryTool(
  state: { spaceHeld?: boolean; button?: 'primary' | 'middle' | 'secondary'; inTextInput?: boolean },
  activeToolId: string,
  tools: readonly CanvasToolDescriptor[],
  rules: readonly TemporaryToolRule[] = TEMPORARY_TOOLS,
): CanvasToolDescriptor {
  const byId = indexTools(tools);
  for (const rule of rules) {
    const w = rule.while;
    const keyOk = w.key === undefined ? true : w.key === ' ' ? !!state.spaceHeld : false;
    const buttonOk = w.button === undefined ? true : state.button === w.button;
    const textOk = w.outsideTextInput ? !state.inTextInput : true;
    if (keyOk && buttonOk && textOk && (w.key !== undefined || w.button !== undefined)) {
      const t = byId.get(rule.toolId);
      if (t) return t;
    }
  }
  return byId.get(activeToolId) ?? tools[0];
}

/**
 * The whole interpreter: given the effective tool, what the pointer hit, and the
 * gesture phase, return the configured intent. Missing cell → noop.
 */
export function resolveIntent(
  tool: CanvasToolDescriptor,
  hitKind: CanvasHitKind,
  phase: GesturePhase,
): CanvasIntent {
  const cell = tool.gestures[hitKind];
  return cell?.[phase] ?? { kind: 'noop' };
}

/** Build a GestureChord from a PointerEvent + spaceHeld flag. */
export function chordOf(event: PointerEvent, spaceHeld: boolean): GestureChord {
  const button: GestureChord['button'] =
    event.button === 1 ? 'middle' : event.button === 2 ? 'secondary' : 'primary';
  return {
    button,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    spaceHeld,
  };
}
