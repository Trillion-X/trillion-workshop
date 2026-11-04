// parts/ui/index.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Root barrel export for browser-local screen parts. Feature packages may import
// these pure visual parts when they intentionally choose direct source coupling.
// Durable reads, writes, target invokes, and owner behavior do not live here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Every exported part is browser-local visual code only
// 2. Adding a screen part means: create it under show/, build it, add export here
// 3. Type exports use `export type` for proper tree-shaking and isolatedModules
// 4. Order: utilities first, then parts alphabetically
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export { cn } from './show/cn';
// Saved screens may install their own declared preference read/write owner.
export { keepRecordViewPreferencesIn, useRecordViewPreference, writeRecordViewPreference } from './show/record-views/record-view-preferences';
export type { RecordViewPreferenceStore } from './show/record-views/record-view-preferences';
export { applySceneStyleToElement, realizeSceneStyle, sceneStyleToCss, measureNaturalTextWidth } from './show/composition-scene-style';
export type { CompositionSceneStyle, SceneStyleRealization } from './show/composition-scene-style';
export { downloadAddress, downloadBlob, downloadTextFile } from './show/file-download/download-file';
// svgToPngBlob, parseSvgSize, svgDataUrl: import from ./show/raster/svg-to-png itself; kept off this barrel so only the screens using it load it.
// copyImageBlobToClipboard: import from ./show/clipboard/copy-blob itself; kept off this barrel so only the screens using it load it.
// copyTextToClipboard: import from ./show/clipboard/copy-text itself; kept off this barrel so only the screens using it load it.
// mergeOutputDestinations, findOutputDestination: import from ./show/output-destination itself; kept off this barrel so only the screens using it load it.
// OutputPayload, OutputDeliverCapability, OutputDestination: import from ./show/output-destination itself; kept off this barrel so only the screens using it load it.
export { buildSurfaceOutputDispatcher } from './show/surface-output';
export type { SurfaceOutput, SurfaceOutputEventDetail } from './show/surface-output';
// Notice: import from ./show/notice/Notice itself; kept off this barrel so only the screens using it load it.
// NoticeProps, NoticeTone, NoticePlacement: import from ./show/notice/Notice itself; kept off this barrel so only the screens using it load it.
export { mountReactMaterial, mountReactSurface } from './show/react-surface-mount';
export type { ReactMaterialMountArgs, ReactSurfaceUnmount } from './show/react-surface-mount';
export {
  SourceBytesScreenMount,
  cleanupSourceBytesScreenMount,
  isUint8Array,
  stableValueKey,
} from './show/source-bytes-screen-mount';
export { IsolatedModuleSurface } from './show/isolated-module-surface/IsolatedModuleSurface';
export type { IsolatedModuleSurfaceProps, ModuleSurfaceCall, ModuleSurfaceRequestMap } from './show/isolated-module-surface/IsolatedModuleSurface';
export {
  PlaceableSurfaceHost,
  packageEntryBytesAddressLabel,
} from './show/placeable-surface-host';
export type { PlaceableSurfaceHostProps } from './show/placeable-surface-host';
export type {
  SourceBytesScreenMountElement,
  SourceBytesScreenMountProps,
  SourceBytesScreenMountRequest,
  SourceBytesScreenRuntime,
} from './show/source-bytes-screen-mount';

// ---------------------------------------------------------------------------
// AvatarGroup
// ---------------------------------------------------------------------------

export { AvatarGroup } from './show/avatar-group';
export type { AvatarGroupItem, AvatarGroupProps } from './show/avatar-group';
// LiveSurfacePeopleOverlay, LiveSurfacePeopleRoster, stableLiveSurfaceColor: import from ./show/live-surface-people itself; kept off this barrel so only the screens using it load it.
// LiveSurfaceBounds, LiveSurfaceBoundsSource, LiveSurfacePeopleOverlayProps, LiveSurfacePeopleRosterProps, LiveSurfacePersonView, LiveSurfacePoint: import from ./show/live-surface-people itself; kept off this barrel so only the screens using it load it.

// ---------------------------------------------------------------------------
// DisplayMark — THE universal identity-mark renderer (image|glyph|monogram ×
// shape × tint × badge × stack). Subsumes ServiceMark + ParticipantRouteMark
// (both deleted) and SelectableAvatar (deleted: its selection check is the
// `check` badge). The one place a person's initials are made (initialsOf).
// ---------------------------------------------------------------------------

// DisplayMark, displayMarkVariants: import from ./show/display-mark itself; kept off this barrel so only the screens using it load it.
// DisplayMarkProps, DisplayMarkSpec, DisplayMarkBadge, DisplayMarkTint: import from ./show/display-mark itself; kept off this barrel so only the screens using it load it.

// ProviderMark remains a shared UI identity primitive. Service-connections and
// other provider-neutral surfaces consume it through this public barrel.
export {
  ProviderMark,
  normalizeProviderSlug,
  readProviderIconRegistry,
  resolveProviderMark,
} from './show/provider-mark';
/** The provider icons this shared UI package publishes, for callers of ProviderMark. */
export {providerIconRegistry} from './show/provider-mark/shipped-provider-icons';
export type {
  ProviderMarkProps,
  ProviderIconRegistryEntry,
  ProviderIconRegistryRow,
  ProviderIconBundledAsset,
  ProviderIconVector,
  ProviderIdentity,
  ResolvedProviderMark,
} from './show/provider-mark';

// ---------------------------------------------------------------------------
// Bar
// ---------------------------------------------------------------------------

export { AudioClipPlayer } from './show/audio-clip-player/AudioClipPlayer';
export {
  isSelfDescribingChunkRef,
  readSelfDescribingChunkBlob,
} from './show/media-bytes/read-self-describing-chunk-blob';
export type { SelfDescribingChunkRef } from './show/media-bytes/read-self-describing-chunk-blob';
// The engine's own /cas/ byte transport. `ui` declares the `network` reach for these
// routes so a surface wanting engine bytes imports this reader instead of fetching.
export {
  chunkHashesFromManifest,
  assembleCasChunkManifestBlob,
  defaultCasFetch,
} from './show/media-bytes/read-cas-chunk-manifest-blob';
export type { CasFetch, CasChunkManifestRef } from './show/media-bytes/read-cas-chunk-manifest-blob';

export type { AudioClipPlayerProps } from './show/audio-clip-player/AudioClipPlayer';
export { HoverRevealGroup, HoverRevealItem } from './show/hover-reveal';
export { DragHandleMenu } from './show/drag-handle-menu';
export { ExpandableRegion } from './show/expandable-region';
export type { ExpandableRegionProps } from './show/expandable-region';
export { SceneFrame } from './show/scene-frame';
export type { SceneFrameProps, SceneFrameRect } from './show/scene-frame';
export { SceneResizeHandles, applySceneResize, handleMovesOrigin } from './show/scene-resize-handles/SceneResizeHandles';
export type { SceneResizeHandlesProps, SceneResizeRect, SceneResizeHandleId } from './show/scene-resize-handles/SceneResizeHandles';
export { CanvasHud } from './show/canvas-hud/CanvasHud';
export type { CanvasHudProps } from './show/canvas-hud/CanvasHud';
export { PersistenceStatus } from './show/persistence-status/PersistenceStatus';
export type { PersistenceStatusProps, PersistenceTone } from './show/persistence-status/PersistenceStatus';
export { SplitDividers } from './show/split-dividers/SplitDividers';
export type { SplitDividersProps, SplitDividerView } from './show/split-dividers/SplitDividers';
export { ConditionEditor } from './show/condition-editor/ConditionEditor';
export type { ConditionEditorProps, ConditionDraft, ConditionOperatorOption } from './show/condition-editor/ConditionEditor';
export { SpacingEditor } from './show/spacing-editor/SpacingEditor';
export type { SpacingEditorProps, SpacingFieldView } from './show/spacing-editor/SpacingEditor';
export type { DragHandleAction, DragHandleMenuProps } from './show/drag-handle-menu';
export type { HoverRevealGroupProps, HoverRevealItemProps } from './show/hover-reveal';
export { Bar, barVariants, barSegmentVariants } from './show/bar/Bar';
export { UsageMeter } from './show/usage-meter';
export type { UsageMeterProps, UsageSegment } from './show/usage-meter';
export { FileTree } from './show/file-tree';
export type { FileTreeNode, FileTreePage, FileTreeProps } from './show/file-tree';
export type { BarProps, BarSegment } from './show/bar/Bar';
export { RegionMap, REGION_HEAT_STEPS, regionHeatSteps, regionValuesFromRecords } from './show/region-map';
export type { MapRegion, RegionMapProps, RegionHeatDomain, RegionMapPlacement } from './show/region-map';

