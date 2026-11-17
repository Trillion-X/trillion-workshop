// bitfield/packages/ui/index.ts
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

export { cn } from '../../../ui/show/cn';
export { AskBar } from '../../../ui/show/ask-bar';
export type { AskBarProps, AskBarSuggestion } from '../../../ui/show/ask-bar';
export { applySceneStyleToElement, realizeSceneStyle, sceneStyleToCss } from '../../../ui/show/composition-scene-style';
export type { CompositionSceneStyle, SceneStyleRealization } from '../../../ui/show/composition-scene-style';
export { downloadBlob, downloadTextFile } from '../../../ui/show/file-download/download-file';
export { svgToPngBlob, parseSvgSize, svgDataUrl } from '../../../ui/show/raster/svg-to-png';
export { copyImageBlobToClipboard } from '../../../ui/show/clipboard/copy-blob';
export { copyTextToClipboard } from '../../../ui/show/clipboard/copy-text';
export { mergeOutputDestinations, findOutputDestination } from '../../../ui/show/output-destination';
export type { OutputPayload, OutputDeliverCapability, OutputDestination } from '../../../ui/show/output-destination';
export { buildSurfaceOutputDispatcher } from '../../../ui/show/surface-output';
export type { SurfaceOutput, SurfaceOutputEventDetail } from '../../../ui/show/surface-output';
export { Notice } from '../../../ui/show/notice/Notice';
export type { NoticeProps, NoticeTone, NoticePlacement } from '../../../ui/show/notice/Notice';
export { mountReactMaterial, mountReactSurface } from '../../../ui/show/react-surface-mount';
export type { ReactMaterialMountArgs, ReactSurfaceUnmount } from '../../../ui/show/react-surface-mount';
export {
  SourceBytesScreenMount,
  cleanupSourceBytesScreenMount,
  isUint8Array,
  stableValueKey,
} from '../../../ui/show/source-bytes-screen-mount';
export {
  PlaceableSurfaceHost,
  packageEntryBytesAddressLabel,
} from '../../../ui/show/placeable-surface-host';
export type { PlaceableSurfaceHostProps } from '../../../ui/show/placeable-surface-host';
export type {
  SourceBytesScreenMountElement,
  SourceBytesScreenMountProps,
  SourceBytesScreenMountRequest,
  SourceBytesScreenRuntime,
} from '../../../ui/show/source-bytes-screen-mount';

// ---------------------------------------------------------------------------
// AvatarGroup
// ---------------------------------------------------------------------------

export { AvatarGroup } from '../../../ui/show/avatar-group';
export type { AvatarGroupItem, AvatarGroupProps } from '../../../ui/show/avatar-group';
export {
  LiveSurfacePeopleOverlay,
  LiveSurfacePeopleRoster,
  liveSurfaceInitials,
  stableLiveSurfaceColor,
} from '../../../ui/show/live-surface-people';
export type {
  LiveSurfaceBounds,
  LiveSurfaceBoundsSource,
  LiveSurfacePeopleOverlayProps,
  LiveSurfacePeopleRosterProps,
  LiveSurfacePersonView,
  LiveSurfacePoint,
} from '../../../ui/show/live-surface-people';

// ---------------------------------------------------------------------------
// DisplayMark — THE universal identity-mark renderer (image|glyph|monogram ×
// shape × tint × badge × stack). Subsumes ServiceMark + ParticipantRouteMark
// (both deleted). SelectableAvatar still pending DisplayMark multi-corner-badge
// support (check + dot simultaneously). See chat contract § Phase E.
// ---------------------------------------------------------------------------

export { DisplayMark, displayMarkVariants } from '../../../ui/show/display-mark';
export type {
  DisplayMarkProps,
  DisplayMarkSpec,
  DisplayMarkBadge,
  DisplayMarkTint,
} from '../../../ui/show/display-mark';

// ProviderMark remains a shared UI identity primitive. Service-connections and
// other provider-neutral surfaces consume it through this public barrel.
export {
  ProviderMark,
  normalizeProviderSlug,
  readProviderIconRegistry,
  resolveProviderMark,
} from '../../../ui/show/provider-mark';
export type {
  ProviderMarkProps,
  ProviderIconRegistryEntry,
  ProviderIconRegistryRow,
  ProviderIconBundledAsset,
  ProviderIconVector,
  ProviderIdentity,
  ResolvedProviderMark,
} from '../../../ui/show/provider-mark';

// ---------------------------------------------------------------------------
// Bar
// ---------------------------------------------------------------------------

export { AudioClipPlayer } from '../../../ui/show/audio-clip-player/AudioClipPlayer';
export {
  isSelfDescribingChunkRef,
  readSelfDescribingChunkBlob,
} from '../../../ui/show/media-bytes/read-self-describing-chunk-blob';
export type { SelfDescribingChunkRef } from '../../../ui/show/media-bytes/read-self-describing-chunk-blob';
// The engine's own /cas/ byte transport. `ui` declares the `network` reach for these
// routes so a surface wanting engine bytes imports this reader instead of fetching.
export {
  chunkHashesFromManifest,
  assembleCasChunkManifestBlob,
  defaultCasFetch,
} from '../../../ui/show/media-bytes/read-cas-chunk-manifest-blob';
export type { CasFetch, CasChunkManifestRef } from '../../../ui/show/media-bytes/read-cas-chunk-manifest-blob';

export type { AudioClipPlayerProps } from '../../../ui/show/audio-clip-player/AudioClipPlayer';
export { HoverRevealGroup, HoverRevealItem } from '../../../ui/show/hover-reveal';
export { DragHandleMenu } from '../../../ui/show/drag-handle-menu';
export { SceneFrame } from '../../../ui/show/scene-frame';
export type { SceneFrameProps, SceneFrameRect } from '../../../ui/show/scene-frame';
export { SceneResizeHandles, applySceneResize, handleMovesOrigin } from '../../../ui/show/scene-resize-handles/SceneResizeHandles';
export type { SceneResizeHandlesProps, SceneResizeRect, SceneResizeHandleId } from '../../../ui/show/scene-resize-handles/SceneResizeHandles';
export { CanvasHud } from '../../../ui/show/canvas-hud/CanvasHud';
export type { CanvasHudProps } from '../../../ui/show/canvas-hud/CanvasHud';
export { PersistenceStatus } from '../../../ui/show/persistence-status/PersistenceStatus';
export type { PersistenceStatusProps, PersistenceTone } from '../../../ui/show/persistence-status/PersistenceStatus';
export { SplitDividers } from '../../../ui/show/split-dividers/SplitDividers';
export type { SplitDividersProps, SplitDividerView } from '../../../ui/show/split-dividers/SplitDividers';
export { ConditionEditor } from '../../../ui/show/condition-editor/ConditionEditor';
export type { ConditionEditorProps, ConditionDraft, ConditionOperatorOption } from '../../../ui/show/condition-editor/ConditionEditor';
export { SpacingEditor } from '../../../ui/show/spacing-editor/SpacingEditor';
export type { SpacingEditorProps, SpacingFieldView } from '../../../ui/show/spacing-editor/SpacingEditor';
export type { DragHandleAction, DragHandleMenuProps } from '../../../ui/show/drag-handle-menu';
export type { HoverRevealGroupProps, HoverRevealItemProps } from '../../../ui/show/hover-reveal';
export { Bar, barVariants, barSegmentVariants } from '../../../ui/show/bar/Bar';
export type { BarProps, BarSegment } from '../../../ui/show/bar/Bar';

