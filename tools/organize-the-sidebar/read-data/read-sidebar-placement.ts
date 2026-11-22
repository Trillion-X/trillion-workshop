import { decodeDockFit, decodeDockPoint, decodeDockSeam, type DockFit, type DockPoint, type DockSeam } from '../../ui/show/dockable-placement/dockable-placement';
import sidebarSize from './sidebar-size.json';

export type SidebarPosition = 'left' | 'right' | 'top' | 'bottom';
export type SidebarDockState = 'docked' | 'floating';
/** `folded`: only a small handle shows, where the person put it, and opens the list over the work. */
export type SidebarMode = 'expanded' | 'collapsed' | 'auto' | 'folded';
export type SidebarSeam = DockSeam;
export type SidebarPoint = DockPoint;
export type SidebarFit = DockFit;

/** The docked width bounds and starting width (sidebar-size.json): the one source every reader of them uses. */
export const SIDEBAR_MIN_W: number = sidebarSize.min_px;
export const SIDEBAR_MAX_W: number = sidebarSize.max_px;
export const SIDEBAR_DEFAULT_W: number = sidebarSize.default_px;

/** A docked width kept inside the bounds. */
export function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, value));
}

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SidebarPlacementState {
  position: SidebarPosition;
  dockState: SidebarDockState;
  mode: SidebarMode;
  width: number;
  floatRect: FloatRect;
  /** On this seam between two panes instead of on `position`, which is where it goes when the seam is gone. */
  seam?: SidebarSeam;
  /** Where the folded handle sits, as shares of the window; absent is the docked side's bottom corner. */
  foldedAt?: SidebarPoint;
  /** How many icons the thin bar shows before the rest go behind its More button. */
  fit?: SidebarFit;
}

interface SidebarPlacementFeedRow {
  property_id?: unknown;
  value?: unknown;
}

// Default mode is `expanded` (locked open, always visible), NOT `auto` (slides
// off-screen, hover-to-reveal). `auto` reserves zero stage space but requires a
// reveal hotzone that does not exist when the sidebar is mounted NESTED inside a
// member shell (vs as a scene root), so an `auto` default rendered the member
// sidebar permanently off-screen (translateX(-width)). A visible sidebar is the
// correct default for a portal; any app that wants auto sets its own placement fact.
export const DEFAULT_SIDEBAR_PLACEMENT_STATE: SidebarPlacementState = {
  position: 'left',
  dockState: 'docked',
  mode: 'expanded',
  width: SIDEBAR_DEFAULT_W,
  floatRect: { x: 100, y: 100, w: 280, h: 600 },
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function decodeSidebarPlacementValue(value: unknown): SidebarPlacementState {
  const record = readRecord(value);
  if (!record) return DEFAULT_SIDEBAR_PLACEMENT_STATE;

  const rect = readRecord(record.floatRect) ?? {};
  const position: SidebarPosition =
    record.position === 'right' || record.position === 'top' || record.position === 'bottom'
      ? record.position
      : 'left';
  const dockState: SidebarDockState = record.dockState === 'floating' ? 'floating' : 'docked';
  const mode: SidebarMode =
    record.mode === 'collapsed' || record.mode === 'auto' || record.mode === 'folded' ? record.mode : 'expanded';
  const seam = decodeDockSeam(record.seam);
  const foldedAt = decodeDockPoint(record.foldedAt);
  const fit = decodeDockFit(record.fit);

  return {
    position,
    dockState,
    mode,
    width: clampSidebarWidth(readFiniteNumber(record.width, DEFAULT_SIDEBAR_PLACEMENT_STATE.width)),
    floatRect: {
      x: readFiniteNumber(rect.x, DEFAULT_SIDEBAR_PLACEMENT_STATE.floatRect.x),
      y: readFiniteNumber(rect.y, DEFAULT_SIDEBAR_PLACEMENT_STATE.floatRect.y),
      w: readFiniteNumber(rect.w, DEFAULT_SIDEBAR_PLACEMENT_STATE.floatRect.w),
      h: readFiniteNumber(rect.h, DEFAULT_SIDEBAR_PLACEMENT_STATE.floatRect.h),
    },
    ...(seam ? { seam } : {}),
    ...(foldedAt ? { foldedAt } : {}),
    ...(fit ? { fit } : {}),
  };
}

export function decodeSidebarPlacementFeed(raw: unknown): SidebarPlacementState {
  const direct = readRecord(raw);
  if (direct && 'position' in direct) return decodeSidebarPlacementValue(direct);

  const rows = Array.isArray(raw)
    ? raw.filter(
        (entry): entry is SidebarPlacementFeedRow =>
          !!entry && typeof entry === 'object' && !Array.isArray(entry),
      )
    : [];

  const row = rows.find((entry) => entry.property_id === 'prop:settings:sidebar_placement');
  return decodeSidebarPlacementValue(row?.value);
}