// ---------------------------------------------------------------------------
// WorkStartState
// ---------------------------------------------------------------------------

// WorkSkeletonRows, WorkStartState: import from ./show/work-start-state itself; kept off this barrel so only the screens using it load it.
// WorkStartItem, WorkStartStateProps: import from ./show/work-start-state itself; kept off this barrel so only the screens using it load it.

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export { Badge, badgeVariants } from './show/badge';
export type { BadgeProps } from './show/badge';

// ---------------------------------------------------------------------------
// BulkSelectBar
// ---------------------------------------------------------------------------

// BulkSelectBar: import from ./show/bulk-select-bar itself; kept off this barrel so only the screens using it load it.
// BulkSelectBarAction, BulkSelectBarProps: import from ./show/bulk-select-bar itself; kept off this barrel so only the screens using it load it.

// ---------------------------------------------------------------------------
// BrandWordmark
// ---------------------------------------------------------------------------

export { BrandWordmark } from './show/brand/BrandWordmark';
export type { BrandWordmarkProps } from './show/brand/BrandWordmark';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export { Button, buttonVariants } from './show/button';
export { AddToIt } from './show/add-to-it';
export type { AddToItProps, AddWay } from './show/add-to-it';
export type { ButtonProps } from './show/button';

// ---------------------------------------------------------------------------
// CapabilityIconRow
// ---------------------------------------------------------------------------

export { CapabilityIconRow } from './show/capability-icon-row';
export type { CapabilityIconRowItem, CapabilityIconRowProps } from './show/capability-icon-row';

// ---------------------------------------------------------------------------
// CodeDisplay
// ---------------------------------------------------------------------------

export { CodeDisplay } from './show/code-display';
export type { CodeDisplayProps } from './show/code-display';

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export { Card, cardVariants } from './show/card';
export type { CardProps } from './show/card';
export { EditorialLinkCard } from './show/editorial-link-card/EditorialLinkCard';
export type { EditorialLinkCardProps } from './show/editorial-link-card/EditorialLinkCard';

// ---------------------------------------------------------------------------
// EventInvitation + Tilt
// ---------------------------------------------------------------------------

export { EventInvitation } from './show/event-invitation';
export type { EventInvitationFact, EventInvitationProps } from './show/event-invitation';
export {
  MORPHING_RIBBON_GUIDES,
  MORPHING_RIBBON_PATHS,
  MORPHING_RIBBON_REFERENCE_VIEWBOX,
  MorphingRibbon,
} from './show/morphing-ribbon';
export type {
  MorphingRibbonFrame,
  MorphingRibbonMotion,
  MorphingRibbonProps,
} from './show/morphing-ribbon';
export { Tilt, normalizeTiltPointerPosition } from './show/tilt';
export type { TiltProps } from './show/tilt';

// ---------------------------------------------------------------------------
// CanvasDotGrid
// ---------------------------------------------------------------------------

export { CanvasDotGrid } from './show/canvas-dot-grid';
export type { CanvasDotGridProps } from './show/canvas-dot-grid';
// CanvasSurface — the generic surface primitive (color + DATA tile) of which the
// dot-grid is one configuration. Used for board-level background looks.
export { CanvasSurface } from './show/canvas-surface';
export type { CanvasSurfaceProps, CanvasSurfaceTile } from './show/canvas-surface';
// SurfaceSwatch — a selectable preview tile of a CanvasSurface look (color + tile),
// for "background" pickers. Blind to what it previews; feature catalogs feed it DATA.
// SurfaceSwatch: import from ./show/surface-swatch itself; kept off this barrel so only the screens using it load it.
// SurfaceSwatchProps: import from ./show/surface-swatch itself; kept off this barrel so only the screens using it load it.
// CanvasViewport: import from ./show/canvas-viewport/CanvasViewport itself; kept off this barrel so only the screens using it load it.
// CanvasViewportProps: import from ./show/canvas-viewport/CanvasViewport itself; kept off this barrel so only the screens using it load it.
// SelectionBoundsOverlay: import from ./show/selection-bounds itself; kept off this barrel so only the screens using it load it.
// SelectionBoundsOverlayProps, BoundsRect, BoundsHandle: import from ./show/selection-bounds itself; kept off this barrel so only the screens using it load it.
// CropOverlay: import from ./show/crop-overlay itself; kept off this barrel so only the screens using it load it.
// CropOverlayProps, CropOverlayRect, CropOverlayWindow, CropHandle: import from ./show/crop-overlay itself; kept off this barrel so only the screens using it load it.
export { CaptionScroll } from './show/caption-scroll';
export type { CaptionScrollProps } from './show/caption-scroll';

// ---------------------------------------------------------------------------
// CanvasEdgeOverlay
// ---------------------------------------------------------------------------

export { CanvasEdgeOverlay } from './show/canvas-edge-overlay';
export type { CanvasEdgeOverlayProps } from './show/canvas-edge-overlay';

// ---------------------------------------------------------------------------
// CanvasMinimap
// ---------------------------------------------------------------------------

// CanvasMinimap: import from ./show/canvas-minimap itself; kept off this barrel so only the screens using it load it.
// CanvasMinimapProps, CanvasMinimapFrame: import from ./show/canvas-minimap itself; kept off this barrel so only the screens using it load it.
// DotPlacementMap: import from ./show/canvas-minimap itself; kept off this barrel so only the screens using it load it.
// DotPlacementMapProps, DotPlacementFrame: import from ./show/canvas-minimap itself; kept off this barrel so only the screens using it load it.

// ---------------------------------------------------------------------------
// CanvasNode
// ---------------------------------------------------------------------------

