export {
  DEFAULT_DOCKABLE_PLACEMENT_STATE,
  createDockablePlacementStore,
  fitDockFloatRect,
  decodeDockablePlacementValue,
  decodeDockFit,
  decodeDockPoint,
  decodeDockSeam,
  dockSeamKey,
  foldAtPatch,
  placeAtPatch,
  selectDockIsFloating,
  selectDockIsVertical,
  selectDockOrientation,
  useDockablePlacement,
} from './dockable-placement';
export type {
  DockFit,
  DockFloatRect,
  DockPoint,
  DockSeam,
  DockMode,
  DockPosition,
  DockState,
  DockablePlacementController,
  DockablePlacementState,
  DockablePlacementStore,
} from './dockable-placement';
export { PositionCompass } from './PositionCompass';
export type { PositionCompassProps } from './PositionCompass';
