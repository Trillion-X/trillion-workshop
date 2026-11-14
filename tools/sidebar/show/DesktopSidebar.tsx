// packages/sidebar/show/DesktopSidebar.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Desktop sidebar shell supporting all four positions (left/right/top/bottom),
// docked and floating modes, resizable width/height, and the PositionCompass
// widget. Consumes the useSidebarPlacement owner controller for durable
// placement state; live gesture samples stay in browser-local refs until the
// gesture commits.
// Delegates ALL content rendering to SidebarContent.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO local durable placement state — position/dock/mode/width/floatRect
//    come from useSidebarPlacement. Only interaction state and live gesture refs
//    are local.
// 2. THREE MODES ONLY: expanded (locked open), collapsed (icon-only), auto (hover reveal)
// 3. Width bounds: MIN_W (240px) <= width <= MAX_W (520px), COLLAPSED_W = 64px
// 4. Delegates ALL content rendering to SidebarContent
// 5. Glassmorphism: bg-[var(--glass-bg-primary)] base, border-[var(--border-primary)]
// 6. Floating drag/resize: ref-based imperative (zero re-renders during move)
// 7. PositionCompass: one shared menu control, four cardinal choices, current edge marked
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react';
import { dockablePanelSurfaceStyle } from '../../screen-look/show/dockable-panel-style';
import { createPortal } from 'react-dom';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  Grip,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
} from 'lucide-react';
import { NavItem, SidebarContent, type NavSectionData, type NavItemData, type NavRowEvents } from './SidebarContent';
import { controlShown, showChanged, useShowChange } from '../../ui/show/show-rules/show-of';
import { EVERY_POSITION, homeAmong, readPositionChoices } from '../read-data/position-choices';
import { Button, buttonVariants, Icon, Text, Tooltip, Container, PositionCompass, edgeTransform, ControlRailButton, LAYER_ORDER, SplitDividers } from '../../ui';
import type { DockEdge } from '../../ui';
import { fitDockFloatRect } from '../../ui/show/dockable-placement';
import { minUsableContainerWidthPx } from '../../screen-arrangement/show/split-tree-constraints';
import { registerStageInset, unregisterStageInset, updateStageInset } from '../../ui/show/stage-inset';
import { InWindowCorner } from '../../ui/show/floating-occlusion/window-corner';
import {
  useSidebarPlacement,
  selectIsVertical,
  selectIsFloating,
  type SidebarPosition,
  type FloatRect,
  type SidebarPlacementController,
} from './useSidebarPlacement';
import byWidth from '../read-data/sidebar-settings-by-width.json';
import { readSidebarWidthRows, sidebarAllows, sidebarSettingsAtWidth, SIDEBAR_SWITCHES } from '../read-data/sidebar-settings';
import { dockedListFit } from '../read-data/docked-list-fit';
import { DEFAULT_SIDEBAR_PLACEMENT_STATE } from 'trillion-workshop/tools/organize-the-sidebar/read-data/read-sidebar-placement.ts';
import bar from '../read-data/sidebar-bar.json';
import { SidebarBar, SidebarMoveGrip } from './SidebarBar';
import { usePlaceDrag, type PlaceTarget } from './place-drag';
import { claimSeam, useSeamSlot } from '../../ui/show/seam-slots';

// ============================================================================
// CONSTANTS
// ============================================================================

const REVEAL_HOTZONE = 28;
const MIN_W = 180;
const MAX_W = 520;
const COLLAPSED_W = 64;
// The window's sidebar collapses to its thin bar (read-data/sidebar-bar.json), on an edge or on a seam.
const BAR_W = bar.thickness_px;
// The folded handle: one round button, kept this far inside the window wherever it was put.
const HANDLE_W = 44;
const HANDLE_MARGIN = 8;
const MIN_FLOAT = 200;
const HORIZ_H = 48;
// Stacking layers come from the shared SSOT (`ui` LAYER_ORDER) — no bare z-index
// magic numbers. The revealed auto-hide panel is `floatingPanel` (above the
// arrangement stage AND its own reveal hotzone, which is `edgeHotzone`).
const FLOAT_Z = LAYER_ORDER.floatingPanel;
const HOTZONE_Z = LAYER_ORDER.edgeHotzone;
// What the window's sidebar offers at each width is DATA (sidebar-settings-by-width.json).
const WIDTH_ROWS = readSidebarWidthRows(byWidth.rows);

/** The window's size, kept current as it resizes; null where it does not apply (a contained sidebar measures its container). */
function useWindowSize(applies: boolean): { width: number; height: number } | null {
  const read = () => (applies && typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight } : null);
  const [size, setSize] = React.useState(read);
  React.useEffect(() => {
    if (!applies || typeof window === 'undefined') return;
    const update = () => setSize((current) => (current && current.width === window.innerWidth && current.height === window.innerHeight
      ? current
      : { width: window.innerWidth, height: window.innerHeight }));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [applies]);
  return size;
}

const DOCKED_FRAME_INSET = 8;
// A docked frame keeps the same gap from the window's edges on every side, and rounds its corners as the panes beside
// it do (their glass surface's card radius), so it reads as one of the window's pieces.
const DOCKED_FRAME_RADIUS = 'var(--radius-card, 1rem)';

// A window-level frame is portalled into document.body, outside the workspace's safe box, so it keeps its gap from
// the window's edge PLUS that edge's safe area (status bar, notch, home indicator; 0 everywhere else). The top and
// bottom also follow the visible area (bind-visible-viewport), as the workspace does: while a keyboard is up the bottom
// sits above the keyboard and its typing bar, and the home indicator's safe area under the keyboard no longer counts.
type WindowEdge = 'top' | 'bottom' | 'left' | 'right';
function windowEdgeInset(edge: WindowEdge, gap: number): string {
  if (edge === 'top') return `calc(var(--visible-viewport-top, 0px) + env(safe-area-inset-top) + ${gap}px)`;
  if (edge === 'bottom') {
    return `calc(var(--visible-viewport-bottom, 0px) + env(safe-area-inset-bottom) * (1 - var(--visible-viewport-keyboard, 0)) + ${gap}px)`;
  }
  return `calc(env(safe-area-inset-${edge}) + ${gap}px)`;
}

function clampSidebarSize(value: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, value));
}

/** Suppress new selection only while a sidebar pointer gesture is active. */
export function suppressGestureTextSelection(doc: Pick<Document, 'body'>) {
  const body = doc.body;
  const previousUserSelect = body.style.userSelect;
  body.style.userSelect = 'none';
  return () => {
    // Restore the exact pre-gesture value, including an intentional app style.
    body.style.userSelect = previousUserSelect;
  };
}

// ============================================================================
// TYPES
// ============================================================================

export interface DesktopSidebarProps {
  sceneMountToken?: string;
  capabilities?: { position?: boolean; collapse?: boolean; undock?: boolean; hide?: boolean; resize?: boolean };
  /** The control path this frame's own controls sit under (`sidebar` for the window's sidebar): each capability is
   *  the control `<controls>.<capability>`, which the person's show rules can hide (show-of.ts controlShown). */
  controls?: string;
  /** Where this frame sits when a show rule hides its position control (`<controls>.position`): one place only, so the
   *  control is not drawn and a position saved earlier does not move it elsewhere. Left for the window's sidebar. */
  homePosition?: SidebarPosition;
  ariaLabel?: string;
  /** Lets a contained frame contribute to its stage. Detached frames always contribute to the shared app stage. */
  manageStageInset?: boolean;
  sections: NavSectionData[];
  footerItems: NavItemData[];
  currentSelectionId: string;
  onNavigate: (viewId: string) => void;
  onCollectionsChanged?: () => void | Promise<void>;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  headerContent?: React.ReactNode;
  emptyContent?: React.ReactNode;
  headerItems?: NavItemData[];
  /** Screens shown among the window controls as an icon with their live badge (surface DATA `sidebar_place: "controls"`). */
  controlItems?: NavItemData[];
  onItemAction?: (item: NavItemData, actionId: string) => void;
  /** Caller content drawn before the rows (for example back and forward). */
  leadingContent?: React.ReactNode;
  /** Caller content drawn after the rows (for example a + and the owner's own controls). */
  trailingContent?: React.ReactNode;
  /** Drag, drop and warm events from rows that are not screens (a pane's tabs). */
  rowEvents?: NavRowEvents;
  /**
   * Docked inside a container, the frame takes its own place in the container's layout, beside or above the work,
   * and paints nothing of its own: it is part of the container's surface (a pane's tab bar). Hidden until pointed at
   * and popped out, it floats over the container as every frame does.
   */
  inFlow?: boolean;
  /** The host draws this frame's own controls (position, collapse, pop out, hide) in its own menu, so the frame draws none. */
  hostControls?: boolean;
}