export { CanvasNode, applyResizeGeom, RESIZE_EDGES, RESIZE_CURSOR } from './show/canvas-node';
export type { CanvasNodeProps, ResizeEdge, Rect } from './show/canvas-node';
export { NodeGraph, mountNodeGraph } from './show/node-graph';
export type { NodeGraphProps, GraphNodeInput, GraphEdgeInput, MountedNodeGraph } from './show/node-graph';
// CanvasShape: import from ./show/canvas-shape itself; kept off this barrel so only the screens using it load it.
// CanvasShapeProps: import from ./show/canvas-shape itself; kept off this barrel so only the screens using it load it.
// CanvasFrame: import from ./show/canvas-frame/CanvasFrame itself; kept off this barrel so only the screens using it load it.
// CanvasFrameProps: import from ./show/canvas-frame/CanvasFrame itself; kept off this barrel so only the screens using it load it.
// CanvasPresentBar — blind bottom-center present-mode control bar (◀ position title ▶ ✕).
// CanvasPresentBar: import from ./show/canvas-present-bar itself; kept off this barrel so only the screens using it load it.
// CanvasPresentBarProps: import from ./show/canvas-present-bar itself; kept off this barrel so only the screens using it load it.
// CommandPalette — blind Cmd-K launcher over a caller-supplied action catalog (DATA).
export { CommandPalette, filterCommands } from './show/command-palette';
export type { CommandPaletteProps, CommandPaletteItem } from './show/command-palette';
// action-affordance — decode/filter/resolve/author `kind:"action-affordance"` published
// records (invoke an admitted workflow action from named render contexts). Pure: hosts
// inject dispatch senders and own reads/writes/output placement.
// readActionAffordances, affordancesForChannel, triggerForChannel, resolveBindingTemplate, buildDispatchPayload, affordancePaletteItems, affordanceNodeActions, buildActionAffordanceRecord, buildActionAffordanceWriteItem, writeActionAffordanceLive, ActionAffordanceEditor, registerLocalActorAdmission: import from ./show/action-affordance itself; kept off this barrel so only the screens using it load it.
// ActionAffordance, ActionAffordanceTrigger, ActionAffordanceDispatch, ActionAffordanceStatus, AffordanceInvokeContext, AffordanceInvoke, ActionAffordanceDraft, ActionAffordanceWriteItem, ActionAffordanceEditorProps, AffordanceDefinitionOption, AffordanceChannelOption, AdmissionRecipe, LocalPermissionRequest, LocalPermissionResult: import from ./show/action-affordance itself; kept off this barrel so only the screens using it load it.
// AnchoredOverlay — portal-to-body floating panel (escapes parent clip), height-
// clamped + scrollable + optionally draggable. For toolbars/popovers on clipped surfaces.
export { AnchoredOverlay } from './show/anchored-overlay';
export type { AnchoredOverlayProps } from './show/anchored-overlay';

// ---------------------------------------------------------------------------
// CompositionGraph — the recursive NodeRef composition primitive (RG-1/RG-2):
// container/tab-group/layout/group/board/archive are all configurations of one
// `{ref, members?}` node; every behavior resolves through the uniform FacetRegistry.
// ---------------------------------------------------------------------------

export type { CompositionNode, GroupMember, CompositionGraph, FoldVisit, FacetRegistry } from './show/composition-graph';
export {
  EMPTY_COMPOSITION_GRAPH,
  nodeKey,
  getNode,
  orderedMembers,
  ensureNode,
  addMember,
  removeMember,
  moveMember,
  foldGroup,
  flattenGroup,
  facetRegistryFromMap,
  facetRegistryFromGetter,
  resolveFacet,
} from './show/composition-graph';

// ---------------------------------------------------------------------------
// EdgeAutoHide — generic off-screen auto-hiding edge panel (U2). Wrap any
// content; unpinned it slides fully off the docked edge and a thin hotzone
// reveals it on pointer-enter. Position-aware (top/left/bottom/right).
// ---------------------------------------------------------------------------

export { EdgeAutoHide, edgeTransform, hotzoneStyle, panelAnchorStyle, isHorizontalEdge, isRevealed } from './show/edge-auto-hide';
export type { EdgeAutoHideProps, DockEdge } from './show/edge-auto-hide';

// LAYER_ORDER — single ordered stacking scale (SSOT). Named z layers declared in
// one place so cross-scene stacking (floating panel > stage > its own hotzone) is
// auditable instead of bare magic numbers scattered across components.
export { LAYER_ORDER } from './show/layer-order/layer-order';
export type { LayerName } from './show/layer-order/layer-order';

export { ControlRailButton } from './show/control-rail-button/ControlRailButton';
export type { ControlRailButtonProps } from './show/control-rail-button/ControlRailButton';

export { CaptureControl, ElapsedTime, formatElapsed } from './show/capture-control/CaptureControl';
export { RecordingBar } from './show/recording-bar';
export type { RecordingBarAction, RecordingBarProps } from './show/recording-bar';
export type { CaptureControlProps, CaptureControlState } from './show/capture-control/CaptureControl';

// ---------------------------------------------------------------------------
// CanvasWorldTransform
// ---------------------------------------------------------------------------

export { CanvasWorldTransform } from './show/canvas-world-transform';
export type { CanvasWorldTransformProps } from './show/canvas-world-transform';

// ---------------------------------------------------------------------------
// CodeBlock
// ---------------------------------------------------------------------------

export { CodeBlock, codeBlockVariants } from './show/code-block/CodeBlock';
export type { CodeBlockProps } from './show/code-block/CodeBlock';

// ---------------------------------------------------------------------------
// CopyablePath
// ---------------------------------------------------------------------------

// DatePicker: import from ./show/date-picker/DatePicker itself; kept off this barrel so only the screens using it load it.
// DatePickerProps: import from ./show/date-picker/DatePicker itself; kept off this barrel so only the screens using it load it.

export { CopyablePath, copyablePathVariants } from './show/copyable-path/CopyablePath';
export type { CopyablePathProps } from './show/copyable-path/CopyablePath';

// ---------------------------------------------------------------------------
// ColorDot
// ---------------------------------------------------------------------------

export { DropIndicator } from './show/drop-indicator';
export type { DropIndicatorProps } from './show/drop-indicator';
export { CompletionRing } from './show/completion-ring';
export type { CompletionRingProps } from './show/completion-ring';
export { ScoreRing } from './show/score-ring/ScoreRing';
export type { ScoreRingProps, ScoreRingTone } from './show/score-ring/ScoreRing';
export { ColorDot, colorDotVariants } from './show/color-dot';
export { NestingGuide } from './show/nesting-guide';
export { ColourStrip } from './show/colour-strip';
export { markPageOpen, readPageBackdrop, setPageBackdrop, usePageBackdrop, whenPageOpen } from './show/page-backdrop';
export { ChoiceTiles } from './show/choice-tiles/ChoiceTiles';
export type { ChoiceTile } from './show/choice-tiles/ChoiceTiles';
export type { ColourStop, ColourStripProps } from './show/colour-strip';
export type { ColorDotProps } from './show/color-dot';
export type { NestingGuideProps } from './show/nesting-guide';
// NativeColorInput, NativeColorPickerPanel: import from ./show/native-color-picker itself; kept off this barrel so only the screens using it load it.
// NativeColorInputProps, NativeColorPickerPanelProps: import from ./show/native-color-picker itself; kept off this barrel so only the screens using it load it.
export { ColorWheel, hsvaToHex, hexToHsva, hsvaToRgba, rgbaToHsva, parseHex, hueBaseHex } from './show/color-wheel';
export type { ColorWheelProps, Hsva, Rgba } from './show/color-wheel';
// In-app anchored color picker (ColorWheel + Save in an AnchoredOverlay) — the
// reusable alternative to the native input whose OS picker lands top-of-screen.
export { ColorPickerPopover } from './show/color-picker-popover';
export type { ColorPickerPopoverProps } from './show/color-picker-popover';

// Color/tag option picker (list of dot+label+delete rows in an AnchoredOverlay) —
// data-driven selection for status/priority/category fields with uniform row anatomy.
export { ColorTagPickerOverlay } from './show/color-tag-picker-overlay';
export type { ColorTagOption, ColorTagPickerOverlayProps } from './show/color-tag-picker-overlay';