// ---------------------------------------------------------------------------
// WorkStartState
// ---------------------------------------------------------------------------

export { WorkSkeletonRows, WorkStartState } from '../../../ui/show/work-start-state';
export type { WorkStartItem, WorkStartStateProps } from '../../../ui/show/work-start-state';

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export { Badge, badgeVariants } from '../../../ui/show/badge';
export type { BadgeProps } from '../../../ui/show/badge';

// ---------------------------------------------------------------------------
// BulkSelectBar
// ---------------------------------------------------------------------------

export { BulkSelectBar } from '../../../ui/show/bulk-select-bar';
export type { BulkSelectBarAction, BulkSelectBarProps } from '../../../ui/show/bulk-select-bar';

// ---------------------------------------------------------------------------
// BitfieldBrand
// ---------------------------------------------------------------------------

export { BitfieldBrand } from '../../../ui/show/brand/BitfieldBrand';
export type { BitfieldBrandProps } from '../../../ui/show/brand/BitfieldBrand';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export { Button, buttonVariants } from '../../../ui/show/button';
export type { ButtonProps } from '../../../ui/show/button';

// ---------------------------------------------------------------------------
// CapabilityIconRow
// ---------------------------------------------------------------------------

export { CapabilityIconRow } from '../../../ui/show/capability-icon-row';
export type { CapabilityIconRowItem, CapabilityIconRowProps } from '../../../ui/show/capability-icon-row';

// ---------------------------------------------------------------------------
// CodeDisplay
// ---------------------------------------------------------------------------

export { CodeDisplay } from '../../../ui/show/code-display';
export type { CodeDisplayProps } from '../../../ui/show/code-display';

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export { Card, cardVariants } from '../../../ui/show/card';
export type { CardProps } from '../../../ui/show/card';
export { EditorialLinkCard } from '../../../ui/show/editorial-link-card/EditorialLinkCard';
export type { EditorialLinkCardProps } from '../../../ui/show/editorial-link-card/EditorialLinkCard';

// ---------------------------------------------------------------------------
// EventInvitation + Tilt
// ---------------------------------------------------------------------------

export { EventInvitation } from '../../../ui/show/event-invitation';
export type { EventInvitationFact, EventInvitationProps } from '../../../ui/show/event-invitation';
export {
  MORPHING_RIBBON_GUIDES,
  MORPHING_RIBBON_PATHS,
  MORPHING_RIBBON_REFERENCE_VIEWBOX,
  MorphingRibbon,
} from '../../../ui/show/morphing-ribbon';
export type {
  MorphingRibbonFrame,
  MorphingRibbonMotion,
  MorphingRibbonProps,
} from '../../../ui/show/morphing-ribbon';
export { Tilt, normalizeTiltPointerPosition } from '../../../ui/show/tilt';
export type { TiltProps } from '../../../ui/show/tilt';

// ---------------------------------------------------------------------------
// CanvasDotGrid
// ---------------------------------------------------------------------------

export { CanvasDotGrid } from '../../../ui/show/canvas-dot-grid';
export type { CanvasDotGridProps } from '../../../ui/show/canvas-dot-grid';
// CanvasSurface — the generic surface primitive (color + DATA tile) of which the
// dot-grid is one configuration. Used for board-level background looks.
export { CanvasSurface } from '../../../ui/show/canvas-surface';
export type { CanvasSurfaceProps, CanvasSurfaceTile } from '../../../ui/show/canvas-surface';
// SurfaceSwatch — a selectable preview tile of a CanvasSurface look (color + tile),
// for "background" pickers. Blind to what it previews; feature catalogs feed it DATA.
export { SurfaceSwatch } from '../../../ui/show/surface-swatch';
export type { SurfaceSwatchProps } from '../../../ui/show/surface-swatch';
export { CanvasViewport } from '../../../ui/show/canvas-viewport/CanvasViewport';
export type { CanvasViewportProps } from '../../../ui/show/canvas-viewport/CanvasViewport';
export { SelectionBoundsOverlay } from '../../../ui/show/selection-bounds';
export type { SelectionBoundsOverlayProps, BoundsRect, BoundsHandle } from '../../../ui/show/selection-bounds';
export { CropOverlay } from '../../../ui/show/crop-overlay';
export type { CropOverlayProps, CropOverlayRect, CropOverlayWindow, CropHandle } from '../../../ui/show/crop-overlay';
export { CaptionScroll } from '../../../ui/show/caption-scroll';
export type { CaptionScrollProps } from '../../../ui/show/caption-scroll';

// ---------------------------------------------------------------------------
// CanvasEdgeOverlay
// ---------------------------------------------------------------------------

export { CanvasEdgeOverlay } from '../../../ui/show/canvas-edge-overlay';
export type { CanvasEdgeOverlayProps } from '../../../ui/show/canvas-edge-overlay';

// ---------------------------------------------------------------------------
// CanvasMinimap
// ---------------------------------------------------------------------------

export { CanvasMinimap } from '../../../ui/show/canvas-minimap';
export type { CanvasMinimapProps, CanvasMinimapFrame } from '../../../ui/show/canvas-minimap';
export { DotPlacementMap } from '../../../ui/show/canvas-minimap';
export type { DotPlacementMapProps, DotPlacementFrame } from '../../../ui/show/canvas-minimap';

// ---------------------------------------------------------------------------
// CanvasNode
// ---------------------------------------------------------------------------

