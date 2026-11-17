// packages/ui/show/canvas-tools/canvas-tool-types.ts
//
// The pointer-meaning primitive for any canvas. ONE interpreter owns "what does
// this gesture mean right now"; the active tool's DATA row decides the intent.
// Object components only stamp `data-node-ref` and report a hit — they never own
// gesture meaning (that scatter is the L055 root this primitive dissolves).
//
// Physics vs Society:
//   Physics (this contract + the interpreter) — generic, knows nothing of "board".
//   Society (CanvasToolDescriptor rows, TemporaryToolRule rows) — DATA a consumer
//   supplies. New tools/shortcuts/cursors are data rows, never new code branches.
//
// CanvasIntent.kind is closed by PHYSICS only: the irreducible things a pointer
// can do to a canvas (pan, marquee, click-select, move, resize, stroke, place,
// connector). New TOOLS never add an intent kind — they recombine existing ones.

import type { NodeRef } from '../node-actions/node-ref';

/** A screen/world point pair. */
export interface CanvasPoint {
  x: number;
  y: number;
}

/** What the pointer landed on. Generic core never enumerates node families. */
export type CanvasHit =
  | { kind: 'empty'; world: CanvasPoint; client: CanvasPoint }
  | { kind: 'node'; ref: NodeRef; world: CanvasPoint; client: CanvasPoint }
  | { kind: 'resizeHandle'; ref: NodeRef; handle: string; world: CanvasPoint; client: CanvasPoint }
  | { kind: 'connectorPort'; ref: NodeRef; portId: string; world: CanvasPoint; client: CanvasPoint };

export type CanvasHitKind = CanvasHit['kind'];

/** The modifier/button state at pointer-down. Pure data — no event coupling. */
export interface GestureChord {
  button: 'primary' | 'middle' | 'secondary';
  shift: boolean;
  alt: boolean;
  meta: boolean;
  ctrl: boolean;
  spaceHeld: boolean;
}

/** The gesture phase, decided by a movement threshold. */
export type GesturePhase = 'click' | 'drag';

/**
 * The resolved meaning of a gesture. The `kind` set is closed by Physics — these
 * are the only things a pointer can do to a canvas. Fields configure the op.
 */
export type CanvasIntent =
  | { kind: 'viewport.pan' }
  | { kind: 'selection.marquee'; hitPolicy: 'intersect' | 'contain'; additive: 'shift' | 'never' }
  | { kind: 'selection.click'; additive: 'shift' | 'never'; deep: 'metaOrCtrl' | 'never' }
  | { kind: 'node.move'; selectionPolicy: 'replaceOrMoveSelection' }
  | { kind: 'node.resize' }
  | { kind: 'marks.stroke'; toolRef: string; styleRef?: string }
  | { kind: 'text.place'; draftKind: string }
  | { kind: 'connector.start'; connectorKind: string }
  | { kind: 'noop' };

export type CanvasIntentKind = CanvasIntent['kind'];

/** The per-hit gesture table for one tool. Missing cell → noop. */
export interface ToolGestureTable {
  empty?: Partial<Record<GesturePhase, CanvasIntent>>;
  node?: Partial<Record<GesturePhase, CanvasIntent>>;
  resizeHandle?: Partial<Record<GesturePhase, CanvasIntent>>;
  connectorPort?: Partial<Record<GesturePhase, CanvasIntent>>;
}

/**
 * A tool is DATA: identity, presentation, shortcuts, and its gesture-intent
 * table. Adding a tool is adding one of these rows.
 */
export interface CanvasToolDescriptor {
  id: string;
  label: string;
  /** Icon name resolved by the consumer's icon set (Society string). */
  icon: string;
  /** Idle cursor while this tool is active. */
  cursor: string;
  /** Cursor while a gesture is in progress (e.g. 'grabbing'). */
  activeCursor?: string;
  /** Keyboard shortcuts (single keys, case-insensitive) that activate the tool. */
  shortcuts: readonly string[];
  /** Sort order in the tool picker. */
  order: number;
  gestures: ToolGestureTable;
}

/**
 * A temporary-tool override: while a chord predicate holds, the active tool is
 * swapped for `toolId` (e.g. hold Space → hand). Released → revert. This is how
 * modifiers become DATA instead of `if (metaKey) pan` branches.
 */
export interface TemporaryToolRule {
  toolId: string;
  while: {
    key?: string;
    button?: 'middle' | 'secondary';
    outsideTextInput?: boolean;
  };
}

/**
 * The contract every intent kind binds to. The interpreter resolves an intent
 * then calls `start` on the matching handler. The EXISTING canvas mechanisms
 * (pan, marquee, drag, resize, stroke) ARE the handlers — the interpreter only
 * chooses which one runs.
 */
export interface IntentHandlerArgs<TIntent extends CanvasIntent = CanvasIntent> {
  intent: TIntent;
  hit: CanvasHit;
  chord: GestureChord;
  event: PointerEvent;
}

export type IntentHandler<TIntent extends CanvasIntent = CanvasIntent> = (
  args: IntentHandlerArgs<TIntent>,
) => void;

/** A handler map keyed by intent kind. Partial — unmapped kinds are inert. */
export type IntentHandlerMap = Partial<{
  [K in CanvasIntentKind]: IntentHandler<Extract<CanvasIntent, { kind: K }>>;
}>;