export { RenamePanel, ColorPanel, GrainPanel, BackgroundPickerPanel, BookmarksPanel, LayerStackPanel } from './show/node-editors';
export type { LayerStackPanelProps, LayerRowInfo, LayerAddOption, BookmarkRowInfo } from './show/node-editors';
export { NavArrows } from './show/nav-arrows/NavArrows';
export type { NavArrowsProps, NavHistoryItem } from './show/nav-arrows/NavArrows';
export { DrillMenu } from './show/drill-menu';
export type { DrillMenuProps, DrillLevel, DrillSection, DrillRow } from './show/drill-menu';
export {
  recordVisit,
  stepBack,
  stepForward,
  canStepBack,
  canStepForward,
  currentRef,
  clampCursor,
} from './show/nav-arrows/node-history-model';
export type { NodeHistoryEntry, NodeHistoryTrail } from './show/nav-arrows/node-history-model';
// RecentItems — the MRU jump-list algebra. DISTINCT from the NavigationTrail
// cursor above (no cursor / no back-forward / no drop-forward). web-frame's
// "Recent pages" list consumes this; screen-arrangement's pane history consumes
// the NavigationTrail. They are different algebras (B1 false-primitive split).
export { recordRecent, forgetRecent } from './show/recent-items/recent-items';
export type { RecentItem } from './show/recent-items/recent-items';
export { Inline } from './show/inline/Inline';
export type { InlineProps } from './show/inline/Inline';

// ---------------------------------------------------------------------------
// OpenSurfaceAction
// ---------------------------------------------------------------------------

export { QueueJobButton } from './show/queue-job';
export type { QueueJobButtonProps, QueueJobPress } from './show/queue-job';
export { OpenSurfaceAction } from './show/open-surface-action';
export type { OpenSurfaceActionProps } from './show/open-surface-action';

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export { Container, containerVariants } from './show/container';
export type { ContainerProps } from './show/container';
export { NotesDocument } from './show/notes-document/NotesDocument';
export { formatFactValue } from './show/fact-chips/FactChips';

// ---------------------------------------------------------------------------
// CollapsiblePanel
// ---------------------------------------------------------------------------

export { CollapsiblePanel } from './show/collapsible-panel';
export type {
  CollapsiblePanelContext,
  CollapsiblePanelProps,
} from './show/collapsible-panel';

// ---------------------------------------------------------------------------
// InboxThreePane — generic rail | list | detail inbox shell (responsive)
// ---------------------------------------------------------------------------
export {
  InboxThreePane,
  visiblePaneAtWidth,
  shallowerPane,
  DEFAULT_INBOX_NARROW_BREAKPOINT_PX,
} from './show/inbox-3pane';
export type {
  InboxThreePaneProps,
  InboxPane,
  InboxPaneVisibility,
} from './show/inbox-3pane';

// ---------------------------------------------------------------------------
// DockablePlacement — generic dock/float/collapse placement primitive
// ---------------------------------------------------------------------------
export {
  DEFAULT_DOCKABLE_PLACEMENT_STATE,
  createDockablePlacementStore,
  decodeDockablePlacementValue,
  selectDockIsFloating,
  selectDockIsVertical,
  selectDockOrientation,
  useDockablePlacement,
  PositionCompass,
} from './show/dockable-placement';
export type {
  DockFloatRect,
  DockMode,
  DockPosition,
  DockState,
  DockablePlacementController,
  DockablePlacementState,
  DockablePlacementStore,
  PositionCompassProps,
} from './show/dockable-placement';

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

export { Divider } from './show/divider/Divider';
export type { DividerProps } from './show/divider/Divider';

// ---------------------------------------------------------------------------
// DisclosureSection — titled (optionally collapsible) group of settings rows
// ---------------------------------------------------------------------------

export { DisclosureSection } from './show/disclosure-section/DisclosureSection';
export type { DisclosureSectionProps } from './show/disclosure-section/DisclosureSection';

// ---------------------------------------------------------------------------
// DragReorderList
// ---------------------------------------------------------------------------

export { DragReorderList, reorderIds } from './show/drag-reorder-list';
export type { DragReorderListItem, DragReorderListProps } from './show/drag-reorder-list';

// ---------------------------------------------------------------------------
// AnimatedReorder (generic FLIP animator for any ordered list)
// ---------------------------------------------------------------------------

export { AnimatedReorder, flipInvert } from './show/animated-reorder/AnimatedReorder';
export type {
  AnimatedReorderItem,
  AnimatedReorderProps,
  AnimatedReorderDirection,
  AnimatedReorderGap,
  AnimatedReorderAlign,
} from './show/animated-reorder/AnimatedReorder';

// ---------------------------------------------------------------------------
// Dropdown
// ---------------------------------------------------------------------------

export { Dropdown } from './show/dropdown';
export type { DropdownProps, DropdownItem, DropdownItemState } from './show/dropdown';
export { matchesMenuSearch, searchDropdownItems } from './show/dropdown';
export { PlacementHistoryMenu } from './show/placement-history';
export type { PlacementHistoryEntry, PlacementHistoryMenuProps } from './show/placement-history';

// ---------------------------------------------------------------------------
// GroupedPicker
// ---------------------------------------------------------------------------
// Generic grouped dropdown (section headers + description rows + active
// checkmark; the Granola/ChatGPT model-picker anatomy). Elevated from the former
// chat-local InlineDropdown so every package composes ONE picker (L069/L066).

export { GroupedPicker } from './show/grouped-picker';
export type { GroupedPickerProps } from './show/grouped-picker';

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export { Form } from './show/form/Form';
export type { FormProps } from './show/form/Form';

// ---------------------------------------------------------------------------
// EmptyPlaceholder
// ---------------------------------------------------------------------------

export { EmptyPlaceholder } from './show/empty-placeholder';
export type { EmptyPlaceholderProps } from './show/empty-placeholder';

// ---------------------------------------------------------------------------
// StatementHeader
// ---------------------------------------------------------------------------

export { StatementHeader } from './show/statement-header';
export type { StatementHeaderProps } from './show/statement-header';

// ---------------------------------------------------------------------------
// CalendarGrid — domain-blind date-bucket grid
// ---------------------------------------------------------------------------

export { CalendarGrid } from './show/calendar-grid';
export type {
  CalendarGridProps,
  CalendarGridCell,
  CalendarGridDensity,
} from './show/calendar-grid';

// ---------------------------------------------------------------------------
// HourGrid — domain-blind timed-lane grid (minute axis, hairlines, now-line,
// interval pills with color spine; overlap placement supplied as data)
// ---------------------------------------------------------------------------

export { HourGrid } from './show/hour-grid';
export type {
  HourGridProps,
  HourGridLane,
  HourGridItem,
  HourGridDropMarker,
  HourGridWorkingHours,
} from './show/hour-grid';

// ---------------------------------------------------------------------------
// ScheduleCalendar — a month board or hour lanes that things are dragged onto,
// with a tray for the things with no time (composes CalendarGrid and HourGrid)
// ---------------------------------------------------------------------------

export { ScheduleCalendar, EventOptions, EventProperties, TaskRecurrence, CalendarControls, WeeklyAvailability, planSchedule, timeboxEvent, timeboxPolicies, visibleRange, visibleDays, shiftAnchor, dayKey, dayStart, addDays } from './show/schedule-calendar';
export { QuickCreate } from './show/quick-create/QuickCreate';
export type { QuickCreateProps } from './show/quick-create/QuickCreate';
export { MeetingReviewTabs } from './show/meeting-review/MeetingReviewTabs';
export type { MeetingReviewTab, MeetingReviewTabsProps } from './show/meeting-review/MeetingReviewTabs';
export type {
  CalendarAccount, CalendarAccountCalendar, CalendarAccessRole, CalendarSelection,
  CalendarControlSource, CalendarControlPreferences, CalendarControlsWords,
  CalendarControlNavigationItem, CalendarControlColor, CalendarControlsProps,
  WeeklyAvailabilityDay, WeeklyAvailabilityInterval, WeeklyAvailabilitySchedule,
  WeeklyAvailabilityWords, WeeklyAvailabilityProps,
  ScheduleCalendarProps, ScheduleCalendarWords, ScheduleItem, ScheduleOpenModifiers, ScheduleRange, ScheduleTrayGroup, ScheduleVerbRegistrar, ScheduleVerbRun, ScheduleView,
  ScheduleDayLoad, ScheduleKeptTask, SchedulePlan, SchedulePlanEvent, SchedulePlannerOptions, SchedulePlanTask,
  ScheduleProposal, ScheduleUnscheduledReason, ScheduleUnscheduledTask, ScheduleWorkingHours,
  EventOptionsProps, EventOptionsWords, EventRepeatChoice, EventRepeatSetting, EventReminderSetting,
  EventPropertiesProps, EventPropertyChoice, EventPropertyField, EventPropertySetting,
  TaskRecurrenceChoice, TaskRecurrenceProps, TaskRecurrenceValue, TaskRecurrenceWords,
} from './show/schedule-calendar';