export { CanvasNode, applyResizeGeom, RESIZE_EDGES, RESIZE_CURSOR } from '../../../ui/show/canvas-node';
export type { CanvasNodeProps, ResizeEdge, Rect } from '../../../ui/show/canvas-node';
export { NodeGraph, mountNodeGraph } from '../../../ui/show/node-graph';
export type { NodeGraphProps, GraphNodeInput, GraphEdgeInput, MountedNodeGraph } from '../../../ui/show/node-graph';
export { CanvasShape } from '../../../ui/show/canvas-shape';
export type { CanvasShapeProps } from '../../../ui/show/canvas-shape';
export { CanvasFrame } from '../../../ui/show/canvas-frame/CanvasFrame';
export type { CanvasFrameProps } from '../../../ui/show/canvas-frame/CanvasFrame';
// CanvasPresentBar — blind bottom-center present-mode control bar (◀ position title ▶ ✕).
export { CanvasPresentBar } from '../../../ui/show/canvas-present-bar';
export type { CanvasPresentBarProps } from '../../../ui/show/canvas-present-bar';
// CommandPalette — blind Cmd-K launcher over a caller-supplied action catalog (DATA).
export { CommandPalette, filterCommands } from '../../../ui/show/command-palette';
export type { CommandPaletteProps, CommandPaletteItem } from '../../../ui/show/command-palette';
// action-affordance — decode/filter/resolve/author `kind:"action-affordance"` published
// records (invoke an admitted workflow action from named render contexts). Pure: hosts
// inject dispatch senders and own reads/writes/output placement.
export {
  readActionAffordances,
  affordancesForChannel,
  triggerForChannel,
  resolveBindingTemplate,
  buildDispatchPayload,
  affordancePaletteItems,
  affordanceNodeActions,
  buildActionAffordanceRecord,
  buildActionAffordanceWriteItem,
  writeActionAffordanceLive,
  ActionAffordanceEditor,
  registerLocalActorAdmission,
} from '../../../ui/show/action-affordance';
export type {
  ActionAffordance,
  ActionAffordanceTrigger,
  ActionAffordanceDispatch,
  ActionAffordanceStatus,
  AffordanceInvokeContext,
  AffordanceInvoke,
  ActionAffordanceDraft,
  ActionAffordanceWriteItem,
  ActionAffordanceEditorProps,
  AffordanceDefinitionOption,
  AffordanceChannelOption,
  AdmissionRecipe,
  LocalPermissionRequest,
  LocalPermissionResult,
} from '../../../ui/show/action-affordance';
// AnchoredOverlay — portal-to-body floating panel (escapes parent clip), height-
// clamped + scrollable + optionally draggable. For toolbars/popovers on clipped surfaces.
export { AnchoredOverlay } from '../../../ui/show/anchored-overlay';
export type { AnchoredOverlayProps } from '../../../ui/show/anchored-overlay';

// ---------------------------------------------------------------------------
// CompositionGraph — the recursive NodeRef composition primitive (RG-1/RG-2):
// container/tab-group/layout/group/board/archive are all configurations of one
// `{ref, members?}` node; every behavior resolves through the uniform FacetRegistry.
// ---------------------------------------------------------------------------

export type { CompositionNode, GroupMember, CompositionGraph, FoldVisit, FacetRegistry } from '../../../ui/show/composition-graph';
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
} from '../../../ui/show/composition-graph';

// ---------------------------------------------------------------------------
// EdgeAutoHide — generic off-screen auto-hiding edge panel (U2). Wrap any
// content; unpinned it slides fully off the docked edge and a thin hotzone
// reveals it on pointer-enter. Position-aware (top/left/bottom/right).
// ---------------------------------------------------------------------------

export { EdgeAutoHide, edgeTransform, hotzoneStyle, panelAnchorStyle, isHorizontalEdge, isRevealed } from '../../../ui/show/edge-auto-hide';
export type { EdgeAutoHideProps, DockEdge } from '../../../ui/show/edge-auto-hide';

// LAYER_ORDER — single ordered stacking scale (SSOT). Named z layers declared in
// one place so cross-scene stacking (floating panel > stage > its own hotzone) is
// auditable instead of bare magic numbers scattered across components.
export { LAYER_ORDER } from '../../../ui/show/layer-order/layer-order';
export type { LayerName } from '../../../ui/show/layer-order/layer-order';

export { ControlRailButton } from '../../../ui/show/control-rail-button/ControlRailButton';
export type { ControlRailButtonProps } from '../../../ui/show/control-rail-button/ControlRailButton';

export { CaptureControl, formatElapsed } from '../../../ui/show/capture-control/CaptureControl';
export type { CaptureControlProps, CaptureControlState } from '../../../ui/show/capture-control/CaptureControl';

// ---------------------------------------------------------------------------
// CanvasWorldTransform
// ---------------------------------------------------------------------------

export { CanvasWorldTransform } from '../../../ui/show/canvas-world-transform';
export type { CanvasWorldTransformProps } from '../../../ui/show/canvas-world-transform';

// ---------------------------------------------------------------------------
// CodeBlock
// ---------------------------------------------------------------------------

export { CodeBlock, codeBlockVariants } from '../../../ui/show/code-block/CodeBlock';
export type { CodeBlockProps } from '../../../ui/show/code-block/CodeBlock';

// ---------------------------------------------------------------------------
// CopyablePath
// ---------------------------------------------------------------------------

export { DatePicker } from '../../../ui/show/date-picker/DatePicker';
export type { DatePickerProps } from '../../../ui/show/date-picker/DatePicker';

export { CopyablePath, copyablePathVariants } from '../../../ui/show/copyable-path/CopyablePath';
export type { CopyablePathProps } from '../../../ui/show/copyable-path/CopyablePath';

// ---------------------------------------------------------------------------
// ColorDot
// ---------------------------------------------------------------------------

export { DropIndicator } from '../../../ui/show/drop-indicator';
export type { DropIndicatorProps } from '../../../ui/show/drop-indicator';
export { CompletionRing } from '../../../ui/show/completion-ring';
export type { CompletionRingProps } from '../../../ui/show/completion-ring';
export { ScoreRing } from '../../../ui/show/score-ring/ScoreRing';
export type { ScoreRingProps, ScoreRingTone } from '../../../ui/show/score-ring/ScoreRing';
export { ColorDot, colorDotVariants } from '../../../ui/show/color-dot';
export type { ColorDotProps } from '../../../ui/show/color-dot';
export { NativeColorInput, NativeColorPickerPanel } from '../../../ui/show/native-color-picker';
export type { NativeColorInputProps, NativeColorPickerPanelProps } from '../../../ui/show/native-color-picker';
export { ColorWheel, hsvaToHex, hexToHsva, hsvaToRgba, rgbaToHsva, parseHex, hueBaseHex } from '../../../ui/show/color-wheel';
export type { ColorWheelProps, Hsva, Rgba } from '../../../ui/show/color-wheel';
// In-app anchored color picker (ColorWheel + Save in an AnchoredOverlay) — the
// reusable alternative to the native input whose OS picker lands top-of-screen.
export { ColorPickerPopover } from '../../../ui/show/color-picker-popover';
export type { ColorPickerPopoverProps } from '../../../ui/show/color-picker-popover';

// Color/tag option picker (list of dot+label+delete rows in an AnchoredOverlay) —
// data-driven selection for status/priority/category fields with uniform row anatomy.
export { ColorTagPickerOverlay } from '../../../ui/show/color-tag-picker-overlay';
export type { ColorTagOption, ColorTagPickerOverlayProps } from '../../../ui/show/color-tag-picker-overlay';

