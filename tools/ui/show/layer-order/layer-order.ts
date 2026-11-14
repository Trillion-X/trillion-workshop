// packages/ui/show/layer-order/layer-order.ts
//
// Single ordered stacking scale (SSOT). Higher number = paints on top. The
// cross-scene stacking relationships are declared ONCE, here, instead of as bare
// magic z-index numbers scattered across components that must be hand-kept in the
// right order. A consumer imports a NAMED layer; it never writes a raw z-index.
//
// Why this exists: a floating panel (e.g. an auto-hidden sidebar revealed on
// hover) lives in its own composition scene-root, but must paint ABOVE both the
// arrangement stage (a sibling scene-root) AND above its own edge-reveal trigger.
// Expressing that as `9995 > 9000 > 20` in three different files is an implicit
// contract no one can see. Naming the layers makes the order auditable in one
// place and impossible to get subtly wrong.

/**
 * Named stacking layers, ascending. The numeric gaps are intentional headroom so
 * a future intermediate layer can be inserted without renumbering its neighbours.
 */
export const LAYER_ORDER = {
  /**
   * The arrangement scene-root stage — the container the screen arrangement
   * paints into. The reference floor that floating chrome must clear.
   */
  stage: 20,
  /**
   * Edge-reveal trigger strips. Above the stage so the cursor can always reach
   * them; below the panel they reveal so the revealed panel covers its trigger.
   */
  edgeHotzone: 9000,
  /**
   * Floating panels that escape their scene-root stacking context (portaled to
   * <body>) and must sit above the stage AND their own hotzone — e.g. an
   * auto-hidden sidebar shown on hover.
   */
  floatingPanel: 9995,
  /**
   * A locked arrangement (screen-arrangement/show/arrangement-lock.tsx): while the arrangement is locked on one
   * screen it fills the window above floating navigation and its edge-reveal strips, so nothing under it can be seen
   * or reached; toasts, dialogs and menus the person opens from it stay above it.
   */
  lockedArrangement: 9997,
  /**
   * Picture-in-picture windows: body-level floating windows the person opened
   * and placed (action panels, detached work). They float above navigation
   * chrome (`floatingPanel`, e.g. the sidebar) because the person put them there
   * to keep in view, but stay below dialogs and menus they can open.
   */
  pictureInPicture: 9998,
  /**
   * Persistent toast stack: above stage content and picture-in-picture, below
   * dialogs and user-opened menus.
   */
  notification: 9999,
  /**
   * Dialogs cover floating navigation while leaving an opened menu above the
   * dialog content. Backdrop and viewport share this layer; DOM order places
   * the viewport after its backdrop.
   */
  dialog: 10_000,
  /**
   * Menus, dropdowns, and their submenu flyouts. Portaled to <body> and must
   * paint above EVERY content layer — including freeform floating windows
   * (whose own `bringToFront` z-counter climbs past any small fixed value) and
   * the drag ghost (10_000). A menu the user opened is, by definition, the
   * topmost interactive surface; anything that can cover it is a click-through
   * bug (incident: surface Mode submenu was unclickable over the canvas layer).
   */
  menu: 10_500,
  /**
   * Guided-overlay walkthroughs — the spotlight scrim, anchored coachmarks, and
   * step progress of an in-product tour. Must paint above EVERYTHING the tour can
   * point at, including open menus (`menu`): a coachmark explaining a dropdown
   * item, or a spotlight dimming the whole app to highlight one control, is by
   * definition the topmost surface while the step is live. Below this, a tour
   * highlighting a menu would be occluded by that menu.
   */
  walkthrough: 11_000,
  /**
   * A step the person must take before going on (choosing a plan, connecting their AI): it covers an in-progress
   * tour until the step is done or left (parts/ui/show/step-overlay).
   */
  stepInFront: 12_000,
} as const

export type LayerName = keyof typeof LAYER_ORDER