// ---------------------------------------------------------------------------
// TaskProperties — controlled description, priority and label fields
// ---------------------------------------------------------------------------

export { TaskProperties } from './show/task-properties';
export { SelectionFormatBar, applyFormat } from './show/selection-format-bar';
export type { SelectionFormatBarProps, SelectionFormatCommand } from './show/selection-format-bar';
export type { TaskPropertiesProps, TaskPropertiesWords, TaskPriorityOption } from './show/task-properties';

// ---------------------------------------------------------------------------
// NestedNavigation — drill-in list and its floating picker
// ---------------------------------------------------------------------------

export { NestedNavigationList } from './show/nested-navigation/NestedNavigationList';
export type { NestedNavigationCollection, NestedNavigationItem, NestedNavigationListProps } from './show/nested-navigation/NestedNavigationList';
export { NestedNavigationPicker } from './show/nested-navigation/NestedNavigationPicker';
export type { NestedNavigationPickerProps } from './show/nested-navigation/NestedNavigationPicker';

// ---------------------------------------------------------------------------
// Globe
// ---------------------------------------------------------------------------

export { Globe } from './show/globe';
export type { GlobeProps, GlobeNode, GlobeEdge } from './show/globe';

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------

export { Icon, NamedIcon, resolveNamedIcon, iconVariants } from './show/icon';
export type { IconProps, NamedIconProps } from './show/icon';
export { IconTile, iconTileVariants } from './show/icon-tile/IconTile';
export type { IconTileProps } from './show/icon-tile/IconTile';

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------

export { ErrorBoundary } from './show/error-boundary';
export type { ErrorBoundaryProps, ErrorBoundaryState } from './show/error-boundary';

export { EvidenceSourceCard } from './show/evidence-source-card';
export type { EvidenceSourceCardProps } from './show/evidence-source-card';
export { ArtifactEvidence } from './show/artifact-evidence';
export type { ArtifactEvidenceProps, EvidenceReference } from './show/artifact-evidence';

// ---------------------------------------------------------------------------
// ImageBlock
// ---------------------------------------------------------------------------

export { ImageBlock, imageBlockVariants } from './show/image-block/ImageBlock';
export type { ImageBlockProps } from './show/image-block/ImageBlock';

// ---------------------------------------------------------------------------
// FilePreview — native per-MIME preview (video/audio/image play+show; else embed)
// ---------------------------------------------------------------------------

// FilePreview and MediaFrame are imported from their own files, never from here: this index is part of the page's
// first load, and a file it names is loaded with the page as soon as any screen uses it (the player alone is 43 KB).
export { KeptFiles } from './show/file-preview/KeptFiles';
export type { KeptFile } from './show/file-preview/KeptFiles';

// ---------------------------------------------------------------------------
// VisualLayerStack — region = ordered layer stack; paint dispatched by data
// (capabilityId) through an owner-injected capability map. No closed kind union.
// ---------------------------------------------------------------------------

// VisualLayerStack, LayerStackEditor, createCapabilityMap, builtinVisualLayerCapabilities, isVisualLayerStackRecord, composeStackTextStyle: import from ./show/visual-layer-stack itself; kept off this barrel so only the screens using it load it.
// VisualLayerStackProps, LayerStackEditorProps, FrameDef, VisualLayerCapability, VisualLayerCapabilityMap, VisualLayerRenderContext, AddressRef, CapabilityRef, CapabilityInvocation, VisualLayerDescriptor, VisualLayerStackRecord, VisualLayerOrder, VisualLayerFrame, VisualLayerComposite: import from ./show/visual-layer-stack itself; kept off this barrel so only the screens using it load it.

export { readVisualLayerDrop, canPaintDataTransfer, subjectAddressRef, createVisualLayerSubjectResolver } from './show/visual-layer-intent';
export type { VisualLayerDrop } from './show/visual-layer-intent';

// ---------------------------------------------------------------------------
// RegionDropRouter — a dropped subject dispatched by data to one of N owner-
// provided drop intents (accepts/apply). Default intent owns the whole region;
// other intents render as distinct zones. Sibling of VisualLayerCapability;
// no closed tab/wallpaper union, no modifier-key gate.
// ---------------------------------------------------------------------------

export { RegionDropRouter, acceptedIntents, defaultIntent } from './show/region-drop-intent';
export type { RegionDropRouterProps, RegionDrop, DropIntentCapability, DropIntentPack } from './show/region-drop-intent';

// ---------------------------------------------------------------------------
// NodeRef — the one universal addressed handle for any interactable object
// (tab/container/group/layout/drawing/board-item). Generic layers (context
// menu, decoration, reorder, history) act on a NodeRef; no node-kind union.
// ---------------------------------------------------------------------------

// NODE_REF_ATTR, serializeNodeRef, parseNodeRef, sameNodeRef, closestNodeRef, acceptedNodeActions, indexNodeActions, acceptedBatchActions, indexBatchActions, useNodeContextMenu: import from ./show/node-actions itself; kept off this barrel so only the screens using it load it.
// NodeRef, NodeActionCapability, NodeActionPack, BatchActionCapability, BatchActionPack, BatchRunContext, NodeContextMenuHandle: import from ./show/node-actions itself; kept off this barrel so only the screens using it load it.

// ---------------------------------------------------------------------------
// Selection (P1) · Canvas history (undo/redo) · Marquee hit-test
// ---------------------------------------------------------------------------

export { useSelection } from './show/selection';
export type { SelectionApi } from './show/selection';
// useCanvasHistory, pushCommand, popUndo, popRedo, EMPTY_HISTORY: import from ./show/canvas-history itself; kept off this barrel so only the screens using it load it.
// HistoryCommand, HistoryState, CanvasHistory: import from ./show/canvas-history itself; kept off this barrel so only the screens using it load it.
// refsInRect, rectFromPoints, rectsIntersect: import from ./show/canvas-viewport/marquee itself; kept off this barrel so only the screens using it load it.
// ClientRect, RefsInRectOptions: import from ./show/canvas-viewport/marquee itself; kept off this barrel so only the screens using it load it.
// STAGE_CHROME_ATTR, stageChromeProps, pressIsOnStageChrome: import from ./show/canvas-viewport/stage-chrome itself; kept off this barrel so only the screens using it load it.
// Canvas-tool primitive: active-tool + gesture-intent table (pointer-meaning SSOT).
// CANVAS_TOOLS, TEMPORARY_TOOLS, indexTools, toolForShortcut, resolveTemporaryTool, resolveIntent, chordOf, useCanvasTool, CanvasToolPicker: import from ./show/canvas-tools itself; kept off this barrel so only the screens using it load it.
// CanvasPoint, CanvasHit, CanvasHitKind, GestureChord, GesturePhase, CanvasIntent, CanvasIntentKind, ToolGestureTable, CanvasToolDescriptor, TemporaryToolRule, IntentHandler, IntentHandlerArgs, IntentHandlerMap, CanvasToolApi, UseCanvasToolOptions, CanvasToolPickerProps: import from ./show/canvas-tools itself; kept off this barrel so only the screens using it load it.

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