// ============================================================================
// DOCKED RESIZE HANDLE
// ============================================================================

function ResizeHandle({
  thing,
  isLeft,
  isVertical,
  value,
  onResizeStart,
  onResize,
  onResizeEnd,
  onResizeStep,
}: {
  /** What the frame holds in words ('sidebar', 'tabs'), for the handle's name. */
  thing: string;
  isLeft: boolean;
  isVertical: boolean;
  value: number;
  onResizeStart: () => void;
  onResize: (value: number) => void;
  onResizeEnd: (value: number) => void;
  onResizeStep: (direction: 'decrease' | 'increase' | 'minimum' | 'maximum' | 'reset') => void;
}) {
  const startSize = React.useRef(value);
  const liveSize = React.useRef(value);
  const growDirection = isVertical ? (isLeft ? 1 : -1) : (isLeft ? 1 : -1);
  const resizeStep = (direction: 'decrease' | 'increase' | 'minimum' | 'maximum' | 'reset') => {
    if (growDirection > 0 || (direction !== 'decrease' && direction !== 'increase')) {
      onResizeStep(direction);
      return;
    }
    onResizeStep(direction === 'decrease' ? 'increase' : 'decrease');
  };

  // The hit target sits across the narrow seam between the visible sidebar
  // frame and the first arrangement pane. The rail itself stays quiet until
  // the seam is hovered or a keyboard user focuses the separator.
  // SplitDividers owns pointer tracking, keyboard input, bounds announcements,
  // and the quiet hover-revealed rail used by screen arrangement as well.
  // The reveal group is THIS seam wrapper, never the sidebar frame: a frame-wide
  // group would also reveal every row's HoverRevealItem inside the sidebar.
  return (
    <div
      className="group/hover-reveal"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
      }}
    >
      <SplitDividers
        axis={isVertical ? 'x' : 'y'}
        revealed={false}
        label={`Resize ${thing}`}
        value={{ now: value, min: MIN_W, max: MAX_W }}
        dividers={[{
          leftIndex: 0,
          rightIndex: 1,
          // The frame edge aligns with the arrangement's outer edge. Its first
          // pane has an 8px inset, so center the 12px hit target halfway across
          // that seam (4px beyond the frame for left/top, inward for right/bottom).
          left: isVertical ? (isLeft ? 'calc(100% - 2px)' : -10) : 0,
          top: isVertical ? 0 : (isLeft ? HORIZ_H - 2 : -10),
          width: isVertical ? 12 : '100%',
          height: isVertical ? '100%' : 12,
        }]}
        onResizeStart={() => {
          startSize.current = value;
          liveSize.current = value;
          onResizeStart();
        }}
        onResize={(_left, _right, deltaPx) => {
          const next = Math.max(MIN_W, Math.min(MAX_W, Math.round(startSize.current + deltaPx * growDirection)));
          liveSize.current = next;
          onResize(next);
        }}
        onResizeEnd={() => onResizeEnd(liveSize.current)}
        onResizeStep={resizeStep}
      />
    </div>
  );
}

// ============================================================================
// POSITION COMPASS — generic ui dockable-placement primitive (extracted from
// this file; the sidebar now shares it with every dockable consumer).
// ============================================================================

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function DesktopSidebar(props: DesktopSidebarProps) {
  const placement = useSidebarPlacement();
  return <SidebarFrame {...props} placement={placement} />;
}