export { RenamePanel, ColorPanel, GrainPanel, BackgroundPickerPanel, BookmarksPanel, LayerStackPanel } from '../../../ui/show/node-editors';
export type { LayerStackPanelProps, LayerRowInfo, LayerAddOption, BookmarkRowInfo } from '../../../ui/show/node-editors';
export { NavArrows } from '../../../ui/show/nav-arrows/NavArrows';
export type { NavArrowsProps } from '../../../ui/show/nav-arrows/NavArrows';
export {
  recordVisit,
  stepBack,
  stepForward,
  canStepBack,
  canStepForward,
  currentRef,
  clampCursor,
} from '../../../ui/show/nav-arrows/node-history-model';
export type { NodeHistoryEntry, NodeHistoryTrail } from '../../../ui/show/nav-arrows/node-history-model';
// RecentItems — the MRU jump-list algebra. DISTINCT from the NavigationTrail
// cursor above (no cursor / no back-forward / no drop-forward). web-frame's
// "Recent pages" list consumes this; screen-arrangement's pane history consumes
// the NavigationTrail. They are different algebras (B1 false-primitive split).
export { recordRecent, forgetRecent } from '../../../ui/show/recent-items/recent-items';
export type { RecentItem } from '../../../ui/show/recent-items/recent-items';
export { Inline } from '../../../ui/show/inline/Inline';
export type { InlineProps } from '../../../ui/show/inline/Inline';

// ---------------------------------------------------------------------------
// OpenSurfaceAction
// ---------------------------------------------------------------------------

export { OpenSurfaceAction } from '../../../ui/show/open-surface-action';
export type { OpenSurfaceActionProps } from '../../../ui/show/open-surface-action';

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export { Container, containerVariants } from '../../../ui/show/container';
export type { ContainerProps } from '../../../ui/show/container';

// ---------------------------------------------------------------------------
// CollapsiblePanel
// ---------------------------------------------------------------------------

export { CollapsiblePanel } from '../../../ui/show/collapsible-panel';
export type {
  CollapsiblePanelContext,
  CollapsiblePanelProps,
} from '../../../ui/show/collapsible-panel';

// ---------------------------------------------------------------------------
// InboxThreePane — generic rail | list | detail inbox shell (responsive)
// ---------------------------------------------------------------------------
export {
  InboxThreePane,
  visiblePaneAtWidth,
  shallowerPane,
  DEFAULT_INBOX_NARROW_BREAKPOINT_PX,
} from '../../../ui/show/inbox-3pane';
export type {
  InboxThreePaneProps,
  InboxPane,
  InboxPaneVisibility,
} from '../../../ui/show/inbox-3pane';

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
} from '../../../ui/show/dockable-placement';
export type {
  DockFloatRect,
  DockMode,
  DockPosition,
  DockState,
  DockablePlacementController,
  DockablePlacementState,
  DockablePlacementStore,
  PositionCompassProps,
} from '../../../ui/show/dockable-placement';

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

export { Divider } from '../../../ui/show/divider/Divider';
export type { DividerProps } from '../../../ui/show/divider/Divider';

// ---------------------------------------------------------------------------
// DisclosureSection — titled (optionally collapsible) group of settings rows
// ---------------------------------------------------------------------------

export { DisclosureSection } from '../../../ui/show/disclosure-section/DisclosureSection';
export type { DisclosureSectionProps } from '../../../ui/show/disclosure-section/DisclosureSection';

// ---------------------------------------------------------------------------
// DragReorderList
// ---------------------------------------------------------------------------

export { DragReorderList, reorderIds } from '../../../ui/show/drag-reorder-list';
export type { DragReorderListItem, DragReorderListProps } from '../../../ui/show/drag-reorder-list';

// ---------------------------------------------------------------------------
// AnimatedReorder (generic FLIP animator for any ordered list)
// ---------------------------------------------------------------------------

export { AnimatedReorder, flipInvert } from '../../../ui/show/animated-reorder/AnimatedReorder';
export type {
  AnimatedReorderItem,
  AnimatedReorderProps,
  AnimatedReorderDirection,
  AnimatedReorderGap,
  AnimatedReorderAlign,
} from '../../../ui/show/animated-reorder/AnimatedReorder';

// ---------------------------------------------------------------------------
// Dropdown
// ---------------------------------------------------------------------------

export { Dropdown } from '../../../ui/show/dropdown';
export type { DropdownProps, DropdownItem, DropdownItemState } from '../../../ui/show/dropdown';
export { PlacementHistoryMenu } from '../../../ui/show/placement-history';
export type { PlacementHistoryEntry, PlacementHistoryMenuProps } from '../../../ui/show/placement-history';

// ---------------------------------------------------------------------------
// GroupedPicker
// ---------------------------------------------------------------------------
// Generic grouped dropdown (section headers + description rows + active
// checkmark; the Granola/ChatGPT model-picker anatomy). Elevated from the former
// chat-local InlineDropdown so every package composes ONE picker (L069/L066).

export { GroupedPicker } from '../../../ui/show/grouped-picker';
export type { GroupedPickerProps } from '../../../ui/show/grouped-picker';

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export { Form } from '../../../ui/show/form/Form';
export type { FormProps } from '../../../ui/show/form/Form';

// ---------------------------------------------------------------------------
// EmptyPlaceholder
// ---------------------------------------------------------------------------

export { EmptyPlaceholder } from '../../../ui/show/empty-placeholder';
export type { EmptyPlaceholderProps } from '../../../ui/show/empty-placeholder';

// ---------------------------------------------------------------------------
// StatementHeader
// ---------------------------------------------------------------------------

export { StatementHeader } from '../../../ui/show/statement-header';
export type { StatementHeaderProps } from '../../../ui/show/statement-header';

// ---------------------------------------------------------------------------
// CalendarGrid — domain-blind date-bucket grid
// ---------------------------------------------------------------------------

export { CalendarGrid } from '../../../ui/show/calendar-grid';
export type {
  CalendarGridProps,
  CalendarGridCell,
  CalendarGridDensity,
} from '../../../ui/show/calendar-grid';

// ---------------------------------------------------------------------------
// HourGrid — domain-blind timed-lane grid (minute axis, hairlines, now-line,
// interval pills with color spine; overlap placement supplied as data)
// ---------------------------------------------------------------------------

export { HourGrid } from '../../../ui/show/hour-grid';
export type {
  HourGridProps,
  HourGridLane,
  HourGridItem,
} from '../../../ui/show/hour-grid';

// ---------------------------------------------------------------------------
// NestedNavigation — drill-in list and its floating picker
// ---------------------------------------------------------------------------

export { NestedNavigationList } from '../../../ui/show/nested-navigation/NestedNavigationList';
export type { NestedNavigationCollection, NestedNavigationItem, NestedNavigationListProps } from '../../../ui/show/nested-navigation/NestedNavigationList';
export { NestedNavigationPicker } from '../../../ui/show/nested-navigation/NestedNavigationPicker';
export type { NestedNavigationPickerProps } from '../../../ui/show/nested-navigation/NestedNavigationPicker';

// ---------------------------------------------------------------------------
// Globe
// ---------------------------------------------------------------------------

export { Globe } from '../../../ui/show/globe';
export type { GlobeProps, GlobeNode, GlobeEdge } from '../../../ui/show/globe';

// ---------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------