export { Reveal } from './show/reveal/Reveal';
export type { RevealProps } from './show/reveal/Reveal';
export { OpenScale } from './show/open-scale/OpenScale';
export type { OpenScaleProps } from './show/open-scale/OpenScale';
export { ArrangementThumbnail } from './show/arrangement-thumbnail';
export type { ArrangementThumbnailBox, ArrangementThumbnailProps } from './show/arrangement-thumbnail';
export { PickerTile } from './show/picker-tile/PickerTile';
export type { PickerTileProps } from './show/picker-tile/PickerTile';

// ---------------------------------------------------------------------------
// SelectablePillBar
// ---------------------------------------------------------------------------

export { SelectablePillBar } from './show/selectable-pill-bar/SelectablePillBar';
export type { SelectablePillBarItem, SelectablePillBarProps } from './show/selectable-pill-bar/SelectablePillBar';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export { Input, Textarea } from './show/input';
export { useControlledTextSelection } from './show/input';
export type { ControlledTextSelection, InputProps, TextareaProps } from './show/input';
export { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './show/coss/ui/select';

// ---------------------------------------------------------------------------
// Chart: one chart family (line, area, bar, stacked bars, sparkline, ring, heat map) drawn from DATA placements
// ---------------------------------------------------------------------------

export { Chart } from './show/chart/Chart';
export type { ChartProps } from './show/chart/Chart';
export { ChartPlacement, ChartPlacements, ChartsOver } from './show/chart/ChartPlacement';
export { chartFromRecords, chartOfPoints, registerChartFormula, registerChartBucket, registerChartValueReader } from './show/chart/chart-from-records';
export { registerChartMark } from './show/chart/chart-marks';
export type { ChartData, ChartLine, ChartLineRow, ChartPlacement as ChartPlacementRow, ChartSeries, ChartSlot } from './show/chart/chart-types';

// ---------------------------------------------------------------------------
// LiveWaveform
// ---------------------------------------------------------------------------

export { LiveWaveform } from './show/live-waveform';
export type { LiveWaveformProps } from './show/live-waveform';

// ---------------------------------------------------------------------------
// MarkdownBlock
// ---------------------------------------------------------------------------

export { MarkdownBlock, markdownBlockVariants } from './show/markdown-block/MarkdownBlock';
export type { MarkdownBlockProps } from './show/markdown-block/MarkdownBlock';

// ---------------------------------------------------------------------------
// MetricRow
// ---------------------------------------------------------------------------

export { MetricRow } from './show/metric-row/MetricRow';
export type { MetricRowProps, MetricCell, MetricCellTone } from './show/metric-row/MetricRow';

// ---------------------------------------------------------------------------
// OneStepAtATimeSurface
// ---------------------------------------------------------------------------

export {
  OneStepAtATimeSurface,
  type OneStepAtATimeItem,
  type OneStepAtATimeSurfaceProps,
} from './show/one-step-at-a-time-surface';

// ---------------------------------------------------------------------------
// PlaceableSurfaceIntent
// ---------------------------------------------------------------------------

// PLACEABLE_SURFACE_MIME, AddressedSurfaceIntentRecipient, admitPlaceableSurfaceEntry, emitPlaceableSurfaceIntent, emitAddressedSurfaceIntentRequest, hasPlaceableSurface, hasPlaceableSurfaceEntryCarrier, hasPlaceableSurfaceEntryData, findPlaceableSurfaces, findPlaceableSurfaceForEntryContext, emitPlaceableSurfaceForEntryContext, entryContextMatchesMatcher, placeableSurfaceMatchesEntryContext, placeableSurfaceCatalogForViewer, placeableSurfacePayloadForEntryContext, placeableSurfacePayloadFromRecord, readPlaceableSurfaces, readEntryContextFromLocation, readPlaceableSurfaceEntryDescriptor, readPlaceableSurfacePayload, readPlaceableSurfacePayloadFromUnknown, readAddressedSurfaceIntentRequest, readPlaceableSurfaceSubject, readPublishedRecords, readViewerAccessRefs, setPlaceableSurfaceDragData, ViewerAccessRefsContext, ViewerAccessRefsProvider: import from ./show/placeable-surface-intent itself; kept off this barrel so only the screens using it load it.
// EntryContext, EntryContextMatcher, PlaceableSurfaceAdmissionSurface, PlaceableSurfaceEntryDescriptor, PlaceableSurfacePackageEntryReference, PlaceableSurfacePayload, AddressedSurfaceIntentRequest, AddressedSurfaceIntentSource, PlaceableSurfaceRecord, PlaceableSurfaceSubjectSnapshot, PublishedRecord: import from ./show/placeable-surface-intent itself; kept off this barrel so only the screens using it load it.

// TuningPanel — every setting drawn as a visual control beside the real thing; changes apply at once.
export { TuningPanel, TuningControl, TuningColorField, TuningSliderField, TuningSampleTile, TUNING_WIDGETS, TUNING_PLACEMENT, colourCode, ScrubField, ShadowField, CurveField, SOFT_SHADOW, shadowCss, readShadowCss, curveCss, readCurveCss, curveOf, settingFromCss, settingToCss } from './show/tuning-panel';
export { TuningSplitPreview } from './show/tuning-panel';
export type { TuningSplitPreviewProps } from './show/tuning-panel';
export type { TuningPanelProps, TuningControlProps, TuningSection, TuningSetting, TuningSample, TuningOption, TuningValue, ScrubFieldProps, TuningShadow, TuningCurve } from './show/tuning-panel';

// ---------------------------------------------------------------------------
// There is no Modal, BottomSheet or full-screen ImmersiveView. Nothing opens as a blocking dialog: a panel
// over the page is the movable, resizable FloatingPanel owned by
// packages/screen-arrangement/show/FloatingPanel (React) and
// mount-floating-panel (imperative openWorkPanel / mountFloatingPanel).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export { Pricing } from './show/pricing';
export type { PricingProps, PricingTier } from './show/pricing';

// ---------------------------------------------------------------------------
// ProgressBar
// ---------------------------------------------------------------------------

export { ProgressBar } from './show/progress-bar';
export type { ProgressBarProps } from './show/progress-bar';

// ---------------------------------------------------------------------------
// PathRail — winding learning-path (Duolingo-style) primitives
// ---------------------------------------------------------------------------

export { PathRail, PathNode, windingOffsets, decodePathNodes } from './show/path-rail';
export type { PathRailProps, PathNodeProps, PathNodeView, WindingConfig, RawPathNode, PathStatusOverride, PathStatusOverrides, PathIconResolver, DecodePathNodesOptions } from './show/path-rail';

// ---------------------------------------------------------------------------
// BreathingPacer — guided breathing circle (Calm/Headspace/Breathwrk anatomy)
// ---------------------------------------------------------------------------

export { BreathingPacer, decodeBreathingCycle } from './show/breathing-pacer';
export type { BreathingPacerProps, RawBreathingPhase, ResolvedBreathingPhase, BreathingLabelView, BreathingCycleView, DecodeBreathingCycleOptions } from './show/breathing-pacer';

// ---------------------------------------------------------------------------
// ProtocolSession — guided step-through session (start → paced/timed/prompt/
// input steps → measured completion). Steps + rules arrive as data.
// ---------------------------------------------------------------------------
export { ProtocolSession } from './show/protocol-session/ProtocolSession';
export type { ProtocolSessionProps, ProtocolSessionStep, SessionLifecycleEvent } from './show/protocol-session/ProtocolSession';
export {
  initialSessionState,
  reduceSession,
  summarizeSession,
} from './show/protocol-session/protocol-session-machine';
export type {
  ProtocolStep,
  AdvanceCondition,
  SessionState,
  SessionEvent,
  SessionSummary,
  StepCapture,
  StepTranscriptEntry,
} from './show/protocol-session/protocol-session-machine';
export { createStepAdvanceRegistry, canAdvanceStep } from './show/protocol-session/advance-registry';
export type { StepSignals, StepAdvancePredicate } from './show/protocol-session/advance-registry';
export { createStepContentRegistry } from './show/protocol-session/step-content-registry';
export type { StepContentProps, StepContentRenderer } from './show/protocol-session/step-content-registry';

// ---------------------------------------------------------------------------
// Timeline — vertical connected timeline (routine / schedule / checklist)
// ---------------------------------------------------------------------------

export { Timeline } from './show/timeline';
export type { TimelineProps, TimelineItemView } from './show/timeline';

export { OutputFieldList } from './show/output-field-list';
export type { OutputFieldListProps, OutputField } from './show/output-field-list';
// SchemaValueView — any JSON value shown as a designed view picked by its shape (result-views.json), no raw-data toggle
export { SchemaValueView } from './show/schema-value-view/SchemaValueView';
export type { SchemaValueViewProps, JsonSchema, ValuePiece } from './show/schema-value-view/SchemaValueView';
export { valuePieces, plainLabel } from './show/schema-value-view/value-shape';
export { resultView } from './show/schema-value-view/result-view';
export type { ResultView } from './show/schema-value-view/result-view';

export { RunCard } from './show/run-card';
export type { RunCardProps } from './show/run-card';

export { ResponsiveSwitch } from './show/responsive-switch';
export type { ResponsiveSwitchProps } from './show/responsive-switch';

export { SafeErrorCard, sanitizeErrorText, errorWords } from './show/safe-error-card';
export type { SafeErrorCardProps } from './show/safe-error-card';

// ---------------------------------------------------------------------------
// PositionGrid
// ---------------------------------------------------------------------------

export { PositionGrid } from './show/position-grid';
export type { PositionGridProps } from './show/position-grid';

// ---------------------------------------------------------------------------
// SegmentedControl
// ---------------------------------------------------------------------------

export { SegmentedControl } from './show/segmented-control';
export type { SegmentedControlItem, SegmentedControlProps } from './show/segmented-control';
export { ExpandableTabs, mountExpandableTabs } from './show/expandable-tabs';
export type { ExpandableTab, ExpandableTabItem, ExpandableTabSeparator, ExpandableTabsProps } from './show/expandable-tabs';

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export { Slider } from './show/slider';
export type { SliderProps } from './show/slider';
export { SpeedControl, speedLabel, speedOnScale, speedScale } from './show/speed-control';
export type { SpeedControlProps, SpeedScale } from './show/speed-control';
// RangeInput — bare track+thumb (no label card); for inline clusters like zoom.
// RangeInput: import from ./show/range-input itself; kept off this barrel so only the screens using it load it.
// RangeInputProps: import from ./show/range-input itself; kept off this barrel so only the screens using it load it.

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

export { Spinner } from './show/spinner';
export type { SpinnerProps } from './show/spinner';

// ---------------------------------------------------------------------------
// LoadingOverlay
// ---------------------------------------------------------------------------

export { LoadingOverlay } from './show/loading-overlay/LoadingOverlay';
export type { LoadingOverlayProps } from './show/loading-overlay/LoadingOverlay';

// ---------------------------------------------------------------------------
// StatStrip
// ---------------------------------------------------------------------------

export { StatStrip } from './show/stat-strip';
export type { StatStripItem, StatStripProps } from './show/stat-strip';

// ---------------------------------------------------------------------------
// StatusDot
// ---------------------------------------------------------------------------

export { statusView } from './show/status-vocabulary';
export type { StatusView, StatusTone, StatusOverrides } from './show/status-vocabulary';

export { StatusDot, statusDotVariants } from './show/status-dot';
export { HealthDot } from './show/status-dot';
export type { StatusDotProps, HealthDotProps } from './show/status-dot';

// ---------------------------------------------------------------------------
// StatusCard
// ---------------------------------------------------------------------------

export { StatusCard } from './show/status-card';
export type { StatusCardProps } from './show/status-card';

// ---------------------------------------------------------------------------
// StatusRow
// ---------------------------------------------------------------------------

export { StatusRow } from './show/status-row';
export type { StatusRowProps } from './show/status-row';

// ---------------------------------------------------------------------------
// SeverityRow
// ---------------------------------------------------------------------------

export { SeverityRow } from './show/severity-row';
export type { SeverityRowProps } from './show/severity-row';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export { Text, textVariants } from './show/text';
export type { TextProps } from './show/text';
export {
  ExpressionComposer,
  applyExpressionCompletion,
  insertExpressionReference,
  replaceExpressionSpan,
} from './show/expression-composer';
export type {
  ExpressionCompletionItem,
  ExpressionComposerContentSlot,
  ExpressionComposerLabels,
  ExpressionComposerModalityHelp,
  ExpressionComposerProps,
  ExpressionComposerResult,
  ExpressionComposerState,
  ExpressionComposerUndoState,
  ExpressionDiagnosticAction,
  ExpressionDiagnosticItem,
  ExpressionExplanationSection,
  ExpressionReferenceItem,
  ExpressionSourceChange,
  ExpressionSourceSpan,
} from './show/expression-composer';

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export { Tooltip } from './show/tooltip';
export type { TooltipProps } from './show/tooltip';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export { Tabs, TabsList, TabsTrigger, TabsContent } from './show/tabs';
export type {
  TabsProps,
  TabsListProps,
  TabsTriggerProps,
  TabsContentProps,
} from './show/tabs';

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

export { ToastProvider, useToastContext } from './show/toast';
export { notify, clearNotifications, notificationCenter, ensureNotificationHost, NOTIFICATION_UNREAD_BADGE } from './show/coss/notifications';
export { mountNotificationPanel } from './show/coss/notification-panel';
export { NotificationPanel } from './show/notifications/NotificationPanel';
export { publishSurfaceBadge, readSurfaceBadge, subscribeSurfaceBadges, useSurfaceBadge } from './show/surface-badges/surface-badges';
export type { SurfaceBadge } from './show/surface-badges/surface-badges';
export { SurfacePreviewCard } from './show/surface-preview/SurfacePreviewCard';
export type { SurfacePreview } from './show/surface-preview/SurfacePreviewCard';
export { FloatingGrab } from './show/floating-grab/FloatingGrab';
export { createNotificationCenter, describeTransfer, formatBytes, formatRemaining } from './show/notifications/notification-center';
export type { NotificationCenter, NotificationInput, NotificationHandle, NotificationRecord, NotificationAction, NotificationProgress, NotificationChange } from './show/notifications/notification-center';

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export { Toggle } from './show/toggle';
export type { ToggleProps } from './show/toggle';

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export { Switch } from './show/switch';
export type { SwitchProps } from './show/switch';
export { SwitchMatrix } from './show/switch-matrix';
export type { SwitchMatrixColumn, SwitchMatrixProps, SwitchMatrixRow } from './show/switch-matrix';

// ---------------------------------------------------------------------------
// StructuredValueEditor
// ---------------------------------------------------------------------------

export { StructuredValueEditor } from './show/structured-value-editor';
export type { StructuredValueEditorProps } from './show/structured-value-editor';

// ---------------------------------------------------------------------------
// PersonTag
// ---------------------------------------------------------------------------

export { PersonTag } from './show/person-tag';
export type { PersonTagProps } from './show/person-tag';

// ---------------------------------------------------------------------------
// PaneTab
// ---------------------------------------------------------------------------

export { PaneTab, paneTabVariants } from './show/pane-tab';
export type { PaneTabProps } from './show/pane-tab';
export { PaneTabV2, paneTabV2Variants } from './show/pane-tab';
export type { PaneTabV2Props } from './show/pane-tab';

// ---------------------------------------------------------------------------
// FocusOverlay
// ---------------------------------------------------------------------------

export { FocusOverlay } from './show/focus-overlay';
export type { FocusOverlayProps } from './show/focus-overlay';

// ---------------------------------------------------------------------------
// FileWorkAction
// ---------------------------------------------------------------------------

export { FileWorkAction } from './show/file-work-action';
export type { FileWorkActionProps } from './show/file-work-action';

// ---------------------------------------------------------------------------
// TextWorkAction
// ---------------------------------------------------------------------------

export { TextWorkAction } from './show/text-work-action';
export type { TextWorkActionProps } from './show/text-work-action';

// ---------------------------------------------------------------------------
// FloatingMaterialFrame
// ---------------------------------------------------------------------------

export { FloatingMaterialFrame } from './show/floating-material-frame';
export type { FloatingMaterialFrameProps } from './show/floating-material-frame';

// ---------------------------------------------------------------------------
// Kbd
// ---------------------------------------------------------------------------

export { Kbd, kbdVariants } from './show/kbd';
export type { KbdProps } from './show/kbd';

// ---------------------------------------------------------------------------
// ShortcutSheet — domain-blind keyboard-shortcuts cheat sheet (FloatingPanel +
// Text + Kbd). Owner supplies a `{ heading, rows: { label, keys }[] }[]` catalog;
// the sheet renders it grouped with keycaps. Knows nothing about what any
// shortcut does (the ui-stays-blind catalog pattern).
// ---------------------------------------------------------------------------

// ShortcutSheet: import from ./show/keyboard-shortcuts/ShortcutSheet itself; kept off this barrel so only the screens using it load it.
// ShortcutSheetProps, ShortcutGroup, ShortcutRow: import from ./show/keyboard-shortcuts/ShortcutSheet itself; kept off this barrel so only the screens using it load it.

// ---------------------------------------------------------------------------
// Keyboard-claim — the cross-surface keyboard OWNERSHIP contract for global
// (window/document) key listeners: claim = preventDefault + stopPropagation,
// stand down on defaultPrevented. Compose withKeyboardClaim around any global
// keydown handler so a key claimed by one pane is dead to every other pane.
// ---------------------------------------------------------------------------

// claimKeyboardEvent, keyboardEventClaimed, withKeyboardClaim: import from ./show/keyboard-claim/keyboard-claim itself; kept off this barrel so only the screens using it load it.
export { invokeLocalActionInput, registerLocalActionInput } from './show/local-action-input-registry';

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableColumnResizeHandle } from './show/table';
export type { TableCellProps } from './show/table';