export function SidebarFrame({
  placement,
  sceneMountToken,
  containerRef,
  capabilities,
  controls = 'sidebar',
  homePosition = DEFAULT_SIDEBAR_PLACEMENT_STATE.position,
  ariaLabel = 'Sidebar',
  sections,
  footerItems,
  currentSelectionId,
  onNavigate,
  onCollectionsChanged,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchAriaLabel,
  headerContent,
  emptyContent,
  headerItems,
  controlItems: controlScreens,
  onItemAction,
  leadingContent,
  trailingContent,
  rowEvents,
  inFlow = false,
  hostControls = false,
  manageStageInset = true,
}: DesktopSidebarProps & { placement: SidebarPlacementController; containerRef?: React.RefObject<HTMLElement | null> }) {
  // A contained sidebar follows the capabilities its host gives it; the window's
  // sidebar also follows the width rows for the window's current width.
  const contained = containerRef !== undefined;
  // What this frame holds, in the words its controls use ('Show sidebar', 'Show tabs').
  const thing = ariaLabel.toLowerCase();
  const windowSize = useWindowSize(!contained);
  const [containerBounds, setContainerBounds] = React.useState<{ width: number; height: number } | null>(null);
  React.useEffect(() => {
    const owner = containerRef?.current;
    if (!owner) return;
    const measure = () => setContainerBounds({ width: owner.clientWidth, height: owner.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(owner);
    return () => observer.disconnect();
  }, [containerRef]);
  const windowWidth = windowSize?.width;
  const widthSettings = React.useMemo(() => (windowWidth === undefined ? {} : sidebarSettingsAtWidth(WIDTH_ROWS, windowWidth)), [windowWidth]);
  // A capability is offered when the host gives it, the width allows it and no show rule hides its control.
  useShowChange();
  // Where the frame may sit: a rule of the frame's own subject (`controls`) that changes `position_choices` limits it
  // (../read-data/position-choices.ts); with one place left, or its position control hidden, it sits there and the
  // control is not drawn.
  const positionChoices = readPositionChoices(showChanged(controls, { position_choices: EVERY_POSITION }).position_choices);
  const positionLimited = positionChoices.length < EVERY_POSITION.length;
  const positionFixed = !controlShown(`${controls}.position`) || positionChoices.length === 1;
  const home = homeAmong(homePosition, positionChoices);
  const allows = (key: keyof NonNullable<DesktopSidebarProps['capabilities']>) =>
    (capabilities === undefined || capabilities[key] === true) && sidebarAllows(widthSettings, key) && controlShown(`${controls}.${key}`)
    && !(key === 'position' && positionFixed);
  // The grip (and the floating panel's handle) that moves the frame anywhere: the control `<controls>.move`, drawn
  // only where the frame may be placed at all.
  const movable = allows('position') && controlShown(`${controls}.move`);
  // Docked left or right, the list is measured against the work beside it: when opening it would leave the work
  // narrower than a usable pane, it floats over the work instead (open or collapsed then lives on this screen only,
  // it starts collapsed and closes after a screen is chosen); when even its rail would, only a button that opens it
  // shows. A measurement, never a device or a width: a phone and a narrow desktop window get the same answer.
  // The window's sidebar collapses to the thin bar; a sidebar held in a container keeps its icon rail.
  const windowRail = !contained;
  const collapsedSize = windowRail ? BAR_W : COLLAPSED_W;
  const railSize = collapsedSize + (contained ? 0 : DOCKED_FRAME_INSET);
  // Folded to its handle, or sitting on a seam between two panes, the window's sidebar takes no edge of the window and
  // opens its list over the work (ui/show/seam-slots: the seam's slot is laid by the arrangement, and the bar draws in it).
  const folded = windowRail && placement.mode === 'folded';
  // Positioned by a rule to one place only, the frame sits at its home and never on a seam or another edge; limited to
  // some places, never on a seam.
  const wantedSeam = windowRail && !folded && !positionFixed && !positionLimited ? placement.seam : undefined;
  const seamSlot = useSeamSlot(wantedSeam);
  const seamOwner = React.useRef(Symbol('sidebar-seam')).current;
  React.useLayoutEffect(() => {
    claimSeam(seamOwner, wantedSeam ? { seam: wantedSeam, thickness: BAR_W } : undefined);
  }, [seamOwner, wantedSeam?.split.join('.'), wantedSeam?.after]);
  React.useEffect(() => () => claimSeam(seamOwner, undefined), [seamOwner]);
  const onSeam = seamSlot !== null;
  const placedAt = positionFixed || !positionChoices.includes(placement.position) ? home : placement.position;
  const sideDocked = (placedAt === 'left' || placedAt === 'right')
    && !(allows('undock') && placement.dockState === 'floating');
  const fit = dockedListFit({
    room: sideDocked ? (contained ? containerBounds?.width : windowWidth) : undefined,
    openSize: placement.width,
    railSize,
    workMinimum: minUsableContainerWidthPx(),
  });
  // Collapsed on an edge it is only its handle when even its bar would leave the work too narrow, or when a width row
  // turns the bar on an edge off (`rail`).
  const edgeHandle = windowRail && ((fit.open === 'over' && fit.closed === 'button') || !sidebarAllows(widthSettings, SIDEBAR_SWITCHES.rail));
  const overWork = fit.open === 'over' || folded || onSeam;
  // A sidebar held in a container always draws its icon rail when closed, so it keeps the rail's room even when that
  // leaves the work narrower than a usable pane: reserving nothing drew the rail over the page (Write at 390, 2026-10-03).
  const overWorkReserve = (fit.closed === 'rail' || contained) && !edgeHandle && !folded && !onSeam ? railSize : 0;
  const stayOpen = sidebarAllows(widthSettings, SIDEBAR_SWITCHES.stayOpen) && !overWork;
  // ------------------------------------------------------------------
  // STORE — SSOT for all placement state
  // ------------------------------------------------------------------
  const {
    position: savedPosition,
    dockState: savedDockState,
    mode: savedMode,
    width,
    floatRect: savedFloatRect,
    setPosition,
    setDockState,
    setMode: saveMode,
    setWidth,
    setFloatRect,
  } = placement;
  // With stay_open off, open or collapsed lives on this screen only and starts collapsed.
  const [openHere, setOpenHere] = React.useState(false);
  const position = positionFixed || !positionChoices.includes(savedPosition) ? home : savedPosition;
  const dockState = allows('undock') ? savedDockState : 'docked';
  const mode = !stayOpen ? (openHere ? 'expanded' : 'collapsed')
    : (savedMode === 'auto' && !allows('hide')) || (savedMode === 'collapsed' && !allows('collapse')) ? 'expanded' : savedMode;
  const setMode = (next: typeof savedMode) => {
    if (!stayOpen) setOpenHere(next === 'expanded');
    else saveMode(next);
  };
  const floatRect = contained && containerBounds ? fitDockFloatRect(savedFloatRect, containerBounds) : savedFloatRect;
  const positioning = contained ? 'absolute' : 'fixed';
  const bounds = () => ({ width: containerRef?.current?.clientWidth ?? window.innerWidth, height: containerRef?.current?.clientHeight ?? window.innerHeight });
  const isVertical = selectIsVertical({ position, dockState, mode, width, floatRect });
  const isFloating = selectIsFloating({ position, dockState, mode, width, floatRect });

  // ------------------------------------------------------------------
  // LOCAL UI INTERACTION STATE (not persisted)
  // ------------------------------------------------------------------
  const [hoverSide, setHoverSide] = React.useState<SidebarPosition | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [insideAside, setInsideAside] = React.useState(false);
  const sidebarFrameRef = React.useRef<HTMLElement | null>(null);
  // The open-the-list button floats over the window's bottom edge, so it publishes the band it covers and a box pinned
  // at the bottom of the screen (the message box) lifts above it (parts/ui/show/floating-occlusion).
  const restoreDockResizeStylesRef = React.useRef<(() => void) | null>(null);
  const beginDockResize = (cursor: 'col-resize' | 'row-resize') => {
    restoreDockResizeStylesRef.current?.();
    const body = document.body;
    const previousCursor = body.style.cursor;
    const restoreSelection = suppressGestureTextSelection(document);
    body.style.cursor = cursor;
    restoreDockResizeStylesRef.current = () => {
      restoreSelection();
      body.style.cursor = previousCursor;
      restoreDockResizeStylesRef.current = null;
    };
    setDragging(true);
  };
  const endDockResize = () => {
    restoreDockResizeStylesRef.current?.();
    setDragging(false);
  };
  React.useEffect(() => () => restoreDockResizeStylesRef.current?.(), []);

  // ------------------------------------------------------------------
  // DERIVED
  // ------------------------------------------------------------------
  // Open over the work from a top or bottom place (folded, or on a seam), the list comes in from the left.
  const isLeft = position !== 'right';
  const isTop = position === 'top';
  const isCollapsed = mode === 'collapsed';
  const isAuto = mode === 'auto';
  const isExpanded = mode === 'expanded';
  const autoOpen = isAuto && (dragging || !!hoverSide || insideAside);
  const showLabels = isExpanded || (isAuto && autoOpen);

  // "width" is the sidebar's size on its primary axis (width for vertical, height for horizontal).
  // Auto mode keeps its FULL size and slides off-screen via `autoHideTransform`
  // (U2: truly off the screen + hotzone reveal), rather than shrinking to a rail.
  const currentSize = isCollapsed ? collapsedSize : stayOpen ? width : Math.min(width, window.innerWidth);

  // U2 — off-screen slide for auto mode. Position is the docked edge; when not
  // open the panel translates fully out, when open it returns to identity. The
  // hotzone sensors (`autoSensors`) reveal it. Floating mode never auto-hides.
  const autoHideTransform = isAuto && !isFloating ? edgeTransform(position as DockEdge, autoOpen) : undefined;

  // Each independently movable sidebar contributes only its own reserved edge
  // space. The shared owner sums contributions so nested detached groups never
  // erase the root sidebar's inset (or each other's). Floating and auto-hidden
  // frames register zero; pointer resizing updates the CSS value on each sample.
  const stageInsetId = React.useRef(Symbol('sidebar-stage-inset')).current;
  // A frame in its container's flow takes its room by layout, so it reserves no stage edge.
  const stageInsetOwner = inFlow ? null : !contained || manageStageInset
    ? (contained ? containerRef?.current ?? null : (typeof document !== 'undefined' ? document.documentElement : null))
    : null;
  React.useLayoutEffect(() => {
    if (!stageInsetOwner) return;
    registerStageInset(stageInsetOwner, stageInsetId);
    return () => unregisterStageInset(stageInsetOwner, stageInsetId);
  }, [stageInsetOwner, stageInsetId]);
  React.useLayoutEffect(() => {
    if (!stageInsetOwner) return;
    // Auto mode reserves ZERO stage space. It slides fully off-screen and
    // overlays on reveal, so the app reclaims the full width when hidden (U2).
    const requestedSize = isVertical ? currentSize : windowRail && isCollapsed ? BAR_W : HORIZ_H;
    const reservedSize = isFloating || isAuto ? 0 : overWork ? overWorkReserve : contained
      ? Math.min(requestedSize, isVertical ? stageInsetOwner.clientWidth : stageInsetOwner.clientHeight)
      // Expanded frames end at `width` (they start at the inset and shrink by it);
      // collapsed frames keep their full rail width, so reserve the leading inset
      // too. Either way the frame's trailing edge is the stage edge, and the
      // arrangement's own pane inset supplies the same visible gap in both modes.
      : requestedSize + (!isVertical || isCollapsed ? DOCKED_FRAME_INSET : 0);
    updateStageInset(stageInsetOwner, stageInsetId, {
      position,
      size: reservedSize,
      dragging,
    });
  }, [currentSize, dragging, isAuto, isFloating, isVertical, position, contained, containerBounds, overWork, overWorkReserve, stageInsetOwner, stageInsetId]);

  // The shared SplitDividers primitive owns docked pointer and keyboard input.
  // This ref carries only its last live sample to the one durable commit.

  // ------------------------------------------------------------------
  // FLOATING MODE — ref-based imperative drag/resize (zero re-renders during move)
  // ------------------------------------------------------------------
  type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
  type LiveRect = { x: number; y: number; w: number; h: number };

  const activeOp = React.useRef<{ kind: 'drag' | 'resize'; edge?: ResizeEdge } | null>(null);
  const restoreTextSelectionRef = React.useRef<(() => void) | null>(null);
  const startRef = React.useRef<{ x: number; y: number; base: LiveRect } | null>(null);
  const liveRect = React.useRef<LiveRect>({
    x: floatRect.x,
    y: floatRect.y,
    w: (isFloating && isCollapsed) ? COLLAPSED_W : floatRect.w,
    h: floatRect.h,
  });

  // Sync liveRect from owner state when NOT actively dragging
  if (!activeOp.current) {
    liveRect.current = {
      x: floatRect.x,
      y: floatRect.y,
      w: (isFloating && isCollapsed) ? COLLAPSED_W : floatRect.w,
      h: floatRect.h,
    };
  }

  const applyToDOM = (rect: LiveRect) => {
    const el = sidebarFrameRef.current;
    if (!el) return;
    if (contained) {
      const area = bounds();
      rect.w = Math.min(Math.max(0, rect.w), area.width);
      rect.h = Math.min(Math.max(0, rect.h), area.height);
      rect.x = Math.max(0, Math.min(rect.x, area.width - rect.w));
      rect.y = Math.max(0, Math.min(rect.y, area.height - rect.h));
    }
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
  };

  const applyFloatResizeDelta = (edge: ResizeEdge, dx: number, dy: number) => {
    if (!startRef.current) return;
    const { base } = startRef.current;
    let { x, y, w, h } = base;
    const minFloatW = isCollapsed ? COLLAPSED_W : MIN_FLOAT;
    if (edge.includes('e')) w = Math.max(minFloatW, base.w + dx);
    if (edge.includes('s')) h = Math.max(MIN_FLOAT, base.h + dy);
    if (edge.includes('w')) { w = Math.max(minFloatW, base.w - dx); x = base.x + (base.w - w); }
    if (edge.includes('n')) { h = Math.max(MIN_FLOAT, base.h - dy); y = base.y + (base.h - h); }

    const rect: LiveRect = { x, y, w, h };
    liveRect.current = rect;
    applyToDOM(rect);
  };

  const onFloatPointerMove = (e: PointerEvent) => {
    if (!startRef.current || !activeOp.current) return;
    if (e.buttons === 0) { onFloatPointerUp(); return; }

    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;

    if (activeOp.current.kind === 'drag') {
      const rect: LiveRect = {
        x: startRef.current.base.x + dx,
        y: startRef.current.base.y + dy,
        w: startRef.current.base.w,
        h: startRef.current.base.h,
      };
      liveRect.current = rect;
      applyToDOM(rect);
      return;
    }

    if (activeOp.current.kind === 'resize' && activeOp.current.edge) {
      applyFloatResizeDelta(activeOp.current.edge, dx, dy);
    }
  };

  const onFloatPointerUp = () => {
    const op = activeOp.current;
    activeOp.current = null;
    startRef.current = null;
    if (sidebarFrameRef.current) sidebarFrameRef.current.style.transition = 'width 180ms ease-out';
    unbindFloatListeners();
    restoreTextSelectionRef.current?.();
    restoreTextSelectionRef.current = null;

    if (!op) return;

    const r = liveRect.current;
    // Edge snapping: keep at least 12px visible
    const { width: vw, height: vh } = bounds();
    const peek = 12;
    if (contained) {
      r.w = Math.min(r.w, vw); r.h = Math.min(r.h, vh);
      r.x = Math.min(Math.max(r.x, 0), Math.max(0, vw - r.w));
      r.y = Math.min(Math.max(r.y, 0), Math.max(0, vh - r.h));
    } else {
      r.x = Math.min(Math.max(r.x, -(r.w - peek)), vw - peek);
      r.y = Math.min(Math.max(r.y, -(r.h - peek)), vh - peek);
    }

    setFloatRect({ x: r.x, y: r.y, w: r.w, h: r.h });
  };

  const onFloatPointerMoveRef = React.useRef(onFloatPointerMove);
  onFloatPointerMoveRef.current = onFloatPointerMove;
  const onFloatPointerUpRef = React.useRef(onFloatPointerUp);
  onFloatPointerUpRef.current = onFloatPointerUp;

  const floatListenersRef = React.useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);

  const bindFloatListeners = () => {
    if (floatListenersRef.current) return;
    const move = (e: PointerEvent) => onFloatPointerMoveRef.current(e);
    const up = () => onFloatPointerUpRef.current();
    floatListenersRef.current = { move, up };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
  };

  const unbindFloatListeners = () => {
    if (!floatListenersRef.current) return;
    const { move, up } = floatListenersRef.current;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    window.removeEventListener('blur', up);
    floatListenersRef.current = null;
  };

  React.useEffect(() => () => {
    unbindFloatListeners();
    restoreTextSelectionRef.current?.();
    restoreTextSelectionRef.current = null;
  }, []);

  const beginFloatGesture = () => {
    restoreTextSelectionRef.current?.();
    restoreTextSelectionRef.current = suppressGestureTextSelection(document);
  };

  const startFloatDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    beginFloatGesture();
    activeOp.current = { kind: 'drag' };
    startRef.current = { x: e.clientX, y: e.clientY, base: { ...liveRect.current } };
    if (sidebarFrameRef.current) sidebarFrameRef.current.style.transition = 'none';
    bindFloatListeners();
  };

  const startFloatResize = (edge: ResizeEdge, e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    beginFloatGesture();
    activeOp.current = { kind: 'resize', edge };
    startRef.current = { x: e.clientX, y: e.clientY, base: { ...liveRect.current } };
    if (sidebarFrameRef.current) sidebarFrameRef.current.style.transition = 'none';
    bindFloatListeners();
  };

  const startFloatResizeFromDivider = (edge: ResizeEdge) => {
    beginFloatGesture();
    activeOp.current = { kind: 'resize', edge };
    startRef.current = { x: 0, y: 0, base: { ...liveRect.current } };
    if (sidebarFrameRef.current) sidebarFrameRef.current.style.transition = 'none';
  };

  const resizeFloatByKeyboard = (edge: ResizeEdge, direction: 'decrease' | 'increase' | 'minimum' | 'maximum' | 'reset') => {
    const rect = { ...liveRect.current };
    const isWidth = edge === 'e' || edge === 'w';
    const reverse = edge === 'w' || edge === 'n';
    const normalized = reverse
      ? direction === 'decrease' ? 'increase' : direction === 'increase' ? 'decrease' : direction
      : direction;
    const limits = bounds();
    const minimum = isWidth ? (isCollapsed ? COLLAPSED_W : MIN_FLOAT) : MIN_FLOAT;
    const maximum = Math.max(minimum, isWidth ? limits.width : limits.height);
    const current = isWidth ? rect.w : rect.h;
    const next = normalized === 'minimum' ? minimum
      : normalized === 'maximum' ? maximum
        : normalized === 'reset' ? Math.min(maximum, Math.max(minimum, 280))
          : Math.min(maximum, Math.max(minimum, current + (normalized === 'increase' ? 16 : -16)));
    if (isWidth) {
      if (edge === 'w') rect.x += rect.w - next;
      rect.w = next;
    } else {
      if (edge === 'n') rect.y += rect.h - next;
      rect.h = next;
    }
    const { width, height } = limits;
    if (contained) {
      rect.w = Math.min(rect.w, width); rect.h = Math.min(rect.h, height);
      rect.x = Math.max(0, Math.min(rect.x, width - rect.w));
      rect.y = Math.max(0, Math.min(rect.y, height - rect.h));
    } else {
      rect.x = Math.min(Math.max(rect.x, -(rect.w - 12)), width - 12);
      rect.y = Math.min(Math.max(rect.y, -(rect.h - 12)), height - 12);
    }
    liveRect.current = rect;
    applyToDOM(rect);
    setFloatRect(rect);
  };

  // ------------------------------------------------------------------
  // UNDOCK HANDLER — compute initial float position from current position
  // ------------------------------------------------------------------
  const handleUndock = () => {
    const { width: vw, height: vh } = bounds();
    let initialRect: FloatRect;

    if (position === 'left') {
      initialRect = { x: 16, y: 16, w: width, h: vh - 32 };
    } else if (position === 'right') {
      initialRect = { x: vw - width - 16, y: 16, w: width, h: vh - 32 };
    } else if (position === 'top') {
      initialRect = { x: 16, y: 16, w: vw - 32, h: width };
    } else {
      initialRect = { x: 16, y: vh - width - 16, w: vw - 32, h: width };
    }

    if (contained) {
      initialRect.w = Math.min(Math.max(0, initialRect.w), vw);
      initialRect.h = Math.min(Math.max(0, initialRect.h), vh);
      initialRect.x = Math.max(0, Math.min(initialRect.x, vw - initialRect.w));
      initialRect.y = Math.max(0, Math.min(initialRect.y, vh - initialRect.h));
    }
    setFloatRect(initialRect);
    setDockState('floating');
  };

  const handleToggleCollapse = React.useCallback(() => {
    if (isCollapsed) {
      setMode('expanded');
      if (isFloating && floatRect.w < MIN_W) {
        setFloatRect({ ...floatRect, w: MIN_W });
      }
      return;
    }
    setMode('collapsed');
  }, [isCollapsed, isFloating, floatRect, setMode, setFloatRect]);

  // ------------------------------------------------------------------
  // SIDEBAR CONTROL ITEMS — rendered as regular nav items
  // Order: 1) Position (compass), 2) Collapse/Expand, 3) Dock/Undock.
  // Screen-arrangement controls such as surface mode and layout presets do not
  // live here; sidebar owns only sidebar placement.
  // ------------------------------------------------------------------
  const dockLabel = isFloating ? 'Dock' : 'Undock';
  const dockIcon = isFloating ? Pin : PinOff;
  // An open vertical rail keeps its window controls as one compact row of icons
  // in its header, always visible: controls that appear only on hover read as missing.
  // More controls than the rail is wide (a screen kept among the controls, such as Your devices) wrap to a second row
  // inside the rail instead of running out over the work.
  // A list open over the work (from a seam bar, a folded handle or a too-narrow edge) is always a column, wherever the
  // sidebar sits: drawn across, its controls ran past the list's edge in one row.
  const listVertical = isVertical || (overWork && isExpanded);
  const compactControls = stayOpen && !isCollapsed && (listVertical || isFloating);
  const controlLabels = showLabels && !compactControls;
  const useVerticalControlLayout = (listVertical || isFloating) && !compactControls;
  // Collapsed controls use the same full-width icon card as collapsed navigation rows.
  const iconOnlyControlClass = isCollapsed && useVerticalControlLayout ? ' w-full justify-center' : useVerticalControlLayout ? ' w-full' : ' flex-shrink-0 whitespace-nowrap';
  const windowControls = (
    <Container
      layout={useVerticalControlLayout ? 'vertical' : 'horizontal'}
      gap="xs"
      alignItems={useVerticalControlLayout ? undefined : 'center'}
      data-sidebar-window-controls={compactControls ? 'compact' : 'shown'}
      className={[
        compactControls
          ? 'px-2 pt-1 flex-shrink-0 flex-wrap'
          : useVerticalControlLayout ? 'p-2' : 'h-full pl-2 pr-1 flex-shrink-0',
      ].filter(Boolean).join(' ')}
    >
      {/* Position compass */}
      {allows('position') && (controlLabels ? (
        <Container
          role="group"
          aria-label="Position"
          layout="horizontal"
          alignItems="center"
          className={`${buttonVariants({ variant: 'ghost' })} gap-3 px-3 h-9 min-h-0${useVerticalControlLayout ? ' w-full' : ' flex-shrink-0 whitespace-nowrap'}`}
        >
          <PositionCompass current={position} onSelect={setPosition} choices={positionChoices} />
          <Text className="truncate flex-1 text-left">Position</Text>
        </Container>
      ) : (
        <Tooltip label="Position">
          <Container
            role="group"
            aria-label="Position"
            layout="horizontal"
            alignItems="center"
            className={`${buttonVariants({ variant: 'ghost' })} gap-3 px-3 h-9 min-h-0${iconOnlyControlClass}`}
          >
            <PositionCompass current={position} onSelect={setPosition} choices={positionChoices} />
          </Container>
        </Tooltip>
      ))}

      {/* Collapse / Expand */}
      {allows('collapse') && (controlLabels ? (
        <Button
          variant="ghost"
          onClick={handleToggleCollapse}
          className={`gap-3 px-3 h-9 min-h-0${useVerticalControlLayout ? ' w-full' : ' flex-shrink-0 whitespace-nowrap'}`}
        >
          <Icon icon={isCollapsed ? ChevronRight : ChevronLeft} size="lg" className="flex-shrink-0" />
          <Text className="truncate flex-1 text-left">{isCollapsed ? 'Expand' : 'Collapse'}</Text>
        </Button>
      ) : (
        <Tooltip label={isCollapsed ? 'Expand' : 'Collapse'}>
          <Button
            variant="ghost"
            onClick={handleToggleCollapse}
            aria-label={isCollapsed ? 'Expand' : 'Collapse'}
            className={`gap-3 px-3 h-9 min-h-0${iconOnlyControlClass}`}
          >
            <Icon icon={isCollapsed ? ChevronRight : ChevronLeft} size="lg" className="flex-shrink-0" />
          </Button>
        </Tooltip>
      ))}

      {/* Dock / Undock */}
      {allows('undock') && (controlLabels ? (
        <Button
          variant="ghost"
          onClick={isFloating ? () => setDockState('docked') : handleUndock}
          className={`gap-3 px-3 h-9 min-h-0${useVerticalControlLayout ? ' w-full' : ' flex-shrink-0 whitespace-nowrap'}`}
        >
          <Icon icon={dockIcon} size="lg" className="flex-shrink-0" />
          <Text className="truncate flex-1 text-left">{dockLabel}</Text>
        </Button>
      ) : (
        <Tooltip label={dockLabel}>
          <Button
            variant="ghost"
            onClick={isFloating ? () => setDockState('docked') : handleUndock}
            aria-label={dockLabel}
            className={`gap-3 px-3 h-9 min-h-0${iconOnlyControlClass}`}
          >
            <Icon icon={dockIcon} size="lg" className="flex-shrink-0" />
          </Button>
        </Tooltip>
      ))}
      {/* Auto-hide — toggles `auto` mode: the sidebar slides fully off the docked
          edge and reappears when the pointer enters the edge hotzone (U2). Built
          on the shared ControlRailButton molecule (L065-clean, no feature-code css). */}
      {!isFloating && allows('hide') && (
        <ControlRailButton
          icon={isAuto ? PanelLeftOpen : PanelLeftClose}
          label={isAuto ? 'Show' : 'Hide'}
          showLabel={controlLabels}
          vertical={useVerticalControlLayout}
          onClick={() => setMode(isAuto ? 'expanded' : 'auto')}
        />
      )}
      {/* Screens the DATA places among the controls (a notification bell): after the controls that place the sidebar,
          as a row of its own with its name where the controls show theirs, its icon, badge and preview. */}
      {controlScreens?.map((item) => (
        <Container key={item.id} className={useVerticalControlLayout ? 'w-full' : 'w-11 flex-shrink-0'} data-sidebar-control={item.id}>
          <NavItem item={item} isActive={false} showLabel={controlLabels} onClick={() => onNavigate(item.viewId ?? item.id)} />
        </Container>
      ))}
    </Container>
  );

  // ------------------------------------------------------------------
  // MOVING IT — the bar's grip and the folded handle drag it onto an edge, a seam between two panes, or anywhere
  // (where it folds to its handle). show/place-drag.tsx lights up the places as it is dragged.
  // ------------------------------------------------------------------
  const placeOn = (target: PlaceTarget) => placement.placeAt(target.kind === 'edge' ? { position: target.position } : { seam: target.seam });
  const moveDrag = usePlaceDrag({ onPlace: placeOn, onFold: (point) => placement.foldAt(point) });
  const unfoldOrOpen = () => setMode('expanded');

  // The thin bar's own controls, in its More popover: where it sits, folding it away, its names, hiding it.
  const barControls = (
    <Container layout="vertical" gap="xs" data-sidebar-bar-window-controls="">
      {allows('position') && (
        <Container role="group" aria-label="Position" layout="horizontal" alignItems="center"
          className={`${buttonVariants({ variant: 'ghost' })} gap-3 px-3 h-9 min-h-0 w-full`}>
          <PositionCompass current={position} onSelect={(next) => placement.placeAt({ position: next })} choices={positionChoices} />
          <Text className="truncate flex-1 text-left">{onSeam ? 'Move to an edge' : 'Position'}</Text>
        </Container>
      )}
      {allows('collapse') && (
        <Button variant="ghost" onClick={() => placement.foldAt()} className="w-full justify-start gap-3 px-3 h-9 min-h-0">
          <Icon icon={ChevronsDownUp} size="lg" className="flex-shrink-0" />
          <Text className="truncate flex-1 text-left">Fold away</Text>
        </Button>
      )}
      {allows('undock') && (
        <Button variant="ghost" onClick={handleUndock} className="w-full justify-start gap-3 px-3 h-9 min-h-0">
          <Icon icon={PinOff} size="lg" className="flex-shrink-0" />
          <Text className="truncate flex-1 text-left">Undock</Text>
        </Button>
      )}
      {!onSeam && allows('hide') && (
        <ControlRailButton icon={PanelLeftClose} label="Hide" showLabel vertical onClick={() => setMode('auto')} />
      )}
    </Container>
  );
  const drawBar = (axis: 'vertical' | 'horizontal') => (
    <SidebarBar
      axis={axis}
      sections={sections}
      pinned={[...(controlScreens ?? []), ...footerItems]}
      currentSelectionId={currentSelectionId}
      onNavigate={onNavigate}
      onCollectionsChanged={onCollectionsChanged}
      onItemAction={onItemAction}
      fit={placement.fit}
      onFitChange={(next) => placement.setFit(next)}
      controls={barControls}
      onGripPointerDown={movable ? moveDrag.onPointerDown : undefined}
      onExpand={allows('collapse') ? unfoldOrOpen : undefined}
      thing={thing}
    />
  );

  // ------------------------------------------------------------------
  // FOLDED — one handle wherever the person put it (or the docked side's bottom corner); a tap opens the list over the
  // work. The window's sidebar also folds by itself when even its bar would leave the work narrower than a usable pane.
  // ------------------------------------------------------------------
  if (windowRail && isCollapsed && (folded || (!onSeam && edgeHandle))) {
    const handle = (
      <Tooltip label={`Show ${thing}`}>
        <Button
          variant="secondary"
          aria-label={`Show ${thing}`}
          onPointerDown={allows('position') ? moveDrag.onPointerDown : undefined}
          onClick={() => { if (!moveDrag.consumeDrag()) unfoldOrOpen(); }}
          className="glass-surface h-11 w-11 p-0 rounded-full touch-none"
          data-sidebar-handle=""
        >
          <Icon icon={Menu} size="lg" />
        </Button>
      </Tooltip>
    );
    const saved = folded ? placement.foldedAt : undefined;
    const area = windowSize ?? { width: 0, height: 0 };
    return (
      <>
        {moveDrag.overlay}
        {saved && windowSize ? (
          <Container
            layout="flow"
            data-sidebar-open-toggle="placed"
            style={{
              position: 'fixed',
              left: Math.min(Math.max(HANDLE_MARGIN, saved.x * area.width - HANDLE_W / 2), area.width - HANDLE_W - HANDLE_MARGIN),
              top: Math.min(Math.max(HANDLE_MARGIN, saved.y * area.height - HANDLE_W / 2), area.height - HANDLE_W - HANDLE_MARGIN),
              zIndex: FLOAT_Z,
            }}
          >
            {handle}
          </Container>
        ) : (
          <InWindowCorner corner={position === 'right' ? 'bottom-right' : 'bottom-left'}>
            <Container layout="flow" data-sidebar-open-toggle={position}>{handle}</Container>
          </InWindowCorner>
        )}
      </>
    );
  }

  // ------------------------------------------------------------------
  // ON A SEAM — the thin bar drawn in the slot the arrangement laid between two panes, lying along the seam.
  // ------------------------------------------------------------------
  // Its list opened from the bar shows over the work while the bar stays on its seam.
  const seamBar = onSeam && seamSlot ? createPortal(
    <aside
      aria-label={isCollapsed ? ariaLabel : `${ariaLabel} bar`}
      data-bitfield-scene-portal-owner={sceneMountToken}
      data-sidebar-on-seam={seamSlot.axis}
      className="group/rail flex h-full w-full min-h-0 min-w-0"
    >
      {drawBar(seamSlot.axis)}
    </aside>,
    seamSlot.element,
  ) : null;
  if (seamBar && isCollapsed) {
    return (
      <>
        {moveDrag.overlay}
        {seamBar}
      </>
    );
  }

  // ------------------------------------------------------------------
  // FLOATING RENDER
  // ------------------------------------------------------------------
  if (isFloating) {
    const floatWidth = isCollapsed ? COLLAPSED_W : floatRect.w;
    const resizeEdges: Array<{ edge: ResizeEdge; divider: { leftIndex: number; rightIndex: number; left: number; top: number; width: number; height: number }; axis: 'x' | 'y' }> = [
      { edge: 'n', axis: 'y', divider: { leftIndex: 0, rightIndex: 1, left: 8, top: -6, width: Math.max(0, floatWidth - 16), height: 12 } },
      { edge: 's', axis: 'y', divider: { leftIndex: 0, rightIndex: 1, left: 8, top: floatRect.h - 6, width: Math.max(0, floatWidth - 16), height: 12 } },
      { edge: 'e', axis: 'x', divider: { leftIndex: 0, rightIndex: 1, left: floatWidth - 6, top: 8, width: 12, height: Math.max(0, floatRect.h - 16) } },
      { edge: 'w', axis: 'x', divider: { leftIndex: 0, rightIndex: 1, left: -6, top: 8, width: 12, height: Math.max(0, floatRect.h - 16) } },
    ];
    const cornerEdges: Array<{ edge: ResizeEdge; style: React.CSSProperties }> = [
      { edge: 'ne', style: { top: 0, right: 0, width: 12, height: 12, cursor: 'ne-resize' } },
      { edge: 'nw', style: { top: 0, left: 0, width: 12, height: 12, cursor: 'nw-resize' } },
      { edge: 'se', style: { bottom: 0, right: 0, width: 12, height: 12, cursor: 'se-resize' } },
      { edge: 'sw', style: { bottom: 0, left: 0, width: 12, height: 12, cursor: 'sw-resize' } },
    ];

    return (
      <aside
        // Popped out of a container's flow, the frame takes the floating pane surface of the current look.
        className={inFlow ? 'group/rail glass-surface' : 'group/rail'}
        aria-label={ariaLabel}
        data-bitfield-scene-portal-owner={sceneMountToken}
        ref={(el: HTMLElement | null) => { sidebarFrameRef.current = el; }}
        style={{
          position: positioning,
          left: floatRect.x,
          top: floatRect.y,
          width: floatWidth,
          height: floatRect.h,
          maxWidth: contained ? '100%' : undefined,
          maxHeight: contained ? '100%' : undefined,
          transition: 'width 180ms ease-out',
          zIndex: FLOAT_Z,
          display: 'flex',
          flexDirection: 'column',
          ...(inFlow ? {} : {
            background: 'transparent',
            backdropFilter: 'blur(12px)',
            border: '1px solid var(--border-primary)',
            borderRadius: 8,
            boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
          }),
          overflow: 'hidden',
          ...(contained && !inFlow ? dockablePanelSurfaceStyle(true) : {}),
        }}
      >
        {/* Floating drag grip (the control `<controls>.move`) */}
        {controlShown(`${controls}.move`) ? <Container
          className="flex-shrink-0 flex justify-center pt-2 pb-1 cursor-move"
          onPointerDown={startFloatDrag}
        >
          <Icon icon={Grip} size="sm" color="faint" />
        </Container> : null}

        {/* Navigation content */}
        <Container className="flex-1 min-h-0">
          <SidebarContent
            sections={sections}
            footerItems={footerItems}
            currentSelectionId={currentSelectionId}
            onNavigate={(viewId) => { onNavigate(viewId); if (!stayOpen) setOpenHere(false); }}
            onCollectionsChanged={onCollectionsChanged}
            showLabels={showLabels}
            topContent={hostControls ? undefined : windowControls}
            searchValue={searchValue}
            onSearchChange={onSearchChange}
            searchPlaceholder={searchPlaceholder}
            searchAriaLabel={searchAriaLabel}
            headerContent={headerContent}
            emptyContent={emptyContent}
            headerItems={headerItems}
            onItemAction={onItemAction}
            leadingContent={leadingContent}
            trailingContent={trailingContent}
            rowEvents={rowEvents}
          />
        </Container>

        {/* Shared edge dividers are mouse and keyboard accessible. */}
        {allows('resize') && resizeEdges.map(({ edge, divider, axis }) => (
          <SplitDividers
            key={edge}
            axis={axis}
            revealed
            label={`Resize ${thing}`}
            value={{ now: axis === 'x' ? floatWidth : floatRect.h, min: axis === 'x' && isCollapsed ? COLLAPSED_W : MIN_FLOAT, max: axis === 'x' ? bounds().width : bounds().height }}
            dividers={[divider]}
            onResizeStart={() => startFloatResizeFromDivider(edge)}
            onResize={(_left, _right, delta) => applyFloatResizeDelta(edge, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0)}
            onResizeEnd={onFloatPointerUp}
            onResizeStep={direction => resizeFloatByKeyboard(edge, direction)}
          />
        ))}
        {/* Corner grips retain diagonal pointer resizing; edge dividers above
            expose the same size controls to keyboard users. */}
        {allows('resize') && cornerEdges.map(({ edge, style }) => (
          <Container key={edge} style={{ position: 'absolute', zIndex: 10, ...style }} onPointerDown={(e: React.PointerEvent) => startFloatResize(edge, e)} />
        ))}
      </aside>
    );
  }

  // ------------------------------------------------------------------
  // DOCKED RENDER — vertical (left/right) or horizontal (top/bottom)
  // ------------------------------------------------------------------

  const borderStyle = position === 'left'
    ? 'border-r border-[var(--border-primary)]'
    : position === 'right'
      ? 'border-l border-[var(--border-primary)]'
      : position === 'top'
        ? 'border-b border-[var(--border-primary)]'
        : 'border-t border-[var(--border-primary)]';

  // ------------------------------------------------------------------
  // SHARED: auto-mode edge sensors
  // ------------------------------------------------------------------
  const autoSensors = isAuto && !autoOpen && (
    <button type="button" aria-label={`Show ${thing}`}
      onFocus={() => { setInsideAside(true); setHoverSide(position); }}
      onClick={() => setMode('expanded')}
      onPointerEnter={() => setHoverSide(position)}
      style={{
        position: positioning, zIndex: HOTZONE_Z, pointerEvents: 'auto',
        padding: 0, border: 0, background: 'transparent',
        ...(isVertical ? { top: 0, bottom: 0, width: REVEAL_HOTZONE, [position]: 0 }
          : { left: 0, right: 0, height: REVEAL_HOTZONE, [position]: 0 }),
      }}
    />
  );

  const autoPointerProps = {
    inert: isAuto && !autoOpen,
    'aria-hidden': isAuto && !autoOpen,
    onFocusCapture: () => { if (isAuto) setInsideAside(true); },
    onPointerEnter: () => { if (isAuto) { setInsideAside(true); setHoverSide(position); } },
    onPointerLeave: () => { if (isAuto && !dragging) { setInsideAside(false); setHoverSide(null); } },
  };

  // The composition engine mounts each scene root in its OWN stacking context, and
  // the screen-arrangement root can paint above the sidebar root. A z-index INSIDE
  // the sidebar root therefore cannot guarantee the sidebar stays visible/clickable.
  // Portal every docked/auto desktop sidebar into document.body so its stacking
  // competes at the top level while the CSS stage inset still reserves layout space.
  const wrapOverlay = (node: React.ReactNode): React.ReactNode =>
    !contained && typeof document !== 'undefined' ? createPortal(node, document.body) : node;

  if (listVertical) {
    // ------------------------------------------------------------------
    // VERTICAL DOCKED (left / right), and any list open over the work
    // ------------------------------------------------------------------
    const openOverWork = overWork && isExpanded;
    // In its container's flow unless it floats over the work (open over a too-narrow pane, or hidden until pointed at).
    const flowing = inFlow && !isAuto && !openOverWork;
    return wrapOverlay(
      <>
        {autoSensors}
        {/* The open list floats over the work; a tap on the work beside it closes it. */}
        {openOverWork && (
          <Container
            aria-hidden
            data-sidebar-scrim
            onPointerDown={() => setMode('collapsed')}
            style={{ position: positioning, inset: 0, zIndex: FLOAT_Z - 1, background: 'color-mix(in srgb, var(--text-primary) 16%, transparent)' }}
          />
        )}
        <aside
          aria-label={ariaLabel}
          data-bitfield-scene-portal-owner={sceneMountToken}
          // Closes after the row's own click has run (bubbling, not capturing): closing first redraws the row as a
          // rail icon before its click arrives, and the screen was never chosen.
          onClick={(event) => {
            if (!stayOpen && (event.target as Element).closest('[data-sidebar-activate]')) setOpenHere(false);
          }}
          ref={(el: HTMLElement | null) => { sidebarFrameRef.current = el; }}
          // A sidebar held inside a pane follows the pane's inner corner (screen-look nested-corners.css).
          data-corner-follows={contained ? '' : undefined}
          className={[
            'group/rail flex flex-col',
            // A docked frame is part of the window: it paints nothing and sits
            // on the window background, so the work beside it is the one raised
            // surface. Painting it as a pane made the sidebar read as a card
            // beside another card. Only the open auto-hide flyout, which floats
            // over content, takes the pane surface. A contained frame shares its
            // owner's surface instead (dockablePanelSurfaceStyle below).
            flowing ? 'border-0' : contained && !openOverWork ? borderStyle : (isAuto && autoOpen) || openOverWork ? 'glass-surface backdrop-blur-md border-0' : 'border-0',
            isAuto && !autoOpen ? 'fixed top-0 bottom-0' : '',
            isAuto && !autoOpen ? (isLeft ? 'left-0' : 'right-0') : '',
            isAuto && autoOpen ? 'fixed top-0 bottom-0' : '',
            isAuto && autoOpen ? (isLeft ? 'left-0' : 'right-0') : '',
            !isAuto && !flowing ? 'fixed top-0 bottom-0' : '',
            !isAuto && !flowing ? (isLeft ? 'left-0' : 'right-0') : '',
            flowing ? 'shrink-0' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            position: flowing ? 'relative' : positioning,
            maxWidth: contained ? '100%' : undefined,
            top: contained ? undefined : windowEdgeInset('top', DOCKED_FRAME_INSET),
            bottom: contained ? undefined : windowEdgeInset('bottom', DOCKED_FRAME_INSET),
            left: !contained && isLeft ? windowEdgeInset('left', DOCKED_FRAME_INSET) : undefined,
            right: !contained && !isLeft ? windowEdgeInset('right', DOCKED_FRAME_INSET) : undefined,
            borderRadius: contained ? undefined : DOCKED_FRAME_RADIUS,
            // Let the divider's hit area reach into the arrangement seam while
            // keeping the sidebar frame itself visually unchanged.
            overflow: contained ? undefined : 'visible',
            width: contained ? (isAuto && autoOpen ? width : currentSize) : Math.max(0, (isAuto && autoOpen ? width : currentSize) - (isCollapsed ? 0 : DOCKED_FRAME_INSET)),
            boxShadow: openOverWork ? '0 25px 50px rgba(0,0,0,0.25)' : undefined,
            transform: autoHideTransform,
            // Inline z-index keeps every docked/auto path above screen-arrangement
            // regardless of the local scene stacking context. The sidebar still
            // reserves stage space through the stage-inset CSS variables above.
            zIndex: flowing ? undefined : FLOAT_Z,
            // Docked size changes share the stage's immediate inset update.
            // Animating only this frame lets its icons cross into the work.
            transition: dragging ? 'none' : 'transform 200ms ease',
            ...(contained && !flowing ? dockablePanelSurfaceStyle(openOverWork || (isAuto && autoOpen)) : {}),
          }}
          {...autoPointerProps}
        >
          {windowRail && isCollapsed ? drawBar('vertical') : <>
          {/* The open list moves by the same handle as its thin bar, at its start. */}
          {windowRail && movable ? (
            <Container layout="horizontal" justifyContent="center" className="flex-shrink-0 pt-1" data-sidebar-open-grip="">
              <SidebarMoveGrip thing={thing} axis="vertical" onPointerDown={moveDrag.onPointerDown} />
            </Container>
          ) : null}
          {/* Spacer — replaces former branding header */}
          {inFlow ? null : showLabels ? <Container className="flex-shrink-0 h-3" /> : isCollapsed && !contained && isLeft ? <Container className="flex-shrink-0 h-6" /> : null}

          {/* Control items */}
          {hostControls ? null : windowControls}

          {/* Navigation content */}
          <Container className="flex-1 min-h-0">
            <SidebarContent
              sections={sections}
              footerItems={footerItems}
              currentSelectionId={currentSelectionId}
              onNavigate={(viewId) => { onNavigate(viewId); if (!stayOpen) setOpenHere(false); }}
            onCollectionsChanged={onCollectionsChanged}
            showLabels={showLabels}
            searchValue={searchValue}
            onSearchChange={onSearchChange}
            searchPlaceholder={searchPlaceholder}
            searchAriaLabel={searchAriaLabel}
            headerContent={headerContent}
            emptyContent={emptyContent}
            headerItems={headerItems}
            onItemAction={onItemAction}
            leadingContent={leadingContent}
            trailingContent={trailingContent}
            rowEvents={rowEvents}
            />
          </Container>
          </>}

          {/* Resize handle */}
          {allows('resize') && <ResizeHandle
            thing={thing}
            isLeft={isLeft}
            isVertical={true}
            value={width}
            onResizeStart={() => {
              if (isCollapsed) setMode('expanded');
              beginDockResize('col-resize');
            }}
            onResize={(nextWidth) => {
              if (sidebarFrameRef.current) {
                sidebarFrameRef.current.style.transition = 'none';
                sidebarFrameRef.current.style.width = `${Math.max(0, nextWidth - (contained ? 0 : DOCKED_FRAME_INSET))}px`;
              }
              const owner = stageInsetOwner;
              const nextSize = contained ? Math.min(nextWidth, owner?.clientWidth ?? nextWidth) : nextWidth;
              if (owner) updateStageInset(owner, stageInsetId, {
                position,
                size: isFloating || isAuto ? 0 : overWork ? overWorkReserve : nextSize,
                dragging: true,
              });
            }}
            onResizeEnd={(nextWidth) => {
              if (nextWidth !== width) setWidth(nextWidth);
              endDockResize();
            }}
            onResizeStep={(direction) => {
              const nextWidth = direction === 'reset' ? 280 : direction === 'minimum' ? MIN_W : direction === 'maximum' ? MAX_W : width + (direction === 'increase' ? 16 : -16);
              setWidth(clampSidebarSize(nextWidth));
            }}
          />}
        </aside>
        {moveDrag.overlay}
        {seamBar}
      </>
    );
  }

  // ------------------------------------------------------------------
  // HORIZONTAL DOCKED (top / bottom)
  // Height is fixed — expanded just shows labels, no height change. A frame in
  // its container's flow is as tall as its rows and paints nothing of its own.
  // ------------------------------------------------------------------
  const flowing = inFlow && !isAuto;
  const autoShown = isAuto && autoOpen;
  return wrapOverlay(
    <>
      {autoSensors}
      <aside
        aria-label={ariaLabel}
        data-bitfield-scene-portal-owner={sceneMountToken}
        ref={(el: HTMLElement | null) => { sidebarFrameRef.current = el; }}
        className={[
          'group/rail w-full flex',
          flowing ? 'shrink-0' : borderStyle,
          flowing ? '' : inFlow && autoShown ? 'glass-surface backdrop-blur-md rounded-lg' : 'backdrop-blur-md',
          isAuto && !autoOpen ? 'fixed left-0 right-0' : '',
          isAuto && !autoOpen ? (isTop ? 'top-0' : 'bottom-0') : '',
          isAuto && autoOpen ? 'fixed left-0 right-0' : '',
          isAuto && autoOpen ? (isTop ? 'top-0' : 'bottom-0') : '',
          !isAuto && !flowing ? 'fixed left-0 right-0' : '',
          !isAuto && !flowing ? (isTop ? 'top-0' : 'bottom-0') : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{
          position: flowing ? 'relative' : positioning,
          // A window-level bar keeps clear of the window's safe areas (windowEdgeInset): its own edge and both sides.
          ...(flowing || contained ? {} : {
            [isTop ? 'top' : 'bottom']: windowEdgeInset(isTop ? 'top' : 'bottom', DOCKED_FRAME_INSET),
            left: windowEdgeInset('left', DOCKED_FRAME_INSET),
            right: windowEdgeInset('right', DOCKED_FRAME_INSET),
            borderRadius: DOCKED_FRAME_RADIUS,
          }),
          height: inFlow ? undefined : windowRail && isCollapsed ? BAR_W : HORIZ_H,
          transform: autoHideTransform,
          // Inline z-index (see vertical aside) — keep the docked bar above the
          // arrangement regardless of nested scene stacking contexts.
          zIndex: flowing ? undefined : FLOAT_Z,
          transition: dragging ? 'none' : 'transform 200ms ease',
          ...(contained && !inFlow ? dockablePanelSurfaceStyle(autoShown) : {}),
        }}
        {...autoPointerProps}
      >
        {/* Collapsed, the window's sidebar is its thin bar; otherwise one row: controls + nav items + footer */}
        {windowRail && isCollapsed ? drawBar('horizontal') : <Container layout="horizontal" className={inFlow ? 'w-full min-w-0 items-center py-1 pr-1' : 'h-full w-full overflow-x-auto overflow-y-hidden items-center'}>
          {windowRail && movable ? (
            <Container layout="vertical" justifyContent="center" className="flex-shrink-0 h-full pl-1" data-sidebar-open-grip="">
              <SidebarMoveGrip thing={thing} axis="horizontal" onPointerDown={moveDrag.onPointerDown} />
            </Container>
          ) : null}
          {/* Control items — inline in the row */}
          {hostControls ? null : windowControls}

          {/* Navigation content — horizontal */}
          <Container className="flex-1 overflow-hidden h-full min-w-0">
            <SidebarContent
              sections={sections}
              footerItems={footerItems}
              currentSelectionId={currentSelectionId}
              onNavigate={onNavigate}
              onCollectionsChanged={onCollectionsChanged}
            showLabels={showLabels}
              orientation="horizontal"
              headerContent={headerContent}
              searchValue={searchValue}
              onSearchChange={onSearchChange}
              searchPlaceholder={searchPlaceholder}
              searchAriaLabel={searchAriaLabel}
              emptyContent={emptyContent}
              headerItems={headerItems}
              onItemAction={onItemAction}
            leadingContent={leadingContent}
            trailingContent={trailingContent}
            rowEvents={rowEvents}
            />
          </Container>
        </Container>}

        {/* Resize handle: a frame in its container's flow is as tall as its rows. */}
        {allows('resize') && !inFlow && <ResizeHandle
            thing={thing}
          isLeft={isTop}
          isVertical={false}
          value={width}
          onResizeStart={() => {
            if (isCollapsed) setMode('expanded');
            beginDockResize('row-resize');
          }}
          onResize={(nextSize) => {
            if (sidebarFrameRef.current) {
              sidebarFrameRef.current.style.transition = 'none';
              sidebarFrameRef.current.style.height = `${nextSize}px`;
            }
          }}
          onResizeEnd={(nextSize) => {
            if (nextSize !== width) setWidth(nextSize);
            endDockResize();
          }}
          onResizeStep={(direction) => {
            const nextSize = direction === 'reset' ? 280 : direction === 'minimum' ? MIN_W : direction === 'maximum' ? MAX_W : width + (direction === 'increase' ? 16 : -16);
            setWidth(clampSidebarSize(nextSize));
          }}
        />}
      </aside>
      {moveDrag.overlay}
    </>
  );
}