export { Icon, NamedIcon, resolveNamedIcon, iconVariants } from '../../../ui/show/icon';
export type { IconProps, NamedIconProps } from '../../../ui/show/icon';
export { IconTile, iconTileVariants } from '../../../ui/show/icon-tile/IconTile';
export type { IconTileProps } from '../../../ui/show/icon-tile/IconTile';

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------

export { ErrorBoundary } from '../../../ui/show/error-boundary';
export type { ErrorBoundaryProps, ErrorBoundaryState } from '../../../ui/show/error-boundary';

export { EvidenceSourceCard } from '../../../ui/show/evidence-source-card';
export type { EvidenceSourceCardProps } from '../../../ui/show/evidence-source-card';

// ---------------------------------------------------------------------------
// ImageBlock
// ---------------------------------------------------------------------------

export { ImageBlock, imageBlockVariants } from '../../../ui/show/image-block/ImageBlock';
export type { ImageBlockProps } from '../../../ui/show/image-block/ImageBlock';

// ---------------------------------------------------------------------------
// FilePreview — native per-MIME preview (video/audio/image play+show; else embed)
// ---------------------------------------------------------------------------

export { FilePreview } from '../../../ui/show/file-preview/FilePreview';
export type { FilePreviewProps } from '../../../ui/show/file-preview/FilePreview';

// ---------------------------------------------------------------------------
// VisualLayerStack — region = ordered layer stack; paint dispatched by data
// (capabilityId) through an owner-injected capability map. No closed kind union.
// ---------------------------------------------------------------------------

export { VisualLayerStack, LayerStackEditor, createCapabilityMap, builtinVisualLayerCapabilities, isVisualLayerStackRecord, composeStackTextStyle } from '../../../ui/show/visual-layer-stack';
export type {
  VisualLayerStackProps,
  LayerStackEditorProps,
  FrameDef,
  VisualLayerCapability,
  VisualLayerCapabilityMap,
  VisualLayerRenderContext,
  AddressRef,
  CapabilityRef,
  CapabilityInvocation,
  VisualLayerDescriptor,
  VisualLayerStackRecord,
  VisualLayerOrder,
  VisualLayerFrame,
  VisualLayerComposite,
} from '../../../ui/show/visual-layer-stack';

export { readVisualLayerDrop, canPaintDataTransfer, subjectAddressRef, createVisualLayerSubjectResolver } from '../../../ui/show/visual-layer-intent';
export type { VisualLayerDrop } from '../../../ui/show/visual-layer-intent';

// ---------------------------------------------------------------------------
// RegionDropRouter — a dropped subject dispatched by data to one of N owner-
// provided drop intents (accepts/apply). Default intent owns the whole region;
// other intents render as distinct zones. Sibling of VisualLayerCapability;
// no closed tab/wallpaper union, no modifier-key gate.
// ---------------------------------------------------------------------------

export { RegionDropRouter, acceptedIntents, defaultIntent } from '../../../ui/show/region-drop-intent';
export type { RegionDropRouterProps, RegionDrop, DropIntentCapability, DropIntentPack } from '../../../ui/show/region-drop-intent';

// ---------------------------------------------------------------------------
// NodeRef — the one universal addressed handle for any interactable object
// (tab/container/group/layout/drawing/board-item). Generic layers (context
// menu, decoration, reorder, history) act on a NodeRef; no node-kind union.
// ---------------------------------------------------------------------------

export {
  NODE_REF_ATTR,
  serializeNodeRef,
  parseNodeRef,
  sameNodeRef,
  closestNodeRef,
  acceptedNodeActions,
  indexNodeActions,
  acceptedBatchActions,
  indexBatchActions,
  useNodeContextMenu,
} from '../../../ui/show/node-actions';
export type {
  NodeRef,
  NodeActionCapability,
  NodeActionPack,
  BatchActionCapability,
  BatchActionPack,
  BatchRunContext,
  NodeContextMenuHandle,
} from '../../../ui/show/node-actions';

// ---------------------------------------------------------------------------
// Selection (P1) · Canvas history (undo/redo) · Marquee hit-test
// ---------------------------------------------------------------------------

export { useSelection } from '../../../ui/show/selection';
export type { SelectionApi } from '../../../ui/show/selection';
export {
  useCanvasHistory,
  pushCommand,
  popUndo,
  popRedo,
  EMPTY_HISTORY,
} from '../../../ui/show/canvas-history';
export type { HistoryCommand, HistoryState, CanvasHistory } from '../../../ui/show/canvas-history';
export { refsInRect, rectFromPoints, rectsIntersect } from '../../../ui/show/canvas-viewport/marquee';
export type { ClientRect, RefsInRectOptions } from '../../../ui/show/canvas-viewport/marquee';
export { STAGE_CHROME_ATTR, stageChromeProps, pressIsOnStageChrome } from '../../../ui/show/canvas-viewport/stage-chrome';
// Canvas-tool primitive: active-tool + gesture-intent table (pointer-meaning SSOT).
export {
  CANVAS_TOOLS,
  TEMPORARY_TOOLS,
  indexTools,
  toolForShortcut,
  resolveTemporaryTool,
  resolveIntent,
  chordOf,
  useCanvasTool,
  CanvasToolPicker,
} from '../../../ui/show/canvas-tools';
export type {
  CanvasPoint,
  CanvasHit,
  CanvasHitKind,
  GestureChord,
  GesturePhase,
  CanvasIntent,
  CanvasIntentKind,
  ToolGestureTable,
  CanvasToolDescriptor,
  TemporaryToolRule,
  IntentHandler,
  IntentHandlerArgs,
  IntentHandlerMap,
  CanvasToolApi,
  UseCanvasToolOptions,
  CanvasToolPickerProps,
} from '../../../ui/show/canvas-tools';

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

export { Reveal } from '../../../ui/show/reveal/Reveal';
export type { RevealProps } from '../../../ui/show/reveal/Reveal';
export { OpenScale } from '../../../ui/show/open-scale/OpenScale';
export type { OpenScaleProps } from '../../../ui/show/open-scale/OpenScale';
export { PickerTile } from '../../../ui/show/picker-tile/PickerTile';
export type { PickerTileProps } from '../../../ui/show/picker-tile/PickerTile';

// ---------------------------------------------------------------------------
// SelectableAvatar
// ---------------------------------------------------------------------------

export { SelectableAvatar } from '../../../ui/show/selectable-avatar';
export type { SelectableAvatarProps } from '../../../ui/show/selectable-avatar';

// ---------------------------------------------------------------------------
// SelectablePillBar
// ---------------------------------------------------------------------------