// ---------------------------------------------------------------------------
// DiffView
// ---------------------------------------------------------------------------

export { DiffView, computeUnifiedDiff } from './show/diff-view';
export type { DiffViewProps, DiffLine } from './show/diff-view';

// ---------------------------------------------------------------------------
// RichTextEditor
// ---------------------------------------------------------------------------

// RichTextEditor: import from ./show/rich-text-editor/RichTextEditor itself; kept off this barrel so only the screens using it load it.
// RichTextEditorProps: import from ./show/rich-text-editor/RichTextEditor itself; kept off this barrel so only the screens using it load it.
// RichTextToolbar, DEFAULT_FORMAT_COMMANDS, RICH_FORMAT_COMMANDS, FORMAT_FONT_OPTIONS: import from ./show/rich-text-toolbar itself; kept off this barrel so only the screens using it load it.
// RichTextToolbarProps, FormatCommand, FormatOption: import from ./show/rich-text-toolbar itself; kept off this barrel so only the screens using it load it.
// RichTextPaintControl — paint any text run (or one letter) with the infinite
// visual-layer paint (colour/gradient/mesh/edge), clipped to the glyphs.
// RichTextPaintControl, normalizePaintSpans, resolvePaintTarget, PAINT_STACK_ATTR: import from ./show/rich-text-paint itself; kept off this barrel so only the screens using it load it.
// RichTextPaintControlProps: import from ./show/rich-text-paint itself; kept off this barrel so only the screens using it load it.