export { SelectablePillBar } from '../../../ui/show/selectable-pill-bar/SelectablePillBar';
export type { SelectablePillBarItem, SelectablePillBarProps } from '../../../ui/show/selectable-pill-bar/SelectablePillBar';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export { Input, Textarea } from '../../../ui/show/input';
export { useControlledTextSelection } from '../../../ui/show/input';
export type { ControlledTextSelection, InputProps, TextareaProps } from '../../../ui/show/input';
export { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../../../ui/show/coss/ui/select';

// ---------------------------------------------------------------------------
// LineChart
// ---------------------------------------------------------------------------

export { LineChart, lineChartVariants } from '../../../ui/show/line-chart/LineChart';
export type { LineChartProps, LineChartTone } from '../../../ui/show/line-chart/LineChart';

// ---------------------------------------------------------------------------
// LiveWaveform
// ---------------------------------------------------------------------------

export { LiveWaveform } from '../../../ui/show/live-waveform';
export type { LiveWaveformProps } from '../../../ui/show/live-waveform';

// ---------------------------------------------------------------------------
// MarkdownBlock
// ---------------------------------------------------------------------------

export { MarkdownBlock, markdownBlockVariants } from '../../../ui/show/markdown-block/MarkdownBlock';
export type { MarkdownBlockProps } from '../../../ui/show/markdown-block/MarkdownBlock';

// ---------------------------------------------------------------------------
// MetricRow
// ---------------------------------------------------------------------------

export { MetricRow } from '../../../ui/show/metric-row/MetricRow';
export type { MetricRowProps, MetricCell, MetricCellTone } from '../../../ui/show/metric-row/MetricRow';

// ---------------------------------------------------------------------------
// OneStepAtATimeSurface
// ---------------------------------------------------------------------------

export {
  OneStepAtATimeSurface,
  type OneStepAtATimeItem,
  type OneStepAtATimeSurfaceProps,
} from '../../../ui/show/one-step-at-a-time-surface';

// ---------------------------------------------------------------------------
// PlaceableSurfaceIntent
// ---------------------------------------------------------------------------

export {
  PLACEABLE_SURFACE_MIME,
  AddressedSurfaceIntentRecipient,
  admitPlaceableSurfaceEntry,
  emitPlaceableSurfaceIntent,
  emitAddressedSurfaceIntentRequest,
  hasPlaceableSurface,
  hasPlaceableSurfaceEntryCarrier,
  hasPlaceableSurfaceEntryData,
  findPlaceableSurfaces,
  findPlaceableSurfaceForEntryContext,
  emitPlaceableSurfaceForEntryContext,
  entryContextMatchesMatcher,
  placeableSurfaceMatchesEntryContext,
  placeableSurfaceCatalogForViewer,
  placeableSurfacePayloadForEntryContext,
  placeableSurfacePayloadFromRecord,
  readPlaceableSurfaces,
  readEntryContextFromLocation,
  readPlaceableSurfaceEntryDescriptor,
  readPlaceableSurfacePayload,
  readPlaceableSurfacePayloadFromUnknown,
  readAddressedSurfaceIntentRequest,
  readPlaceableSurfaceSubject,
  readPublishedRecords,
  readViewerAccessRefs,
  setPlaceableSurfaceDragData,
  ViewerAccessRefsContext,
  ViewerAccessRefsProvider,
} from '../../../ui/show/placeable-surface-intent';
export type {
  EntryContext,
  EntryContextMatcher,
  PlaceableSurfaceAdmissionSurface,
  PlaceableSurfaceEntryDescriptor,
  PlaceableSurfacePackageEntryReference,
  PlaceableSurfacePayload,
  AddressedSurfaceIntentRequest,
  AddressedSurfaceIntentSource,
  PlaceableSurfaceRecord,
  PlaceableSurfaceSubjectSnapshot,
  PublishedRecord,
} from '../../../ui/show/placeable-surface-intent';

// ---------------------------------------------------------------------------
// PropertyControl — ONE blind descriptor-driven control (slider/toggle/segmented/
// number/select/color) dispatched via a widget capability map. Elevated from the
// group appearance pattern so grid/board/any surface renders adjustable-property
// controls from one primitive instead of duplicating controls per package.
// ---------------------------------------------------------------------------

export { PropertyControl, coercePropertyValue } from '../../../ui/show/property-control';
export type { PropertyControlDescriptor, PropertyControlProps } from '../../../ui/show/property-control';

// ---------------------------------------------------------------------------
// There is no Modal, BottomSheet or full-screen ImmersiveView. Nothing opens as a blocking dialog: a panel
// over the page is the movable, resizable FloatingPanel owned by
// packages/screen-arrangement/show/FloatingPanel (React) and
// mount-floating-panel (imperative openWorkPanel / mountFloatingPanel).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export { Pricing } from '../../../ui/show/pricing';
export type { PricingProps, PricingTier } from '../../../ui/show/pricing';

// ---------------------------------------------------------------------------
// ProgressBar
// ---------------------------------------------------------------------------

export { ProgressBar } from '../../../ui/show/progress-bar';
export type { ProgressBarProps } from '../../../ui/show/progress-bar';

// ---------------------------------------------------------------------------
// PathRail — winding learning-path (Duolingo-style) primitives
// ---------------------------------------------------------------------------

export { PathRail, PathNode, windingOffsets, decodePathNodes } from '../../../ui/show/path-rail';
export type { PathRailProps, PathNodeProps, PathNodeView, WindingConfig, RawPathNode, PathStatusOverride, PathStatusOverrides, PathIconResolver, DecodePathNodesOptions } from '../../../ui/show/path-rail';

// ---------------------------------------------------------------------------
// BreathingPacer — guided breathing circle (Calm/Headspace/Breathwrk anatomy)
// ---------------------------------------------------------------------------

export { BreathingPacer, decodeBreathingCycle } from '../../../ui/show/breathing-pacer';
export type { BreathingPacerProps, RawBreathingPhase, ResolvedBreathingPhase, BreathingLabelView, BreathingCycleView, DecodeBreathingCycleOptions } from '../../../ui/show/breathing-pacer';

// ---------------------------------------------------------------------------
// ProtocolSession — guided step-through session (start → paced/timed/prompt/
// input steps → measured completion). Steps + rules arrive as data.
// ---------------------------------------------------------------------------
export { ProtocolSession } from '../../../ui/show/protocol-session/ProtocolSession';
export type { ProtocolSessionProps, ProtocolSessionStep, SessionLifecycleEvent } from '../../../ui/show/protocol-session/ProtocolSession';
export {
  initialSessionState,
  reduceSession,
  summarizeSession,
} from '../../../ui/show/protocol-session/protocol-session-machine';
export type {
  ProtocolStep,
  AdvanceCondition,
  SessionState,
  SessionEvent,
  SessionSummary,
  StepCapture,
  StepTranscriptEntry,
} from '../../../ui/show/protocol-session/protocol-session-machine';
export { createStepAdvanceRegistry, canAdvanceStep } from '../../../ui/show/protocol-session/advance-registry';
export type { StepSignals, StepAdvancePredicate } from '../../../ui/show/protocol-session/advance-registry';
export { createStepContentRegistry } from '../../../ui/show/protocol-session/step-content-registry';
export type { StepContentProps, StepContentRenderer } from '../../../ui/show/protocol-session/step-content-registry';

// ---------------------------------------------------------------------------
// Timeline — vertical connected timeline (routine / schedule / checklist)
// ---------------------------------------------------------------------------

export { Timeline } from '../../../ui/show/timeline';
export type { TimelineProps, TimelineItemView } from '../../../ui/show/timeline';

export { OutputFieldList } from '../../../ui/show/output-field-list';
export type { OutputFieldListProps, OutputField } from '../../../ui/show/output-field-list';

export { RunCard } from '../../../ui/show/run-card';
export type { RunCardProps } from '../../../ui/show/run-card';

export { ResponsiveSwitch } from '../../../ui/show/responsive-switch';
export type { ResponsiveSwitchProps } from '../../../ui/show/responsive-switch';

export { SafeErrorCard, sanitizeErrorText } from '../../../ui/show/safe-error-card';
export type { SafeErrorCardProps } from '../../../ui/show/safe-error-card';

// ---------------------------------------------------------------------------
// PositionGrid
// ---------------------------------------------------------------------------

export { PositionGrid } from '../../../ui/show/position-grid';
export type { PositionGridProps } from '../../../ui/show/position-grid';

// ---------------------------------------------------------------------------
// HeatGrid
// ---------------------------------------------------------------------------

export { HeatGrid } from '../../../ui/show/heat-grid';
export type { HeatGridProps } from '../../../ui/show/heat-grid';

// ---------------------------------------------------------------------------
// SegmentedControl
// ---------------------------------------------------------------------------

export { SegmentedControl } from '../../../ui/show/segmented-control';
export type { SegmentedControlItem, SegmentedControlProps } from '../../../ui/show/segmented-control';
export { ExpandableTabs, mountExpandableTabs } from '../../../ui/show/expandable-tabs';
export type { ExpandableTab, ExpandableTabItem, ExpandableTabSeparator, ExpandableTabsProps } from '../../../ui/show/expandable-tabs';

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

export { Slider } from '../../../ui/show/slider';
export type { SliderProps } from '../../../ui/show/slider';
// RangeInput — bare track+thumb (no label card); for inline clusters like zoom.
export { RangeInput } from '../../../ui/show/range-input';
export type { RangeInputProps } from '../../../ui/show/range-input';

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

export { Sparkline, sparklineVariants } from '../../../ui/show/sparkline/Sparkline';
export type { SparklineProps, SparklinePoint } from '../../../ui/show/sparkline/Sparkline';

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

export { Spinner } from '../../../ui/show/spinner';
export type { SpinnerProps } from '../../../ui/show/spinner';

// ---------------------------------------------------------------------------
// LoadingOverlay
// ---------------------------------------------------------------------------

export { LoadingOverlay } from '../../../ui/show/loading-overlay/LoadingOverlay';
export type { LoadingOverlayProps } from '../../../ui/show/loading-overlay/LoadingOverlay';

// ---------------------------------------------------------------------------
// StatStrip
// ---------------------------------------------------------------------------

export { StatStrip } from '../../../ui/show/stat-strip';
export type { StatStripItem, StatStripProps } from '../../../ui/show/stat-strip';

// ---------------------------------------------------------------------------
// StatusDot
// ---------------------------------------------------------------------------

export { statusView } from '../../../ui/show/status-vocabulary';
export type { StatusView, StatusTone, StatusOverrides } from '../../../ui/show/status-vocabulary';

export { StatusDot, statusDotVariants } from '../../../ui/show/status-dot';
export { HealthDot } from '../../../ui/show/status-dot';
export type { StatusDotProps, HealthDotProps } from '../../../ui/show/status-dot';

// ---------------------------------------------------------------------------
// StatusCard
// ---------------------------------------------------------------------------

export { StatusCard } from '../../../ui/show/status-card';
export type { StatusCardProps } from '../../../ui/show/status-card';

// ---------------------------------------------------------------------------
// StatusRow
// ---------------------------------------------------------------------------

export { StatusRow } from '../../../ui/show/status-row';
export type { StatusRowProps } from '../../../ui/show/status-row';

// ---------------------------------------------------------------------------
// SeverityRow
// ---------------------------------------------------------------------------

export { SeverityRow } from '../../../ui/show/severity-row';
export type { SeverityRowProps } from '../../../ui/show/severity-row';

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export { Text, textVariants } from '../../../ui/show/text';
export type { TextProps } from '../../../ui/show/text';
export {
  ExpressionComposer,
  applyExpressionCompletion,
  insertExpressionReference,
  replaceExpressionSpan,
} from '../../../ui/show/expression-composer';
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
} from '../../../ui/show/expression-composer';

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export { Tooltip } from '../../../ui/show/tooltip';
export type { TooltipProps } from '../../../ui/show/tooltip';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../ui/show/tabs';
export type {
  TabsProps,
  TabsListProps,
  TabsTriggerProps,
  TabsContentProps,
} from '../../../ui/show/tabs';

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