// ---------------------------------------------------------------------------
// ScrollableSurface
// ---------------------------------------------------------------------------

export { ScrollableSurface } from './show/scrollable-surface';
export type { ScrollableSurfaceProps } from './show/scrollable-surface';

// ---------------------------------------------------------------------------
// VirtualList
// ---------------------------------------------------------------------------

export { VirtualList } from './show/virtual-list';
export type { VirtualListProps } from './show/virtual-list';

// ---------------------------------------------------------------------------
// ActionControl
// ---------------------------------------------------------------------------

export { ActionControl } from './show/action-control/ActionControl';
export type { ActionControlProps } from './show/action-control/ActionControl';

// ---------------------------------------------------------------------------
// MediaCarousel
// ---------------------------------------------------------------------------

export { MediaCarousel } from './show/media-carousel';
export type { MediaCarouselItem, MediaCarouselProps } from './show/media-carousel';

// ---------------------------------------------------------------------------
// Media editor visual primitives (Waveform, ClipBlock, Playhead, TimeRuler,
// TransportBar, ToolTile, MediaFrame, MediaThumb)
// ---------------------------------------------------------------------------

export * from './show/waveform/Waveform';
export * from './show/clip-block/ClipBlock';
export * from './show/playhead/Playhead';
export * from './show/time-ruler/TimeRuler';
export * from './show/transport-bar/TransportBar';
export * from './show/tool-tile/ToolTile';
export * from './show/media-thumb/MediaThumb';
export * from './show/overlay-layer/OverlayLayer';
export * from './show/caption-overlay/CaptionOverlay';
export * from './show/caption-overlay/StyledCaption';
export * from './show/text-overlay/TextOverlay';

// ---------------------------------------------------------------------------
// InlineEditText
// ---------------------------------------------------------------------------

export { InlineEditText } from './show/inline-edit-text/InlineEditText';
export type { InlineEditTextProps, InlineEditTextVariant } from './show/inline-edit-text/InlineEditText';

// ---------------------------------------------------------------------------
// useNarrowViewport
// ---------------------------------------------------------------------------

export { useNarrowViewport, PHONE_MAX_WIDTH_PX } from './show/use-narrow-viewport/useNarrowViewport';

export { mountCandidateField } from './show/coss/candidate-field';
export type { Candidate } from './show/coss/candidate-field';

// Floating panel opener: one seam to unpin any content into the shared PiP panel.
export { provideFloatingPanelOpener, canOpenFloatingPanel, openFloatingPanel } from './show/floating-panel-opener';
export type { FloatingPanelHandle, FloatingPanelRequest, FloatingPanelOpener } from './show/floating-panel-opener';
export { SectionedPanels, type PanelNavigationGroup } from './show/sectioned-panels/SectionedPanels';

export { ActionMenu } from './show/action-menu';
export type { ActionMenuItem, ActionMenuProps } from './show/action-menu';

export { AnatomyFigure } from './show/anatomy/AnatomyFigure';
export type { AnatomyFigureValue } from './show/anatomy/AnatomyFigure';

export { GanttChart } from './show/gantt-chart';
export type { GanttAxis, GanttEdge, GanttChartHandle, GanttChartProps, GanttHeading, GanttJoin, GanttRow } from './show/gantt-chart';