export { ToastProvider, useToastContext } from '../../../ui/show/toast';
export { notify, clearNotifications, notificationCenter, ensureNotificationHost, mountNotificationPanel, NOTIFICATION_UNREAD_BADGE } from '../../../ui/show/coss/notifications';
export { NotificationPanel } from '../../../ui/show/notifications/NotificationPanel';
export { publishSurfaceBadge, readSurfaceBadge, subscribeSurfaceBadges, useSurfaceBadge } from '../../../ui/show/surface-badges/surface-badges';
export { SurfacePreviewCard } from '../../../ui/show/surface-preview/SurfacePreviewCard';
export type { SurfacePreview } from '../../../ui/show/surface-preview/SurfacePreviewCard';
export { FloatingGrab } from '../../../ui/show/floating-grab/FloatingGrab';
export { createNotificationCenter, describeTransfer, formatBytes, formatRemaining } from '../../../ui/show/notifications/notification-center';
export type { NotificationCenter, NotificationInput, NotificationHandle, NotificationRecord, NotificationAction, NotificationProgress, NotificationChange } from '../../../ui/show/notifications/notification-center';

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export { Toggle } from '../../../ui/show/toggle';
export type { ToggleProps } from '../../../ui/show/toggle';

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export { Switch } from '../../../ui/show/switch';
export type { SwitchProps } from '../../../ui/show/switch';

// ---------------------------------------------------------------------------
// StructuredValueEditor
// ---------------------------------------------------------------------------

export { StructuredValueEditor } from '../../../ui/show/structured-value-editor';
export type { StructuredValueEditorProps } from '../../../ui/show/structured-value-editor';

// ---------------------------------------------------------------------------
// PersonTag
// ---------------------------------------------------------------------------

export { PersonTag } from '../../../ui/show/person-tag';
export type { PersonTagProps } from '../../../ui/show/person-tag';

// ---------------------------------------------------------------------------
// PaneTab
// ---------------------------------------------------------------------------

export { PaneTab, paneTabVariants } from '../../../ui/show/pane-tab';
export type { PaneTabProps } from '../../../ui/show/pane-tab';
export { PaneTabV2, paneTabV2Variants } from '../../../ui/show/pane-tab';
export type { PaneTabV2Props } from '../../../ui/show/pane-tab';

// ---------------------------------------------------------------------------
// FocusOverlay
// ---------------------------------------------------------------------------

export { FocusOverlay } from '../../../ui/show/focus-overlay';
export type { FocusOverlayProps } from '../../../ui/show/focus-overlay';

// ---------------------------------------------------------------------------
// FileWorkAction
// ---------------------------------------------------------------------------

export { FileWorkAction } from '../../../ui/show/file-work-action';
export type { FileWorkActionProps } from '../../../ui/show/file-work-action';

// ---------------------------------------------------------------------------
// TextWorkAction
// ---------------------------------------------------------------------------

export { TextWorkAction } from '../../../ui/show/text-work-action';
export type { TextWorkActionProps } from '../../../ui/show/text-work-action';

// ---------------------------------------------------------------------------
// FloatingMaterialFrame
// ---------------------------------------------------------------------------

export { FloatingMaterialFrame } from '../../../ui/show/floating-material-frame';
export type { FloatingMaterialFrameProps } from '../../../ui/show/floating-material-frame';

// ---------------------------------------------------------------------------
// Kbd
// ---------------------------------------------------------------------------

export { Kbd, kbdVariants } from '../../../ui/show/kbd';
export type { KbdProps } from '../../../ui/show/kbd';

// ---------------------------------------------------------------------------
// ShortcutSheet — domain-blind keyboard-shortcuts cheat sheet (FloatingPanel +
// Text + Kbd). Owner supplies a `{ heading, rows: { label, keys }[] }[]` catalog;
// the sheet renders it grouped with keycaps. Knows nothing about what any
// shortcut does (the ui-stays-blind catalog pattern).
// ---------------------------------------------------------------------------

export { ShortcutSheet } from '../../../ui/show/keyboard-shortcuts/ShortcutSheet';
export type { ShortcutSheetProps, ShortcutGroup, ShortcutRow } from '../../../ui/show/keyboard-shortcuts/ShortcutSheet';

// ---------------------------------------------------------------------------
// Keyboard-claim — the cross-surface keyboard OWNERSHIP contract for global
// (window/document) key listeners: claim = preventDefault + stopPropagation,
// stand down on defaultPrevented. Compose withKeyboardClaim around any global
// keydown handler so a key claimed by one pane is dead to every other pane.
// ---------------------------------------------------------------------------

export { claimKeyboardEvent, keyboardEventClaimed, withKeyboardClaim } from '../../../ui/show/keyboard-claim/keyboard-claim';
export { invokeLocalActionInput, registerLocalActionInput } from '../../../ui/show/local-action-input-registry';

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableColumnResizeHandle } from '../../../ui/show/table';
export type { TableCellProps } from '../../../ui/show/table';

// ---------------------------------------------------------------------------
// DiffView
// ---------------------------------------------------------------------------

export { DiffView, computeUnifiedDiff } from '../../../ui/show/diff-view';
export type { DiffViewProps, DiffLine } from '../../../ui/show/diff-view';

// ---------------------------------------------------------------------------
// RichTextEditor
// ---------------------------------------------------------------------------

export { RichTextEditor } from '../../../ui/show/rich-text-editor/RichTextEditor';
export type { RichTextEditorProps } from '../../../ui/show/rich-text-editor/RichTextEditor';
export { RichTextToolbar, DEFAULT_FORMAT_COMMANDS, RICH_FORMAT_COMMANDS, FORMAT_FONT_OPTIONS } from '../../../ui/show/rich-text-toolbar';
export type { RichTextToolbarProps, FormatCommand, FormatOption } from '../../../ui/show/rich-text-toolbar';
// RichTextPaintControl — paint any text run (or one letter) with the infinite
// visual-layer paint (colour/gradient/mesh/edge), clipped to the glyphs.
export { RichTextPaintControl, normalizePaintSpans, resolvePaintTarget, PAINT_STACK_ATTR } from '../../../ui/show/rich-text-paint';
export type { RichTextPaintControlProps } from '../../../ui/show/rich-text-paint';

// ---------------------------------------------------------------------------
// ScrollableSurface
// ---------------------------------------------------------------------------

export { ScrollableSurface } from '../../../ui/show/scrollable-surface';
export type { ScrollableSurfaceProps } from '../../../ui/show/scrollable-surface';

// ---------------------------------------------------------------------------
// VirtualList
// ---------------------------------------------------------------------------

export { VirtualList } from '../../../ui/show/virtual-list';
export type { VirtualListProps } from '../../../ui/show/virtual-list';

// ---------------------------------------------------------------------------
// ActionControl
// ---------------------------------------------------------------------------

export { ActionControl } from '../../../ui/show/action-control/ActionControl';
export type { ActionControlProps } from '../../../ui/show/action-control/ActionControl';

// ---------------------------------------------------------------------------
// MediaCarousel
// ---------------------------------------------------------------------------

export { MediaCarousel } from '../../../ui/show/media-carousel';
export type { MediaCarouselItem, MediaCarouselProps } from '../../../ui/show/media-carousel';

// ---------------------------------------------------------------------------
// Media editor visual primitives (Waveform, ClipBlock, Playhead, TimeRuler,
// TransportBar, ToolTile, MediaFrame, MediaThumb)
// ---------------------------------------------------------------------------

export * from '../../../ui/show/waveform/Waveform';
export * from '../../../ui/show/clip-block/ClipBlock';
export * from '../../../ui/show/playhead/Playhead';
export * from '../../../ui/show/time-ruler/TimeRuler';
export * from '../../../ui/show/transport-bar/TransportBar';
export * from '../../../ui/show/tool-tile/ToolTile';
export * from '../../../ui/show/media-frame/MediaFrame';
export * from '../../../ui/show/media-thumb/MediaThumb';
export * from '../../../ui/show/overlay-layer/OverlayLayer';
export * from '../../../ui/show/caption-overlay/CaptionOverlay';
export * from '../../../ui/show/text-overlay/TextOverlay';

// ---------------------------------------------------------------------------
// InlineEditText
// ---------------------------------------------------------------------------

export { InlineEditText } from '../../../ui/show/inline-edit-text/InlineEditText';
export type { InlineEditTextProps, InlineEditTextVariant } from '../../../ui/show/inline-edit-text/InlineEditText';

// ---------------------------------------------------------------------------
// useNarrowViewport
// ---------------------------------------------------------------------------

export { useNarrowViewport, PHONE_MAX_WIDTH_PX } from '../../../ui/show/use-narrow-viewport/useNarrowViewport';

export { mountCandidateField } from '../../../ui/show/coss/candidate-field';
export type { Candidate } from '../../../ui/show/coss/candidate-field';

// Floating panel opener: one seam to unpin any content into the shared PiP panel.
export { provideFloatingPanelOpener, canOpenFloatingPanel, openFloatingPanel } from '../../../ui/show/floating-panel-opener';
export type { FloatingPanelHandle, FloatingPanelRequest, FloatingPanelOpener } from '../../../ui/show/floating-panel-opener';
