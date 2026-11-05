// packages/group/show/GroupBoardPanel.tsx
//
// The spatial group board canvas (UI plan v2.0 — Freeform/Pinterest/Craft
// anatomy; logic plan VB3-3). A person opens it and places image/note/media
// items on an infinite dot-grid canvas, drags them, pans/zooms, and every change
// persists to the live engine through the group EEAF write path. Built on the
// SHARED `canvas-*` suite + `CanvasViewport` (L106) — NOT hand-rolled — with item
// content dispatched by a kind→renderer registry (L090). Generic: a board,
// an archive, a moodboard are the same surface at a different board id.
//
// L065: visuals via ui/ components (canvas chrome via the shared canvas suite).
// The board IS a group; an item is a positioned member (position in opaque
// presentation) — the leaf/EEAF stay blind to the owning product.

import { watchBoardLoad } from './board-load.ts';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, CommandPalette, CanvasSurface, CanvasNode, CanvasWorldTransform, AnchoredOverlay, Badge, Card, Container, Dropdown, Icon, MediaCarousel, Text, applyResizeGeom, downloadTextFile, downloadBlob } from '../../ui/index.ts';
import { ShortcutSheet } from '../../ui/show/keyboard-shortcuts/ShortcutSheet';
import { CanvasMinimap } from '../../ui/show/canvas-minimap';
import { CanvasPresentBar } from '../../ui/show/canvas-present-bar';
import { CanvasViewport } from '../../ui/show/canvas-viewport/CanvasViewport';
import { LayerStackEditor, builtinVisualLayerCapabilities } from '../../ui/show/visual-layer-stack';
import { RICH_FORMAT_COMMANDS } from '../../ui/show/rich-text-toolbar';
import { useNodeContextMenu, acceptedBatchActions, serializeNodeRef } from '../../ui/show/node-actions';
import { BulkSelectBar } from '../../ui/show/bulk-select-bar';
import { useCanvasHistory } from '../../ui/show/canvas-history';
import { refsInRect, rectFromPoints } from '../../ui/show/canvas-viewport/marquee';
import { pressIsOnStageChrome, STAGE_CHROME_ATTR } from '../../ui/show/canvas-viewport/stage-chrome';
import { useCanvasTool, CanvasToolPicker, CANVAS_TOOLS, resolveIntent as resolveToolIntent } from '../../ui/show/canvas-tools';
import { SelectionBoundsOverlay } from '../../ui/show/selection-bounds';
import { CropOverlay } from '../../ui/show/crop-overlay';
import { svgToPngBlob } from '../../ui/show/raster/svg-to-png';
import { copyImageBlobToClipboard } from '../../ui/show/clipboard/copy-blob';
import { copyTextToClipboard } from '../../ui/show/clipboard/copy-text.ts';
import { Notice } from '../../ui/show/notice/Notice';
import { withKeyboardClaim } from '../../ui/show/keyboard-claim/keyboard-claim';
import { MediaFrame } from '../../ui/show/media-frame/MediaFrame';
import type { ResizeEdge } from '../../ui/index.ts';
import type { NodeActionPack, NodeRef, BatchActionCapability } from '../../ui/show/node-actions';
import type { CanvasToolApi } from '../../ui/show/canvas-tools';
import type { FrameDef } from '../../ui/show/visual-layer-stack';
import { FolderPlus, Plus, Bookmark, Lock, ArrowLeft, Check, EyeOff, AppWindow, Sparkles, MessageSquare, ThumbsUp, Flame, Target, GitBranch, FileText, SlidersHorizontal } from 'lucide-react';
import type { VisualLayerDescriptor, VisualLayerStackRecord } from '../../ui/show/visual-layer-stack/visual-layer-types';
import type { AddressRef, GroupGraph } from '../../ui/show/group/group-graph';
import { emptyGraph, membersOf } from '../../ui/show/group/group-graph';
import {
  addBoard,
  addBoardEntry,
  duplicateBoard,
  renameBoard,
  archiveBoard,
  archiveStaleCadenceBoards,
  boardIndexRef,
  boardItemContentType,
  readPlaceableSurface,
  boardRootRef,
  cadenceBucket,
  editItem,
  ensureCadenceBoard,
  groupItems,
  groupIndexOf,
  expandSelectionByGroup,
  hasBoard,
  isBoardEmpty,
  itemIsConnector,
  itemIsLocked,
  readActiveBoards,
  readArchivedBoards,
  restoreBoard,
  setBoardBackground,
  setBoardGridSnap,
  setBoardAppearanceKey,
  applyAppearanceProfileToBoard,
  itemRef,
  type CadenceUnit,
  MIN_ITEM_H,
  MIN_ITEM_W,
  moveItem,
  moveItemToGroup,
  resizeItem,
  patchItem,
  placeItem,
  placeSection,
  connectNewNote,
  readItems,
  removeItem,
  sectionRef,
  ungroupItems,
  type BoardItem,
} from '../read-data/group-board-model.ts';
import { groupRecordAddress } from '../read-data/group-eeaf.ts';
import { nearestInDirection, type NavRect, type NavDir } from '../read-data/spatial-nav.ts';
import { panToReveal } from '../read-data/viewport-visibility.ts';
import { viewIndexRef, rememberLastCamera, readLastCamera } from '../read-data/board-view-store.ts';
import { nextInCycle } from '../read-data/cyclic-step.ts';
import { backgroundById, readBackgroundCatalog } from './board-backgrounds.ts';
import { readAppearancePresetCatalog } from './appearance-preset-catalog.ts';
import { makeAppearancePreset, presetIsEmpty } from './appearance-presets.ts';
import { writeAppearancePresetLive } from './write-appearance-preset-live.ts';
import { readProducerStatus, type ProducerStatusAddresses } from '../read-data/read-producer-status.ts';
import { producerStartMs, producerLimitMs, producerTimedOut } from '../read-data/producer-timeout.ts';
import { computeAppearDelays } from '../read-data/appear-stagger.ts';
import { buildItemShelf, ShelfToolButton, rendererForKind, itemFrame, textToHtml, type ShelfEntry, type ShelfVariantCreator } from './item-renderers.tsx';
import { writeBoardCatalogItemLive } from './write-board-catalog-live.ts';
import { BoardActionsButton } from './BoardActionsButton.tsx';
import { readStampCatalog } from './board-stamps.ts';
import { readShapeCatalog } from './board-shapes.ts';
import { readFillSwatchCatalog } from './item-fill.ts';
import { TextInputModal, type TextInputRequest } from './TextInputModal.tsx';
import { PlaceableSurfaceHost } from '../../ui/show/placeable-surface-host';
import {
  readActionAffordances,
  readArchivedActionAffordances,
  writeActionAffordanceLive,
  writeActionAffordanceItemLive,
  archiveActionAffordanceLive,
  setActionAffordanceActiveLive,
  buildActionPresetWriteItem,
  buildActionAffordanceEditWriteItem,
  draftOfActionAffordanceRecord,
  ActionAffordanceEditor,
  ActionForm,
  buildDispatchPayload,
  resolveBindingTemplate,
  getPath,
  type ActionAffordanceDraft,
  type AffordanceDefinitionOption,
  type AffordanceChannelOption,
  type OptionSourceRecord,
  foldAffordanceChannelOptions,
  foldAffordanceDefinitionOptions,
  resolveAskFieldOptions,
  materializeActionFormFile,
  type AskField,
  type AskFieldOption,
} from '../../ui/show/action-affordance';
import {
  BOARD_CHANNELS,
  BOARD_MENU_PLACEMENTS,
  actionNeedsMissingSubject,
  boardAffordancePaletteItems,
  boardAffordanceContextActions,
  ownerSelectionContext,
  templateBindsTypedText,
} from './board-action-affordances.ts';
import { InspectorSidebar } from '../../ui/show/inspector-sidebar';
import { createBlindRegistry } from '../../ui/show/blind-registry/blind-registry';
import { resolveInspection, type InspectionSource, type InspectionWriteDescriptor } from '../../ui/show/inspection-ref';
import {
  BOARD_MODEL_WRITE_KIND,
  boardItemRecordProjection,
  createBoardInspectionRegistry,
  createBoardWriteOpRegistry,
  dispatchBoardModelWrite,
  readInspectionFieldSets,
} from './board-inspection.ts';
import { SavedArrangementGallery } from './SavedArrangementGallery.tsx';
import { applyTemplate, materializeItems, type BoardTemplate, type TemplateItem } from '../read-data/board-template-apply.ts';
import {
  readSavedArrangementLibrary,
  readArrangementLensCatalog,
  saveBoardAsArrangement,
  resolveArrangementTemplate,
  type SavedArrangement,
} from '../read-data/saved-arrangement.ts';
import { boardSelectionToTemplate } from '../read-data/selection-to-template.ts';
import {
  addBasketPick,
  basketPickFromSelection,
  basketToCollection,
  basketToShareCapsule,
  basketItemCount,
  basketBoardCount,
  basketPickCount,
  clearBasket,
} from '../do-work/collection-basket.ts';
import { CollectionSaveButton } from './CollectionSaveButton.tsx';
import { CollectionBasketBar } from './CollectionBasketBar.tsx';
import { ShareScopeControl } from './ShareScopeControl.tsx';
import { RelationInspector } from './RelationInspector.tsx';
import { buildRelationGraph, pathBetween } from '../read-data/relationship-graph.ts';
import { cardReferences, backlinksOf, brokenReferencesFrom } from '../read-data/card-references.ts';
import { orphanCards } from '../read-data/board-orphans.ts';
import { readyCardIds, boardHasReadyCards as computeBoardHasReadyCards } from '../do-work/board-readiness-actions.ts';
import { cardsWithUnlinkedMentions, boardHasUnlinkedMentions as computeBoardHasUnlinkedMentions } from '../read-data/board-mentions.ts';
import { cardsWithQuestions, boardHasQuestions as computeBoardHasQuestions } from '../read-data/board-questions.ts';
import { ambiguousTitleIds, boardHasDuplicateTitles as computeBoardHasDuplicateTitles } from '../read-data/board-titles.ts';
import { cardsWithFragmentedTag, boardHasFragmentedTags as computeBoardHasFragmentedTags } from '../do-work/board-tag-hygiene.ts';
import { canonicalTagMap, canonicalizeTags, tagsEqual } from '../do-work/board-tag-canonicalize.ts';
import { largestIsland, boardHasMultipleClusters as computeBoardHasMultipleClusters } from '../read-data/board-islands.ts';
import { redundantConnectorIds, boardHasDuplicateConnectors as computeBoardHasDuplicateConnectors } from '../read-data/duplicate-connectors.ts';
import { boardSources, boardSinks, boardHasSources as computeBoardHasSources, boardHasSinks as computeBoardHasSinks } from '../do-work/board-sources-sinks.ts';
import { undatedCardIds, boardHasDateGaps as computeBoardHasDateGaps } from '../do-work/board-date-coverage.ts';
import { cardIdsForTopTheme, boardHasThemes as computeBoardHasThemes } from '../read-data/board-themes.ts';
import { cardIdsWithEntity, boardHasEntities as computeBoardHasEntities } from '../read-data/board-entity-index.ts';
import { splitCandidateIds, boardHasSplitCandidates as computeBoardHasSplitCandidates } from '../read-data/board-split-candidates.ts';
import { untaggedCardIds as computeUntaggedCardIds, boardHasTagGaps as computeBoardHasTagGaps } from '../read-data/board-tag-coverage.ts';
import { cardIdsInTopRelationship, boardHasRelationships as computeBoardHasRelationships } from '../read-data/board-connector-legend.ts';
import { cardIdsWithHealthIssues, boardHasHealthIssues as computeBoardHasHealthIssues } from '../read-data/board-health.ts';
import { cardIdsForTopFacetValue, boardHasFacet } from '../read-data/board-facet-census.ts';
import { cardIdsForTopPair, boardHasCooccurrence } from '../read-data/board-cooccurrence.ts';
import { templateChangelog } from '../do-work/board-diff-actions.ts';
import { WalkthroughOverlay, renderedTargetRect } from './WalkthroughOverlay.tsx';
import { BoardToolsPanel } from './BoardToolsPanel.tsx';
import { BoardChromeMenu } from './BoardChromeMenu.tsx';
import { boardSelectionChromeVisible } from './board-selection-chrome-visibility';
import { smartSetIndexRef, readActiveSmartSets, readArchivedSmartSets, readUnavailableSmartSets, saveSmartSet, archiveSmartSet, restoreSmartSet, renameSmartSet, replaceSmartSetQuery, smartQueryText } from '../read-data/saved-smart-set.ts';
import { nextIndex as tourNext, prevIndex as tourPrev, type Tour } from '../read-data/walkthrough.ts';
import { readingTour } from '../do-work/reading-tour-actions.ts';
import { boardHasReadingOrder } from '../read-data/board-reading-order.ts';
import { DraftSparringView, type SparringDraft } from './DraftSparringView.tsx';
import { RewriteLoopView } from './RewriteLoopView.tsx';
import { ListBlockEditor } from './ListBlockEditor.tsx';
import { OutlineDisplay } from './OutlineDisplay.tsx';
import { MarkerPicker } from './MarkerPicker.tsx';
import { type ListItem } from '../read-data/list-block-model.ts';
import { parseOutline, serializeOutline } from '../read-data/outline-text.ts';
import {
  buildShareCapsule,
  capsuleSummary,
  decodeShareLink,
  encodeShareLink,
  hasCapsuleLink,
  type CapsuleSourceItem,
} from '../read-data/share-capsule.ts';
import { boardToCapsuleSource } from '../read-data/board-to-capsule-source.ts';
import { shareReferenceWarnings } from '../do-work/share-reference-warnings.ts';
import type { ShareScopeRequest } from '../read-data/share-scope.ts';
import { boardToTemplate } from '../read-data/group-board-model.ts';
import { runArrangementLibraryAction } from '../read-data/arrangement-library-actions.ts';
import { collectionIndexRef, saveCollection } from '../read-data/collection-store.ts';
import { addStrategyFor, type BoardItemDraft, type PickedBytes } from './item-add-strategies';
import { imageFootprint } from './image-footprint.ts';
import { placeableSurfaceVariants } from './placeable-surface-shelf.ts';
import { commitAddressedPlaceableSurface } from './addressed-placeable-surface-placement.ts';
import { AddressedSurfaceIntentRecipient } from '../../ui/show/placeable-surface-intent/addressed-surface-intent-recipient';
import { normalizeAddressedSurfaceIntentRecords, type SurfaceIntentReaderConfig } from '../../ui/show/placeable-surface-intent/addressed-surface-intent-data';
import { placeableSurfaceCatalogForViewer } from '../../ui/show/placeable-surface-intent/entry-context-intent';
import { surfaceIntentMatchesCatalogPayload } from '../../ui/show/placeable-surface-intent/record-surface-intent';
import { SurfaceIntentReader } from '../../ui/show/placeable-surface-intent/surface-intent-reader';
import { ViewerAccessRefsContext } from '../../ui/show/placeable-surface-intent/viewer-access-refs-context';
import { findPlaceableSurfaces } from '../../ui/show/placeable-surface-intent/placeable-surface-record';
import { readPublishedRecords } from '../../ui/show/placeable-surface-intent/placeable-surface-record';
import { normalizeFeedRows } from '../read-data/feed-rows.ts';
import { useBitfieldData } from '#workspace-records';
import { sendRequestToBitfieldTarget } from '#workspace-records';

import { createGroupBoardStore, type GroupBoardStore } from '../read-data/read-group-board.ts';
import { chooseLocalFiles } from '../../local-files/do-work/choose-local-files';
import { materializeBrowserBytes } from '../../ui/show/action-affordance/materialize-browser-artifact';
import { groupKey } from '../../ui/show/group/group-graph';
import { openExternalHref } from '../do-work/open-external.ts';
import { submitProducerRequest, type ProducerSubmitDescriptor } from '../do-work/submit-producer-request.ts';
import { applyProducerOutput, applyPartialProducerOutput } from '../do-work/apply-producer-output.ts';
import { isSingleUrl, linkCardDraft, readLinkPreview, hostFromHref, mergeLinkPreviewEdit } from '../do-work/link-preview.ts';
import { textToNoteDrafts } from './paste-to-notes.ts';
import { markdownTreeToTemplateItems } from './markdown-to-drafts.ts';
import { routeImport } from './import-router.ts';
import { isImportableTextFile, IMPORT_TEXT_EXTENSIONS } from './document-imports.ts';
import { boardToSvg, exportFillOf, type BoardSvgStyle, type BoardSvgOverlay } from '../do-work/board-svg.ts';
import { boardToDeck, deckToHtml, deckToMediaCarouselItems } from '../do-work/board-deck.ts';
import { boardFrameMedia, type BoardFrameMedia } from '../do-work/board-frame-media.ts';
import { BoardCommentsLayer, type CommentPin } from './BoardCommentsLayer.tsx';
import type { CommentEntry } from '../read-data/board-comments.ts';
type SharedCommentEntry = CommentEntry & { readonly record: string; readonly resolved: boolean };
type SharedCommentSummary = { readonly record: string; readonly count: number; readonly lastAt: number; readonly resolved: boolean };
import { CommentsReviewPanel } from './CommentsReviewPanel.tsx';
import { addCommentToItem, boardCommentThreads, commentThreadOf, setItemThreadResolved } from '../do-work/board-comments-actions.ts';
import { threadSummary, type ThreadSummary } from '../read-data/board-comments.ts';
import { BoardVotesLayer, type VoteChip } from './BoardVotesLayer.tsx';
import { VoteRankingPanel } from './VoteRankingPanel.tsx';
import { boardTallies, castVoteOnItem, voteRankingRows } from '../do-work/board-votes-actions.ts';
import { actorBudgetRemaining, totalVotes, voteCount } from '../read-data/board-votes.ts';
import { ChecklistPanel } from './ChecklistPanel.tsx';
import { BoardChecklistLayer, type ChecklistPill } from './BoardChecklistLayer.tsx';
import { addStepToItem, boardChecklists, boardRollup, checklistOf, removeStepFromItem, toggleStepOnItem } from '../do-work/board-checklist-actions.ts';
import { checklistProgress } from '../read-data/board-checklist.ts';
import { BoardDueDateLayer, type DueBadge } from './BoardDueDateLayer.tsx';
import { InsightsMenu } from './InsightsMenu.tsx';
import { boardInsightLenses } from './board-insight-lenses.tsx';
import { boardDueItems, setItemDueDate } from '../do-work/board-due-date-actions.ts';
import { relativeDue } from '../read-data/board-due-date.ts';
import { BoardHabitLayer, type HabitPill } from './BoardHabitLayer.tsx';
import { PresenceLayer } from './PresenceLayer.tsx';
import { PresenceRoster } from './PresenceRoster.tsx';
import { useBoardPresence } from './use-board-presence.ts';
import { toggleHabitToday, cadenceOfItem, setHabitCadence, itemIsHabitTarget, habitBadgeOf } from '../do-work/board-habit-actions.ts';
import { cadenceLabel, type Cadence } from '../read-data/board-habit-cadence.ts';
import { BoardMetricLayer, type MetricPill } from './BoardMetricLayer.tsx';
import { MetricPanel } from './MetricPanel.tsx';
import { boardMetricSummary, boardMetrics, bumpItemMetric, itemIsMetricTarget, metricOf, setItemMetric } from '../do-work/board-metric-actions.ts';
import { boardCompletion } from '../read-data/board-completion.ts';
import { BoardCompletionChip } from './BoardCompletionChip.tsx';
import { formatValue, isComplete as metricIsComplete, progressPct, setCurrent as metricSetCurrent, setTarget as metricSetTarget } from '../read-data/board-metric.ts';
import { BoardTimeLayer, type TimePill } from './BoardTimeLayer.tsx';
import { TimeLogPanel } from './TimeLogPanel.tsx';
import { boardTimeLogs, clearTimeLog, logMinutes, logSession, removeLastSession, timeLogOf, totalTimeOf } from '../do-work/board-time-log-actions.ts';
import { formatDuration, lastWorkedAtMs, totalDurationMs } from '../read-data/board-time-log.ts';
import { BoardExportPanel } from './BoardExportPanel.tsx';
import { getBoardExportDestinationsWithTargets } from './board-output-destinations.ts';
import { nextFocus } from '../do-work/board-next-focus-actions.ts';
import { BoardRollupLayer, type RollupPill } from './BoardRollupLayer.tsx';
import { RollupPanel } from './RollupPanel.tsx';
import { rollupChildren, rollupOfItem, rollupParents, rollupSpecFromRaw } from '../do-work/board-rollup-actions.ts';
import { relationKinds } from '../read-data/relationship-graph.ts';
import { setBoardRollupSpec } from '../read-data/group-board-model.ts';
import { placeItems, removeItems, removeUnlockedItems, patchItems, moveItemsToGroup } from '../read-data/group-board-model.ts';
import { flattenBoardTree, findMemberRef, findParentRef } from '../read-data/board-tree.ts';
import {
  layoutMixedProducerOutput,
  isIdentityPreserving,
  layoutDraftsToOutput,
  type ProducerDraft,
} from '../do-work/layout-producer-drafts.ts';
import { reconcileOutputFromItems, producerItemsToReconcileItems } from '../do-work/reconcile-output-from-items.ts';
import { reconcileBoardGraphFromUntrustedResult } from '../do-work/reconcile-board-producer.ts';
import { subjectBag, selectedSubjectBag, idAnnotatedLine } from '../do-work/board-subject-bag.ts';
import { MarkSessionProvider } from '../../addressed-marks/show/MarkSessionContext';
import { useBoardInkSvgReader } from '../../addressed-marks/show/use-board-ink-svg';
import { BoardMarkLayers, DrawToolBinder, boardWorldMarkTarget } from './BoardMarkLayers.tsx';
import { ConnectorLayer, type ConnectorModel } from './ConnectorLayer.tsx';
import { InsightLensSvg, INSIGHT_LENSES } from './insight-lenses.tsx';
import { connectorEndpoints, buildConnectorModels } from './connector-models.ts';
import {
  connectorPath,
  readWaypoints,
  insertBendAt,
  moveWaypoint,
  removeWaypoint,
  readConnectorAnchor,
} from '../do-work/connector-geometry.ts';
import { selectionCapabilityFlags } from './selection-capabilities.ts';
import { SnapGuideLayer } from './SnapGuideLayer.tsx';
import { computeSnap, computeResizeSnap, snapRectToGrid, type SnapGuide, type SnapRect } from './snap-guides.ts';
import { frameCamera, zoomAroundCenter, zoomAroundPoint } from './camera-frame.ts';
import { SelectionHud } from './SelectionHud.tsx';
import { RotateHandle } from './RotateHandle.tsx';
import { resizeRotated, orbitPoint } from './rotated-transform.ts';
import { resizeCrop, isCrop, FULL_CROP, type Crop } from './crop-rect.ts';
import { BOARD_FILTER_PRESETS, filterCssById, presetIdForCss } from './filter-presets.ts';
import { normalizeHref, itemHref } from './item-link.ts';
import { markerById, readMarkerCatalog, resolveLevelMarkers, DEFAULT_OUTLINE_MARKER_IDS } from './board-marker-catalog.ts';
import { boardDefaultItemSize, boardExportLook, resolveAppearanceKey } from './item-appearance.ts';
import { itemBoardLink } from './item-board-link.ts';
import { pushBoardHistory, popBoardHistory } from './board-history.ts';
import { beginEditSession, endEditSession, type EditSession } from './note-edit-session.ts';
import { parseTags, itemTags, formatTags, distinctTags, mergeTags } from './item-tags.ts';
import { hasActiveFacets, toggleFacetValue, facetValues, facetValueCounts, facetColorAssignment, matchesFacets, type FacetSelection } from '../read-data/facet-filter.ts';
import { BOARD_ITEM_FACETS, BOARD_FOCUS_FACETS, boardFocusMatch, focusedItemIds, nonFocusedVisibleIds } from './board-item-facets.ts';
import { BOARD_PALETTES } from './board-palettes.ts';
import { nodeAriaLabel } from './node-accessibility.ts';
import { CONNECTOR_ITEM_FACETS, CONNECTOR_FOCUS_FACETS, dimmedConnectorIds, focusedConnectorIds } from './connector-facets.ts';
import { readFocusViews, makeFocusView, archiveFocusView, sanitizeFocusView, type FocusView } from './focus-view.ts';
import { writeFocusViewLive } from './write-focus-view-live.ts';
import { similarIds } from './item-similarity.ts';
import { BOARD_COMMANDS, BOARD_SHORTCUTS } from './board-shortcuts.ts';
import { coachedCommand, paletteItems as tablePaletteItems } from '../../ui/show/command-table/command-table';
import { coach, tipsOn, type CoachingHistory } from '../../ui/show/command-table/shortcut-coaching';
import coaching from '../../ui/show/command-table/shortcut-coaching.json';
import { ConnectorFormatControls, type ConnectorArrow, type ConnectorRouting } from './ConnectorFormatControls.tsx';
import { BoardFillControls } from './BoardFillControls.tsx';
import { itemFillColor, setStackFill, emptyStack, BOARD_ITEM_LAYER_REGISTRY, inheritedBranchStyle } from './item-fill.ts';
import { BoardShapeControls } from './BoardShapeControls.tsx';
import { ItemStylePicker } from './ItemStylePicker.tsx';
import { shapeSvgPathById, shapeOutlineById } from './board-shapes.ts';
import type { FormatCommand } from '../../ui/show/rich-text-toolbar';
import {
  readTextStylePalette,
  writeTextStylePalette,
  TEXT_STYLE_CAPTURE_PROPERTIES,
  type SavedTextStyle,
} from '../do-work/text-style-palette.ts';
import { buildBoardBatchPack, batchActionsAsNodeActions, distributeByGap, BOARD_ITEM_FAMILY, BOARD_GRID, applyBundleToAll, minOf, reorderZ, reorderZStep, setHidden, setLocked, reorderZToOrder, branchToggleStates, setBranchHidden, parentViaConnectors, directChildCount, branchColorAssignments, connectorBranchColors, reshapeFramesToAspect, unlockedOf, connectorPairKey, invertedNodeIds, mindMapOutline, outlineToMarkdown, planOutlineMindMap, branchMemberIds, upstreamMemberIds, mindMapNonRootIds, COLOR_BY_FACET_KEYS, type ConnectorTopology } from '../do-work/batch-actions.ts';
import { planCardMerge, mergeCardsInGraph } from '../do-work/board-card-merge.ts';
import { splitSegments, splitCardInGraph } from '../do-work/board-card-split.ts';
import { Upload } from 'lucide-react';
import { createFrameFromSelection, nextFrameOrder, appendCopiedFrameOrders, boardFrames, frameRect, presentStep, itemsInsideFrame, withFrameContents, tidyFrameLayout, moveFrameOrder, frameLinkTarget, presentationCaptionOf, presentationFrameOf, frameFitBox } from '../do-work/board-frames.ts';
import type { FrameAspect } from './frame-aspects.ts';
import { BoardObjectsButton } from './BoardObjectsButton.tsx';
import { BoardSwitcherMenu } from './BoardSwitcherMenu.tsx';
import { BoardBackgroundPicker } from './BoardBackgroundPicker.tsx';
import { BoardZoomCluster } from './BoardZoomCluster.tsx';
import { BoardBreadcrumb } from './BoardBreadcrumb.tsx';
import { BoardFocusBar, type BoardFocusBarHandle } from './BoardFocusBar.tsx';
import { applyTextReplace } from '../do-work/board-text-replace.ts';
import { NodeCornerActions } from './NodeCornerActions.tsx';
import { SelectedItemToolbar } from './SelectedItemToolbar.tsx';
import { BoardStatusOverlay } from './BoardStatusOverlay.tsx';
import { SavedPresetsRow, FrameAspectRow } from './BulkBarPickerRows.tsx';
import { arrangeWith } from './arrange-strategies.ts';
import { boardLayerTree } from './board-layer-rows.ts';
import {
  copyItemsToClipboard,
  clipboardToDrafts,
  capsuleBoardToClipboard,
  planPaste,
  setBoardClipboard,
  getBoardClipboard,
  writeBoardClipboard,
  readBoardClipboard,
  setStyleClipboard,
  getStyleClipboard,
  type PasteDraft,
} from '../do-work/board-clipboard.ts';
import {
  selectionBounds,
  anchorForHandle,
  scaleForHandleDrag,
  scaleRectsAroundAnchor,
  constrainToAxis,
  type ResizeHandle as GroupResizeHandle,
  type Rect as GroupRect,
} from '../do-work/group-resize.ts';
import { fitRectToContents, needsGrow } from '../do-work/fit-to-contents.ts';
import {
  readBundlePalette,
  writeBundlePalette,
  type SavedBundle,
} from '../do-work/attribute-bundle-palette.ts';
import { FloatingPanel } from '../../screen-arrangement/show/FloatingPanel';

import { errorWords } from '../../ui/show/safe-error-card/sanitize-error-text.ts';
/** Alignment-snap radius in SCREEN pixels — divided by zoom for a constant feel. */
// What the person has been told about shortcuts, kept on this device (shortcut-coaching.ts decides from it).
const TIPS_KEY = 'trillion-shortcut-tips';
const readTips = (): CoachingHistory => {
  try { return JSON.parse(window.localStorage.getItem(TIPS_KEY) ?? '{}') as CoachingHistory; } catch { return {}; } // a history that cannot be read starts again
};
const keepTips = (history: CoachingHistory) => {
  try { window.localStorage.setItem(TIPS_KEY, JSON.stringify(history)); } catch { /* a device that keeps nothing tells the tip every time it is allowed */ }
};
const SNAP_PX = 6;

/** Open the native OS picker (the proven Finder path; the browser file input does
 * not reliably open Finder in the shell), filtered to the accepted content prefixes. */
async function pickBoardFiles(acceptPrefixes: readonly string[]): Promise<PickedBytes[]> {
  const chosen = await chooseLocalFiles({
    prompt: 'Choose a file',
    multiple: false,
    includeBytes: true,
    allowedContentPrefixes: [...acceptPrefixes],
  });
  return chosen
    .filter((f) => f.bytes && f.bytes.byteLength > 0)
    .map((f) => ({ bytes: f.bytes as Uint8Array, contentType: f.contentType, name: f.name }));
}

const BOARD_ARTIFACT_MATERIALIZER = {
  target: 'content-media-evidence.materialize-artifact',
  admission: 'hosted-session-admitted' as const,
  output_contract: { kind: 'content-media.materialized-relation/v1' },
  relation: { role_ref: { id: 'board-artifact' } },
};

/** Materialize browser bytes through the admitted owner and retain only the
 * returned relation identity. The board cannot choose a CAS namespace or retain
 * a raw storage reference. */
async function storeBoardBytes(bytes: Uint8Array, contentType: string, displayName = 'Board attachment'): Promise<string> {
  const materialized = await materializeBrowserBytes({
    bytes,
    media_type: contentType || 'application/octet-stream',
    display_name: displayName,
    descriptor: BOARD_ARTIFACT_MATERIALIZER,
  });
  return materialized.relation_ref;
}

/** Decode an image's natural pixel size via the browser (#215). The injected
 *  measure capability for `pickAndStore` and the direct measurer for drop/paste;
 *  returns null for a non-image, a decode failure, or a non-DOM environment so the
 *  caller falls back to the item's default footprint. */
async function measureImageNaturalSize(
  input: Uint8Array | Blob,
  contentType: string,
): Promise<{ w: number; h: number } | null> {
  if (typeof createImageBitmap !== 'function' || !contentType.startsWith('image/')) return null;
  const blob = input instanceof Blob ? input : new Blob([input], { type: contentType });
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return size.w > 0 && size.h > 0 ? size : null;
  } catch {
    return null;
  }
}

/** Decode an image's natural size from a URL (#216 — a generated/produced image lands
 *  as a CAS url, not bytes). Uses an <img> element so the browser fetches + decodes;
 *  returns null for a non-image contentType, a non-DOM environment, or a load failure
 *  (caller keeps the placeholder size). */
function measureImageUrlNaturalSize(
  url: string,
  contentType: string | undefined,
): Promise<{ w: number; h: number } | null> {
  if (typeof Image !== 'function' || !url || (contentType && !contentType.startsWith('image/'))) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// BOARD_ITEM_LAYER_REGISTRY — the item-layer capability registry — is imported from
// item-fill (the fill SSOT owner) so every fill writer shares ONE source of truth (L030).

export interface GroupBoardPanelProps {
  readonly partitionLabel: string;
  readonly boardId: string;
  readonly title?: string;
  /** The workspace keeps and shares frame images. The board supplies only ordered rendered frames. */
  readonly publishFrameMedia?: (frames: readonly BoardFrameMedia[]) => Promise<{ pageUrl: string; mediaUrls: readonly string[]; stop: () => Promise<void> }>;
  readonly subtitle?: string;
  readonly makeStore?: (partition: string, root: AddressRef) => GroupBoardStore;
  /** The board has a live room its members meet in (mount DATA: a space's board). Absent → presence reaches only
   *  this person's other windows. */
  readonly sharedRoom?: boolean;
  /** When mounted in a Space, record responses are shared through that Space's response owner. */
  readonly responseSpaceId?: string;
  /** The Space response owner is also the board pin's read/write path; old item comments remain a read bridge. */
  readonly readResponseSummaries?: () => Promise<readonly SharedCommentSummary[]>;
  readonly readResponseThread?: (record: string) => Promise<{ readonly entries: readonly SharedCommentEntry[]; readonly resolved: boolean }>;
  readonly addResponse?: (record: string, text: string) => Promise<unknown>;
  readonly setResponseResolved?: (record: string, resolved: boolean) => Promise<unknown>;
  /** Show a note as a document (mount DATA + behavior): `run` makes the note's words a document wherever the mount
   *  keeps this board's records, opens it, and answers the patch that makes the card that document's view (null when
   *  the card already is one). The board stays blind to which editor or store that is; absent, the action is not shown. */
  readonly openAsDocument?: { readonly label: string; run(item: BoardItem): Promise<Record<string, unknown> | null> };
  /** The producer wired to the board's production affordance — DATA from the composition
   *  mount (which workflow def to fire + where it publishes). Absent → the tool
   *  places a plain text item. The board stays blind to which producer this is. */
  readonly producer?: ProducerSubmitDescriptor;
  /** The producer that AUTO-enriches a pasted link card (DATA from the mount) — a leaf
   *  fetch→parse→write def that flips the card's bare-domain title to the real page
   *  title + og:image once the fetch lands. Absent → a pasted URL stays a plain
   *  favicon+domain card (still fully usable via the manual "Edit card" control). The
   *  board stays blind: it forwards the opaque descriptor + the pasted card's memberId,
   *  and the #208 identity poller merges the result in place. */
  readonly linkEnrichProducer?: ProducerSubmitDescriptor;
  /** Opt into a calendar cadence (mount DATA). When set, opening the surface ensures
   *  the current period's board exists and rolls stale ones into the archive (empty
   *  past periods vanish, periods with content are kept/archived). `keepActive`
   *  (default 1) keeps the N most recent periods active. `landOnCurrent` (default
   *  false) lands on the current period's board instead of the default board — true
   *  for a pure per-period journal, false to keep a persistent default board as the
   *  landing with the dated boards available in the switcher. Absent → one persistent
   *  board, no auto-rollover. */
  readonly cadence?: { readonly unit: CadenceUnit; readonly keepActive?: number; readonly landOnCurrent?: boolean };
  /** Extra producer-backed shelf tools supplied as DATA by the product mount (e.g. a
   *  producer-backed tool). Rendered after the built-in ITEM_SHELF; each may carry its own
   *  `producer` descriptor. The board stays blind — adding a producer tool is DATA,
   *  not a panel edit (L069/Generic Gate #1). */
  readonly extraTools?: ReadonlyArray<ShelfEntry>;
  /**
   * Per-click descriptor override hook. When provided, called at submit time with the
   * definitionId and the opaque owner input; returns a replacement ProducerSubmitDescriptor
   * or null to use the tool's descriptor unchanged. Lets a composition root inject
   * per-click options without coupling the board to any specific producer (L069/L098).
   */
  readonly onBuildProducerDescriptor?: (
    definitionId: string,
    input: Record<string, unknown>,
  ) => ProducerSubmitDescriptor | null | undefined;
  /** Retained only for mount compatibility. Content-media derives storage
   *  namespace from admitted target runtime, never this browser-facing surface. */
  readonly bytesNamespace?: unknown;
  /**
   * IN-PLACE reload signal (mount DATA). A live-feed mount bumps this monotonically
   * when the board's MEMBERSHIP changes (a record added/removed upstream). On change
   * the panel re-reads the store INTO THE EXISTING instance — it does NOT flip the
   * `isLoading` "Loading your board…" state and does NOT reset camera/selection — so
   * a live board refreshes its cards while the user keeps their pan/zoom. Absent (or
   * unchanged) → no reload. This replaces the old `key={nonce}` REMOUNT, which threw
   * away the whole panel (and the user's view) on every upstream change. Only membership
   * changes bump it (a field change on an existing card is self-updated by that card's
   * own live read, needing no board reload at all). */
  readonly reloadSignal?: number;
  /** A source card's action pressed (do-work/board-source.ts `sourceActions`): the board's owner does it. */
  readonly onSourceAction?: (item: BoardItem, actionId: string) => void;
  /** Frame everything on the board once when it first shows its items and they run past what the stage shows (a list
   *  drawn on the board, opened on a phone), never smaller than `leastZoom` so its words stay readable: what does not
   *  fit then starts at the top left. Absent: the board opens where it always does. */
  readonly fitOnOpen?: { readonly leastZoom: number } | null;
  /** What a source can add to the board (a step, a tool, any kind its owner offers): `label` names the button,
   *  `search(words)` answers the rows to choose from (searched by the source, grouped by `section`), and
   *  `add(id, at, words)` asks the source to add one, where `at` is the board point it should land on and `words` what
   *  the person typed (a row may take them as what the new record says). */
  readonly sourceAdds?: {
    readonly label: string;
    readonly placeholder?: string;
    readonly search: (words: string) => Promise<ReadonlyArray<{ id: string; label: string; icon?: string; detail?: string; section?: string }>>;
    readonly add: (id: string, at: { x: number; y: number }, words: string) => void;
  };
  readonly surfaceIntentReader?: SurfaceIntentReaderConfig | null;
  readonly surfaceIntentReaderValue?: unknown;
  readonly surfaceIntentDestinationRef?: string | null;
  /**
   * DRILLDOWN CONSOLE (mount DATA). When set, activating (double-clicking) a node
   * that carries `extra.consoleSubject` opens `console.surface` (a tabbed console)
   * in a board overlay, scoped to that subject — the board composes
   * `surfaceInput = { tabs: console.tabs, subject: node.extra.consoleSubject }`.
   * Blind: the board names no product; the surface + tab list are opaque DATA the
   * live-feed mount supplies from the projection config. Absent → no console; a
   * placeable-surface node's double-click keeps its normal enter-embedded behaviour.
   */
  readonly consoleDrilldown?: {
    readonly surface: { readonly packageName: string; readonly entryName: string };
    readonly tabs: ReadonlyArray<Record<string, unknown>>;
  };
  /** TRILLION: the canvas tool chosen when the board opens (a CANVAS_TOOLS id such as `draw`), so a screen that opens
   *  the board to draw opens it drawing. Absent: the board opens on its usual tool. */
  readonly initialToolId?: string;
}

function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  return `${prefix}-${rand}`;
}

/** Pure placement transaction seed shared by immediate and acknowledged rails. */
function buildDraftPlacement(
  draft: BoardItemDraft,
  worldX: number,
  worldY: number,
  boardId: string,
  appearance: unknown,
) {
  const defaultSize = boardDefaultItemSize(appearance as Parameters<typeof boardDefaultItemSize>[0]);
  return {
    memberId: newId('m'),
    nodeRef: itemRef(boardId, newId('item')),
    kind: draft.kind,
    x: Math.round(worldX), y: Math.round(worldY),
    w: typeof draft.w === 'number' ? draft.w : defaultSize.w,
    h: typeof draft.h === 'number' ? draft.h : defaultSize.h,
  };
}

/** #169 — world-px breathing room a "Frame selection" leaves around the bounded items. */
import { sourceActionsOf, sourcePortsOf } from '../do-work/board-source.ts';
const FRAME_SELECTION_PADDING = 48;
// A source card's live state (board-source.ts `sourceState`): words and a tone, the tone a badge variant or a plain
// tone word (good, attention, bad, quiet), each said by the badge variant that already means it.
const BADGE_FOR_TONE: Record<string, 'success' | 'warning' | 'error' | 'info' | 'accent' | 'neutral' | 'muted'> = {
  success: 'success', good: 'success', warning: 'warning', attention: 'warning', error: 'error', bad: 'error',
  info: 'info', accent: 'accent', neutral: 'neutral', muted: 'muted', quiet: 'muted', idle: 'muted',
};
function sourceStateOf(item: BoardItem): { label: string; tone?: string; pulse?: boolean } | null {
  const state = item.extra?.sourceState as { label?: unknown; tone?: unknown; pulse?: unknown } | undefined;
  return state && typeof state.label === 'string' && state.label ? { label: state.label, ...(typeof state.tone === 'string' ? { tone: state.tone } : {}), ...(state.pulse === true ? { pulse: true } : {}) } : null;
}
const badgeVariantForSourceTone = (tone?: string) => BADGE_FOR_TONE[tone ?? ''] ?? 'neutral';

/** #165 — the rainbow-branch palette (Society DATA, INJECTED into the blind
 *  `branchColorAssignments` engine so the engine never names a colour). Distinct,
 *  legible hues; the assignment wraps `% length` past the 8th branch. */
const BRANCH_PALETTE: readonly string[] = [
  '#2563eb', // blue
  '#16a34a', // green
  '#db2777', // pink
  '#f59e0b', // amber
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#dc2626', // red
  '#65a30d', // lime
];

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
/** How long a pan or zoom must rest before the board remembers where it is. */
const CAMERA_REMEMBER_MS = 800;
/** Char cap on the action SUBJECT (the selection / whole-board text an action's
 *  `typed.text` binding resolves to). A pathological thousand-card board must not
 *  blow the producer's prompt; a real board's text is far below this. Same
 *  defuse-the-hostile-input posture as item-add-strategies' MAX_TEXT_SOURCE_CHARS. */
const MAX_SUBJECT_CHARS = 200_000;
/** The bundle-palette kind for saved board LAYER-STACK presets (P3). One string,
 *  one address namespace — a new saved-bundle kind would be a new string. */
const PRESET_BUNDLE_KIND = 'visual-layer-stack';
/** Synthetic NodeRef family for the board surface itself — the address the
 *  empty-canvas context menu (#140) opens for. Canvas-level actions `accept` it;
 *  it is never a real stamped member (the menu is opened imperatively). */
const BOARD_ROOT_FAMILY = 'group.board-root';
// Switcher sentinels (New/Rename/Export/Archive/Restore rows) live with the
// menu itself in show/BoardSwitcherMenu.tsx.

// flattenBoardTree / findMemberRef / findParentRef — the pure recursive board-tree
// reads — now live in read-data/board-tree.ts (unit-tested; imported above). Kept
// out of this component so the traversal is testable and this surface shrinks.

// exportFillOf (the default SVG-export fill/border/opacity resolver) now lives in
// do-work/board-svg.ts beside BoardSvgStyle + boardToSvg (imported above) — the
// export contract owns its own resolver, keeping this surface leaner.

/** Inline an item's image src to a `data:` URL so a PNG raster can paint it (an
 *  SVG rendered through `new Image()` only resolves `data:`/same-origin hrefs;
 *  an un-inlined external image would taint the canvas → `toBlob` throws). Best
 *  effort: returns '' on any failure so the caller drops the src and the item
 *  exports as its styled rect instead of crashing the whole export (L090 honest
 *  degradation). `data:` srcs pass through untouched. */
async function inlineImageSrc(src: string): Promise<string> {
  if (src.startsWith('data:')) return src;
  try {
    const resp = await fetch(src);
    if (!resp.ok) return '';
    const blob = await resp.blob();
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  } catch {
    return '';
  }
}

/** An SVG used as an image has its own resource boundary. Resolve board media
 * before rendering frames as a deck or carousel so those views contain the same
 * images the board shows, including sources outside the current page origin. */
async function inlineBoardImages(items: readonly BoardItem[]): Promise<BoardItem[]> {
  return Promise.all(items.map(async (item) => {
    if (typeof item.src !== 'string' || item.src.length === 0) return item;
    const src = await inlineImageSrc(item.src);
    return { ...item, src: src || undefined };
  }));
}

// Dot-voting: the local voter id + the per-participant dot budget. Single-user boards vote as one
// actor; multiplayer presence would supply real per-participant ids (the tally engine is actor-agnostic).
const LOCAL_VOTER = 'me';
const VOTE_BUDGET = 5;


/** Undo/redo closures report an unsaved step by THROWING (the canvas-history contract):
 *  `applyGraph` returns the save error as a message, so a closure that just awaited it
 *  would resolve as success and the history would move while the board stayed put. */
function savedOrThrow(error: string | null): void {
  if (error !== null) throw new Error(error);
}

export function GroupBoardPanel({
  partitionLabel,
  boardId,
  title = 'Board',
  publishFrameMedia,
  subtitle = '',
  makeStore,
  sharedRoom = false,
  responseSpaceId,
  readResponseSummaries,
  readResponseThread,
  addResponse,
  setResponseResolved,
  producer,
  linkEnrichProducer,
  cadence,
  extraTools = [],
  onBuildProducerDescriptor,
  reloadSignal,
  onSourceAction,
  fitOnOpen = null,
  sourceAdds,
  surfaceIntentReader = null,
  surfaceIntentReaderValue,
  surfaceIntentDestinationRef = null,
  consoleDrilldown,
  initialToolId,
  openAsDocument,
}: GroupBoardPanelProps) {
  // The surface holds MANY boards under one INDEX; the store roots at the index so
  // a single load folds the index + every board's items. `boardId` is the DEFAULT
  // board (seeded on first load so existing items stay reachable — zero migration).
  const indexRef = useMemo(() => boardIndexRef(boardId), [boardId]);
  // The saved-arrangement library index shares the surface scope, so saved layouts
  // fold from the SAME graph the board index does (one load, one reactive `graph`).
  const cidx = useMemo(() => collectionIndexRef(boardId), [boardId]);
  const store = useMemo<GroupBoardStore>(
    () => (makeStore ? makeStore(partitionLabel, indexRef) : createGroupBoardStore(partitionLabel, indexRef)),
    [makeStore, partitionLabel, indexRef],
  );

  // Where the board keeps the camera it was last looked at through (read-data/board-view-store), loaded with the library.
  const viewRef = useMemo(() => viewIndexRef(boardId), [boardId]);
  const libraryRoots = useMemo(() => [cidx, smartSetIndexRef(), viewRef], [cidx, viewRef]);

  // Which board is open. Switching resets the drill-in nav + selection.
  const [currentBoardId, setCurrentBoardId] = useState(boardId);
  const currentBoardRoot = useMemo(() => boardRootRef(currentBoardId), [currentBoardId]);
  const currentBoardIdRef = useRef(currentBoardId);
  currentBoardIdRef.current = currentBoardId;

  // #168 — the drawing-ink export seam. addressed-marks OWNS ink and serializes it to an
  // OPAQUE `{ svg, bounds }` fragment; this panel stays blind to stroke structure (no god
  // package). The reader reads the LIVE mark feed for the current board's world target — the
  // same persisted ink BoardMarkLayers renders — so a whole-board export includes the ink the
  // user drew (previously every export silently dropped it). `boardInkOverlay()` returns the
  // fragment to hand to `boardToSvg`'s `overlay`, or undefined when there is no ink to compose.
  const readBoardInkSvg = useBoardInkSvgReader(
    useMemo(() => boardWorldMarkTarget(currentBoardId), [currentBoardId]),
  );
  const readBoardInkSvgRef = useRef(readBoardInkSvg);
  readBoardInkSvgRef.current = readBoardInkSvg;
  const boardInkOverlay = useCallback((): BoardSvgOverlay | undefined => {
    const ink = readBoardInkSvgRef.current();
    return ink.bounds ? { svg: ink.svg, bounds: ink.bounds } : undefined;
  }, []);

  // Saved composite text STYLES for this surface (#88). The palette is one
  // label-addressed DATA record shared across every board on the surface, read
  // back directly and overwritten via engine.operation.write-batch. The toolbar
  // is blind to persistence — it gets the bundles as DATA and hands new ones back.
  const [savedTextStyles, setSavedTextStyles] = useState<SavedTextStyle[]>([]);
  const savedTextStylesRef = useRef(savedTextStyles);
  savedTextStylesRef.current = savedTextStyles;

  const [graph, setGraph] = useState<GroupGraph>(emptyGraph());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const stopOpeningRef = useRef<(() => void) | null>(null);
  // A board read can hang forever under engine-thread contention (no store.load()
  // timeout of its own) — bumping this re-runs the load effect below so "Try
  // again" actually retries instead of stranding the user on a dead overlay.
  const [retryNonce, setRetryNonce] = useState(0);
  const retryLoad = useCallback(() => {
    setError(null);
    setLoadError(null);
    setRetryNonce((n) => n + 1);
  }, []);
  const [camera, setCamera] = useState({ panX: 80, panY: 80, zoom: 1 });
  // Active board INSIGHT LENS (b113/b115) — a read-only analysis wash under the cards (cluster hulls /
  // heatmap / treemap), chosen from the ⌘K "Insights:" commands. undefined = no lens (default).
  const [insightLensId, setInsightLensId] = useState<string | undefined>(undefined);
  // Which analytics lens panel is open (null = none). Lifted out of InsightsMenu so BOTH the Insights menu and
  // the ⌘K command palette can open a lens (b220).
  const [activeInsightKey, setActiveInsightKey] = useState<string | null>(null);
  // Multi-select: a SET of member ids in the CURRENT group. Grouping needs ≥2.
  const [selectedIds, setSelectedIdsRaw] = useState<ReadonlySet<string>>(() => new Set());
  // Items sharing a `groupId` (read-data/group-board-model assignGroupId) are one thing to select: choosing any member
  // chooses the whole group. The index is refreshed from the current items on every render.
  const selectionGroupsRef = useRef<ReturnType<typeof groupIndexOf>>(new Map());
  const setSelectedIds = useCallback((next: React.SetStateAction<ReadonlySet<string>>) => {
    setSelectedIdsRaw((prev) => expandSelectionByGroup(typeof next === 'function' ? next(prev) : next, selectionGroupsRef.current));
  }, []);
  // Anchored comments: the item whose thread popover is open (null = none) + the reply draft.
  const [commentAnchorId, setCommentAnchorId] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [sharedCommentEntries, setSharedCommentEntries] = useState<readonly SharedCommentEntry[]>([]);
  const [sharedCommentSummaries, setSharedCommentSummaries] = useState<readonly SharedCommentSummary[]>([]);
  const [sharedThreadResolutions, setSharedThreadResolutions] = useState<Readonly<Record<string, boolean>>>({});
  useEffect(() => {
    if (!responseSpaceId || !readResponseSummaries) { setSharedCommentSummaries([]); return; }
    let active = true;
    void readResponseSummaries().then(summaries => { if (active) setSharedCommentSummaries(summaries); }).catch(() => { if (active) setSharedCommentSummaries([]); });
    return () => { active = false; };
  }, [responseSpaceId, readResponseSummaries]);
  useEffect(() => {
    if (!commentAnchorId || !readResponseThread) return;
    let active = true;
    const record = groupRecordAddress(itemRef(currentBoardId, commentAnchorId));
    void readResponseThread(record).then(thread => {
      if (!active) return;
      setSharedThreadResolutions(current => ({ ...current, [record]: thread.resolved }));
      setSharedCommentEntries(thread.entries);
    }).catch(() => {});
    return () => { active = false; };
  }, [commentAnchorId, currentBoardId, readResponseThread]);
  // Comments triage: whether the all-threads review panel is open.
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  // Dot-voting: whether a voting round is active (shows +/- chips + the budget readout).
  const [votingMode, setVotingMode] = useState(false);
  // Dot-voting: whether the "Top voted" ranking panel is open.
  const [voteResultsOpen, setVoteResultsOpen] = useState(false);
  // Checklist: the item whose checklist panel is open (null = none) + the add-a-step draft.
  const [checklistAnchorId, setChecklistAnchorId] = useState<string | null>(null);
  const [checklistDraft, setChecklistDraft] = useState('');
  // Metrics / Time: the item whose inline progress/time editor is open (null = none). The "Progress", "Most
  // time", "Due soon", "Streaks", and "Review" RANKING panels now live behind the consolidated InsightsMenu.
  const [metricAnchorId, setMetricAnchorId] = useState<string | null>(null);
  const [timeAnchorId, setTimeAnchorId] = useState<string | null>(null);
  // Export: whether the board export panel (Markdown / Calendar) is open.
  const [exportOpen, setExportOpen] = useState(false);
  const [carouselOpen, setCarouselOpen] = useState(false);
  const [carouselItems, setCarouselItems] = useState<ReturnType<typeof deckToMediaCarouselItems>>([]);
  const [framePublication, setFramePublication] = useState<{ pageUrl: string; stop: () => Promise<void> } | null>(null);
  const [publishingFrames, setPublishingFrames] = useState(false);
  // Rollup: the parent card whose sub-goal breakdown is open (null = none).
  const [rollupAnchorId, setRollupAnchorId] = useState<string | null>(null);
  // Live marquee (rubber-band) rectangle in viewport-LOCAL px while dragging on
  // empty canvas to select multiple items. null = not marqueeing. The hit-test
  // (refsInRect) and the overlay both read this.
  const [selectionRect, setSelectionRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // True while a marquee drag is active → crosshair cursor (Figma/Pinterest feel).
  const [marqueeing, setMarqueeing] = useState(false);
  // The PINNED selection for the tools-rail combine bar (b189) — null = nothing pinned.
  const [pinnedToolIds, setPinnedToolIds] = useState<string[] | null>(null);
  // Selection chrome is opt-in. Clicking a card leaves the canvas calm and
  // surfaces one compact selection trigger; the full inspector opens only when
  // the person asks for it.
  const [selectionInspectorOpen, setSelectionInspectorOpen] = useState(false);
  useEffect(() => {
    if (selectedIds.size === 0) setSelectionInspectorOpen(false);
  }, [selectedIds.size]);
  // The active-tool primitive (ui/canvas-tools): ONE owner of "what does this
  // gesture mean right now." Move/Select-area/Hand/Draw are DATA rows; the board
  // never branches on pan-vs-marquee-vs-move — it asks the tool. Select-area's
  // node.drag = marquee is what lets you rubber-band across a DENSE board (no
  // empty space needed). Hold Space → temporary Hand (pan from anywhere).
  // The full registry is wired: Select/Marquee/Hand/Draw + Text (text.place →
  // drop an editable note at the click point, handled in onStagePointerDown).
  const boardTools = useMemo(() => CANVAS_TOOLS, []);
  const toolApi: CanvasToolApi = useCanvasTool({ tools: boardTools });
  const toolApiRef = useRef(toolApi);
  toolApiRef.current = toolApi;
  // TRILLION: open on the tool the mount names (initialToolId), once.
  useEffect(() => {
    if (initialToolId && boardTools.some((tool) => tool.id === initialToolId)) toolApiRef.current.setActiveTool(initialToolId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** The resolved intent kind for a press on a node / resize-handle under the
   *  effective tool (Space/middle fold into the temporary Hand). The board uses
   *  this to decide whether an item press DRAGS (node.move) or falls through to
   *  the stage interpreter (marquee / pan). */
  const nodeIntentKind = useCallback((e: React.PointerEvent, hit: 'node' | 'resizeHandle') => {
    const button = e.button === 1 ? 'middle' : e.button === 2 ? 'secondary' : 'primary';
    const tool = toolApiRef.current.effectiveTool({ button });
    return resolveToolIntent(tool, hit, 'drag').kind;
  }, []);
  // Undo/redo for batch (multi-edit) transactions — one Cmd-Z reverses a whole
  // align/distribute/apply-to-all as a single step (generic ui canvas-history).
  const history = useCanvasHistory();
  // Saved LAYER-STACK presets for this surface (kind-keyed bundle palette, P3).
  const [savedPresets, setSavedPresets] = useState<SavedBundle<VisualLayerStackRecord>[]>([]);
  const savedPresetsRef = useRef(savedPresets);
  savedPresetsRef.current = savedPresets;
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  // #177 — the frame-aspect picker: which frame member(s) to reshape (captured when the
  // "Reshape as slide…" row fires) + whether the picker is open. Null target → closed.
  const [aspectTargetIds, setAspectTargetIds] = useState<string[] | null>(null);
  // Drill-in navigation: a stack of nested sections we've opened. Empty = board root.
  // currentRef (below) is where every item op reads/writes; the STORE still folds
  // from the root, so a change to any nested group persists in one apply().
  const [navStack, setNavStack] = useState<ReadonlyArray<{ ref: AddressRef; label: string }>>([]);
  const [immersiveId, setImmersiveId] = useState<string | null>(null);
  // The section currently under a dragged item — highlighted as a drop target.
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  // The item currently in inline edit mode (a note open in the rich editor). null =
  // none. Double-click a note to enter; blur/Escape (or a new drag) leaves.
  const [editingId, setEditingId] = useState<string | null>(null);
  // The live placeable-surface node the user has "entered" (double-click) — while set,
  // that node's mounted surface receives pointer events (interactive). A ref mirrors it
  // for the window keydown closure. Auto-exit when the node is no longer selected
  // (clicking the canvas / another node changes selection), so the surface never traps
  // the user in interactive mode; Esc also exits (see the board keydown handler).
  const [activeEmbeddedSurfaceId, setActiveEmbeddedSurfaceId] = useState<string | null>(null);
  const activeEmbeddedSurfaceIdRef = useRef<string | null>(null);
  useEffect(() => { activeEmbeddedSurfaceIdRef.current = activeEmbeddedSurfaceId; }, [activeEmbeddedSurfaceId]);
  useEffect(() => {
    if (activeEmbeddedSurfaceId && !selectedIds.has(activeEmbeddedSurfaceId)) setActiveEmbeddedSurfaceId(null);
  }, [selectedIds, activeEmbeddedSurfaceId]);
  // The DRILLDOWN CONSOLE currently open (a node was activated + carries a
  // consoleSubject + `consoleDrilldown` is configured). Holds the subject label +
  // scoped surfaceInput while the shared movable, resizable FloatingPanel mounts
  // `consoleDrilldown.surface`. null = closed. Closed by the panel or Esc.
  const [openConsole, setOpenConsole] = useState<{ label: string; surfaceInput: Record<string, unknown> } | null>(null);
  const openConsoleRef = useRef<typeof openConsole>(null);
  useEffect(() => { openConsoleRef.current = openConsole; }, [openConsole]);
  // The image currently in CROP mode (double-click an image to enter; Done/Escape
  // leaves). While set, the CropOverlay's handles resize `extra.crop` on this item.
  const [cropTargetId, setCropTargetId] = useState<string | null>(null);
  // The active tag filter (a set of selected tags). Empty = no filter (all items
  // bright). Non-empty focuses the board: items without any selected tag dim. Pure
  // VIEW state — never persisted; reuses the generic CanvasNode opacity to dim.
  const [focusFacets, setFocusFacets] = useState<FacetSelection>({});
  // The RELATIONSHIP focus over connectors — INDEPENDENT of the node focus above (Codex: a
  // connector's relationKind in the node selection would fail-closed every node). Dims non-matching connectors.
  const [relationFocus, setRelationFocus] = useState<FacetSelection>({});
  // Free-text board search (Mural/Craft/Miro "Find" canon). Transient VIEW state,
  // never persisted; combines with the tag filter through ONE focus conjunction —
  // an item is focused iff it passes EVERY active filter, else it dims.
  const [searchQuery, setSearchQuery] = useState('');
  // Reveal hidden items (#149). Transient VIEW state, never persisted: when false a
  // hidden item (`extra.hidden === true`) is removed from the canvas; when true every
  // hidden item renders as a selectable ghost so it can be un-hidden. The toggle only
  // appears when something is actually hidden, and resets to false on board switch.
  const [showHidden, setShowHidden] = useState(false);
  // Reveal mode is per-board: switching boards returns to the normal (hidden-removed)
  // view so a reveal never silently leaks onto a different board.
  useEffect(() => { setShowHidden(false); }, [currentBoardId]);
  // Which Objects-panel sections are expanded (#153). Per-board: a fresh board
  // starts fully collapsed so an expand never carries across boards.
  const [expandedLayerIds, setExpandedLayerIds] = useState<Set<string>>(new Set());
  useEffect(() => { setExpandedLayerIds(new Set()); }, [currentBoardId]);
  const toggleLayerExpand = useCallback((id: string) => {
    setExpandedLayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // The pending in-app text input (replaces window.prompt — unavailable in the macOS
  // WKWebView). `askText` opens the overlay and resolves with the entered text or null.
  const [inputRequest, setInputRequest] = useState<TextInputRequest | null>(null);
  const askText = useCallback(
    (label: string, value = '', submitLabel?: string): Promise<string | null> =>
      new Promise((resolve) => {
        setInputRequest({
          label,
          value,
          submitLabel,
          resolve: (entered) => {
            setInputRequest(null);
            resolve(entered);
          },
        });
      }),
    [],
  );

  // Transient export/copy confirmation (#145) — a self-contained notice owned by
  // the panel (no ToastProvider, works in every shell, like askText). `showNotice`
  // arms an auto-dismiss timer, replacing any prior one. An optional `action`
  // (label + callback) renders as the chip's one interactive control ("Undo") —
  // running it dismisses the notice; the notice stays blind to what it does.
  const [notice, setNotice] = useState<{ text: string; tone: 'info' | 'success' | 'error'; action?: { label: string; onAction: () => void } } | null>(null);
  // R20 fail-forward indirection: exportBoardDeck (declared above frameSelection) offers
  // "Frame the board" on its no-frames notice; a deps-array reference to the later const
  // would evaluate at render time and TDZ-crash at mount (the proven pitfall), so the
  // action goes through this ref, assigned once frameSelection exists.
  const frameSelectionRef = useRef<(memberIds: readonly string[]) => void>(() => {});
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((text: string, tone: 'info' | 'success' | 'error' = 'info', action?: { label: string; onAction: () => void }) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice({
      text,
      tone,
      ...(action ? { action: { label: action.label, onAction: () => { setNotice(null); action.onAction(); } } } : {}),
    });
    // An actionable notice lingers longer — the user needs time to reach "Undo".
    noticeTimerRef.current = setTimeout(() => setNotice(null), action ? 6000 : 2600);
  }, []);

  // A command run the slow way (the palette) while it has a shortcut: the shortcut is named now and then, capped and
  // spaced by the coaching rules (shortcut-coaching.json); what the person has been told is kept on this device.
  const [tipsOff, setTipsOff] = useState(() => readTips().off === true);
  const coachShortcut = useCallback((command: string | undefined) => {
    const row = coachedCommand(BOARD_COMMANDS, command);
    if (!row) return;
    const told = coach(row, 'palette', readTips(), Date.now());
    if (!told) return;
    keepTips(told.history);
    showNotice(told.tip, 'info');
  }, [showNotice]);
  const toggleTips = useCallback(() => {
    keepTips(tipsOn(readTips(), tipsOff));
    showNotice(tipsOff ? coaching.words.on : coaching.words.off, 'info');
    setTipsOff(!tipsOff);
  }, [tipsOff, showNotice]);
  useEffect(() => () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current); }, []);

  const currentRef = navStack.length ? navStack[navStack.length - 1].ref : currentBoardRoot;
  // The group ONE level up from the current one (null at the board root) — the
  // destination for "Move out of this section".
  const parentRef: AddressRef | null =
    navStack.length === 0 ? null : navStack.length === 1 ? currentBoardRoot : navStack[navStack.length - 2].ref;

  const stageRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const currentRefRef = useRef(currentRef);
  currentRefRef.current = currentRef;
  // First time THIS session observed each still-pending producer item (memberId → ms).
  // Used by the consume-seam fail-closed timeout for orphans that carry no submit stamp.
  const firstSeenRef = useRef<Map<string, number>>(new Map());
  const parentRefRef = useRef(parentRef);
  parentRefRef.current = parentRef;

  /** Replace the selection with one id, or toggle it in/out when additive (shift). */
  const selectItem = useCallback((id: string, additive: boolean) => {
    setSelectedIds((prev) => {
      if (!additive) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    let live = true;
    setIsLoading(true);
    setLoadError(null);
    const stopWatching = watchBoardLoad(async () => {
      // A slow load keeps running: the warning offers retry without discarding its eventual result.
      globalThis.performance?.mark('canvas:open:read-start');
      let loaded = await store.load(libraryRoots);
      globalThis.performance?.mark('canvas:open:read-complete');
      if (!live) return;
      // Seed the default board on first run. Register the INDEX ENTRY ONLY (never
      // ensure/overwrite its root — it may already hold items), persist just that
      // entry, then RELOAD so BFS follows the index into the existing root and
      // preserves its items (zero migration). The default board then shows in the
      // switcher.
      if (!hasBoard(loaded, indexRef, boardId)) {
        const withEntry = addBoardEntry(loaded, indexRef, { memberId: newId('b'), boardId, title });
        globalThis.performance?.mark('canvas:open:index-apply-start');
        await store.apply(loaded, withEntry).catch(() => undefined);
        globalThis.performance?.mark('canvas:open:index-apply-complete');
        // Re-read the index into its existing root; the whole open remains watched.
        loaded = await store.load(libraryRoots);
        globalThis.performance?.mark('canvas:open:index-reload-complete');
        if (!live) return;
      }
      // Calendar cadence: ensure the current period's board exists, roll stale ones
      // into the archive (empty past periods vanish), and land on the current one.
      // Idempotent — once today's board exists and nothing is stale this is a no-op.
      if (cadence) {
        const now = new Date();
        const ensured = ensureCadenceBoard(loaded, indexRef, cadence.unit, now, { memberId: newId('b') });
        const rolled = archiveStaleCadenceBoards(
          ensured.graph,
          indexRef,
          cadence.unit,
          cadenceBucket(cadence.unit, now),
          cadence.keepActive ?? 1,
        );
        if (rolled !== loaded) {
          globalThis.performance?.mark('canvas:open:cadence-apply-start');
          await store.apply(loaded, rolled).catch(() => undefined);
          globalThis.performance?.mark('canvas:open:cadence-apply-complete');
          // The same open warning also covers this reload.
          loaded = await store.load(libraryRoots);
          globalThis.performance?.mark('canvas:open:cadence-reload-complete');
          if (!live) return;
        }
        if (cadence.landOnCurrent) setCurrentBoardId(ensured.boardId);
      }
      return loaded;
    }, {
      timeoutMs: BOARD_LOAD_TIMEOUT_MS,
      onSlow: () => {
        setLoadError('Your board is taking a while to load. You can wait, or try again.');
        setIsLoading(false);
      },
      onLoaded: loaded => {
        if (!loaded) return;
        globalThis.performance?.mark('canvas:open:ready');
        setGraph(loaded);
        setLoadError(null);
        setIsLoading(false);
      },
      onFailed: e => {
        console.warn('[group-board] board load failed', e);
        setLoadError('Your board couldn’t load. Try again.');
        setIsLoading(false);
      },
    });
    const stopOpening = () => {
      live = false;
      stopWatching();
    };
    stopOpeningRef.current = stopOpening;
    return () => {
      stopOpening();
      if (stopOpeningRef.current === stopOpening) stopOpeningRef.current = null;
    };
  }, [store, indexRef, libraryRoots, boardId, title, cadence?.unit, cadence?.keepActive, retryNonce]);

  // IN-PLACE reload on the mount's membership-change signal. Deliberately depends on
  // ONLY `reloadSignal` (not `store`): it re-reads the SAME store into the existing
  // panel WITHOUT flipping `isLoading` (no "Loading your board…" flash) and WITHOUT
  // touching camera/selection — so a live-feed board refreshes its cards while the
  // user keeps their pan/zoom. The initial mount is handled by the main load effect
  // above; this fires only when the signal actually CHANGES (a new/removed worker).
  const reloadSignalSeenRef = useRef<number | undefined>(reloadSignal);
  useEffect(() => {
    if (reloadSignal === undefined) return; // opt-in only
    if (reloadSignalSeenRef.current === reloadSignal) return; // skip the initial value
    reloadSignalSeenRef.current = reloadSignal;
    let live = true;
    void (async () => {
      try {
        const loaded = await store.load(libraryRoots);
        if (live) {
          // A newer refresh has landed. The original open must not overwrite it
          // or bring its warning back if that older request finishes later.
          stopOpeningRef.current?.();
          stopOpeningRef.current = null;
          setGraph(loaded);
          setLoadError(null);
          setIsLoading(false);
        } // in place — no camera reset
      } catch {
        /* transient reload hiccup — keep the current graph, never flash/crash (L117) */
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  /**
   * Apply a leaf transition optimistically, persist, revert on failure. `before`
   * defaults to the current graph — correct for one-shot edits. A LIVE GESTURE
   * (drag/resize) optimistically `setGraph`s during the gesture, so by commit time
   * the current graph already equals `after`; such callers MUST pass the snapshot
   * taken at gesture start so `store.apply(before, after)` sees a real delta.
   */
  // The persistence half WITHOUT history bookkeeping — used directly by the undo
  // engine's apply/revert closures (so reversing a step never records a new step).
  const applyGraph = useCallback(
    async (after: GroupGraph, before: GroupGraph): Promise<string | null> => {
      setGraph(after);
      setError(null);
      try {
        await store.apply(before, after);
        return null;
      } catch (e) {
        // Persistence FAILED: revert optimistic state + surface the error. RETURN
        // the message (rather than swallow) so callers that must NOT falsely report
        // success — the inspector edit path — can reject. Gesture/undo callers that
        // ignore the return keep their revert-and-continue behavior unchanged.
        const message = messageOf(e);
        setGraph(before);
        setError(message);
        return message;
      }
    },
    [store],
  );

  /**
   * Apply a leaf transition optimistically, persist, revert on failure, AND record
   * it as ONE undo step (Cmd-Z) — by default. This is THE structural reason undo
   * covers EVERYTHING the user does (delete, move, add, group, style, resize): every
   * user mutation flows through commit, so every user mutation is undoable with zero
   * per-callsite bookkeeping (L063). `before` defaults to the current graph; a LIVE
   * GESTURE that optimistically `setGraph`d during the drag MUST pass its start
   * snapshot so the persisted delta — and the undo step — are real. Pass
   * `{ undoable: false }` for SYSTEM writes (producer results, seeding) that the user
   * never initiated and must not be able to "undo".
   */
  const commit = useCallback(
    async (after: GroupGraph, before: GroupGraph = graphRef.current, opts?: { undoable?: boolean; stepFrom?: GroupGraph }): Promise<string | null> => {
      const error = await applyGraph(after, before);
      // `stepFrom`: a finished live gesture saves only its last delta (`before` = the saved preview) but is ONE
      // undo step back to the graph from when the gesture began.
      const from = opts?.stepFrom ?? before;
      if (error === null && opts?.undoable !== false) {
        history.record({ apply: async () => savedOrThrow(await applyGraph(after, from)), revert: async () => savedOrThrow(await applyGraph(from, after)) });
      }
      return error; // null on success, message on persistence failure
    },
    [applyGraph, history],
  );

  // ── Rich-note edit as a TRANSACTION (#223) ────────────────────────────────
  // Typing a note persists per-keystroke drafts with `{ undoable: false }` (see the
  // NoteItem `onEditHtml` write) so board history isn't flooded with a step per keystroke.
  // But that left the whole edit invisible to Cmd-Z once focus left the editor. We fix it
  // by recording the WHOLE session as ONE undoable step when editing ends — no matter HOW
  // it ends (blur, selecting another item, starting a drag/rotate/resize, unmount). The
  // `editingId` state transition is the single close signal, so this one effect finalizes
  // EVERY exit path (L063) instead of the 8+ call sites that clear editingId each having to.
  const editSessionRef = useRef<EditSession<GroupGraph> | null>(null);
  // Reassigned every render so the recorded closures always use the freshest history/applyGraph.
  const recordEditStepRef = useRef<(before: GroupGraph, after: GroupGraph) => void>(() => {});
  recordEditStepRef.current = (before, after) => {
    history.record({ apply: async () => savedOrThrow(await applyGraph(after, before)), revert: async () => savedOrThrow(await applyGraph(before, after)) });
  };
  useEffect(() => {
    if (!editingId) return;
    const id = editingId;
    editSessionRef.current = beginEditSession(graphRef.current, id);
    return () => {
      // Content-aware close: an editor opened-but-untouched (or typed-then-reverted to the
      // same text) records NO undo step — only a genuine html/text change on THIS note does.
      const step = endEditSession(editSessionRef.current, graphRef.current, (b, a) => {
        const bi = readItems(b, currentRefRef.current).find((i) => i.memberId === id);
        const ai = readItems(a, currentRefRef.current).find((i) => i.memberId === id);
        return (bi?.html ?? '') !== (ai?.html ?? '') || (bi?.text ?? '') !== (ai?.text ?? '');
      });
      editSessionRef.current = null;
      if (step) recordEditStepRef.current(step.before, step.after);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- graphRef/currentRefRef/recordEditStepRef are refs; editingId is the only reactive close signal.
  }, [editingId]);

  /** Remove EVERY selected item from the current group (persists). Shared by the
   *  Delete key and the visible Delete control — ONE removal path (leaf removeItem). */
  const deleteSelected = useCallback(() => {
    const cur = currentRefRef.current;
    // A locked item resists deletion exactly like it resists drag/resize/nudge —
    // lock protects from removal too. Delete only the UNLOCKED part of the
    // selection; if everything selected is locked, no-op and KEEP the selection so
    // the lock badge stays visible and the user can Unlock first (Figma behaviour).
    // removeUnlockedItems is the one removal rule: it skips locked items and takes the
    // now-dangling connectors in the SAME undoable step.
    const { graph: next, removed } = removeUnlockedItems(graphRef.current, cur, [...selectedIdsRef.current]);
    if (removed.length === 0) return;
    setSelectedIds(new Set());
    void commit(next);
  }, [commit]);

  /** Wrap the selected items (≥2) into a nested section at the first one's spot. */
  const groupSelected = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    if (ids.length < 2) return;
    const cur = currentRefRef.current;
    const anchor = readItems(graphRef.current, cur).find((i) => i.memberId === ids[0]);
    const after = groupItems(graphRef.current, cur, ids, {
      sectionNodeRef: sectionRef(boardId, newId('s')),
      wrapperMemberId: newId('sm'),
      x: anchor?.x ?? 80,
      y: anchor?.y ?? 80,
      text: 'Section',
    });
    setSelectedIds(new Set());
    void commit(after);
  }, [boardId, commit]);

  /** Merge the selected cards into ONE (b132) — fold near-duplicates into a single survivor that keeps the
   *  joined text and inherits every connector (re-anchored; self-loops/dupes dropped). One undoable step; the
   *  survivor stays selected. No-op on <2 cards or a merge with nothing to fold. */
  const mergeSelectedCards = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    if (ids.length < 2) return;
    const cur = currentRefRef.current;
    const plan = planCardMerge(readItems(graphRef.current, cur), ids);
    if (plan.removeMemberIds.length === 0 && plan.reanchor.length === 0) return;
    const after = mergeCardsInGraph(graphRef.current, cur, ids);
    setSelectedIds(new Set([plan.primaryId]));
    void commit(after);
  }, [commit]);

  /** Split the single selected card into one card per line (b133) — the inverse of merge. Places the
   *  children (fresh ids), re-anchors the original's connectors onto the head child, removes the original,
   *  in one undoable commit. No-op unless exactly one card with 2+ segments is selected. */
  const splitAnchorCard = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    if (ids.length !== 1) return;
    const before = graphRef.current;
    const after = splitCardInGraph(before, currentRefRef.current, boardId, ids[0], newId);
    if (after === before) return;
    setSelectedIds(new Set());
    void commit(after);
  }, [boardId, commit]);

  /** Create an EMPTY section (folder) at the viewport center — folders-first:
   *  make it, double-click in, then Add items (which route into the open group). */
  const addSection = useCallback(() => {
    // World-space viewport center (same math as viewportCenter, inlined here so
    // this callback only depends on the top-level stage/camera refs).
    const rect = stageRef.current?.getBoundingClientRect();
    const cam = cameraRef.current;
    const cx = ((rect?.width ?? 600) / 2 - cam.panX) / cam.zoom;
    const cy = ((rect?.height ?? 400) / 2 - cam.panY) / cam.zoom;
    setSelectedIds(new Set());
    void commit(
      placeSection(graphRef.current, currentRefRef.current, {
        memberId: newId('sm'),
        sectionNodeRef: sectionRef(boardId, newId('s')),
        x: Math.round(cx - 110),
        y: Math.round(cy - 80),
        text: 'Section',
      }),
    );
  }, [boardId, commit]);

  /** Land on a board — the ONE board-change effect: reset the drill-in nav + selection +
   *  immersive, then set the current board. Both switchBoard (forward) and goBackBoard
   *  call this, so the reset trio lives in one place (SSOT). */
  const landOnBoard = useCallback((id: string) => {
    setSelectedIds(new Set());
    setPinnedToolIds(null);
    setSelectionInspectorOpen(false);
    setNavStack([]);
    setImmersiveId(null);
    setCurrentBoardId(id);
  }, []);

  /** #220 — a back-stack of previously-viewed boards so a board change (switcher OR the
   *  #218 board-link chip) has a way back (browser-like), instead of a one-way trip. */
  const [boardBackStack, setBoardBackStack] = useState<readonly string[]>([]);
  const boardBackStackRef = useRef<readonly string[]>(boardBackStack);
  boardBackStackRef.current = boardBackStack;

  /** Open a different board — pushes the board being left onto the back-stack, then lands. */
  const switchBoard = useCallback((id: string) => {
    setBoardBackStack((s) => pushBoardHistory(s, currentBoardIdRef.current, id));
    landOnBoard(id);
  }, [landOnBoard]);

  /** #220 — go back to the previously-viewed board. Pops the most-recent still-active board
   *  (skipping any archived/deleted since — self-healing) and lands on it WITHOUT re-pushing. */
  const goBackBoard = useCallback(() => {
    const activeIds = new Set(readActiveBoards(graphRef.current, indexRef).map((b) => b.boardId));
    const { target, rest } = popBoardHistory(boardBackStackRef.current, activeIds, currentBoardIdRef.current);
    setBoardBackStack(rest);
    if (target) landOnBoard(target);
  }, [landOnBoard, indexRef]);

  /** Create a new board, register it in the index, and switch to it (empty). */
  const newBoard = useCallback(async () => {
    const name = await askText('New board name', 'Untitled board', 'Create');
    if (name === null) return;
    const id = newId('board');
    if (await commit(addBoard(graphRef.current, indexRef, { memberId: newId('b'), boardId: id, title: name.trim() || 'Untitled board' })) !== null) return;
    switchBoard(id); // #220 voluntary nav → pushes the previous board so Back returns to it
  }, [askText, commit, indexRef, switchBoard]);

  /** Rename the CURRENT board (Figma/Miro/FigJam canon — a board title is editable).
   *  Opens the in-app text overlay (askText — works in every shell, same path as
   *  New board) prefilled with the current title; on Save commits via the pure
   *  `renameBoard` model fn (sets the index member's presentation.text). Empty →
   *  keeps the old title (never blanks the switcher row). */
  const renameCurrentBoard = useCallback(async () => {
    const entry = readActiveBoards(graphRef.current, indexRef).find((b) => b.boardId === currentBoardIdRef.current);
    if (!entry) return;
    const next = await askText('Rename board', entry.title, 'Save');
    if (next === null) return;
    void commit(renameBoard(graphRef.current, indexRef, entry.memberId, next.trim() || entry.title));
  }, [askText, commit, indexRef]);

  /** Share the current board (or a scope of it) as a self-contained link. The scope
   *  picker (ShareScopeControl) drives WHICH content — whole board, current selection,
   *  a tag, or a certain kind of item ("a certain type of thing"). We resolve that scope
   *  into a portable capsule (the content rides IN the link fragment), copy the link to
   *  the OS clipboard, and confirm via the in-app notice. Engine-free: a preview/local
   *  share needs no hosting (the `public-scene-share` owner mints the PUBLIC short link
   *  from this same capsule — not group's job). L090: the scope kind is data-dispatched. */
  const shareBoard = useCallback(
    async (scopeKind: string) => {
      let request: ShareScopeRequest = { kind: scopeKind, selectedIds: [...selectedIdsRef.current] };
      if (scopeKind === 'type') {
        const k = await askText('Share which kind of item? (e.g. note, link, media)', 'link', 'Share');
        if (k === null) return;
        request = { ...request, itemKind: k.trim() };
      } else if (scopeKind === 'tag') {
        const t = await askText('Share which tag?', '', 'Share');
        if (t === null || t.trim() === '') return;
        request = { ...request, tag: t.trim() };
      }
      const entry = readActiveBoards(graphRef.current, indexRef).find((b) => b.boardId === currentBoardIdRef.current);
      const title = entry?.title ?? 'Board';
      // Gather the WHOLE board tree (root items + every nested section's descendants) in world
      // space so a share carries section contents, not just the top level (Codex share-audit #2).
      // A kept section brings its subtree via the section-closure in buildShareCapsule.
      const items: CapsuleSourceItem[] = boardToCapsuleSource(graphRef.current, currentRefRef.current);
      const capsule = buildShareCapsule(
        [{ boardId: currentBoardIdRef.current, title, items, scope: request, background: entry?.background }],
        title,
      );
      if (capsule.boards.length === 0) {
        showNotice('Nothing to share in that scope', 'info');
        return;
      }
      const referenceWarnings = shareReferenceWarnings(capsule);
      if (referenceWarnings.length > 0) {
        showNotice(`${referenceWarnings.length} linked ${referenceWarnings.length === 1 ? 'card is' : 'cards are'} not included in this share`, 'info');
      }
      const base =
        typeof window !== 'undefined' && window.location
          ? window.location.origin + window.location.pathname
          : '';
      const link = encodeShareLink(capsule, base);
      // Fail-closed copy (shared ui helper: async API → WKWebView-safe execCommand
      // fallback). Success is only claimed when a write verifiably landed; otherwise
      // the link itself is shown in the selectable text overlay so the user can copy
      // it manually — never a "copied" lie over an empty clipboard.
      if (await copyTextToClipboard(link)) {
        showNotice(`Share link copied — ${capsuleSummary(capsule)}`, 'success');
      } else {
        void askText('Copy did not work. Select this link and copy it', link, 'Done');
      }
    },
    [askText, indexRef, showNotice],
  );

  /** Duplicate the CURRENT board into a new "<title> copy" board and switch to it
   *  (Miro/FigJam/Mural canon). All items, nested sections, connectors (endpoints
   *  remapped) and the background are deep-copied by the pure `duplicateBoard`
   *  board-model fn — `newId` mints the fresh ids it needs. */
  const duplicateCurrentBoard = useCallback(async () => {
    const src = readActiveBoards(graphRef.current, indexRef).find((b) => b.boardId === currentBoardIdRef.current);
    if (!src) return;
    const newBoardId = newId('board');
    const next = duplicateBoard(graphRef.current, indexRef, {
      srcBoardId: src.boardId,
      newBoardId,
      newMemberId: newId('b'),
      title: `${src.title} copy`,
      mint: () => newId('dup'),
    });
    if (await commit(next) !== null) return;
    switchBoard(newBoardId); // #220 voluntary nav → Back returns to the source board
  }, [commit, indexRef, switchBoard]);

  /** "New from template" (#147) — open the gallery, then on pick stamp the DATA
   *  template onto a fresh board via the generic `applyTemplate` and open it. */
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const createBoardFromTemplate = useCallback(
    async (template: BoardTemplate) => {
      const newBoardId = newId('board');
      const next = applyTemplate(graphRef.current, indexRef, {
        template,
        newBoardId,
        newMemberId: newId('b'),
        mint: () => newId('tpl'),
      });
      if (await commit(next) !== null) return;
      switchBoard(newBoardId); // #220 voluntary nav → Back returns to the previous board
      setTemplatesOpen(false);
      showNotice(`Created from ${template.name}`, 'success');
    },
    [commit, indexRef, showNotice, switchBoard],
  );

  /** Snapshot the CURRENT board into the saved-arrangement library — the emergent
   *  `saveBoardAsArrangement` capability (boardToTemplate → saveCollection). The
   *  reactive `graph` then shows it as a re-appliable, manageable row. */
  const saveCurrentBoardToLibrary = useCallback(async () => {
    const entry = readActiveBoards(graphRef.current, indexRef).find((b) => b.boardId === currentBoardIdRef.current);
    const name = await askText('Save this board as', entry?.title ?? 'My layout', 'Save');
    if (name === null) return;
    const next = saveBoardAsArrangement(graphRef.current, cidx, currentBoardIdRef.current, {
      memberId: newId('col'),
      collectionId: newId('arr'),
      name: name.trim() || entry?.title || 'My layout',
    });
    void commit(next);
    showNotice('Saved to your library', 'success');
  }, [askText, cidx, commit, indexRef, showNotice]);

  /** SAVE this board's LOOK as a reusable named preset — the capture side of the appearance-preset
   *  round-trip (apply already exists; makeAppearancePreset captured a profile but had no surface).
   *  Reuses the proven live published-record write (same path as authoring an action): the saved
   *  look streams back through published-records into the "Board look" list, zero redeploy. An
   *  un-themed board (no meaningful overrides) is a no-op with a nudge, never an empty preset. */
  const saveCurrentLook = useCallback(async () => {
    const preset = makeAppearancePreset(newId('look'), 'My look', currentBoardAppearanceRef.current);
    if (presetIsEmpty(preset)) {
      showNotice('Set a board look first (background, note style, connectors…), then save it.', 'info');
      return;
    }
    const name = await askText('Save this look as', 'My look', 'Save');
    if (name === null) return;
    const named = makeAppearancePreset(preset.id, name.trim() || 'My look', preset.profile);
    try {
      await writeAppearancePresetLive(named, partitionLabel);
      showNotice(`"${named.name}" is now in your board looks.`, 'success');
    } catch (error) {
      console.error('[group] save appearance preset failed:', error);
      showNotice('This look could not be saved.', 'error');
    }
  }, [askText, partitionLabel, showNotice]);

  /** R44 add-your-own: persist a user-typed catalog value (a custom emoji stamp, a custom
   *  note colour) as a new catalog row via the generic live writer. The `creator` DATA carries
   *  the catalog identity + which row field the value fills, so this handler names no specific
   *  catalog (L090) — it round-trips into the tool's flyout with zero redeploy. */
  const createCatalogVariant = useCallback(async (creator: ShelfVariantCreator, value: string) => {
    const item = { id: newId('cat'), label: value, [creator.valueField]: value };
    try {
      await writeBoardCatalogItemLive(
        { kind: creator.catalogKind, arrayKey: creator.arrayKey, addressPrefix: creator.addressPrefix },
        item,
        partitionLabel,
      );
      showNotice(`Added — "${value}" is now in your ${creator.addLabel.replace(/^Add an? /i, '')} set.`, 'success');
    } catch (error) {
      console.error('[group] save catalog item failed:', error);
      showNotice('This could not be saved.', 'error');
    }
  }, [partitionLabel, showNotice]);

  /** R5 — save the CURRENT SELECTION (not the whole board) as a reusable collection
   *  (a user's "what if I just wanted to save a list / part of my board"). Reuses the
   *  proven `selectionToTemplate` → `saveCollection` pipeline: read every board item +
   *  connector (partitioned by the SHAPE predicate `itemIsConnector`, L090), hand the
   *  full set + the selected ids to `selectionToTemplate` (it keeps only the selection,
   *  re-origins to 0,0, and drops connectors with a dropped endpoint), then persist as a
   *  collection the library shows as a re-appliable row. Same DATA path as the board save. */
  const saveSelectionAsCollection = useCallback(async () => {
    const ids = [...selectedIdsRef.current];
    if (ids.length === 0) return;
    const name = await askText('Save selection as collection', 'My collection', 'Save');
    if (name === null) return;
    const cleanName = name.trim() || 'My collection';
    const collectionId = newId('arr');
    // boardSelectionToTemplate reads the whole board (items + connectors), keeps only the
    // selection (re-origined; connectors with a dropped endpoint pruned) — one pure helper.
    const template = boardSelectionToTemplate(readItems(graphRef.current, currentRefRef.current), ids, cleanName, collectionId);
    void commit(saveCollection(graphRef.current, cidx, { memberId: newId('col'), collectionId, name: cleanName, record: template }));
    showNotice(`Saved ${ids.length === 1 ? '1 item' : `${ids.length} items`} to your library`, 'success');
  }, [askText, cidx, commit, showNotice]);

  // R5 (cross-board) — the COLLECTION BASKET: accumulate this board's selection into the
  // session basket, switch boards, add more, then merge them ALL into one collection (a user:
  // "pull in from all these other boards and throw all these things into one template together").
  // The basket is a module singleton (survives board switches, like the clipboard); this bump
  // re-renders the panel so the basket bar reflects the current counts.
  const [, forceBasketRender] = useState(0);

  const addSelectionToBasket = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    if (ids.length === 0) return;
    const label =
      readActiveBoards(graphRef.current, indexRef).find((b) => b.boardId === currentBoardIdRef.current)?.title ?? 'Board';
    addBasketPick(basketPickFromSelection(currentBoardIdRef.current, label, readItems(graphRef.current, currentRefRef.current), ids));
    forceBasketRender((n) => n + 1);
    showNotice(`Added ${ids.length === 1 ? '1 item' : `${ids.length} items`} to the collection basket`, 'success');
  }, [indexRef, showNotice]);

  const saveBasketAsCollection = useCallback(async () => {
    if (basketPickCount() === 0) return;
    const name = await askText('Save collection', 'My collection', 'Save');
    if (name === null) return;
    const cleanName = name.trim() || 'My collection';
    const collectionId = newId('arr');
    const template = basketToCollection(cleanName, collectionId);
    const n = basketItemCount();
    const m = basketBoardCount();
    void commit(saveCollection(graphRef.current, cidx, { memberId: newId('col'), collectionId, name: cleanName, record: template }));
    clearBasket();
    forceBasketRender((v) => v + 1);
    showNotice(`Saved ${n} item${n === 1 ? '' : 's'} from ${m} board${m === 1 ? '' : 's'} to your library`, 'success');
  }, [askText, cidx, commit, showNotice]);

  const clearCollectionBasket = useCallback(() => {
    clearBasket();
    forceBasketRender((n) => n + 1);
  }, []);

  // Share the whole basket (several boards) as ONE self-contained link — "share a list of
  // several of my boards all at once with the same link" (R12). Composes the basket with the
  // capsule primitive; the hosted short-link stays the public-scene-share owner's job.
  const shareBasketAsLink = useCallback(async () => {
    if (basketPickCount() === 0) return;
    const name = await askText('Name this shared set', 'My boards', 'Share');
    if (name === null) return;
    const capsule = basketToShareCapsule(name.trim() || 'My boards');
    if (capsule.boards.length === 0) {
      showNotice('Nothing to share in the basket', 'info');
      return;
    }
    const referenceWarnings = shareReferenceWarnings(capsule);
    if (referenceWarnings.length > 0) {
      showNotice(`${referenceWarnings.length} linked ${referenceWarnings.length === 1 ? 'card is' : 'cards are'} not included in this share`, 'info');
    }
    const base = typeof window !== 'undefined' && window.location ? window.location.origin + window.location.pathname : '';
    const link = encodeShareLink(capsule, base);
    // Same fail-closed copy contract as shareBoard: verified success or the link
    // shown selectable for a manual copy — never a false "copied".
    if (await copyTextToClipboard(link)) {
      showNotice(`Share link copied — ${capsuleSummary(capsule)}`, 'success');
    } else {
      void askText('Copy did not work. Select this link and copy it', link, 'Done');
    }
  }, [askText, showNotice]);

  /** The library gallery's opaque action dispatch. `apply` stamps the arrangement
   *  onto a fresh board (reusing the template applier — a payload IS a BoardTemplate);
   *  the store-manage actions route to the ONE DATA-keyed controller (rename/archive/
   *  restore/duplicate), minting ids + prompting a name where the action needs one. */
  const onLibraryAction = useCallback(
    async (action: string, row: SavedArrangement) => {
      if (action === 'apply') {
        // §9.2 — ONE apply path for every arrangement kind (Codex-converged): resolve the
        // row's artifact against the CURRENT board's items, then stamp the result onto a
        // fresh board. A snapshot ignores the items (constant producer → its stored
        // template); a live lens re-clusters them by its facet. No branch on kind/source.
        const currentItems = boardToTemplate(graphRef.current, currentBoardIdRef.current);
        createBoardFromTemplate(resolveArrangementTemplate(row, currentItems));
        return;
      }
      if (action === 'compare') {
        // b145 — read-only "what changed since this saved version?": resolve the row against the current
        // board (same resolve path as apply), diff before=saved / after=current, copy the changelog to the
        // clipboard (no modal, mirrors copyOutline). A snapshot arrangement shares the board's ids, so the
        // diff is meaningful; an identical board yields "No changes".
        const currentItems = boardToTemplate(graphRef.current, currentBoardIdRef.current);
        const saved = resolveArrangementTemplate(row, currentItems);
        const { text, changed } = templateChangelog(saved.items, currentItems, `Changes since ${row.label}`);
        if (await copyTextToClipboard(text)) {
          showNotice(changed ? `Copied changes vs ${row.label}` : `No changes vs ${row.label}`, 'success');
        } else {
          void askText('Copy did not work. Select the changes and copy them', text, 'Done');
        }
        return;
      }
      if (action === 'rename') {
        const name = await askText('Rename layout', row.label, 'Save');
        if (name === null) return;
        void commit(runArrangementLibraryAction(graphRef.current, cidx, 'rename', row, { name: name.trim() || row.label }));
        return;
      }
      if (action === 'duplicate') {
        void commit(
          runArrangementLibraryAction(graphRef.current, cidx, 'duplicate', row, {
            newMemberId: newId('col'),
            newCollectionId: newId('arr'),
            name: `Copy of ${row.label}`,
          }),
        );
        showNotice('Duplicated', 'success');
        return;
      }
      // archive / restore need no extra input.
      void commit(runArrangementLibraryAction(graphRef.current, cidx, action, row, {}));
    },
    [askText, cidx, commit, createBoardFromTemplate, showNotice],
  );

  /** Export the CURRENT board (every item, nested sections, connectors) to a
   *  downloadable SVG — the portable artifact every canvas offers (#142). Pure
   *  `boardToSvg` serializes the flattened world-space tree; `downloadTextFile`
   *  (shared ui primitive) saves it. PNG raster + cross-origin image inlining is
   *  the #143 follow-on on this same SVG contract. */
  /** The flat item list for EXPORT — the whole board tree MINUS hidden items (#149).
   *  Hidden means "not on the visible board", so a hidden item must never appear in an
   *  exported SVG/PNG (Figma excludes hidden layers) — this excludes hidden items
   *  UNCONDITIONALLY, even while reveal mode (`showHidden`) shows them as editor ghosts.
   *  The ONE chokepoint every export path (whole-board count/SVG/PNG + selection subset)
   *  reads, so the rule lives once. */
  const visibleFlatten = useCallback(
    (rootRef: AddressRef): BoardItem[] =>
      flattenBoardTree(graphRef.current, rootRef).filter((it) => it.extra?.hidden !== true),
    [],
  );

  /** Count the drawable (non-connector) items across the visible board tree — the
   *  empty-export guard (a connector-only, empty, or all-hidden board has nothing to export). */
  const currentBoardDrawableCount = useCallback((): number => {
    return visibleFlatten(boardRootRef(currentBoardIdRef.current)).filter((it) => !itemIsConnector(it)).length;
  }, [visibleFlatten]);

  const exportBoardSvg = useCallback(() => {
    if (currentBoardDrawableCount() === 0) {
      showNotice('Board is empty — nothing to export', 'info');
      return;
    }
    try {
      const rootRef = boardRootRef(currentBoardIdRef.current);
      const flat = visibleFlatten(rootRef);
      const svg = boardToSvg(flat, { fillOf: exportFillOf, shapePathById: shapeSvgPathById, shapeOutlineById, background: '#ffffff', overlay: boardInkOverlay(), ...boardExportLook(currentBoardAppearanceRef.current) });
      const title =
        readActiveBoards(graphRef.current, indexRef).find((b) => b.boardId === currentBoardIdRef.current)?.title ?? 'board';
      const safe = title.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'board';
      downloadTextFile(svg, `${safe}.svg`, 'image/svg+xml');
      showNotice('Exported as SVG', 'success');
    } catch {
      showNotice('Could not export', 'error');
    }
  }, [indexRef, currentBoardDrawableCount, visibleFlatten, boardInkOverlay, showNotice]);

  /** Export the board's PRESENTATION FRAMES as a downloadable SLIDE DECK (one printable HTML doc,
   *  each frame a full-page slide in story order). Composes the SAME `boardToSvg` per frame via
   *  `boardToDeck`, then `deckToHtml` wraps them — zero new geometry/serialization (L069/L100). A
   *  board with no presentation frames has no deck, so this guides the user instead of exporting. */
  const exportBoardDeck = useCallback(async () => {
    const flat = await inlineBoardImages(visibleFlatten(boardRootRef(currentBoardIdRef.current)));
    const title =
      readActiveBoards(graphRef.current, indexRef).find((b) => b.boardId === currentBoardIdRef.current)?.title ?? 'board';
    const deck = boardToDeck(flat, { fillOf: exportFillOf, shapePathById: shapeSvgPathById, shapeOutlineById, background: '#ffffff', ...boardExportLook(currentBoardAppearanceRef.current) });
    if (deck.slides.length === 0) {
      // R20 fail-forward: the failure notice carries the fix. "Frame the board" bounds
      // every current drawable item in one new presentation frame (the same #169 path
      // the context menu uses), after which the deck export has its first slide.
      const allIds = flat.filter((i) => !itemIsConnector(i)).map((i) => i.memberId);
      showNotice(
        'No presentation frames to export — add a frame to build a deck',
        'info',
        allIds.length > 0 ? { label: 'Frame the board', onAction: () => frameSelectionRef.current(allIds) } : undefined,
      );
      return;
    }
    try {
      const safe = title.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'board';
      downloadTextFile(deckToHtml(deck, { title, font: getComputedStyle(document.documentElement).getPropertyValue('--font-primary') }), `${safe}.deck.html`, 'text/html');
      showNotice(`Exported ${deck.slides.length} slides`, 'success');
    } catch {
      showNotice('Could not export', 'error');
    }
  }, [indexRef, visibleFlatten, showNotice]);

  /** Open the shared image carousel over the board, adapting the same ordered
   *  `BoardDeck` that powers deck export. This keeps preview order and rendering
   *  tied to the existing presentation-frame data. */
  const openFrameCarousel = useCallback(async () => {
    const flat = await inlineBoardImages(visibleFlatten(boardRootRef(currentBoardIdRef.current)));
    const deck = boardToDeck(flat, {
      fillOf: exportFillOf,
      shapePathById: shapeSvgPathById,
      shapeOutlineById,
      background: '#ffffff',
      ...boardExportLook(currentBoardAppearanceRef.current),
    });
    const media = deckToMediaCarouselItems(deck);
    if (media.length === 0) {
      showNotice('No presentation frames to view — add a frame to build a carousel', 'info');
      return;
    }
    setCarouselItems(media);
    setCarouselOpen(true);
  }, [visibleFlatten, showNotice]);

  const publishFrames = useCallback(async () => {
    if (!publishFrameMedia || publishingFrames) return;
    setPublishingFrames(true);
    try {
      const flat = await inlineBoardImages(visibleFlatten(boardRootRef(currentBoardIdRef.current)));
      const deck = boardToDeck(flat, {
        fillOf: exportFillOf, shapePathById: shapeSvgPathById, shapeOutlineById,
        background: '#ffffff', ...boardExportLook(currentBoardAppearanceRef.current),
      });
      const frames = boardFrameMedia(deck);
      if (!frames.length) throw new Error('Add a presentation frame before sharing images.');
      const shared = await publishFrameMedia(frames);
      if (shared.mediaUrls.length !== frames.length) throw new Error('The shared images did not match the board frames.');
      setCarouselItems(frames.map((frame, index) => ({
        id: frame.frameId, src: shared.mediaUrls[index], alt: frame.label, label: `${frame.order}. ${frame.label}`,
      })));
      setFramePublication({ pageUrl: shared.pageUrl, stop: shared.stop });
      showNotice('Frame images are ready to share', 'success');
    } catch (error) {
      showNotice(errorWords(error, 'Could not share frame images'), 'error');
    } finally { setPublishingFrames(false); }
  }, [publishFrameMedia, publishingFrames, visibleFlatten, showNotice]);

  const stopFramePublication = useCallback(async () => {
    if (!framePublication) return;
    try {
      await framePublication.stop();
      setFramePublication(null);
      await openFrameCarousel();
      showNotice('Frame image link stopped', 'success');
    } catch (error) {
      showNotice(errorWords(error, 'Could not stop the link'), 'error');
    }
  }, [framePublication, openFrameCarousel, showNotice]);

  /** Rasterize ANY flat item list to a PNG Blob — the ONE raster core (L069/L030).
   *  Whole-board (#143/#146) AND selection (#148) export both flow through here:
   *  inline image srcs → SAME `boardToSvg` (#142) → `svgToPngBlob`. The item list is
   *  the only variable — the bytes pipeline is identical, so selection export is
   *  free once the subset is computed. */
  const rasterBlobFromItems = useCallback(
    async (flat: readonly BoardItem[], overlay?: BoardSvgOverlay): Promise<Blob> => {
      const inlined = await inlineBoardImages(flat);
      const svg = boardToSvg(inlined, { fillOf: exportFillOf, shapePathById: shapeSvgPathById, shapeOutlineById, background: '#ffffff', overlay, ...boardExportLook(currentBoardAppearanceRef.current) });
      return svgToPngBlob(svg, { scale: 2, background: '#ffffff' });
    },
    [],
  );

  const currentBoardRasterBlob = useCallback(async (): Promise<Blob> => {
    const flat = visibleFlatten(boardRootRef(currentBoardIdRef.current));
    // Whole-board raster (PNG download + copy-PNG) carries the drawing ink overlay (#168);
    // selection raster passes no overlay (a selection export is item-scoped, not ink-scoped).
    return rasterBlobFromItems(flat, boardInkOverlay());
  }, [rasterBlobFromItems, visibleFlatten, boardInkOverlay]);

  /** R43c: the board-as-a-picture exports surfaced INSIDE the Export panel (SVG + PNG),
   *  each an injected `produce` capability the panel delivers through the destination chain
   *  (so the image saves via the working engine file-save, not the presenter-dead anchor).
   *  Reuses the SAME boardToSvg / raster core the standalone menu actions use (L069/L100). */
  const boardImageExports = useMemo(() => {
    const safeTitle = (): string => {
      const t = readActiveBoards(graphRef.current, indexRef).find((b) => b.boardId === currentBoardIdRef.current)?.title ?? 'board';
      return t.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'board';
    };
    return [
      {
        id: 'image-svg',
        label: 'SVG',
        produce: async () => {
          const flat = visibleFlatten(boardRootRef(currentBoardIdRef.current));
          const svg = boardToSvg(flat, { fillOf: exportFillOf, shapePathById: shapeSvgPathById, shapeOutlineById, background: '#ffffff', overlay: boardInkOverlay(), ...boardExportLook(currentBoardAppearanceRef.current) });
          return { filename: `${safeTitle()}.svg`, mimeType: 'image/svg+xml', text: svg };
        },
      },
      {
        id: 'image-png',
        label: 'PNG',
        produce: async () => {
          const blob = await currentBoardRasterBlob();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          return { filename: `${safeTitle()}.png`, mimeType: 'image/png', bytes };
        },
      },
    ];
  }, [indexRef, visibleFlatten, boardInkOverlay, currentBoardRasterBlob]);

  const exportBoardPng = useCallback(async () => {
    if (currentBoardDrawableCount() === 0) {
      showNotice('Board is empty — nothing to export', 'info');
      return;
    }
    try {
      const blob = await currentBoardRasterBlob();
      const title =
        readActiveBoards(graphRef.current, indexRef).find((b) => b.boardId === currentBoardIdRef.current)?.title ?? 'board';
      const safe = title.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'board';
      downloadBlob(blob, `${safe}.png`);
      showNotice('Saved as PNG', 'success');
    } catch {
      showNotice('Could not export', 'error');
    }
  }, [currentBoardRasterBlob, indexRef, currentBoardDrawableCount, showNotice]);

  /** Copy the current board to the system clipboard as a PNG (#146) — the 3rd
   *  caller of the boardToSvg→svgToPngBlob chain (L069). Users paste straight into
   *  Slack/docs/email with no file roundtrip. Clipboard denied/absent → no-op
   *  (copyImageBlobToClipboard returns false, never throws). */
  const copyBoardPng = useCallback(async () => {
    if (currentBoardDrawableCount() === 0) {
      showNotice('Board is empty — nothing to copy', 'info');
      return;
    }
    try {
      const blob = await currentBoardRasterBlob();
      const ok = await copyImageBlobToClipboard(blob);
      showNotice(ok ? 'Copied to clipboard' : 'Clipboard unavailable', ok ? 'success' : 'error');
    } catch {
      showNotice('Could not copy', 'error');
    }
  }, [currentBoardRasterBlob, currentBoardDrawableCount, showNotice]);

  /** The flat item subset for a selection export (#148): exactly the chosen members
   *  PLUS connectors whose BOTH endpoints are in the selection (a half-selected line
   *  would dangle, so it's dropped). Deterministic: export reflects what's selected,
   *  nothing more. Drawables (non-connectors) drive the count gate below. */
  const selectionSubset = useCallback((memberIds: readonly string[]): BoardItem[] => {
    const wanted = new Set(memberIds);
    const flat = visibleFlatten(boardRootRef(currentBoardIdRef.current));
    return flat.filter((it) => {
      if (itemIsConnector(it)) {
        const f = it.extra?.fromMemberId;
        const t = it.extra?.toMemberId;
        return typeof f === 'string' && typeof t === 'string' && wanted.has(f) && wanted.has(t);
      }
      return wanted.has(it.memberId);
    });
  }, [visibleFlatten]);

  /** Export ONLY the selected items as SVG/PNG, or copy them as PNG — the 4th caller
   *  of the #142 `boardToSvg` contract (L069). `boardToSvg`/`rasterBlobFromItems`
   *  reframe the viewBox to the subset's bbox automatically, so the artifact is
   *  cropped to the selection with zero special-casing. */
  const exportSelectionSvg = useCallback(
    (memberIds: string[]) => {
      const subset = selectionSubset(memberIds);
      if (subset.filter((it) => !itemIsConnector(it)).length === 0) {
        showNotice('Nothing selected to export', 'info');
        return;
      }
      try {
        const svg = boardToSvg(subset, { fillOf: exportFillOf, shapePathById: shapeSvgPathById, shapeOutlineById, background: '#ffffff', ...boardExportLook(currentBoardAppearanceRef.current) });
        downloadTextFile(svg, 'selection.svg', 'image/svg+xml');
        showNotice('Exported selection (SVG)', 'success');
      } catch {
        showNotice('Could not export', 'error');
      }
    },
    [selectionSubset, showNotice],
  );

  const exportSelectionPng = useCallback(
    async (memberIds: string[]) => {
      const subset = selectionSubset(memberIds);
      if (subset.filter((it) => !itemIsConnector(it)).length === 0) {
        showNotice('Nothing selected to export', 'info');
        return;
      }
      try {
        const blob = await rasterBlobFromItems(subset);
        downloadBlob(blob, 'selection.png');
        showNotice('Saved selection (PNG)', 'success');
      } catch {
        showNotice('Could not export', 'error');
      }
    },
    [selectionSubset, rasterBlobFromItems, showNotice],
  );

  const copySelectionPng = useCallback(
    async (memberIds: string[]) => {
      const subset = selectionSubset(memberIds);
      if (subset.filter((it) => !itemIsConnector(it)).length === 0) {
        showNotice('Nothing selected to copy', 'info');
        return;
      }
      try {
        const blob = await rasterBlobFromItems(subset);
        const ok = await copyImageBlobToClipboard(blob);
        showNotice(ok ? 'Copied selection' : 'Clipboard unavailable', ok ? 'success' : 'error');
      } catch {
        showNotice('Could not copy', 'error');
      }
    },
    [selectionSubset, rasterBlobFromItems, showNotice],
  );

  /** Archive the current board (recoverable) and open another active one. Never
   *  archives the last active board — a surface always shows at least one. */
  const archiveCurrentBoard = useCallback(() => {
    const list = readActiveBoards(graphRef.current, indexRef);
    if (list.length <= 1) return;
    const entry = list.find((bd) => bd.boardId === currentBoardIdRef.current);
    if (!entry) return;
    const fallback = list.find((bd) => bd.boardId !== entry.boardId);
    if (!fallback) return;
    landOnBoard(fallback.boardId); // #220 forced redirect (current board archived) → NO history push
    void commit(archiveBoard(graphRef.current, indexRef, entry.memberId));
  }, [commit, indexRef, landOnBoard]);

  /** Restore an archived board into the active switcher and open it. */
  const restoreArchivedBoard = useCallback((archivedBoardId: string) => {
    const entry = readArchivedBoards(graphRef.current, indexRef).find((bd) => bd.boardId === archivedBoardId);
    if (!entry) return;
    switchBoard(entry.boardId); // #220 voluntary nav to the restored board → Back returns
    void commit(restoreBoard(graphRef.current, indexRef, entry.memberId));
  }, [commit, indexRef, switchBoard]);

  /** Permanently delete every archived board (empty the archive). */
  const emptyArchive = useCallback(() => {
    const archived = readArchivedBoards(graphRef.current, indexRef);
    if (!archived.length) return;
    // ONE batch removal instead of folding removeBoard per archived board (removeBoard = removeMember on the
    // index, so removeItems over the index is the batch SSOT) — O(#boards + K) not O(K * #boards).
    void commit(removeItems(graphRef.current, indexRef, archived.map((bd) => bd.memberId)));
  }, [commit, indexRef]);

  /** Declutter: soft-archive EVERY active board except the current one, in a
   *  single commit. Recoverable — the archived boards move to the Archived
   *  section, restorable individually. Composes the same {@link archiveBoard}
   *  model fn as {@link archiveCurrentBoard} over the active list (the fold-once
   *  pattern of {@link emptyArchive}); adds zero physics. Lets a user with many
   *  boards focus down to one without N one-by-one archive clicks. */
  const archiveOtherBoards = useCallback(() => {
    const list = readActiveBoards(graphRef.current, indexRef);
    const others = list.filter((bd) => bd.boardId !== currentBoardIdRef.current);
    if (!others.length) return;
    let next = graphRef.current;
    for (const bd of others) next = archiveBoard(next, indexRef, bd.memberId);
    void commit(next);
  }, [commit, indexRef]);

  /** Dissolve a selected section back into the current group (its items rejoin). */
  const ungroupSelected = useCallback((memberId: string) => {
    setSelectedIds(new Set());
    void commit(ungroupItems(graphRef.current, currentRefRef.current, memberId));
  }, [commit]);

  /** Move the selection OUT to the parent group (the inverse of drag-into-section).
   *  Completes folder symmetry: items go in by drag/group and out by this action. */
  const moveSelectedOut = useCallback(() => {
    const dest = parentRefRef.current;
    if (!dest) return;
    const ids = [...selectedIdsRef.current];
    if (!ids.length) return;
    setSelectedIds(new Set());
    // ONE batch cross-group move (O(M_from+M_to+K)) instead of folding moveItemToGroup per id — moving a
    // large selection out of a section was O(K*(M_from+M_to)) = O(N^2) (each move re-spread both groups).
    const next = moveItemsToGroup(graphRef.current, currentRefRef.current, dest, ids);
    void commit(next);
  }, [commit]);

  /** Rename a section (or any titled item) — the one generic text edit. Drill-in
   *  owns double-click, so renaming a section is a deliberate toolbar action. */
  const renameItem = useCallback(async (memberId: string, current: string) => {
    const next = await askText('Rename', current, 'Save');
    if (next === null) return;
    // text+html in sync (same as renameLayer #154) — keeps the canvas consistent if
    // this path ever renames a note, not just a section (which ignores html).
    const t = next.trim() || current;
    void commit(editItem(graphRef.current, currentRefRef.current, memberId, { text: t, html: textToHtml(t) }));
  }, [askText, commit]);

  /** Link an item to its source URL — the one generic href write. Opens the in-app
   *  text overlay (works in every shell) pre-filled with the current link; on Save
   *  the input is normalized to a safe href (bare host → https://, non-URL → cleared)
   *  and written as `extra.href` DATA via the generic patchItem. The blind link chip
   *  (rendered in the node's `cornerActions`) reads it and opens it. */
  const setItemLink = useCallback(async (memberId: string, current: string | undefined) => {
    const next = await askText('Link to a URL', current ?? '', 'Save');
    if (next === null) return;
    void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { href: normalizeHref(next) || undefined }));
  }, [askText, commit]);

  /** #218 — link an item to ANOTHER board (Miro/FigJam "board of boards"). The sibling of
   *  setItemLink: where href points at an external URL, `extra.boardLink` names a boardId
   *  of the board index. `boardId` null clears it (Unlink). The blind board-link chip
   *  (in the node's `cornerActions`) resolves it against the live boards list and, on
   *  click, navigates via `switchBoard`. One generic DATA write — no portal item-kind. */
  const setItemBoardLink = useCallback((memberId: string, boardId: string | null) => {
    void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { boardLink: boardId || undefined }));
  }, [commit]);

  // #225 (P1) — set a text item's size mode (fit/fill/scroll) as self-describing DATA. One
  // undoable patch of `extra.sizeMode`; the blind renderer honors it via the appearance cascade.
  // Set/clear ONE per-item appearance override (`extra.<key>`) — the cascade's third tier. Generic
  // over `key` (the descriptor primitive names it): `undefined`/'' clears so the note inherits the
  // board default. One write path for every note-appearance key (dissolved the old sizeMode one-off).
  const setItemAppearanceKey = useCallback((memberId: string, key: string, value: unknown) => {
    const cleared = value === undefined || value === '' ? undefined : value;
    void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { [key]: cleared }));
  }, [commit]);

  // R3/P2 — set/clear a note's list marker as self-describing DATA. Writes `extra.marker` (a
  // marker id); the blind NoteItem renderer resolves it via the catalog's injected producer
  // map. A media marker (self-describing `needsMediaUrl` flag — the panel never hardcodes which
  // kinds are media) prompts for a URL via the in-app overlay and writes `extra.markerMediaUrl`;
  // any other pick clears a stale media URL. '' clears the marker. Same DATA path as sizeMode.
  const setItemMarker = useCallback(async (memberId: string, markerId: string) => {
    // Clear BOTH per-item overrides on every pick; the chosen marker's flags re-set the one it needs.
    const patch: Record<string, unknown> = { marker: markerId || undefined, markerMediaUrl: undefined, markerGlyph: undefined };
    const marker = markerById(markerId);
    if (marker?.needsMediaUrl) {
      const url = await askText('Image or video URL for the bullet', '', 'Set');
      if (url === null) return; // cancelled → leave the item unchanged
      patch.markerMediaUrl = normalizeHref(url) || undefined;
    } else if (marker?.needsGlyph) {
      // a user's "whatever they want": any char/emoji becomes the bullet (self-describing needsGlyph).
      const glyph = await askText('Type any character or emoji for the bullet', '★', 'Set');
      if (glyph === null) return; // cancelled → leave the item unchanged
      const trimmed = glyph.trim();
      patch.markerGlyph = trimmed !== '' ? [...trimmed][0] : undefined; // first grapheme; empty → no override
    }
    void commit(patchItem(graphRef.current, currentRefRef.current, memberId, patch));
  }, [askText, commit]);

  /** #217 — a note reports the height it needs to show all its text (grow-only, measured
   *  by the renderer). Patch the item's `h` as a layout write (not undoable — it is a
   *  derivation of the content, like the producer result-land patch). Locked items resist;
   *  the live re-check drops a stale report from a render that has since been superseded. */
  const autoHeightNote = useCallback((memberId: string, height: number) => {
    const it = readItems(graphRef.current, currentRefRef.current).find((i) => i.memberId === memberId);
    if (!it || itemIsLocked(it) || Math.abs((it.h ?? 0) - height) < 2) return;
    void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { h: height }), graphRef.current, { undoable: false });
  }, [commit]);

  /** Manually author a link card's preview — the Dub-style owner override. Prompts for
   *  the card TITLE then an optional DESCRIPTION and writes them as `extra.linkPreview`
   *  DATA (the SAME field the OG-enrichment workflow will populate), so the rich renderer
   *  (#204/#205/#206) is reachable without waiting for the fetch. Empty answers clear a
   *  field; an all-empty preview clears the whole DATA (no fake). Locked items resist. */
  const setItemLinkPreview = useCallback(async (memberId: string) => {
    const it = readItems(graphRef.current, currentRefRef.current).find((i) => i.memberId === memberId);
    if (!it || itemIsLocked(it)) return;
    const cur = readLinkPreview(it.extra) ?? {};
    const domain = hostFromHref(typeof it.src === 'string' ? it.src : undefined);
    const title = await askText('Card title', cur.title ?? domain, 'Save');
    if (title === null) return;
    const description = await askText('Description (optional)', cur.description ?? '', 'Save');
    if (description === null) return;
    const linkPreview = mergeLinkPreviewEdit(cur, { title, description });
    void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { linkPreview }));
  }, [askText, commit]);

  /** Tag an item — the one generic tags write. Opens the in-app text overlay pre-filled
   *  with the current comma-separated tags; on Save the input is parsed (split / trim /
   *  dedupe) and written as `extra.tags` DATA via the generic patchItem (empty clears).
   *  The blind filter bar reads the distinct tag set across all items. */
  const setItemTags = useCallback(async (memberId: string, current: readonly string[]) => {
    const next = await askText('Tags (comma-separated)', formatTags(current), 'Save');
    if (next === null) return;
    const tags = parseTags(next);
    void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { tags: tags.length ? tags : undefined }));
  }, [askText, commit]);

  // Delete / Backspace removes the selection. Ignored while editing text (a
  // note's contentEditable / any input) so typing in a note stays safe.
  // withKeyboardClaim (all four global listeners here): stands down on a key another
  // pane already claimed and seals our own claims — live incident 2026-07-10: a
  // neighbouring editor pane's Cmd+A (preventDefault only) bubbled into this window
  // listener, selected every card, and docked the tools rail over that pane.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKey = withKeyboardClaim((e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      deleteSelected();
    });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, deleteSelected]);

  // Cmd/Ctrl-Z undo, Cmd-Shift-Z (or Ctrl-Y) redo — reverses a whole batch
  // multi-edit (align/distribute/apply-to-all) as ONE step via canvas-history.
  // Ignored while typing in a note so text undo stays native.
  useEffect(() => {
    const onKey = withKeyboardClaim((e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const redo = key === 'y' || (key === 'z' && e.shiftKey);
      e.preventDefault();
      if (redo) history.redo();
      else history.undo();
    });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history]);

  /** Screen → world coords (inverse of the world-transform translate+scale). */
  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const cam = cameraRef.current;
    return { x: (clientX - (rect?.left ?? 0) - cam.panX) / cam.zoom, y: (clientY - (rect?.top ?? 0) - cam.panY) / cam.zoom };
  }, []);

  /** World → screen (viewport) coords — the forward of {@link screenToWorld}. A
   *  body-portaled overlay (AnchoredOverlay) lives in viewport space, so a canvas
   *  anchor's world rect must be projected through the camera to place it. Recomputed
   *  per render (camera drives re-render) so it stays fresh across pan/zoom. */
  const worldToScreen = useCallback((worldX: number, worldY: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    const cam = cameraRef.current;
    return { x: worldX * cam.zoom + cam.panX + (rect?.left ?? 0), y: worldY * cam.zoom + cam.panY + (rect?.top ?? 0) };
  }, []);

  const items = useMemo(() => readItems(graph, currentRef), [graph, currentRef]);
  const empty = isBoardEmpty(graph, currentRef);
  // Visibility (#149): the set of hidden member ids. Declared here (with `items`)
  // because the connector layer and the focus bar both read it below — declaring it
  // by `lockedIds` would be a TDZ ReferenceError on mount.
  const hiddenIds = useMemo(() => new Set(items.filter((i) => i.extra?.hidden === true).map((i) => i.memberId)), [items]);
  // #163 — per-node collapse-caret state (the toggle shown on any node with a connector
  // subtree). Computed ONCE per items/hiddenIds change (not O(n²) per render) so the node
  // render is an O(1) map lookup. A node with no children is absent → no caret (L118).
  const branchToggles = useMemo(() => branchToggleStates(items, hiddenIds), [items, hiddenIds]);

  // ── Node layer vs edge layer ────────────────────────────────────────────────
  // A board item is an EDGE iff its presentation carries two endpoint refs — the
  // one Physics distinction in a graph canvas (a relation needs two endpoints; a
  // placed object needs one position). The partition keys off the DATA SHAPE
  // (presence of from/to refs), not a kind string, so ANY future relation that
  // carries endpoint refs renders as an edge with zero new branch (L090).
  const endpointsOf = useCallback((it: BoardItem) => connectorEndpoints(it), []);
  const nodeItems = useMemo(() => items.filter((it) => endpointsOf(it) === null), [items, endpointsOf]);
  const allCommentReviewRows = useMemo(() => {
    const legacy = new Map(boardCommentThreads(nodeItems).map(({ anchorId, thread }) => [anchorId, threadSummary(thread)]));
    const shared = new Map(sharedCommentSummaries.map(summary => [summary.record, summary]));
    return nodeItems.flatMap(item => {
      const record = groupRecordAddress(itemRef(currentBoardId, item.memberId));
      const old = legacy.get(item.memberId);
      const current = shared.get(record);
      if (!old && (!current || current.count === 0)) return [];
      const resolved = sharedThreadResolutions[record] ?? current?.resolved ?? old?.resolved ?? false;
      const latestIsOld = (old?.lastAt ?? 0) >= (current?.lastAt ?? 0);
      const summary: ThreadSummary = {
        count: (old?.count ?? 0) + (current?.count ?? 0),
        resolved,
        open: !resolved,
        lastAt: Math.max(old?.lastAt ?? 0, current?.lastAt ?? 0) || null,
        lastAuthor: latestIsOld ? old?.lastAuthor ?? null : null,
        preview: latestIsOld ? old?.preview ?? null : null,
      };
      return [{ anchorId: item.memberId, label: item.text?.trim() || item.memberId, summary }];
    }).sort((a, b) => Number(b.summary.open) - Number(a.summary.open) || (b.summary.lastAt ?? 0) - (a.summary.lastAt ?? 0));
  }, [nodeItems, currentBoardId, sharedCommentSummaries, sharedThreadResolutions]);
  const connectorItems = useMemo(() => items.filter((it) => endpointsOf(it) !== null), [items, endpointsOf]);
  // Document EXPORT items = the whole board TREE (root + every drill-in section's contents), NOT just the
  // current level, so Markdown/CSV/iCalendar/Status never silently drop a card nested inside a section —
  // matching the SVG export path (which already flattens). Connectors excluded (exports are of content).
  const exportItems = useMemo(
    () => flattenBoardTree(graph, currentRef).filter((it) => endpointsOf(it) === null),
    [graph, currentRef, endpointsOf],
  );
  // Single wall-clock instant for this render frame. Every render-path reader (due, streaks, forecast,
  // attention, momentum, critical-path, next-focus, on-card due/habit/time layers) computes against this
  // ONE `nowFrame`, never its own `Date.now()` — so no frame can straddle a day/period boundary and show
  // contradictory surfaces ("0 overdue" beside "streak broken"). Event handlers still read the clock fresh
  // at action time; this is the render frame's clock only. Refreshes on every re-render (clock::tick).
  const nowFrame = Date.now();

  // R9 — the board's typed connectors ARE a relationship graph; derive it once and let the
  // RelationInspector read "what does the selected card depend on / block / relate to".
  const relationGraph = useMemo(() => buildRelationGraph(items), [items]);
  const memberTitle = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) {
      const plain = it.text ?? (it.html ? it.html.replace(/<[^>]+>/g, '').trim() : '');
      m.set(it.memberId, plain || it.memberId);
    }
    return m;
  }, [items]);
  const titleForMember = useCallback((id: string) => memberTitle.get(id) ?? id, [memberTitle]);

  // The SUBJECT an action acts on: the selected note cards' text, in board order, joined —
  // and when NOTHING is selected, the WHOLE board's card text. This is the board's
  // equivalent of composition's focused-block text — the surface fills an action's
  // `typed.text` with its subject so translate/summarize/brainstorm operate on real
  // content instead of an empty prompt (the "nothing to translate" bug). The whole-board
  // fallback is what makes a no-ask action (a user's 2026-07-09 report) meaningful with
  // zero extra prompts: the action already knows its instruction (DATA) and its subject
  // (the selection, else the board). Ref'd so the async producer submit callback reads
  // live state, never a stale closure.
  // Codex-audit hardening (b247): the whole-board branch EXCLUDES hidden cards
  // (`extra.hidden` — off-canvas content must not leak into a run the user can't
  // see) and the subject is size-capped so a thousand-card board can't blow the
  // producer's prompt (same defuse-the-pathological posture as MAX_TEXT_SOURCE_CHARS).
  const selectedSubjectText = useMemo(() => selectedSubjectBag(nodeItems, selectedIds, MAX_SUBJECT_CHARS), [nodeItems, selectedIds]);
  const selectedSubjectTextRef = useRef(selectedSubjectText);
  selectedSubjectTextRef.current = selectedSubjectText;
  // Flavor B (edit-in-place) sibling of `typed.text`: the WHOLE board as ID-ANNOTATED
  // lines (`[memberId] text` per non-hidden card) via the shared `subjectBag` projection
  // leaf. A reconcile action whose instruction reads `{typed.items_text}` and asks the
  // agent to ECHO existing ids for edits (no id → new note) lets the reconcile consume
  // seam edit each card IN PLACE (position kept) instead of regenerating. Additive: the
  // shipped Flavor-A `typed.text` binding is untouched; actions opt in by naming this key.
  const idAnnotatedSubjectText = useMemo(() => subjectBag(nodeItems, idAnnotatedLine), [nodeItems]);
  const idAnnotatedSubjectTextRef = useRef(idAnnotatedSubjectText);
  idAnnotatedSubjectTextRef.current = idAnnotatedSubjectText;

  // R7 — a guided walkthrough of the board. The tour is DATA; its steps attach to the first
  // few cards (or float unattached when the board is empty). `tourIndex` null = inactive.
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  // The tour the overlay is currently walking — the authored board guide, or a "Read in order" tour generated
  // from the board's spatial reading order (b202). null → fall back to the authored boardTour.
  const [activeTour, setActiveTour] = useState<Tour | null>(null);
  // R13 sparring: the selected note cards that hold text, as drafts to rank.
  const [showSparring, setShowSparring] = useState(false);
  const sparringDrafts = useMemo<SparringDraft[]>(
    () =>
      nodeItems
        .filter((it) => selectedIds.has(it.memberId))
        .map((it) => {
          const text = it.text ?? (it.html ? it.html.replace(/<[^>]+>/g, '').trim() : '');
          return { id: it.memberId, title: memberTitle.get(it.memberId) ?? it.memberId, text };
        })
        .filter((d) => d.text.length > 0),
    [nodeItems, selectedIds, memberTitle],
  );
  // R13/R14 "keep the best": remove every sparred draft except the winner (undoable — the
  // board's normal history covers it). Reuses the exact delete path (removeItem + dangling-
  // connector cleanup) so a removed card takes its connectors with it.
  const keepWinnerDrafts = useCallback(
    async (winnerId: string, loserIds: readonly string[]) => {
      const cur = currentRefRef.current;
      // The same removal rule as Delete: a locked draft stays, and its connectors with it.
      const { graph: next, removed, locked } = removeUnlockedItems(graphRef.current, cur, loserIds);
      if (removed.length > 0) {
        // Announce only what was saved: a failed save has already reverted the board and
        // shown its error, so the sparring view stays open for another try.
        const error = await commit(next);
        if (error !== null) return;
      }
      setSelectedIds(new Set([winnerId]));
      setShowSparring(false);
      if (removed.length === 0 && locked.length === 0) return;
      const removedWords = `removed ${removed.length} draft${removed.length === 1 ? '' : 's'}`;
      const lockedWords = locked.length > 0 ? `; ${locked.length} locked draft${locked.length === 1 ? '' : 's'} stayed` : '';
      showNotice(`Kept the winner, ${removedWords}${lockedWords}`, 'success');
    },
    [commit, showNotice],
  );
  // R14 "write-a-lot → cut to nugget → rewrite": the ONE selected note with text is the
  // starting draft. The whole loop is engine-free (judge + author-typed rewrites); AI
  // generation would only prefill the rewrite box (ai-providers owner boundary).
  const [showRefine, setShowRefine] = useState(false);
  const refineTarget = useMemo<{ id: string; text: string } | null>(() => {
    if (selectedIds.size !== 1) return null;
    const only = nodeItems.find((it) => selectedIds.has(it.memberId));
    if (!only) return null;
    const text = only.text ?? (only.html ? only.html.replace(/<[^>]+>/g, '').trim() : '');
    return text.trim().length > 0 ? { id: only.memberId, text } : null;
  }, [nodeItems, selectedIds]);
  const useRewriteVersion = useCallback(
    (memberId: string, text: string) => {
      const t = text.trim();
      if (t.length === 0) return;
      void commit(editItem(graphRef.current, currentRefRef.current, memberId, { text: t, html: textToHtml(t) }));
      setShowRefine(false);
      showNotice('Updated the note with the chosen version', 'success');
    },
    [commit, showNotice],
  );
  // R3 outline: a multi-line note can be restructured as a nested outline (indent/outdent/
  // reorder rows via the pure list-block-model leaf). Only offered for a note with 2+ lines,
  // since a single line has no structure to shape. Applying serializes back to indented text.
  const [outlineEdit, setOutlineEdit] = useState<{ id: string; items: readonly ListItem[]; marker: string; multiLevel: boolean } | null>(null);
  const outlineCandidate = useMemo<{ id: string; text: string; marker: string; multiLevel: boolean } | null>(() => {
    if (!refineTarget || !refineTarget.text.includes('\n')) return null;
    const node = nodeItems.find((it) => it.memberId === refineTarget.id);
    const marker = typeof node?.extra?.marker === 'string' ? (node.extra.marker as string) : '';
    const multiLevel = Array.isArray(node?.extra?.outlineMarkers);
    return { id: refineTarget.id, text: refineTarget.text, marker, multiLevel };
  }, [refineTarget, nodeItems]);
  const applyOutline = useCallback(
    (memberId: string, items: readonly ListItem[], marker: string, multiLevel: boolean) => {
      const t = serializeOutline(items).trim();
      if (t.length === 0) return;
      // Persist the text, the chosen list marker (picked in-flow — '' clears it), AND flip the
      // note into outline render mode (extra.contentMode) so it draws as a marked, indented
      // outline. patchItem drops `undefined`, so marker:'' → no marker. The SAME marker draws
      // one bullet on a plain note and per-row bullets here (L069 reuse, no new field).
      // Multi-level → store the legal-outline marker-id cascade per nesting level (else clear it).
      void commit(editItem(graphRef.current, currentRefRef.current, memberId, {
        text: t,
        html: textToHtml(t),
        contentMode: 'outline',
        marker: marker || undefined,
        outlineMarkers: multiLevel ? [...DEFAULT_OUTLINE_MARKER_IDS] : undefined,
      }));
      setOutlineEdit(null);
      showNotice('Applied the outline to the note', 'success');
    },
    [commit, showNotice],
  );
  const boardTour = useMemo<Tour>(() => {
    const ids = nodeItems.slice(0, 3).map((n) => n.memberId);
    return {
      id: 'board-basics',
      name: 'Board basics',
      steps: [
        { id: 's1', target: ids[0], title: 'Your cards', body: 'Every card is an idea — drag it, colour it, give it a bullet.' },
        { id: 's2', target: ids[1], title: 'Connect & relate', body: 'Draw a connector to make a relationship: depends on, blocks, relates to.' },
        { id: 's3', target: ids[2], title: 'Arrange & share', body: 'Group by tag or colour, then Share the board as a link.' },
      ],
    };
  }, [nodeItems]);
  // Every distinct tag across the board's items — still used to gate the focus bar's
  // visibility (L090: read from self-describing `extra.tags`, never an item-kind branch).
  const boardTags = useMemo(() => distinctTags(nodeItems), [nodeItems]);
  // The available values for EVERY focus facet (tag/color/kind) across the board's items —
  // the chip groups. ONE facet SSOT (`facetValues` + `BOARD_ITEM_FACETS`), so a new focus
  // dimension is one descriptor row, zero panel code (the cont.28 facet engine, 2nd consumer).
  const focusFacetValues = useMemo<Record<string, string[]>>(
    () => Object.fromEntries(BOARD_FOCUS_FACETS.map((f) => [f.key, facetValues(nodeItems, BOARD_ITEM_FACETS[f.key])])),
    [nodeItems],
  );
  // How many items each focus chip would match GIVEN the other active focus facets (conjunctive
  // faceted-nav) — the number shown on each chip so you know the subset size before clicking.
  // Same facet SSOT (`facetValueCounts` + `BOARD_ITEM_FACETS`); recomputed as the selection moves.
  const focusFacetCounts = useMemo<Record<string, Record<string, number>>>(
    () => Object.fromEntries(BOARD_FOCUS_FACETS.map((f) => [f.key, facetValueCounts(nodeItems, f.key, focusFacets, BOARD_ITEM_FACETS)])),
    [nodeItems, focusFacets],
  );
  // The COLOUR each focus-facet value would get from "Colour by <facet>" (cont.43 stable board-wide
  // assignment, the SAME palette the bulk action paints). Feeds a swatch on each focus chip so the
  // chip group doubles as a LIVE colour LEGEND — the readout half of colour-by-facet (L116). ONE
  // facet SSOT (`facetColorAssignment` over `nodeItems`); a chip's swatch == the colour it paints.
  const focusFacetColors = useMemo<Record<string, Record<string, string>>>(
    () =>
      Object.fromEntries(
        BOARD_FOCUS_FACETS.map((f) => [
          f.key,
          // Only facets that HAVE a "Colour by <facet>" action get swatches — else the legend would
          // imply a colouring that no action produces (colour-family is excluded as circular).
          COLOR_BY_FACET_KEYS.includes(f.key)
            ? Object.fromEntries(
                facetColorAssignment(nodeItems, BOARD_ITEM_FACETS[f.key], BOARD_PALETTES[0].colors).pairs.map((p) => [p.value, p.color]),
              )
            : {},
        ]),
      ),
    [nodeItems],
  );
  // Drop any selected facet value that no longer exists on the board (e.g. the last item
  // carrying it was deleted or retagged) so the focus can never strand the board dimmed
  // against a value nobody has — generalized across ALL facets (was tag-only).
  useEffect(() => {
    setFocusFacets((prev) => {
      if (!hasActiveFacets(prev)) return prev;
      let changed = false;
      const next: Record<string, readonly string[]> = {};
      for (const [key, vals] of Object.entries(prev)) {
        const live = new Set((focusFacetValues[key] ?? []).map((v) => v.toLowerCase()));
        const kept = vals.filter((v) => live.has(v.toLowerCase()));
        if (kept.length !== vals.length) changed = true;
        if (kept.length > 0) next[key] = kept;
      }
      return changed ? next : prev;
    });
  }, [focusFacetValues]);
  /** Toggle one value in a focus facet (multi-select OR within, AND across facets). */
  const toggleFocusFacet = useCallback((facetKey: string, value: string) => {
    setFocusFacets((prev) => toggleFacetValue(prev, facetKey, value));
  }, []);
  // The RELATIONSHIP focus facet values + conjunctive counts over CONNECTORS (human labels via
  // the relation catalog); same facet SSOT as the node focus, a different item shape.
  const relationFacetValues = useMemo<Record<string, string[]>>(
    () => Object.fromEntries(CONNECTOR_FOCUS_FACETS.map((f) => [f.key, facetValues(connectorItems, CONNECTOR_ITEM_FACETS[f.key])])),
    [connectorItems],
  );
  const relationFacetCounts = useMemo<Record<string, Record<string, number>>>(
    () => Object.fromEntries(CONNECTOR_FOCUS_FACETS.map((f) => [f.key, facetValueCounts(connectorItems, f.key, relationFocus, CONNECTOR_ITEM_FACETS)])),
    [connectorItems, relationFocus],
  );
  const toggleRelationFocus = useCallback((facetKey: string, value: string) => {
    setRelationFocus((prev) => toggleFacetValue(prev, facetKey, value));
  }, []);
  // Drop a relation-focus value whose relationship kind no longer exists on any connector (all
  // lines of that kind deleted/retyped) so the focus never strands the canvas dimmed. Mirrors the node prune.
  useEffect(() => {
    setRelationFocus((prev) => {
      if (!hasActiveFacets(prev)) return prev;
      let changed = false;
      const next: Record<string, readonly string[]> = {};
      for (const [key, vals] of Object.entries(prev)) {
        const live = new Set((relationFacetValues[key] ?? []).map((v) => v.toLowerCase()));
        const kept = vals.filter((v) => live.has(v.toLowerCase()));
        if (kept.length !== vals.length) changed = true;
        if (kept.length > 0) next[key] = kept;
      }
      return changed ? next : prev;
    });
  }, [relationFacetValues]);
  // memberId → live rect, for resolving each connector endpoint to its box border.
  const nodeRects = useMemo(
    () => new Map(nodeItems.map((it) => [it.memberId, { x: it.x, y: it.y, w: it.w, h: it.h }])),
    [nodeItems],
  );
  // Ref mirror so the pointer-move callback (stable deps) reads the LIVE peer rects
  // for the alignment-snap pass without re-creating the handler every render.
  const nodeRectsRef = useRef(nodeRects);
  nodeRectsRef.current = nodeRects;

  // R16 multiplayer — LIVE presence over the same-origin BroadcastChannel
  // transport (two studio windows on this board see each other's cursors +
  // selection rings + the roster facepile TODAY; a networked transport is the
  // owner boundary and feeds the same hook). Model/overlay/roster were all
  // shipped + proven 2026-07-04; this hook is the missing wire (L062).
  const { peers: presencePeers } = useBoardPresence(boardId, screenToWorld, selectedIds, { room: sharedRoom });
  // The connector render-models — pure fold extracted to connector-models.ts
  // (hidden-suppression + self-describing extra.* → ConnectorModel, unit-tested).
  const connectorModels = useMemo<ConnectorModel[]>(
    () => buildConnectorModels(connectorItems, { selectedIds, showHidden, hiddenIds }),
    [connectorItems, selectedIds, showHidden, hiddenIds],
  );
  // Apply the relationship focus: connectors outside the active relation facet render dimmed
  // (DIM-only — the models are byte-identical when no relation focus is active).
  const focusedConnectorModels = useMemo<ConnectorModel[]>(() => {
    const dim = new Set(dimmedConnectorIds(connectorItems, relationFocus));
    return dim.size === 0 ? connectorModels : connectorModels.map((m) => (dim.has(m.memberId) ? { ...m, dimmed: true } : m));
  }, [connectorModels, connectorItems, relationFocus]);

  // The connector model iff EXACTLY ONE item is selected and it is an edge — drives
  // the format controls (color/dashed/arrow) shown in the selection bar.
  const singleConnector = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const id = [...selectedIds][0];
    return connectorModels.find((c) => c.memberId === id) ?? null;
  }, [selectedIds, connectorModels]);
  // #180 — true when ≥1 SELECTED member is a connector (gates the Reverse-direction batch
  // row). Distinct from selectionHasConnectors (connectors between selected NODES).
  const anyConnectorSelected = useMemo(
    () => connectorModels.some((c) => selectedIds.has(c.memberId)),
    [connectorModels, selectedIds],
  );
  // #181 — true when ≥2 selected members are non-connector NODES (gates the Connect row).
  const multipleNodesSelected = useMemo(
    () => nodeItems.filter((it) => selectedIds.has(it.memberId)).length >= 2,
    [nodeItems, selectedIds],
  );
  // Trace-path gate: EXACTLY two nodes selected — a path query has a single FROM and TO.
  const exactlyTwoNodesSelected = useMemo(
    () => nodeItems.filter((it) => selectedIds.has(it.memberId)).length === 2,
    [nodeItems, selectedIds],
  );
  // #183 — true when ≥1 node is NOT selected (gates the Invert-selection row — nothing to
  // swap to otherwise).
  const hasUnselectedNodes = useMemo(
    () => nodeItems.some((it) => !selectedIds.has(it.memberId)),
    [nodeItems, selectedIds],
  );

  // The selected NON-connector items (a line has no fill) and the anchor's current
  // fill colour — drive the #124 quick-fill swatch in the selection bar.
  const fillTargets = useMemo(
    () => nodeItems.filter((it) => selectedIds.has(it.memberId)),
    [nodeItems, selectedIds],
  );
  const fillAnchorColor = useMemo(
    () => (fillTargets.length ? itemFillColor(fillTargets[fillTargets.length - 1]) : undefined),
    [fillTargets],
  );
  // The anchor item's current shape id — drives the #155 Shape picker in the bar.
  // (shapeTargets === fillTargets: selected non-connectors. A line has no shape.)
  const shapeAnchor = useMemo(() => {
    const anchor = fillTargets[fillTargets.length - 1];
    const s = anchor?.extra?.shape;
    return typeof s === 'string' ? s : undefined;
  }, [fillTargets]);

  // Live piece-by-piece entrance: items that appear SINCE the last commit (a producer
  // landing N notes at once, a paste, a drag-drop) cascade in ~70ms apart so the board
  // comes to life one item at a time instead of dumping all at once. Items present on
  // first paint (board open / reload) get NO stagger — only genuinely-new arrivals do.
  // The diff is computed against the previously-committed id set (updated post-commit),
  // so it is StrictMode-safe (render reads the ref; the effect writes it).
  const prevItemIdsRef = useRef<Set<string> | null>(null);
  const appearDelays = useMemo(
    () => computeAppearDelays(items.map((it) => it.memberId), prevItemIdsRef.current),
    [items],
  );
  useEffect(() => {
    prevItemIdsRef.current = new Set(items.map((it) => it.memberId));
  }, [items]);

  // The boards registered in this surface's index — split into the active set
  // (drives the switcher) and the archived set (restorable via the Archived section).
  const boards = useMemo(() => readActiveBoards(graph, indexRef), [graph, indexRef]);
  const archivedBoards = useMemo(() => readArchivedBoards(graph, indexRef), [graph, indexRef]);
  const currentBoardEntry = boards.find((b) => b.boardId === currentBoardId);
  const currentBoardTitle = currentBoardEntry?.title ?? title;
  // #202 — the active board's snap-to-grid-while-dragging preference (per-board DATA).
  // Mirrored into a ref because the pointer-move handler runs off refs, not render
  // state; `currentGridSnap` drives the popover Toggle's checked state.
  const currentGridSnap = currentBoardEntry?.gridSnap === true;
  const gridSnapRef = useRef(currentGridSnap);
  gridSnapRef.current = currentGridSnap;
  // #225 (P1) — the active board's appearance-defaults profile (middle cascade tier).
  // Opaque key bag; handed verbatim to every item renderer, resolved per-key there.
  const currentBoardAppearance = currentBoardEntry?.appearance;
  // Ref mirror so placeDraftAt (a stable useCallback) reads the CURRENT board's appearance
  // without a stale closure — the default new-item footprint resolves through the cascade.
  const currentBoardAppearanceRef = useRef(currentBoardAppearance);
  currentBoardAppearanceRef.current = currentBoardAppearance;
  const [bgPickerOpen, setBgPickerOpen] = useState(false);
  // "?" opens the keyboard-shortcuts cheat sheet (discoverability for the whole
  // keyboard layer). The catalog is DATA (board-shortcuts.ts); the blind ui
  // ShortcutSheet renders it.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  // The source's palette (sourceAdds): open, the words typed, and the rows the source answered for them.
  const [addsOpen, setAddsOpen] = useState(false);
  const [addsWords, setAddsWords] = useState('');
  const [addsRows, setAddsRows] = useState<ReadonlyArray<{ id: string; label: string; icon?: string; detail?: string; section?: string }>>([]);
  useEffect(() => {
    if (!addsOpen || !sourceAdds) return undefined;
    let current = true;
    const timer = setTimeout(() => { void sourceAdds.search(addsWords).then(rows => { if (current) setAddsRows(rows); }, () => { if (current) setAddsRows([]); }); }, addsWords ? 200 : 0);
    return () => { current = false; clearTimeout(timer); };
  }, [addsOpen, addsWords, sourceAdds]);
  // Objects/Layers panel (#151) — a popover anchored to the header "Layers" button.
  const [layersOpen, setLayersOpen] = useState(false);
  // Pick a surface: write the chosen id onto the board's index member (same commit
  // path as rename/archive) and close. Per-board — each board remembers its own.
  const chooseBackground = useCallback(
    (id: string) => {
      const memberId = boards.find((b) => b.boardId === currentBoardIdRef.current)?.memberId;
      if (memberId) void commit(setBoardBackground(graphRef.current, indexRef, memberId, id));
      setBgPickerOpen(false);
    },
    [boards, commit, indexRef],
  );
  // #202 — toggle snap-to-grid for THIS board. Same single-field index-member write
  // as the background (per-board, persisted); the popover stays open so the user
  // sees the switch flip without losing the surface picker.
  const toggleGridSnap = useCallback(
    (on: boolean) => {
      const memberId = boards.find((b) => b.boardId === currentBoardIdRef.current)?.memberId;
      if (memberId) void commit(setBoardGridSnap(graphRef.current, indexRef, memberId, on));
    },
    [boards, commit, indexRef],
  );
  // #225 (P1) — set ONE key in THIS board's appearance-defaults profile (the middle
  // cascade tier). Generic over the key: the same callback serves sizeMode today and
  // every future appearance key (containerVariant, palettes…) with zero new code.
  const setBoardAppearanceDefault = useCallback(
    (key: string, value: unknown) => {
      const memberId = boards.find((b) => b.boardId === currentBoardIdRef.current)?.memberId;
      if (memberId) void commit(setBoardAppearanceKey(graphRef.current, indexRef, memberId, key, value));
    },
    [boards, commit, indexRef],
  );
  // Rollup: choose (or clear) the board's goal-hierarchy relation — persisted on the index member as
  // board DATA, so the rollup badges appear for THIS board. No default kind (per Codex); off until chosen.
  const setBoardRollup = useCallback(
    (spec: { relationKind: string; childEndpoint: 'from' | 'to' } | null) => {
      const memberId = boards.find((b) => b.boardId === currentBoardIdRef.current)?.memberId;
      if (memberId) void commit(setBoardRollupSpec(graphRef.current, indexRef, memberId, spec));
    },
    [boards, commit, indexRef],
  );
  // #225 (P1 / R2 preset) — apply a whole appearance PRESET to THIS board in one
  // commit. Folds the preset's key bag through the same generic setBoardAppearanceKey
  // path (blind to what the keys mean), so a preset is DATA and adding one needs no
  // new code here. Every note without its own override adopts the look.
  const applyBoardAppearancePreset = useCallback(
    (profile: Record<string, unknown>) => {
      const memberId = boards.find((b) => b.boardId === currentBoardIdRef.current)?.memberId;
      if (memberId) void commit(applyAppearanceProfileToBoard(graphRef.current, indexRef, memberId, profile));
    },
    [boards, commit, indexRef],
  );

  // Overview minimap (#123): tracks the live viewport size so its window
  // rectangle is accurate. The minimap reads node frames + camera and emits a
  // world point to centre on; the board owns the camera (it never mutates it).
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const minimapFrames = useMemo(
    () => nodeItems.map((it) => ({ id: it.memberId, x: it.x, y: it.y, width: it.w, height: it.h })),
    [nodeItems],
  );
  const jumpToWorld = useCallback((wx: number, wy: number) => {
    const el = stageRef.current;
    const w = el?.clientWidth || viewportSize.w;
    const h = el?.clientHeight || viewportSize.h;
    setCamera((c) => ({ ...c, panX: w / 2 - wx * c.zoom, panY: h / 2 - wy * c.zoom }));
  }, [viewportSize.w, viewportSize.h]);
  // Bring a node ON-SCREEN with a minimal pan (keyboard-nav / jump-to). Unchanged camera when it is already
  // visible — no jarring re-centre. Reuses the pure `panToReveal` primitive over the live node rect.
  const revealNode = useCallback((memberId: string) => {
    const r = nodeRectsRef.current.get(memberId);
    if (!r) return;
    const el = stageRef.current;
    const view = { w: el?.clientWidth || viewportSize.w, h: el?.clientHeight || viewportSize.h };
    setCamera((c) => ({ ...c, ...panToReveal(c, view, { x: r.x, y: r.y, w: r.w, h: r.h }) }));
  }, [viewportSize.w, viewportSize.h]);
  const revealNodeRef = useRef(revealNode);
  revealNodeRef.current = revealNode;
  // The focus bar's imperative handle — ⌘F / "/" on the canvas focus the search field through it.
  const boardFocusBarRef = useRef<BoardFocusBarHandle>(null);

  // Search-match STEP navigation (find-next): the ordered matching node ids (the same set the "Select all
  // matches" action uses), a cursor over them, and a stepper that selects + REVEALS each match in turn
  // (Enter/Shift+Enter in the search field, or the ▲/▼ chevrons). Reuses `nextInCycle` (cyclic wrap) +
  // `revealNode` (b79 scroll-into-view) — no new navigation code. Cursor position is derived from the live
  // match list, so editing the query or the board keeps "N of M" honest (stale cursor → null).
  const matchIds = useMemo(
    () => (searchQuery.trim() !== '' || hasActiveFacets(focusFacets) ? focusedItemIds(nodeItems, focusFacets, searchQuery) : []),
    [nodeItems, focusFacets, searchQuery],
  );
  const [matchCursorId, setMatchCursorId] = useState<string | null>(null);
  const matchIdsRef = useRef(matchIds);
  matchIdsRef.current = matchIds;
  const matchCursorIdRef = useRef(matchCursorId);
  matchCursorIdRef.current = matchCursorId;
  const stepMatch = useCallback((delta: 1 | -1) => {
    const id = nextInCycle(matchIdsRef.current, matchCursorIdRef.current, delta);
    if (!id) return;
    setMatchCursorId(id);
    selectItem(id, false);
    revealNodeRef.current(id);
  }, [selectItem]);
  // 1-based position of the stepped-to match in the live match list (null when the cursor isn't a match).
  const matchCursorPos = matchCursorId ? (matchIds.indexOf(matchCursorId) >= 0 ? matchIds.indexOf(matchCursorId) + 1 : null) : null;

  // The single "primary" selection drives single-item actions (View, Ungroup).
  // Group needs ≥2; delete works on the whole set. null when 0 or >1 selected.
  const primaryId = selectedIds.size === 1 ? [...selectedIds][0] : null;

  // The primary item (if exactly one) and the item being viewed full-bleed. Only
  // an item with resolved bytes (`src`) can go immersive — a note or an unresolved
  // producer job has nothing to fill the screen with.
  const selectedItem = useMemo(
    () => (primaryId ? items.find((i) => i.memberId === primaryId) ?? null : null),
    [items, primaryId],
  );
  const immersiveItem = useMemo(
    () => (immersiveId ? items.find((i) => i.memberId === immersiveId) ?? null : null),
    [items, immersiveId],
  );

  // ── Per-item STYLE editor — opens in the SAME click-anchored popover a
  // container/region uses (ui/ NodeContextMenu), NOT a sheet. Right-click an item
  // (or the Style button) → the shared, blind LayerStackEditor inside the popover:
  // add/reorder fills, pick an edge silhouette, tune each layer — persisted onto
  // the item's own `visualLayerStack` via the same `patchItem` path (L069/L090). ──
  const itemsRef = useRef(items);
  itemsRef.current = items;
  selectionGroupsRef.current = groupIndexOf(items);
  /** Read-modify-write the item's whole visual-layer-stack record (layers AND the
   *  card-level edge clip), persisting via the same patchItem path. */
  const writeItemStack = useCallback(
    (memberId: string, mutate: (record: VisualLayerStackRecord) => VisualLayerStackRecord) => {
      const prev = itemsRef.current.find((i) => i.memberId === memberId)?.extra?.visualLayerStack as
        | VisualLayerStackRecord
        | undefined;
      const base: VisualLayerStackRecord = prev ?? {
        kind: 'visual-layer-stack',
        version: 1,
        region: currentRefRef.current as AddressRef,
        layers: [],
      };
      void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { visualLayerStack: mutate(base) }));
    },
    [commit],
  );
  // Owner-injected subject picker for image/video LAYERS: open the native Finder
  // and materialize through content-media. The returned relation identity is an
  // opaque value for the blind editor; no CAS import crosses this UI boundary.
  const pickLayerSubject = useCallback(
    async (prefixes: readonly string[]): Promise<{ url: string; contentType: string } | null> => {
      const picked = await pickBoardFiles(prefixes);
      const file = picked[0];
      if (!file) return null;
      const url = await storeBoardBytes(file.bytes, file.contentType, file.name);
      return { url, contentType: file.contentType };
    },
    [],
  );

  // ── P2 batch operations + P3 layer-stack presets ───────────────────────────
  // The opaque layer-stack bundle of the anchor (last-added) selected item — the
  // source for "apply to all" and "save as preset".
  const primaryStack = useCallback((): VisualLayerStackRecord | null => {
    const ids = [...selectedIdsRef.current];
    const anchor = ids[ids.length - 1] ?? null;
    if (!anchor) return null;
    const rec = itemsRef.current.find((i) => i.memberId === anchor)?.extra?.visualLayerStack as
      | VisualLayerStackRecord
      | undefined;
    return rec ?? null;
  }, []);

  /** Run a pure batch transform over the selected members as ONE undoable, ONE-write
   *  transaction (P2). Snapshot → commit the diff → record a single history step so
   *  Cmd-Z reverses the whole multi-edit at once. */
  const applyBatch = useCallback(
    (produce: (graph: GroupGraph, memberIds: string[], parentRef: AddressRef) => GroupGraph) => {
      const before = graphRef.current;
      const cur = currentRefRef.current;
      // A locked item is FROZEN — every batch mutation that consumes these ids
      // (paste-style, space-by-gap, keyboard z-order, nudge) skips locked items,
      // exactly like pointer drag/resize and Delete (#135). Ops that must act ON
      // locked items (Unlock, batch-tag) read the selection directly and ignore
      // this param, so they are unaffected.
      const lockedSet = new Set(readItems(before, cur).filter((i) => itemIsLocked(i)).map((i) => i.memberId));
      const ids = [...selectedIdsRef.current].filter((id) => !lockedSet.has(id));
      const after = produce(before, ids, cur);
      if (after === before) return;
      // commit() records the undo step itself — one batch = one Cmd-Z.
      void commit(after, before);
    },
    [commit],
  );

  /** Isolate the selection (#150) — hide every visible drawable EXCEPT the keep set, in
   *  ONE undoable batch (Figma "Isolate selection"). Connectors are left to auto-suppress
   *  when an endpoint hides. Like Hide (#149), this is a reversible VIEW op, so it ignores
   *  the lock chokepoint and reads the full live board inside the produce. */
  const isolateSelection = useCallback(
    (keepIds: string[]) => {
      const keep = new Set(keepIds);
      applyBatch((g, _ids, p) => {
        const others = readItems(g, p)
          .filter((it) => !itemIsConnector(it) && it.extra?.hidden !== true && !keep.has(it.memberId))
          .map((it) => it.memberId);
        return others.length ? setHidden(g, p, others, true) : g;
      });
    },
    [applyBatch],
  );

  /** Un-hide EVERY hidden item on the board in one batch (#150) — the bulk inverse of
   *  Hide, so restoring a decluttered board is one click instead of select-each-then-Show. */
  const showAllItems = useCallback(() => {
    applyBatch((g, _ids, p) => {
      const hidden = readItems(g, p).filter((it) => it.extra?.hidden === true).map((it) => it.memberId);
      return hidden.length ? setHidden(g, p, hidden, false) : g;
    });
  }, [applyBatch]);

  /** ISOLATE the focus: HIDE every visible item NOT in the current focus (the inverse of the
   *  #149 Hide-selection action, driven by the focus). Reuses the setHidden primitive so the
   *  existing "N hidden / Show all" reveal controls are the exit. Clears the focus after (the
   *  filter has done its job — only the matching items remain). No-op (with a notice) when
   *  everything visible already matches. Connectors + already-hidden items are never touched. */
  const hideNonFocused = useCallback(() => {
    applyBatch((g, _ids, p) => {
      const toHide = nonFocusedVisibleIds(readItems(g, p), focusFacets, searchQuery);
      if (!toHide.length) {
        showNotice('Everything visible matches the focus — nothing to hide.', 'info');
        return g;
      }
      return setHidden(g, p, toHide, true);
    });
    setFocusFacets({});
    setSearchQuery('');
  }, [applyBatch, showNotice, focusFacets, searchQuery]);

  // ISOLATE the relationship focus: HIDE every visible connector NOT of the focused kind
  // ("show only the depends-on lines" → declutter to just them). Uses the same setHidden the
  // node isolate uses; the now-fixed connector hide (its own flag) makes lines actually vanish.
  const hideUnrelatedConnectors = useCallback(() => {
    applyBatch((g, _ids, p) => {
      const conns = readItems(g, p).filter((it) => connectorEndpoints(it) !== null);
      const toHide = dimmedConnectorIds(conns, relationFocus).filter(
        (id) => conns.find((c) => c.memberId === id)?.extra?.hidden !== true,
      );
      if (!toHide.length) {
        showNotice('Every visible line matches the relationship focus — nothing to hide.', 'info');
        return g;
      }
      return setHidden(g, p, toHide, true);
    });
    setRelationFocus({});
  }, [applyBatch, showNotice, relationFocus]);

  // SELECT the focused relationship: turn the read-only relation focus into a real selection of
  // the MATCHING connectors (select all the "blocks" lines → bulk delete/restyle them via the
  // existing selection actions), mirroring the node onSelectFocused.
  const selectFocusedConnectors = useCallback(() => {
    setSelectedIds(new Set(focusedConnectorIds(connectorItems, relationFocus)));
  }, [connectorItems, relationFocus]);
  // The single selected NODE (not a connector), or null — the anchor for a graph traversal.
  const singleSelectedNodeId = useMemo(() => {
    if (selectedIds.size !== 1) return null;
    const id = [...selectedIds][0];
    return nodeItems.some((n) => n.memberId === id) ? id : null;
  }, [selectedIds, nodeItems]);
  // TRAVERSE the graph along the FOCUSED relationship kind: from the selected node, select the whole
  // transitive DOWNSTREAM subtree reached by FOLLOWING ONLY edges that match the relationship focus
  // ("focus depends-on, select node A → select A's entire dependency chain"). Composes the reachability
  // primitive (branchMemberIds) with the facet predicate as the edge filter — kind-scoped traversal, no
  // engine change (the all-edge "Select branch" #186 is the same primitive with no filter).
  const selectDownstreamViaFocus = useCallback(() => {
    if (!singleSelectedNodeId) return;
    const items = readItems(graphRef.current, currentRefRef.current);
    const ids = branchMemberIds(items, singleSelectedNodeId, (c) => matchesFacets(c, relationFocus, CONNECTOR_ITEM_FACETS));
    setSelectedIds(new Set(ids));
  }, [singleSelectedNodeId, relationFocus]);
  // The UPSTREAM twin: from the selected node, select the whole transitive ANCESTOR chain reached by
  // walking the focused relationship kind BACKWARD ("focus depends-on, select node A → select every
  // node that transitively depends ON A"). Same primitive as downstream, reverse edge direction.
  const selectUpstreamViaFocus = useCallback(() => {
    if (!singleSelectedNodeId) return;
    const items = readItems(graphRef.current, currentRefRef.current);
    const ids = upstreamMemberIds(items, singleSelectedNodeId, (c) => matchesFacets(c, relationFocus, CONNECTOR_ITEM_FACETS));
    setSelectedIds(new Set(ids));
  }, [singleSelectedNodeId, relationFocus]);

  /** #191 — Fold ALL branches: hide every non-root mind-map node (indegree ≥ 1) so only the
   *  roots stay visible, collapsing the whole board's maps at once (MindNode/XMind "fold
   *  all"). The board-wide sibling of #162's per-branch collapse; unfold-all is `showAllItems`.
   *  Reads the live board inside the produce and reuses the #149 setHidden primitive. */
  const foldAllBranches = useCallback(() => {
    applyBatch((g, _ids, p) => {
      const live = readItems(g, p);
      const alreadyHidden = new Set(live.filter((it) => it.extra?.hidden === true).map((it) => it.memberId));
      const toHide = mindMapNonRootIds(live).filter((id) => !alreadyHidden.has(id));
      return toHide.length ? setHidden(g, p, toHide, true) : g;
    });
  }, [applyBatch]);

  /** Toggle ONE item's visibility / lock from the Objects panel (#151) — single-item
   *  versions of the batch Hide/Show + Lock/Unlock, each one undoable commit. The
   *  current flag is read from the live graph inside the produce so the toggle is
   *  always against truth, never a stale render. */
  // The Objects panel is a TREE (#153) — a row can be a nested section child, so
  // the toggle must target the member's OWN parent group, not the board root.
  // `findParentRef` resolves that group at any depth; setHidden/setLocked then
  // flip the live flag in one undoable commit (lock-orthogonal, like the batch row).
  const toggleItemHidden = useCallback(
    (id: string) => {
      const g = graphRef.current;
      const parentRef = findParentRef(g, currentRefRef.current, id);
      if (!parentRef) return;
      const it = readItems(g, parentRef).find((i) => i.memberId === id);
      if (!it) return;
      void commit(setHidden(g, parentRef, [id], it.extra?.hidden !== true), g);
    },
    [commit],
  );
  const toggleItemLocked = useCallback(
    (id: string) => {
      const g = graphRef.current;
      const parentRef = findParentRef(g, currentRefRef.current, id);
      if (!parentRef) return;
      const it = readItems(g, parentRef).find((i) => i.memberId === id);
      if (!it) return;
      void commit(setLocked(g, parentRef, [id], !itemIsLocked(it)), g);
    },
    [commit],
  );
  /** Restack from a drag-reorder in the Objects-panel tree (#152/#153). `parentId`
   *  null = the board root, else a SECTION whose children were reordered → restack
   *  WITHIN that section's group (`findMemberRef` → the section's nodeRef). The panel
   *  list is TOP-most first; memberOrder is BOTTOM-first, so reverse before applying.
   *  A panel management gesture (lock-orthogonal) — one undoable commit. */
  const reorderLayers = useCallback(
    (parentId: string | null, newTopFirstIds: string[]) => {
      const g = graphRef.current;
      const parentRef = parentId == null ? currentRefRef.current : findMemberRef(g, currentRefRef.current, parentId);
      if (!parentRef) return;
      void commit(reorderZToOrder(g, parentRef, [...newTopFirstIds].reverse()), g);
    },
    [commit],
  );
  /** Rename an Objects-panel node (double-click its label, #154). Parent-ref-aware
   *  like the toggles, so a nested child renames against its own group; reuses the
   *  generic `editItem` text write + the in-app `askText` overlay, pre-filled with
   *  the item's current raw text (not the panel's section/image/note fallback). */
  const renameLayer = useCallback(
    async (id: string) => {
      const g = graphRef.current;
      const parentRef = findParentRef(g, currentRefRef.current, id);
      if (!parentRef) return;
      const it = readItems(g, parentRef).find((i) => i.memberId === id);
      if (!it) return;
      const next = await askText('Rename', it.text ?? '', 'Save');
      if (next === null) return;
      // Write text AND html together — a note's read-only render prefers `html`, so
      // setting text alone would leave the canvas showing the stale old value (#154).
      const t = next.trim();
      void commit(editItem(g, parentRef, id, { text: t, html: textToHtml(t) }), g);
    },
    [askText, commit],
  );

  /** Quick-fill (#124): set/clear the solid fill of EVERY selected board item (skip
   *  connectors — a line has no fill) in one undoable commit. Writes the SAME
   *  `visualLayerStack` solid layer the Style editor edits (SSOT via `setStackFill`).
   *  `undoable:false` = live preview while dragging the colour wheel. */
  const fillSelected = useCallback(
    (color: string | null, opts?: { undoable?: boolean }) => {
      const before = graphRef.current;
      const p = currentRefRef.current;
      // Read the board ONCE into a by-id map (was readItems(out).find() PER id = O(K*M)), collect one patch
      // per fillable member, then apply ONE batch patch (O(M+K)) — the doubly-O(N^2) fill is now O(M+K).
      const byId = new Map(readItems(before, p).map((i) => [i.memberId, i]));
      const patches: Array<{ memberId: string; patch: Record<string, unknown> }> = [];
      for (const id of selectedIdsRef.current) {
        const item = byId.get(id);
        // Skip connectors (no fill) AND locked items (lock = fully frozen, incl. fill).
        if (!item || endpointsOf(item) !== null || itemIsLocked(item)) continue;
        const stack = (item.extra?.visualLayerStack as VisualLayerStackRecord | undefined) ?? emptyStack(p);
        patches.push({ memberId: id, patch: { visualLayerStack: setStackFill(stack, color, BOARD_ITEM_LAYER_REGISTRY) } });
      }
      const out = patchItems(before, p, patches);
      if (out === before) return;
      void commit(out, before, { undoable: opts?.undoable !== false });
    },
    [commit, endpointsOf],
  );

  /** #165 — rainbow branches: colour each top-level branch of the selected mind-map a
   *  distinct hue. The pure `branchColorAssignments` engine reads the connector topology
   *  over the WHOLE board (so a branch colours correctly) and returns memberId→colour from
   *  the injected DATA palette; we apply only the assignments that fall inside the selected
   *  set, through the SAME `setStackFill` path `fillSelected` uses (skipping connectors +
   *  locked items), as ONE undoable commit. Zero new fill mechanism. */
  const colorBranches = useCallback(
    (memberIds: readonly string[]) => {
      const before = graphRef.current;
      const p = currentRefRef.current;
      const assign = branchColorAssignments(readItems(before, p), BRANCH_PALETTE);
      const sel = new Set(memberIds);
      // Phase 1 (nodes): read ONCE, collect one fill patch per in-selection branch node, apply ONE batch
      // patch (O(M+K)) — was readItems(out).find() + patchItem PER node (doubly O(N^2)).
      const byId = new Map(readItems(before, p).map((i) => [i.memberId, i]));
      const nodePatches: Array<{ memberId: string; patch: Record<string, unknown> }> = [];
      for (const [id, color] of assign) {
        if (!sel.has(id)) continue;
        const item = byId.get(id);
        if (!item || endpointsOf(item) !== null || itemIsLocked(item)) continue;
        const stack = (item.extra?.visualLayerStack as VisualLayerStackRecord | undefined) ?? emptyStack(p);
        nodePatches.push({ memberId: id, patch: { visualLayerStack: setStackFill(stack, color, BOARD_ITEM_LAYER_REGISTRY) } });
      }
      let out = patchItems(before, p, nodePatches);
      // #166 — tint each branch's connector LINE to match (the line points INTO a coloured node, so it takes
      // that node's branch colour via the #101 `extra.color`). Computed from the post-node graph; only a
      // connector whose `to` node is in the selection and that isn't locked — same undoable commit, one batch.
      const connColors = connectorBranchColors(readItems(out, p), assign);
      const byId2 = new Map(readItems(out, p).map((i) => [i.memberId, i]));
      const connPatches: Array<{ memberId: string; patch: Record<string, unknown> }> = [];
      for (const [connId, color] of connColors) {
        const conn = byId2.get(connId);
        const toId = conn?.extra?.toMemberId;
        if (typeof toId !== 'string' || !sel.has(toId) || (conn != null && itemIsLocked(conn))) continue;
        connPatches.push({ memberId: connId, patch: { color } });
      }
      out = patchItems(out, p, connPatches);
      if (out === before) return;
      void commit(out, before);
    },
    [commit, endpointsOf],
  );

  /** Set the SHAPE of every selected board item (#155) — writes `extra.shape`, which
   *  the blind CanvasNode resolves to a clip-path. Mirrors `fillSelected`: skips
   *  connectors (a line has no shape) and locked items; one undoable commit.
   *  `'rectangle'` clears the clip (its catalog clip-path is empty). */
  const shapeSelected = useCallback(
    (shapeId: string) => {
      const before = graphRef.current;
      const p = currentRefRef.current;
      // Read ONCE, collect one shape patch per shapeable member, apply ONE batch patch (O(M+K)).
      const byId = new Map(readItems(before, p).map((i) => [i.memberId, i]));
      const patches: Array<{ memberId: string; patch: Record<string, unknown> }> = [];
      for (const id of selectedIdsRef.current) {
        const item = byId.get(id);
        if (!item || endpointsOf(item) !== null || itemIsLocked(item)) continue;
        patches.push({ memberId: id, patch: { shape: shapeId } });
      }
      const out = patchItems(before, p, patches);
      if (out === before) return;
      void commit(out, before);
    },
    [commit, endpointsOf],
  );

  /** Batch per-item APPEARANCE override (R2c multi-select): set ONE cascade key (Note style /
   *  Text size / Note density) on EVERY selected non-connector item at once — the multi-select
   *  counterpart of `setItemAppearanceKey`. Mirrors `shapeSelected` exactly (skips connectors +
   *  locked items; one undoable commit): a user selecting N notes + picking "Card" styles them all.
   *  `''`/undefined clears the key → those notes fall back to the board default (cascade). Same
   *  descriptor primitive as the single-item "Note look" — this is just its selection-wide sink. */
  const styleSelected = useCallback(
    (key: string, value: unknown) => {
      const cleared = value === undefined || value === '' ? undefined : value;
      const before = graphRef.current;
      const p = currentRefRef.current;
      // Read ONCE, collect one appearance-key patch per stylable member, apply ONE batch patch (O(M+K)).
      const byId = new Map(readItems(before, p).map((i) => [i.memberId, i]));
      const patches: Array<{ memberId: string; patch: Record<string, unknown> }> = [];
      for (const id of selectedIdsRef.current) {
        const item = byId.get(id);
        if (!item || endpointsOf(item) !== null || itemIsLocked(item)) continue;
        patches.push({ memberId: id, patch: { [key]: cleared } });
      }
      const out = patchItems(before, p, patches);
      if (out === before) return;
      void commit(out, before);
    },
    [commit, endpointsOf],
  );

  /** Batch-tag: ADD tags to EVERY selected item at once (one prompt, one undoable
   *  batch). Merges into each item's existing tags (never wipes them) — the multi-edit
   *  composition of #119 tags × the BatchActionCapability primitive. */
  const tagSelected = useCallback(async (memberIds: readonly string[]) => {
    const next = await askText('Add tags to selection (comma-separated)', '', 'Add');
    if (next === null) return;
    const add = parseTags(next);
    if (add.length === 0) return;
    applyBatch((g, _ids, p) => {
      // Read ONCE, collect one merged-tags patch per selected member, apply ONE batch patch (O(M+K)).
      const byId = new Map(readItems(g, p).map((i) => [i.memberId, i]));
      const patches: Array<{ memberId: string; patch: Record<string, unknown> }> = [];
      for (const id of memberIds) {
        const item = byId.get(id);
        if (!item) continue;
        patches.push({ memberId: id, patch: { tags: mergeTags(itemTags(item), add) } });
      }
      return patchItems(g, p, patches);
    });
  }, [askText, applyBatch]);

  /** #169 — bound the selection in a NEW presentation frame (Figma/Miro "frame selection").
   *  Asks for a title, unions the selected non-connector rects via the pure
   *  `createFrameFromSelection`, sends the frame to the BACK so it never occludes the items
   *  it wraps, and selects it — one undoable commit. The frame is a normal member from here
   *  on (drags/resizes/locks/exports/appears in Objects). */
  const frameSelection = useCallback(async (memberIds: readonly string[]) => {
    const p = currentRefRef.current;
    const items = readItems(graphRef.current, p);
    const hasContent = memberIds.some((id) => {
      const it = items.find((i) => i.memberId === id);
      return it && !itemIsConnector(it);
    });
    if (!hasContent) return;
    const title = await askText('Name this frame', 'Frame', 'Create');
    if (title === null) return;
    const frameMemberId = newId('m');
    let next = createFrameFromSelection(graphRef.current, p, [...memberIds], {
      memberId: frameMemberId,
      nodeRef: itemRef(boardId, newId('i')),
      title: title.trim() || 'Frame',
      padding: FRAME_SELECTION_PADDING,
      order: nextFrameOrder(items),
    });
    if (next === graphRef.current) return; // nothing bounded
    next = reorderZ(next, p, [frameMemberId], 'back');
    setSelectedIds(new Set([frameMemberId]));
    void commit(next);
  }, [askText, boardId, commit]);
  frameSelectionRef.current = (memberIds) => { void frameSelection(memberIds); };

  /** Duplicate every selected item in place (offset so the copies are visible). */
  // Place a batch of paste-drafts as fresh items (one undoable transaction),
  // selecting the new items. The ONE materialization path for duplicate AND
  // cross-board paste (board-clipboard primitive). Drafts carry no geometry in
  // `extra`, so the draft x/y survive placeItem's extra-spread.
  const placePasteDrafts = useCallback(
    (drafts: PasteDraft[]) => {
      if (drafts.length === 0) return;
      const cur = currentRefRef.current;
      // planPaste mints fresh ids (nodes first) and re-anchors internal connectors to the
      // NEW node ids, so duplicating a sub-diagram keeps its arrows (#187). Connectors are
      // dropped when an endpoint was not pasted; the selection is the new NODES only.
      const placements = appendCopiedFrameOrders(planPaste(drafts, () => newId('m')), readItems(graphRef.current, cur));
      const nodeIds = placements.filter((p) => !p.isConnector).map((p) => p.memberId);
      // ONE batch placement (O(M+K)) instead of folding placeItem per draft (O(K*M) = O(N^2) on a large
      // paste / capsule-import — the fold re-spread the whole members map per item and froze the commit).
      const next = placeItems(
        graphRef.current,
        cur,
        placements.map((p) => ({
          memberId: p.memberId,
          nodeRef: itemRef(boardId, newId('i')),
          kind: p.kind,
          x: p.x,
          y: p.y,
          w: p.w,
          h: p.h,
          text: p.text,
          src: p.src,
          extra: p.extra,
        })),
      );
      setSelectedIds(new Set(nodeIds));
      void commit(next);
    },
    [boardId, commit],
  );

  /** Clone a set of source items into the graph at a (dx,dy) offset, WITHOUT committing
   *  — returns the new graph + the placed NODE rects (id + srcId + position/size). Routes
   *  through the SAME clipboard clone primitive the copy/paste path uses (copyItemsToClipboard
   *  → clipboardToDrafts → planPaste), so an internal connector between two cloned nodes is
   *  re-anchored to the clones (#187/#190) instead of dangling — and geometry-in-extra is
   *  stripped so it can't clobber the new position. `placed` is NODE-only (connectors follow
   *  their nodes via the reactive layer, so they never join the drag group); each carries
   *  `srcId` so the caller can find the grabbed item's clone as the drag anchor. */
  const cloneItemsInto = useCallback(
    (graph: GroupGraph, cur: AddressRef, items: ReadonlyArray<BoardItem>, dx: number, dy: number) => {
      const clip = copyItemsToClipboard(items);
      const placed: Array<{ id: string; srcId?: string; x: number; y: number; w: number; h: number }> = [];
      if (!clip) return { graph, placed };
      // minOf (reduce, not Math.min(...spread)) so a select-all alt-drag of a huge board
      // doesn't RangeError past the JS argument limit; finiteCoord-guarded inside.
      const minX = minOf(items.map((i) => i.x));
      const minY = minOf(items.map((i) => i.y));
      const placements = appendCopiedFrameOrders(planPaste(clipboardToDrafts(clip, minX + dx, minY + dy), () => newId('m')), readItems(graph, cur));
      // ONE batch placement (O(M+K)) instead of folding placeItem per clone (O(K*M) = O(N^2) on a large
      // alt-drag) — placeItems re-spreads the members map once for the whole clone set.
      const next = placeItems(
        graph,
        cur,
        placements.map((p) => ({
          memberId: p.memberId,
          nodeRef: itemRef(boardId, newId('i')),
          kind: p.kind,
          x: p.x,
          y: p.y,
          w: p.w,
          h: p.h,
          text: p.text,
          src: p.src,
          extra: p.extra,
        })),
      );
      for (const p of placements) {
        if (!p.isConnector) placed.push({ id: p.memberId, srcId: p.localId, x: p.x, y: p.y, w: p.w, h: p.h });
      }
      return { graph: next, placed };
    },
    [boardId],
  );

  const duplicateSelected = useCallback(
    (ids: string[]) => {
      const idSet = new Set(ids);
      const src = readItems(graphRef.current, currentRefRef.current).filter((i) => idSet.has(i.memberId));
      const clip = copyItemsToClipboard(src);
      if (!clip) return;
      // Offset the duplicate +24 from the original group's top-left anchor so the
      // copy is visibly offset (the old inline path's +24 was silently clobbered
      // by extra-spread — fixed by routing through the clipboard primitive).
      // minOf (reduce, not Math.min(...spread)) so a select-all duplicate of a huge board
      // doesn't RangeError past the JS argument limit; finiteCoord-guarded inside.
      const minX = minOf(src.map((i) => i.x));
      const minY = minOf(src.map((i) => i.y));
      placePasteDrafts(clipboardToDrafts(clip, minX + 24, minY + 24));
    },
    [placePasteDrafts],
  );

  /** ⌘C: capture the selection into the cross-board clipboard (module singleton). */
  const copySelected = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    const src = readItems(graphRef.current, currentRefRef.current).filter((i) => idSet.has(i.memberId));
    const clip = copyItemsToClipboard(src);
    if (clip) setBoardClipboard(clip);
  }, []);

  /** ⌘V: paste the clipboard onto the CURRENT board at the cursor (relative
   *  layout preserved). Works across boards/surfaces — the clipboard is a session
   *  singleton and the paste reads the current board ref at paste time. */
  const pasteClipboard = useCallback(() => {
    const clip = getBoardClipboard();
    if (!clip) return;
    const lp = lastPointerRef.current;
    const origin = lp.x || lp.y ? screenToWorld(lp.x, lp.y) : { x: 60, y: 60 };
    placePasteDrafts(clipboardToDrafts(clip, origin.x, origin.y));
  }, [placePasteDrafts, screenToWorld]);

  /** IMPORT a shared capsule onto THIS board (the receive side of "Copy link"): decode the
   *  link, merge every board's scoped items in at the cursor. Rides the SAME clone pipeline
   *  as ⌘V — `capsuleBoardToClipboard` turns each capsule board into the clipboard bundle
   *  shape, then `placePasteDrafts` mints fresh ids + re-anchors internal connectors (#187),
   *  so an imported sub-diagram keeps its arrows and never collides with existing member ids.
   *  Multi-board falls out for free (L069): each board's bundle-local ids are namespaced by
   *  index so cross-board connectors never mis-anchor, and boards fan out with a small offset.
   *  Returns true iff `text` was a decodable capsule (so the caller can stop other paste
   *  handling). No engine dependency — the link carries the whole capsule. */
  const importCapsule = useCallback(
    (text: string): boolean => {
      const capsule = decodeShareLink(text);
      if (!capsule) return false;
      const lp = lastPointerRef.current;
      const origin = lp.x || lp.y ? screenToWorld(lp.x, lp.y) : { x: 60, y: 60 };
      const drafts = capsule.boards.flatMap((board, bi) =>
        clipboardToDrafts(capsuleBoardToClipboard(board), origin.x + bi * 40, origin.y + bi * 40).map((d) => ({
          ...d,
          localId: d.localId ? `b${bi}:${d.localId}` : d.localId,
          fromLocalId: d.fromLocalId ? `b${bi}:${d.fromLocalId}` : d.fromLocalId,
          toLocalId: d.toLocalId ? `b${bi}:${d.toLocalId}` : d.toLocalId,
        })),
      );
      placePasteDrafts(drafts);
      return true;
    },
    [placePasteDrafts, screenToWorld],
  );

  /** Place a pre-built board FRAGMENT — a `BoardItem[]` that already carries its own positions AND connectors
   *  (as opposed to a flat draft list or a section tree) — at a world anchor. This is the placement primitive
   *  for the `items` import kind (b135): a Mermaid flowchart, or any future graph-bearing format, parses to
   *  positioned node cards + connector items, and lands here. The SAME clone pipeline capsule-import uses
   *  (copyItemsToClipboard → clipboardToDrafts → placePasteDrafts) mints fresh ids and re-anchors the internal
   *  connectors, so the graph drops onto the canvas as one undo step at `(worldX, worldY)`. No-op on []. */
  const placeBoardItemsAt = useCallback(
    (items: readonly BoardItem[], worldX: number, worldY: number): boolean => {
      if (items.length === 0) return false;
      const clip = copyItemsToClipboard(items);
      if (!clip) return false;
      placePasteDrafts(clipboardToDrafts(clip, worldX, worldY));
      return true;
    },
    [placePasteDrafts],
  );

  /** ⌘X / Ctrl+X — CUT: copy the selection to the board clipboard, then remove it
   *  (FigJam/Figma/Miro canon; completes the ⌘C/⌘V/⌘X clipboard triad). PURE
   *  COMPOSITION of the two shipped primitives — `copySelected` (the exact ⌘C
   *  path) + `deleteSelected` (the exact ⌫ path) — so Cut inherits identical copy
   *  semantics (internal connectors carried like #187) AND identical lock
   *  semantics for free: it copies ONLY the UNLOCKED subset, so what you paste ==
   *  what was removed and a locked item is never cut (matching "lock resists
   *  removal", #135/#136). The removal is `deleteSelected`'s one undoable step
   *  (which also cleans up now-dangling connectors). Zero engine code — the
   *  unlocked-subset filter is the SAME tested `unlockedOf` chokepoint every batch
   *  op + `deleteSelected` already funnel through (L063), never a re-implementation. */
  const cutSelected = useCallback(() => {
    const ids = unlockedOf(graphRef.current, [...selectedIdsRef.current], currentRefRef.current);
    if (ids.length === 0) return;
    copySelected(ids);
    deleteSelected();
  }, [copySelected, deleteSelected]);

  // ── COPY / PASTE STYLE (#127) — FigJam "copy/paste properties" (⌥⌘C / ⌥⌘V). A
  // session style clipboard (module singleton) lets you copy ONE item's appearance
  // now and stamp it onto a DIFFERENT, later selection — the cross-time gap that
  // "Same layers as first" (same-selection only) cannot fill. `hasStyleClip` gates
  // the Paste-style row; lazy-init from the singleton so the row survives remount.
  const [hasStyleClip, setHasStyleClip] = useState(() => getStyleClipboard() !== null);
  const copyStyle = useCallback(() => {
    const bundle = primaryStack();
    if (!bundle) return;
    setStyleClipboard(bundle);
    setHasStyleClip(true);
  }, [primaryStack]);
  const pasteStyle = useCallback(() => {
    const bundle = getStyleClipboard();
    if (!bundle) return;
    applyBatch((g, ids, p) => applyBundleToAll(g, p, ids, bundle));
  }, [applyBatch]);

  // ── SELECT SIMILAR (#128) — expand the selection to every item LIKE the anchor.
  // The anchor is the LAST selected (consistent with primaryStack). The generic
  // `similarIds` engine never names a criterion — the panel injects it (kind / tag).
  const anchorMember = useCallback((ids: string[]): string | null => {
    const sel = ids.length ? ids : [...selectedIdsRef.current];
    return sel[sel.length - 1] ?? null;
  }, []);
  const selectSameKind = useCallback(
    (ids: string[]) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      setSelectedIds(new Set(similarIds(itemsRef.current, anchor, (i) => i.kind)));
    },
    [anchorMember],
  );
  const selectSameTag = useCallback(
    (ids: string[]) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      setSelectedIds(new Set(similarIds(itemsRef.current, anchor, (i) => itemTags(i))));
    },
    [anchorMember],
  );
  // #131 — third criterion: same FILL colour. Reuses itemFillColor (#124) as the keyOf
  // — ZERO engine change (the deletion-test proof that #128 is a true primitive).
  const selectSameFill = useCallback(
    (ids: string[]) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      setSelectedIds(new Set(similarIds(itemsRef.current, anchor, (i) => itemFillColor(i) ?? '')));
    },
    [anchorMember],
  );
  // The now-first-class per-item marker (cont.12) + shape (cont.13) become two more Select-similar
  // criteria — the SAME similarIds engine + injected keyOf the kind/tag/fill rows use (ZERO engine
  // change), the selection sibling of Group-by-marker/shape. keyOf reads the item's OWN extra value.
  const selectSameMarker = useCallback(
    (ids: string[]) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      setSelectedIds(new Set(similarIds(itemsRef.current, anchor, (i) => (typeof i.extra?.marker === 'string' ? i.extra.marker : ''))));
    },
    [anchorMember],
  );
  const selectSameShape = useCallback(
    (ids: string[]) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      setSelectedIds(new Set(similarIds(itemsRef.current, anchor, (i) => (typeof i.extra?.shape === 'string' ? i.extra.shape : ''))));
    },
    [anchorMember],
  );
  // #170 — select everything spatially inside the anchor FRAME (FigJam section-select).
  // Pure containment read (itemsInsideFrame) → replace the selection with the contents,
  // so every existing batch op (move/style/tag/delete) then applies to the whole frame.
  const selectFrameContents = useCallback(
    (ids: string[]) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      const all = itemsRef.current;
      const frame = all.find((i) => i.memberId === anchor && presentationFrameOf(i) !== null);
      if (!frame) return;
      const contents = itemsInsideFrame(all, frame);
      if (contents.length === 0) return;
      setSelectedIds(new Set(contents.map((i) => i.memberId)));
    },
    [anchorMember],
  );
  // #173 — arrange the anchor frame's contents into an even grid inside it (FigJam
  // "reorganize section"). Pure layout (tidyFrameLayout) → commit a moveItem fold as
  // ONE undo step. Locked contents are frozen (excluded), consistent with #135/#136.
  const tidyFrameContents = useCallback(
    (ids: string[]) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      const all = itemsRef.current;
      const frame = all.find((i) => i.memberId === anchor && presentationFrameOf(i) !== null);
      if (!frame) return;
      const locked = new Set(all.filter((i) => itemIsLocked(i)).map((i) => i.memberId));
      const contents = itemsInsideFrame(all, frame).filter((i) => !locked.has(i.memberId));
      const positions = tidyFrameLayout(contents, frame);
      if (positions.length === 0) return;
      const before = graphRef.current;
      const cur = currentRefRef.current;
      // ONE batch position patch (O(M+K)) instead of folding moveItem per item (moveItem = patchItem{x,y},
      // so folding it was O(K*M) = O(N^2) on a large tidy).
      const next = patchItems(before, cur, positions.map((p) => ({ memberId: p.id, patch: { x: p.x, y: p.y } })));
      if (next === before) return;
      void commit(next, before);
    },
    [anchorMember, commit],
  );
  // R8 (arrange) — lay the selected NODES out with a chosen strategy (grid/row/
  // column/circle/diagonal/masonry), anchored at the selection's current top-left so
  // it arranges IN PLACE (never jumps to the origin). Pure `arrangeWith` (DATA-selected
  // strategy, L090 — no switch) → commit a moveItem fold as ONE undo step. Locked and
  // connector members are excluded (connectors follow their endpoints); <2 nodes is a
  // no-op. Adding a strategy is one registry row — this callback never changes.
  const arrangeSelection = useCallback(
    (strategyId: string) => {
      const sel = selectedIdsRef.current;
      const nodes = itemsRef.current.filter(
        (it) => sel.has(it.memberId) && !itemIsConnector(it) && !itemIsLocked(it),
      );
      if (nodes.length < 2) return;
      const bounds = selectionBounds(nodes.map((n) => ({ id: n.memberId, x: n.x, y: n.y, w: n.w, h: n.h })));
      if (!bounds) return;
      const placed = arrangeWith(
        strategyId,
        nodes.map((n) => ({ memberId: n.memberId, w: n.w, h: n.h })),
        { originX: bounds.x, originY: bounds.y },
      );
      if (placed.length === 0) return;
      const before = graphRef.current;
      const cur = currentRefRef.current;
      // ONE batch position patch (O(M+K)) instead of folding moveItem per node (O(K*M) = O(N^2) arrange).
      const next = patchItems(before, cur, placed.map((p) => ({ memberId: p.memberId, patch: { x: p.x, y: p.y } })));
      if (next === before) return;
      void commit(next, before);
    },
    [commit],
  );
  // #178 — resize the anchor frame to snugly bound its current contents (FigJam
  // "resize section to fit"; companion to Tidy). Pure frameFitBox (reuses the same
  // selectionBounds union as frame-selection) → patchItem the frame's own x/y/w/h as
  // ONE undo step. Empty frame → frameFitBox is null → no-op (L118).
  const fitFrameToContents = useCallback(
    (ids: string[]) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      const all = itemsRef.current;
      const frame = all.find((i) => i.memberId === anchor && presentationFrameOf(i) !== null);
      if (!frame || itemIsLocked(frame)) return;
      const box = frameFitBox(all, frame, FRAME_SELECTION_PADDING);
      if (!box) return;
      const before = graphRef.current;
      const cur = currentRefRef.current;
      const next = patchItem(before, cur, frame.memberId, { x: box.x, y: box.y, w: box.w, h: box.h });
      if (next === before) return;
      void commit(next, before);
    },
    [anchorMember, commit],
  );
  // Section (isSection group) fit-to-contents — the membership-container twin of fit-frame-to-contents.
  // A section's children are world-absolute, so the pure `fitRectToContents` (reuses selectionBounds)
  // wraps them + a top header inset. `SECTION_HEADER` reserves the title bar; padding matches frames.
  const SECTION_FIT_PADDING = 28;
  const SECTION_HEADER = 44;
  const sectionChildRects = useCallback(
    (g: GroupGraph, section: BoardItem) =>
      readItems(g, section.nodeRef).filter((c) => endpointsOf(c) === null).map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
    [endpointsOf],
  );
  // Grow-only auto-fit: expand a section to swallow a child dragged past its edge (Miro frame canon).
  // No-op (same graph) when the section already contains its children — no stray undo entry.
  const growSectionToFit = useCallback(
    (g: GroupGraph, section: BoardItem): GroupGraph => {
      const kids = sectionChildRects(g, section);
      const rect = { x: section.x, y: section.y, w: section.w, h: section.h };
      if (!needsGrow(rect, kids, { padding: SECTION_FIT_PADDING, headerHeight: SECTION_HEADER })) return g;
      const grown = fitRectToContents(rect, kids, { padding: SECTION_FIT_PADDING, headerHeight: SECTION_HEADER, growOnly: true });
      return patchItem(g, currentRefRef.current, section.memberId, grown);
    },
    [sectionChildRects],
  );
  // Manual EXACT fit (can shrink) — the "Resize section to fit" action on a section anchor.
  const fitSectionToContents = useCallback(
    (ids: string[]) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      const section = itemsRef.current.find((i) => i.memberId === anchor && i.isSection);
      if (!section || itemIsLocked(section)) return;
      const kids = sectionChildRects(graphRef.current, section);
      if (kids.length === 0) return;
      const rect = { x: section.x, y: section.y, w: section.w, h: section.h };
      const fit = fitRectToContents(rect, kids, { padding: SECTION_FIT_PADDING, headerHeight: SECTION_HEADER });
      const before = graphRef.current;
      const next = patchItem(before, currentRefRef.current, section.memberId, fit);
      if (next === before) return;
      void commit(next, before);
    },
    [anchorMember, commit, sectionChildRects],
  );
  // #181 — wire the selected NODES into a connector chain in spatial order (left→right,
  // then top→bottom), so selecting several notes and connecting them into a flow is one
  // action. The board owns the spatial sort, the existing-link dedup (no duplicate arrows
  // on repeat), the id mint, and the ONE undoable commit. No-op when <2 nodes or every
  // consecutive pair is already linked. Newly-minted connectors become the selection.
  const connectSelected = useCallback(
    (ids: string[], topology: ConnectorTopology) => {
      const want = new Set(ids);
      const all = readItems(graphRef.current, currentRefRef.current);
      const nodes = all
        .filter((i) => want.has(i.memberId) && !itemIsConnector(i))
        .sort((a, b) => a.x - b.x || a.y - b.y);
      if (nodes.length < 2) return;
      const existing = new Set<string>();
      for (const it of all) {
        if (!itemIsConnector(it)) continue;
        const f = it.extra?.fromMemberId;
        const t = it.extra?.toMemberId;
        if (typeof f === 'string' && typeof t === 'string') existing.add(connectorPairKey(f, t));
      }
      const pairs = topology(nodes.map((n) => n.memberId), existing);
      if (pairs.length === 0) return;
      const before = graphRef.current;
      const cur = currentRefRef.current;
      const made = pairs.map((p) => ({ id: newId('c'), from: p.from, to: p.to }));
      const madeIds = made.map((m) => m.id);
      // ONE batch placement (O(M+K)) instead of folding placeItem per connector — "connect all" over a
      // large selection was O(K*M) = O(N^2) (each placeItem re-spread the whole members map).
      const next = placeItems(
        before,
        cur,
        made.map((m) => ({
          memberId: m.id,
          nodeRef: itemRef(boardId, newId('i')),
          kind: 'connector',
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          extra: { fromMemberId: m.from, toMemberId: m.to },
        })),
      );
      if (next === before) return;
      void commit(next, before);
      setSelectedIds(new Set(madeIds));
    },
    [boardId, commit],
  );
  // #183 — Invert selection (Select Inverse). Replace the current selection with every
  // OTHER node on the board. Pure `invertedNodeIds` off the live item list; connectors are
  // excluded (they are relationship edges, not selectable inverse targets — same node-only
  // universe the Connect/Invert rows reason about). No commit: selection is transient VIEW
  // state, never persisted.
  const invertSelection = useCallback(
    (ids: string[]) => {
      const selected = new Set(ids);
      const allNodeIds = readItems(graphRef.current, currentRefRef.current)
        .filter((i) => !itemIsConnector(i))
        .map((i) => i.memberId);
      setSelectedIds(new Set(invertedNodeIds(allNodeIds, selected)));
    },
    [],
  );
  // #186 — select the anchor's whole branch (the node + every connector-descendant). Pure
  // `branchMemberIds` off the live board; anchor = last selected. Transient selection VIEW
  // state, no commit.
  const selectBranch = useCallback(
    (ids: string[]) => {
      const anchor = ids[ids.length - 1];
      if (!anchor) return;
      setSelectedIds(new Set(branchMemberIds(readItems(graphRef.current, currentRefRef.current), anchor)));
    },
    [],
  );
  // The UPSTREAM mirror of Select branch — the anchor + every transitive ancestor (all connectors,
  // #186 twin). Pure `upstreamMemberIds` off the live board; transient selection VIEW state.
  const selectUpstream = useCallback(
    (ids: string[]) => {
      const anchor = ids[ids.length - 1];
      if (!anchor) return;
      setSelectedIds(new Set(upstreamMemberIds(readItems(graphRef.current, currentRefRef.current), anchor)));
    },
    [],
  );
  // Trace path (b138): swap the selection to the shortest connector chain between the two selected cards
  // (either direction), so "how does A lead to B?" is one click. Reads live items → relationship graph →
  // `pathBetween`; a no-op (selection unchanged) when the two are not connected. Transient VIEW state.
  const tracePath = useCallback(
    (ids: string[]) => {
      if (ids.length !== 2) return;
      const path = pathBetween(buildRelationGraph(readItems(graphRef.current, currentRefRef.current)), ids[0], ids[1]);
      if (path.length > 0) setSelectedIds(new Set(path));
    },
    [],
  );
  // Select the cards that [[link]] to the anchor — its backlinks / "linked mentions" (b139). Reads the live
  // reference graph off the board; a no-op when nothing links here. Transient selection VIEW state.
  const selectBacklinks = useCallback(
    (ids: string[]) => {
      const anchor = ids[ids.length - 1];
      if (!anchor) return;
      const back = backlinksOf(cardReferences(readItems(graphRef.current, currentRefRef.current)), anchor);
      if (back.length > 0) setSelectedIds(new Set(back));
    },
    [],
  );
  // Create a card for each of the anchor's BROKEN [[Title]] references (b140 — the Obsidian "click the red
  // link to create the note" move): its dangling wikilinks become real cards (titled by the reference), which
  // resolves the links. Reuses the shipped `fillFromDrafts` multi-place (one commit, one undo, grid layout).
  const createMissingCards = useCallback(
    (ids: string[]) => {
      const anchor = ids[ids.length - 1];
      if (!anchor) return;
      const titles = brokenReferencesFrom(readItems(graphRef.current, currentRefRef.current), anchor);
      if (titles.length > 0) fillFromDraftsRef.current(titles.map((text) => ({ kind: 'note', text })));
    },
    [],
  );
  // Select every ORPHAN — the cards touched by no connector and no [[reference]] (b141). Board-global (ignores
  // the current selection, like Select-inverse); reads the live board. Transient selection VIEW state.
  const selectOrphans = useCallback(() => {
    const orphans = orphanCards(readItems(graphRef.current, currentRefRef.current));
    if (orphans.length > 0) setSelectedIds(new Set(orphans));
  }, []);
  // Select the READY frontier — cards whose every prerequisite is cleared, actionable now (b144). Board-global
  // (like Select-orphans); reads the live board via the readiness bridge. Transient selection VIEW state.
  const selectReady = useCallback(() => {
    const ready = readyCardIds(readItems(graphRef.current, currentRefRef.current));
    if (ready.length > 0) setSelectedIds(new Set(ready));
  }, []);
  // Select every card with an UNLINKED MENTION — its prose names another card's title without a [[link]] (b146).
  // Board-global (like Select-orphans); reads the live board. Transient selection VIEW state.
  const selectUnlinkedMentions = useCallback(() => {
    const mentioning = cardsWithUnlinkedMentions(readItems(graphRef.current, currentRefRef.current));
    if (mentioning.length > 0) setSelectedIds(new Set(mentioning));
  }, []);
  // Select every card with an OPEN QUESTION — an interrogative line in its text (b150). Board-global (like
  // Select-orphans); reads the live board. Transient selection VIEW state.
  const selectQuestions = useCallback(() => {
    const asking = cardsWithQuestions(readItems(graphRef.current, currentRefRef.current));
    if (asking.length > 0) setSelectedIds(new Set(asking));
  }, []);
  // Select every card in a TITLE COLLISION — winner + shadowed (b151), the ambiguous `[[link]]` targets to
  // rename/merge. Board-global (like Select-orphans); reads the live board. Transient selection VIEW state.
  const selectDuplicateTitles = useCallback(() => {
    const ambiguous = ambiguousTitleIds(readItems(graphRef.current, currentRefRef.current));
    if (ambiguous.length > 0) setSelectedIds(new Set(ambiguous));
  }, []);
  // Select every card carrying a NEAR-DUPLICATE tag (b152) — the fragmented-taxonomy set to unify onto one
  // spelling. Board-global (like Select-orphans); reads the live board. Transient selection VIEW state.
  const selectFragmentedTags = useCallback(() => {
    const fragmented = cardsWithFragmentedTag(readItems(graphRef.current, currentRefRef.current));
    if (fragmented.length > 0) setSelectedIds(new Set(fragmented));
  }, []);
  // UNIFY near-duplicate tags (b156) — rewrite every card's fragmented tags onto the canonical (most-used)
  // spelling in ONE undoable batch. Board-global mutation; mirrors the tagSelected read-once/patch-once path.
  const unifyFragmentedTags = useCallback(() => {
    applyBatch((g, _ids, p) => {
      const items = readItems(g, p);
      const map = canonicalTagMap(items);
      if (map.size === 0) return g;
      const patches: Array<{ memberId: string; patch: Record<string, unknown> }> = [];
      for (const item of items) {
        const cur = itemTags(item);
        if (cur.length === 0) continue;
        const next = canonicalizeTags(cur, map);
        if (!tagsEqual(cur, next)) patches.push({ memberId: item.memberId, patch: { tags: next } });
      }
      return patches.length > 0 ? patchItems(g, p, patches) : g;
    });
  }, [applyBatch]);
  // Select the LARGEST connected cluster (b153) — isolate the main structure from disconnected side-clusters.
  // Board-global (like Select-orphans); reads the live board. Transient selection VIEW state.
  const selectLargestCluster = useCallback(() => {
    const main = largestIsland(readItems(graphRef.current, currentRefRef.current));
    if (main.length > 0) setSelectedIds(new Set(main));
  }, []);
  // Select the REDUNDANT connectors (b154) — the duplicate lines to delete. Board-global (like Select-orphans);
  // reads the live board. Transient selection VIEW state (the user then deletes the selected connectors).
  const selectRedundantConnectors = useCallback(() => {
    const dupes = redundantConnectorIds(readItems(graphRef.current, currentRefRef.current));
    if (dupes.length > 0) setSelectedIds(new Set(dupes));
  }, []);
  // Select the SOURCE / SINK cards (b157) — the dependency graph's starting points / final outcomes.
  // Board-global (like Select-orphans); read the live board. Transient selection VIEW state.
  const selectSources = useCallback(() => {
    const ids = boardSources(readItems(graphRef.current, currentRefRef.current));
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  const selectSinks = useCallback(() => {
    const ids = boardSinks(readItems(graphRef.current, currentRefRef.current));
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  // Select the UNDATED cards (b158) — the tasks still missing a deadline. Board-global; read the live board.
  const selectUndatedCards = useCallback(() => {
    const ids = undatedCardIds(readItems(graphRef.current, currentRefRef.current));
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  // b159 — select the cards sharing the board's TOP recurring theme (the biggest implicit topic,
  // mined from card prose via board-themes). Board-global; read-only selection, not a mutation.
  const selectTopThemeCards = useCallback(() => {
    const ids = cardIdsForTopTheme(readItems(graphRef.current, currentRefRef.current));
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  // b160 — select the cards carrying an external link (the board's cited sources), via board-entity-index
  // over the 'url' kind. Board-global; read-only selection, not a mutation.
  const selectLinkedCards = useCallback(() => {
    const ids = cardIdsWithEntity(readItems(graphRef.current, currentRefRef.current), 'url');
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  // b161 — select the cards worth splitting (mini-documents the Split action would break into ≥2 cards), via
  // board-split-candidates. Board-global; read-only selection, not a mutation.
  const selectSplitCandidates = useCallback(() => {
    const ids = splitCandidateIds(readItems(graphRef.current, currentRefRef.current));
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  // b162 — select the UNTAGGED cards (the cards still missing a tag), via board-tag-coverage.
  // Board-global; read-only selection, not a mutation.
  const selectUntaggedCards = useCallback(() => {
    const ids = computeUntaggedCardIds(readItems(graphRef.current, currentRefRef.current));
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  // b163 — select the cards in the board's dominant relationship (the endpoints of the most-used connector
  // kind), via board-connector-legend. Board-global; read-only selection, not a mutation.
  const selectMainRelationshipCards = useCallback(() => {
    const ids = cardIdsInTopRelationship(readItems(graphRef.current, currentRefRef.current));
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  // b164 — select every card a health signal flagged (orphans, ambiguous titles, untagged, …) so they can be
  // fixed in one pass, via board-health. Board-global; read-only selection, not a mutation.
  const selectHealthIssueCards = useCallback(() => {
    const ids = cardIdsWithHealthIssues(readItems(graphRef.current, currentRefRef.current));
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  // b166 — select the cards in the board's LARGEST colour family, via the generic facet census over the
  // `colorFamily` extractor (the top legend row). Board-global; read-only selection, not a mutation.
  const selectLargestColorGroup = useCallback(() => {
    const ids = cardIdsForTopFacetValue(readItems(graphRef.current, currentRefRef.current), BOARD_ITEM_FACETS.colorFamily);
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  // b168 — select the cards carrying the board's strongest tag pair, via the generic co-occurrence reducer over
  // the `itemTags` extractor. Board-global; read-only selection, not a mutation.
  const selectStrongestTagPair = useCallback(() => {
    const ids = cardIdsForTopPair(readItems(graphRef.current, currentRefRef.current), itemTags);
    if (ids.length > 0) setSelectedIds(new Set(ids));
  }, []);
  // #184 — copy the selected mind-map subtree to the clipboard as a Markdown outline.
  // Pure `mindMapOutline` off the live board; connectors define the tree, text reads
  // top-to-bottom. Read-only (no commit) — an export, not a mutation.
  const copyOutline = useCallback(
    (ids: string[]) => {
      const lines = mindMapOutline(readItems(graphRef.current, currentRefRef.current), ids);
      if (lines.length === 0) {
        showNotice('Nothing to copy', 'info');
        return;
      }
      const text = outlineToMarkdown(lines);
      void (async () => {
        if (await copyTextToClipboard(text)) {
          showNotice(`Copied outline (${lines.length} lines)`, 'success');
        } else {
          void askText('Copy did not work. Select the outline and copy it', text, 'Done');
        }
      })();
    },
    [askText, showNotice],
  );
  // #174 — reorder the anchor frame in the present path. Pure moveFrameOrder →
  // renumber every frame contiguously → commit the changed orders as ONE undo step
  // via the same patchItem path createFrameFromSelection's order rides on.
  const reorderFrame = useCallback(
    (ids: string[], dir: -1 | 1) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      const patches = moveFrameOrder(boardFrames(itemsRef.current), anchor, dir);
      if (patches.length === 0) return;
      const before = graphRef.current;
      const cur = currentRefRef.current;
      // ONE batch patch (O(M+K)) instead of folding patchItem per frame.
      const next = patchItems(before, cur, patches.map((p) => ({ memberId: p.id, patch: { presentationFrame: { order: p.order } } })));
      if (next === before) return;
      void commit(next, before);
    },
    [anchorMember, commit],
  );
  // b125 — reorder a SPECIFIC frame from the Outline dock (not the anchor). Same pure moveFrameOrder →
  // contiguous renumber → one undoable patchItems batch as reorderFrame, keyed by the section's frame id.
  const reorderFrameById = useCallback(
    (frameId: string, dir: -1 | 1) => {
      const patches = moveFrameOrder(boardFrames(itemsRef.current), frameId, dir);
      if (patches.length === 0) return;
      const before = graphRef.current;
      const cur = currentRefRef.current;
      const next = patchItems(before, cur, patches.map((p) => ({ memberId: p.id, patch: { presentationFrame: { order: p.order } } })));
      if (next === before) return;
      void commit(next, before);
    },
    [commit],
  );
  // #176 — set/clear the anchor frame's caption / speaker-note (shown while presenting).
  // askText prefilled with the current note; an empty answer clears the DATA key. Stored
  // as extra.frameCaption via the generic patchItem (separate from presentationFrame.order).
  const setFrameCaption = useCallback(
    async (ids: string[]) => {
      const anchor = anchorMember(ids);
      if (!anchor) return;
      const frame = itemsRef.current.find((i) => i.memberId === anchor && presentationFrameOf(i) !== null);
      if (!frame) return;
      const next = await askText('Frame notes', presentationCaptionOf(frame) ?? '', 'Save');
      if (next === null) return; // cancelled
      const trimmed = next.trim();
      void commit(patchItem(graphRef.current, currentRefRef.current, anchor, { frameCaption: trimmed.length ? trimmed : undefined }));
    },
    [anchorMember, commit],
  );
  // The same-X rows only make sense when the anchor actually carries that property (L118).
  // Which context-sensitive rows are meaningful for the current selection (#161/#162
  // gating, L118) — pure fold extracted to selection-capabilities.ts (unit-tested).
  const anchorMemo = useMemo(
    () => selectionCapabilityFlags(selectedIds, items, hiddenIds),
    [selectedIds, items, hiddenIds],
  );
  // #174 — whether the anchor frame can move earlier/later in the present path
  // (gates the two reorder rows, L118). Position = the anchor frame's index among
  // the order-sorted frames; first can't go earlier, last can't go later.
  const { anchorFrameCanMoveEarlier, anchorFrameCanMoveLater } = useMemo(() => {
    if (!anchorMemo.anchorIsFrame) return { anchorFrameCanMoveEarlier: false, anchorFrameCanMoveLater: false };
    const anchorId = [...selectedIds].pop() ?? null;
    const frames = boardFrames(items).sort((a, b) => (presentationFrameOf(a)?.order ?? 0) - (presentationFrameOf(b)?.order ?? 0));
    const idx = frames.findIndex((f) => f.memberId === anchorId);
    return { anchorFrameCanMoveEarlier: idx > 0, anchorFrameCanMoveLater: idx >= 0 && idx < frames.length - 1 };
  }, [anchorMemo.anchorIsFrame, selectedIds, items]);
  const anchorHasTags = anchorMemo.hasTags;
  const anchorHasFill = anchorMemo.hasFill;
  const anchorHasMarker = anchorMemo.hasMarker;
  const anchorHasShape = anchorMemo.hasShape;
  const selectionHasConnectors = anchorMemo.selectionHasConnectors;
  const anchorHasVisibleDescendants = anchorMemo.anchorHasVisibleDescendants;
  const anchorHasHiddenDescendants = anchorMemo.anchorHasHiddenDescendants;
  const anchorHasAncestors = anchorMemo.anchorHasAncestors;
  const anchorIsFrame = anchorMemo.anchorIsFrame;
  // Card cross-reference ("wikilink") graph — [[Title]] mentions resolved to board cards (b139). The anchor
  // has BACKLINKS when ≥1 other card [[links]] to it (gates the Select-backlinks row, L118 — no dead no-op).
  const cardRefs = useMemo(() => cardReferences(items), [items]);
  const anchorHasBacklinks = useMemo(() => {
    const anchorId = [...selectedIds].pop();
    return anchorId ? backlinksOf(cardRefs, anchorId).length > 0 : false;
  }, [selectedIds, cardRefs]);
  // The anchor has BROKEN references when it types ≥1 [[Title]] naming no card (gates Create-linked-cards).
  const anchorHasBrokenRefs = useMemo(() => {
    const anchorId = [...selectedIds].pop();
    return anchorId ? brokenReferencesFrom(items, anchorId).length > 0 : false;
  }, [selectedIds, items]);
  // ORPHANS (b141): content cards touched by no connector AND no [[reference]] — gates Select-unconnected.
  const boardHasOrphans = useMemo(() => orphanCards(items).length > 0, [items]);
  // READY frontier (b144): ≥1 card whose prerequisites are all cleared — gates Select-ready to start.
  const boardHasReadyCards = useMemo(() => computeBoardHasReadyCards(items), [items]);
  // UNLINKED MENTIONS (b146): ≥1 card names another card's title in prose without a [[link]] — gates Select-mentions.
  const boardHasUnlinkedMentions = useMemo(() => computeBoardHasUnlinkedMentions(items), [items]);
  // OPEN QUESTIONS (b150): ≥1 card has an interrogative line — gates Select-open-questions.
  const boardHasQuestions = useMemo(() => computeBoardHasQuestions(items), [items]);
  // DUPLICATE TITLES (b151): ≥2 cards share a title (ambiguous [[link]] target) — gates Select-duplicate-titles.
  const boardHasDuplicateTitles = useMemo(() => computeBoardHasDuplicateTitles(items), [items]);
  // TAG HYGIENE (b152): ≥1 near-duplicate tag group (to-do vs todo) — gates Select-near-duplicate-tags.
  const boardHasFragmentedTags = useMemo(() => computeBoardHasFragmentedTags(items), [items]);
  // ISLANDS (b153): ≥2 separate connected clusters — gates Select-largest-cluster.
  const boardHasMultipleClusters = useMemo(() => computeBoardHasMultipleClusters(items), [items]);
  // DUPLICATE CONNECTORS (b154): a relationship drawn ≥2 times — gates Select-duplicate-connectors.
  const boardHasDuplicateConnectors = useMemo(() => computeBoardHasDuplicateConnectors(items), [items]);
  // SOURCES / SINKS (b157): dependency-flow endpoints — gate Select-starting-points / Select-final-outcomes.
  const boardHasSources = useMemo(() => computeBoardHasSources(items), [items]);
  const boardHasSinks = useMemo(() => computeBoardHasSinks(items), [items]);
  // DATE COVERAGE (b158): partly scheduled (some dated, some not) — gates Select-cards-without-a-date.
  const boardHasDateGaps = useMemo(() => computeBoardHasDateGaps(items), [items]);
  const boardHasThemes = useMemo(() => computeBoardHasThemes(items), [items]);
  const boardHasLinks = useMemo(() => computeBoardHasEntities(items, 'url'), [items]);
  const boardHasSplitCandidates = useMemo(() => computeBoardHasSplitCandidates(items), [items]);
  const boardHasTagGaps = useMemo(() => computeBoardHasTagGaps(items), [items]);
  const boardHasRelationships = useMemo(() => computeBoardHasRelationships(items), [items]);
  const boardHasHealthIssues = useMemo(() => computeBoardHasHealthIssues(items), [items]);
  const boardHasColorGroups = useMemo(() => boardHasFacet(items, BOARD_ITEM_FACETS.colorFamily), [items]);
  const boardHasTagPairs = useMemo(() => boardHasCooccurrence(items, itemTags), [items]);
  // Whether the anchor (last-selected) is a section (isSection group) — gates the Fit-section row (L118).
  const anchorIsSection = useMemo(() => {
    const anchorId = [...selectedIds].pop();
    return anchorId ? !!items.find((i) => i.memberId === anchorId)?.isSection : false;
  }, [selectedIds, items]);
  // Whether EXACTLY one card is selected whose text splits into 2+ lines — gates Split into cards (L118).
  const anchorIsSplittable = useMemo(() => {
    if (selectedIds.size !== 1) return false;
    const it = items.find((i) => i.memberId === [...selectedIds][0]);
    if (!it || itemIsConnector(it)) return false;
    return splitSegments(typeof it.text === 'string' ? it.text : '').length >= 2;
  }, [selectedIds, items]);
  const distinctFacetValues = anchorMemo.distinctFacetValues;

  // #130 — distribute by a user-typed exact gap. Auto-axis from the selection's
  // bounding box (wider-than-tall → horizontal, FigJam "Tidy up" canon) so we never
  // ask the axis; reuse the existing askText prompt for the px value.
  const spaceByGap = useCallback(() => {
    void (async () => {
      const ids = [...selectedIdsRef.current];
      if (ids.length < 2) return;
      const want = new Set(ids);
      const rects = readItems(graphRef.current, currentRefRef.current)
        .filter((i) => want.has(i.memberId))
        .map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
      const b = selectionBounds(rects);
      if (!b) return;
      const axis: 'h' | 'v' = b.w >= b.h ? 'h' : 'v';
      const raw = await askText('Spacing in pixels', '24', 'Space evenly');
      if (raw === null) return;
      const gap = Math.round(Number(raw.trim()));
      if (!Number.isFinite(gap)) return;
      applyBatch((g, sel, p) => distributeByGap(g, p, sel, axis, gap));
    })();
  }, [askText, applyBatch]);

  // Load the surface's saved LAYER presets once (board-surface scoped, kind-keyed).
  useEffect(() => {
    let cancelled = false;
    void readBundlePalette<VisualLayerStackRecord>(partitionLabel, boardId, PRESET_BUNDLE_KIND)
      .then((entries) => {
        if (!cancelled) setSavedPresets(entries);
      })
      .catch(() => {
        /* honest empty palette on read failure — no fake presets */
      });
    return () => {
      cancelled = true;
    };
  }, [partitionLabel, boardId]);

  /** Capture the anchor item's layer stack as a named preset (P3 save). */
  const savePreset = useCallback(() => {
    const bundle = primaryStack();
    if (!bundle) return;
    void (async () => {
      const name = await askText('Name this layer preset', '', 'Save preset');
      if (name === null) return;
      const next: SavedBundle<VisualLayerStackRecord>[] = [
        ...savedPresetsRef.current,
        { id: newId('lp'), name: name.trim() || 'Untitled preset', bundle },
      ];
      setSavedPresets(next);
      await writeBundlePalette(boardId, PRESET_BUNDLE_KIND, next).catch(() => {
        /* leave optimistic state; next mount re-reads canonical palette */
      });
    })();
  }, [askText, boardId, primaryStack]);

  const openPresetPicker = useCallback(() => setPresetPickerOpen(true), []);
  /** Apply a saved preset's opaque layer stack to every selected item (P3 apply). */
  const applyPreset = useCallback(
    (bundle: VisualLayerStackRecord) => {
      applyBatch((g, ids, p) => applyBundleToAll(g, p, ids, bundle));
      setPresetPickerOpen(false);
    },
    [applyBatch],
  );

  // #177 — open the frame-aspect picker for the selected frame(s). The memberIds are
  // captured now (the picker renders the FRAME_ASPECTS DATA); the actual reshape waits
  // for a pick. Storing the target keeps the reshape scoped to the frames that were
  // selected when the row fired, even if the selection changes while the picker is open.
  const pickFrameAspect = useCallback((memberIds: string[]) => {
    if (memberIds.length === 0) return;
    setAspectTargetIds(memberIds);
  }, []);
  /** Reshape every captured frame to the picked aspect ratio as ONE undo step (#177),
   *  skipping locked frames (the #135/#136 lock contract), then close the picker. */
  const applyFrameAspect = useCallback(
    (aspect: FrameAspect) => {
      const ids = aspectTargetIds;
      if (ids && ids.length > 0) {
        applyBatch((g, _sel, p) => reshapeFramesToAspect(g, p, unlockedOf(g, ids, p), aspect.w, aspect.h));
      }
      setAspectTargetIds(null);
    },
    [applyBatch, aspectTargetIds],
  );

  // Which selected items are locked — gates the Lock/Unlock pack rows so only the
  // applicable one shows (L118: no row that would be a no-op).
  const lockedIds = useMemo(() => new Set(items.filter((i) => itemIsLocked(i)).map((i) => i.memberId)), [items]);
  // #169 — the board's frames in presentation order (drives the Present affordance +
  // the HUD). Absent frames → no Present button (L118: no dead affordance).
  const frames = useMemo(() => boardFrames(items), [items]);
  const anyLockedSelected = useMemo(() => [...selectedIds].some((id) => lockedIds.has(id)), [selectedIds, lockedIds]);
  const anyUnlockedSelected = useMemo(() => [...selectedIds].some((id) => !lockedIds.has(id)), [selectedIds, lockedIds]);
  // Visibility (#149): which Hide/Show row applies to the current selection (only the
  // applicable one shows — L118). `hiddenIds` itself is declared up by `items` because
  // the connector layer + focus bar read it before this point (avoids a TDZ).
  const anyHiddenSelected = useMemo(() => [...selectedIds].some((id) => hiddenIds.has(id)), [selectedIds, hiddenIds]);
  const anyVisibleSelected = useMemo(() => [...selectedIds].some((id) => !hiddenIds.has(id)), [selectedIds, hiddenIds]);
  // Isolate (#150) only makes sense when there is ≥1 visible, non-selected drawable to
  // hide (otherwise the row is a no-op — L118). nodeItems already excludes connectors.
  const canIsolate = useMemo(
    () => nodeItems.some((it) => !selectedIds.has(it.memberId) && it.extra?.hidden !== true),
    [nodeItems, selectedIds],
  );
  // A section's connector-free children, read live from the section's own group
  // (#153). Injected into `boardLayerTree` so the pure model never sees the graph.
  const childrenOf = useCallback(
    (it: BoardItem) => readItems(graph, it.nodeRef).filter((c) => endpointsOf(c) === null),
    [graph, endpointsOf],
  );
  // Objects-panel TREE (#151 + #153) — top-level connector-free `nodeItems` plus
  // each section's children recursively, TOP-MOST z first, hidden/locked read off
  // each item's own `extra`, selected from the board-wide set. Pure mapping.
  const layerTree = useMemo(
    () => boardLayerTree(nodeItems, childrenOf, selectedIds, expandedLayerIds),
    [nodeItems, childrenOf, selectedIds, expandedLayerIds],
  );

  // The board's full multi-edit pack (P2) — DATA-described capabilities; adding a
  // multi-edit is one row in buildBoardBatchPack, never a panel edit.
  const batchPack = useMemo<BatchActionCapability[]>(
    () =>
      buildBoardBatchPack({
        applyBatch,
        primaryBundle: primaryStack,
        selectSameKind,
        selectSameTag,
        selectSameFill,
        selectSameMarker,
        selectSameShape,
        selectFrameContents,
        tidyFrameContents,
        reorderFrame,
        setFrameCaption: (ids) => void setFrameCaption(ids),
        pickFrameAspect,
        fitFrameToContents,
        fitSectionToContents,
        anchorIsSection,
        anchorFrameCanMoveEarlier,
        anchorFrameCanMoveLater,
        anchorIsFrame,
        selectionHasConnectors,
        anyConnectorSelected,
        multipleNodesSelected,
        distinctFacetValues,
        connectSelected,
        hasUnselectedNodes,
        invertSelection,
        selectBranch,
        selectUpstream,
        anchorHasVisibleDescendants,
        anchorHasHiddenDescendants,
        anchorHasAncestors,
        anchorHasTags,
        anchorHasFill,
        anchorHasMarker,
        anchorHasShape,
        copyStyle: () => copyStyle(),
        pasteStyle: () => pasteStyle(),
        hasStyleClipboard: hasStyleClip,
        duplicateSelected,
        deleteSelected: () => deleteSelected(),
        groupSelected: () => groupSelected(),
        mergeSelected: () => mergeSelectedCards(),
        splitAnchor: () => splitAnchorCard(),
        anchorIsSplittable,
        exactlyTwoNodesSelected,
        tracePath,
        anchorHasBacklinks,
        selectBacklinks,
        anchorHasBrokenRefs,
        createMissingCards,
        boardHasOrphans,
        selectOrphans,
        boardHasReadyCards,
        selectReady,
        boardHasUnlinkedMentions,
        selectUnlinkedMentions,
        boardHasQuestions,
        selectQuestions,
        boardHasDuplicateTitles,
        selectDuplicateTitles,
        boardHasFragmentedTags,
        selectFragmentedTags,
        unifyFragmentedTags,
        boardHasMultipleClusters,
        selectLargestCluster,
        boardHasDuplicateConnectors,
        selectRedundantConnectors,
        boardHasSources,
        selectSources,
        boardHasSinks,
        selectSinks,
        boardHasDateGaps,
        selectUndatedCards,
        boardHasThemes,
        selectTopThemeCards,
        boardHasLinks,
        selectLinkedCards,
        boardHasSplitCandidates,
        selectSplitCandidates,
        boardHasTagGaps,
        selectUntaggedCards,
        boardHasRelationships,
        selectMainRelationshipCards,
        boardHasHealthIssues,
        selectHealthIssueCards,
        boardHasColorGroups,
        selectLargestColorGroup,
        boardHasTagPairs,
        selectStrongestTagPair,
        savePreset,
        openPresetPicker,
        tagSelected: (ids) => void tagSelected(ids),
        createFrameFromSelection: (ids) => void frameSelection(ids),
        spaceByGap,
        hasPresets: savedPresets.length > 0,
        anyUnlockedSelected,
        anyLockedSelected,
        anyVisibleSelected,
        anyHiddenSelected,
        canIsolate,
        isolateSelection,
        exportSelectionSvg,
        exportSelectionPng: (ids) => void exportSelectionPng(ids),
        copySelectionPng: (ids) => void copySelectionPng(ids),
        colorBranches,
        copyOutline,
      }),
    [applyBatch, primaryStack, selectSameKind, selectSameTag, selectSameFill, selectSameMarker, selectSameShape, selectFrameContents, tidyFrameContents, reorderFrame, setFrameCaption, pickFrameAspect, fitFrameToContents, fitSectionToContents, anchorIsSection, anchorFrameCanMoveEarlier, anchorFrameCanMoveLater, anchorIsFrame, selectionHasConnectors, anyConnectorSelected, multipleNodesSelected, distinctFacetValues, connectSelected, hasUnselectedNodes, invertSelection, selectBranch, selectUpstream, anchorHasVisibleDescendants, anchorHasHiddenDescendants, anchorHasAncestors, anchorHasTags, anchorHasFill, anchorHasMarker, anchorHasShape, copyStyle, pasteStyle, hasStyleClip, duplicateSelected, deleteSelected, groupSelected, mergeSelectedCards, splitAnchorCard, anchorIsSplittable, exactlyTwoNodesSelected, tracePath, anchorHasBacklinks, selectBacklinks, anchorHasBrokenRefs, createMissingCards, boardHasOrphans, selectOrphans, boardHasReadyCards, selectReady, boardHasUnlinkedMentions, selectUnlinkedMentions, boardHasQuestions, selectQuestions, boardHasDuplicateTitles, selectDuplicateTitles, boardHasFragmentedTags, selectFragmentedTags, unifyFragmentedTags, boardHasMultipleClusters, selectLargestCluster, boardHasDuplicateConnectors, selectRedundantConnectors, boardHasSources, selectSources, boardHasSinks, selectSinks, boardHasDateGaps, selectUndatedCards, boardHasThemes, selectTopThemeCards, boardHasLinks, selectLinkedCards, boardHasSplitCandidates, selectSplitCandidates, boardHasTagGaps, selectUntaggedCards, boardHasRelationships, selectMainRelationshipCards, boardHasHealthIssues, selectHealthIssueCards, boardHasColorGroups, selectLargestColorGroup, boardHasTagPairs, selectStrongestTagPair, savePreset, openPresetPicker, tagSelected, spaceByGap, savedPresets.length, anyUnlockedSelected, anyLockedSelected, anyVisibleSelected, anyHiddenSelected, canIsolate, isolateSelection, exportSelectionSvg, exportSelectionPng, copySelectionPng, colorBranches, copyOutline],
  );
  // selectedIds (memberIds) → the universal NodeRefs the generic batch layer speaks.
  const selectedRefs = useMemo<NodeRef[]>(
    () => [...selectedIds].map((member) => ({ family: BOARD_ITEM_FAMILY, parts: { member } })),
    [selectedIds],
  );
  const batchActions = useMemo(() => acceptedBatchActions(batchPack, selectedRefs), [batchPack, selectedRefs]);

  // The selection bounding box (≥2 items) — the union of the selected items'
  // world rects. Recomputed from the live graph so it tracks during a group resize.
  // The live rotation angle (degrees) while a rotate gesture is in flight — drives the
  // HUD to show the angle instead of W×H. Null when not rotating (cleared on pointer-up).
  // Declared BEFORE the `hud` memo: a useMemo deps array is evaluated eagerly during
  // render, so referencing this after the memo would be a TDZ ReferenceError on mount.
  const [liveRotation, setLiveRotation] = useState<number | null>(null);

  const groupBounds = useMemo<GroupRect | null>(() => {
    if (selectedIds.size < 2) return null;
    const selected = readItems(graph, currentRef).filter((i) => selectedIds.has(i.memberId) && !itemIsConnector(i));
    return selectionBounds(selected.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h })));
  }, [graph, currentRef, selectedIds]);

  // The selection HUD: live W×H for exactly one node (tracks resize/drag off the
  // live graph), or "N selected" for ≥2 — a blind pill below the selection bounds.
  const hud = useMemo<{ bounds: GroupRect | null; label: string }>(() => {
    if (selectedIds.size === 0) return { bounds: null, label: '' };
    const selected = readItems(graph, currentRef).filter((i) => selectedIds.has(i.memberId) && !itemIsConnector(i));
    if (selected.length === 0) return { bounds: null, label: '' };
    const rects = selected.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
    const bounds = selectionBounds(rects);
    // While rotating, the pill shows the live angle — the item's absolute angle for a
    // single rotation, or the group rotation delta Δ for a multi-select rotation
    // (both flow through `liveRotation`). Otherwise it shows W×H (one item) or the
    // selection count (≥2).
    const label = liveRotation != null
      ? `${Math.round(liveRotation)}°`
      : selected.length === 1
        ? `${Math.round(rects[0].w)} × ${Math.round(rects[0].h)}`
        : `${selected.length} selected`;
    return { bounds, label };
  }, [graph, currentRef, selectedIds, liveRotation]);

  // The free-rotation target: exactly ONE selected, non-connector, unlocked item.
  // Its world rect + current rotation feed the rotate grip overlay; null hides it
  // (multi-select / nothing / a connector / a locked item shows no rotate handle).
  const rotateTarget = useMemo<{ memberId: string; rect: GroupRect; rotation: number } | null>(() => {
    if (selectedIds.size !== 1) return null;
    const selected = readItems(graph, currentRef).filter((i) => selectedIds.has(i.memberId) && !itemIsConnector(i));
    if (selected.length !== 1) return null;
    const it = selected[0];
    if (itemIsLocked(it)) return null;
    return { memberId: it.memberId, rect: { x: it.x, y: it.y, w: it.w, h: it.h }, rotation: Number(it.extra?.rotation) || 0 };
  }, [graph, currentRef, selectedIds]);

  /** Frame a set of world rects in the viewport via the camera-frame primitive
   *  (Zoom-to-fit / Zoom-to-selection). Defined BEFORE the keydown effect so the
   *  effect's dep array can reference these stable callbacks without a TDZ. */
  const FIT_PADDING = 80;
  const frameRects = useCallback((rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>) => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return;
    const cam = frameCamera(rects, { w: box.width, h: box.height }, { padding: FIT_PADDING, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM });
    if (cam) setCamera(cam);
  }, []);
  const zoomToFit = useCallback(() => {
    frameRects([...nodeRectsRef.current.values()]);
  }, [frameRects]);
  // The board opens where it was last looked at: once loaded, the remembered camera is restored (and, being the person's
  // own place, replaces the first-open fit); every pan or zoom that settles for a moment is remembered again, outside
  // undo history, only when it differs from what is kept.
  const cameraRestoredRef = useRef(false);
  useEffect(() => {
    if (isLoading || cameraRestoredRef.current) return;
    cameraRestoredRef.current = true;
    const kept = readLastCamera(graphRef.current, viewRef);
    if (!kept) return;
    fittedOnOpenRef.current = true;
    setCamera(kept);
  }, [isLoading, viewRef]);
  useEffect(() => {
    if (isLoading || !cameraRestoredRef.current) return;
    const timer = setTimeout(() => {
      const kept = readLastCamera(graphRef.current, viewRef);
      if (kept && Math.abs(kept.panX - camera.panX) < 0.5 && Math.abs(kept.panY - camera.panY) < 0.5 && Math.abs(kept.zoom - camera.zoom) < 0.001) return;
      const before = graphRef.current;
      const after = rememberLastCamera(before, viewRef, camera, Date.now());
      // A place is not an edit: it is saved straight to the store, with no undo step, and a refusal (a viewer who may
      // not change the board) is simply not remembered rather than shown as a board error.
      store.apply(before, after).then(() => setGraph(after), () => {});
    }, CAMERA_REMEMBER_MS);
    return () => clearTimeout(timer);
  }, [camera, isLoading, viewRef, store]);
  // `fitOnOpen`: the first time the loaded board shows items, frame them all when any runs past the stage.
  const fittedOnOpenRef = useRef(false);
  useEffect(() => {
    if (!fitOnOpen || fittedOnOpenRef.current || isLoading || nodeRects.size === 0) return;
    const box = stageRef.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;
    fittedOnOpenRef.current = true;
    const rects = [...nodeRects.values()];
    const shown = rects.every(r => r.x * camera.zoom + camera.panX >= 0 && r.y * camera.zoom + camera.panY >= 0
      && (r.x + r.w) * camera.zoom + camera.panX <= box.width && (r.y + r.h) * camera.zoom + camera.panY <= box.height);
    if (shown) return;
    const framed = frameCamera(rects, { w: box.width, h: box.height }, { padding: FIT_PADDING, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM });
    if (!framed) return;
    if (framed.zoom >= fitOnOpen.leastZoom) { setCamera(framed); return; }
    const zoom = fitOnOpen.leastZoom;
    const pad = Math.min(FIT_PADDING, box.width / 8);
    setCamera({ zoom, panX: pad - Math.min(...rects.map(r => r.x)) * zoom, panY: pad - Math.min(...rects.map(r => r.y)) * zoom });
  }, [fitOnOpen, isLoading, nodeRects, camera]);
  const zoomToSelection = useCallback(() => {
    const sel = selectedIdsRef.current;
    const rects = [...nodeRectsRef.current].filter(([id]) => sel.has(id)).map(([, r]) => r);
    frameRects(rects.length > 0 ? rects : [...nodeRectsRef.current.values()]);
  }, [frameRects]);
  const resetZoom = useCallback(() => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return;
    setCamera((c) => zoomAroundCenter(c, { w: box.width, h: box.height }, 1, MIN_ZOOM, MAX_ZOOM));
  }, []);

  // ── #169 Present mode (story path) ─────────────────────────────────────────
  // Walk the board's frames as ordered chapters via the SAME frameCamera primitive
  // (Zoom-to-fit's cousin). `presentIndex` null = not presenting; a number = the
  // current frame. Enter frames the first, Next/Prev step + re-frame (clamped, no
  // wrap), Escape exits. The frames are DATA (`boardFrames` — extra.presentationFrame,
  // order asc); this controller owns no geometry, only which rect to hand the camera.
  const [presentIndex, setPresentIndex] = useState<number | null>(null);
  const presentIndexRef = useRef(presentIndex);
  presentIndexRef.current = presentIndex;
  const enterPresent = useCallback(() => {
    const frames = boardFrames(readItems(graphRef.current, currentRefRef.current));
    if (frames.length === 0) return; // nothing to present
    setSelectedIds(new Set()); // a clean stage — no selection chrome while presenting
    setPresentIndex(0);
    frameRects([frameRect(frames[0])]);
  }, [frameRects]);
  const goPresent = useCallback((dir: number) => {
    const cur = presentIndexRef.current;
    if (cur === null) return;
    const all = readItems(graphRef.current, currentRefRef.current);
    const frames = boardFrames(all);
    if (frames.length === 0) { setPresentIndex(null); return; }
    // #175 — advancing follows a frame→frame connector (prototype link) when the
    // current frame has one; otherwise the sequential next. Prev is always sequential.
    const linked = dir > 0 ? frameLinkTarget(frames, all, cur) : null;
    const next = linked ?? presentStep(frames.length, cur, dir);
    setPresentIndex(next);
    frameRects([frameRect(frames[next])]);
  }, [frameRects]);
  const exitPresent = useCallback(() => setPresentIndex(null), []);
  // #175 — the last SEQUENTIAL frame can still advance when it carries a prototype
  // link (frame→frame connector), so the Next-disabling "atLast" must be link-aware.
  const presentAtLast = useMemo(() => {
    if (presentIndex === null || frames.length === 0) return true;
    if (presentIndex < frames.length - 1) return false;
    return frameLinkTarget(frames, items, presentIndex) === null;
  }, [presentIndex, frames, items]);

  // R10/P7 ACTION AS DATA — the board's action-affordance rows. One published-records
  // read feeds BOTH this catalog and the "Live surface" tool below (declared here so
  // the palette memo can see it; JS TDZ, not hook rules, dictates the order). Every
  // entry point (shelf, ⌘K palette, right-click menu) derives the SAME ShelfEntry and
  // runs it through the panel's ONE run path (`addItem` — ask → fire → pending → poll);
  // the ref indirection exists only because addItem is declared later in this file.
  // PERF (board-load hang): read the scoped group-owned feed plus the independent
  // kind-addressed action-affordance feed, never the shared `published-records` aggregate. The aggregate
  // re-delivers + re-parses the ENTIRE studio's ~28k published records (tens of MB) on the main
  // thread every open, jamming the engine queue so the board's targeted note reads (store.load)
  // hang on "Loading your board…". Each scoped feed delivers only its declared
  // payload class; its
  // `{record:{address},payload}` rows are normalized back to the `{address,payload}` contract every
  // reader below already consumes (SSOT — one row shape). Mirrors screen-arrangement / documents.
  const groupOwnedRecordsRaw = normalizeFeedRows(useBitfieldData('group-owned-feed'));
  const actionAffordanceRecordsRaw = normalizeFeedRows(useBitfieldData('action-affordance-feed'));
  const publishedRecordsRaw = useMemo(
    () => [...groupOwnedRecordsRaw, ...actionAffordanceRecordsRaw],
    [groupOwnedRecordsRaw, actionAffordanceRecordsRaw],
  );
  // This context narrows presentation eligibility only. It is defense in depth
  // around the board's catalog; Product Access and Hosted closure remain buyer
  // authorization authorities.
  const viewerAccessRefs = React.useContext(ViewerAccessRefsContext);
  const affordanceRows = useMemo(
    () => readActionAffordances(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  // The ARCHIVED (soft-deleted) actions — decoded from the SAME feed. Restoring one
  // rewrites its ORIGINAL bytes with is_active:true (the liveness primitive's restore
  // configuration); the feed re-reads and it returns to every surface. This is the
  // DURABLE way back once the transient Undo notice is gone.
  const archivedActionRows = useMemo(
    () => readArchivedActionAffordances(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  const archivedActionRestoreRows = useMemo(
    () => archivedActionRows.map((row) => ({
      label: row.label,
      restore: () => {
        void setActionAffordanceActiveLive(
          { id: row.id, ...(row.source_address ? { source_address: row.source_address } : {}), payload: row.payload },
          true,
          partitionLabel,
        )
          .then(() => showNotice(`"${row.label}" is back.`))
          .catch(() => showNotice(`Could not restore "${row.label}".`, 'error'));
      },
    })),
    [archivedActionRows, partitionLabel, showNotice],
  );
  const addItemRef = useRef<(tool: ShelfEntry) => void>(() => {});
  const runAffordanceTool = useCallback((tool: ShelfEntry) => addItemRef.current(tool), []);

  // A row's removalRef.payload is a RENDER-TIME snapshot — after an edit (or any
  // concurrent write) it can be STALE, and archive/restore/edit rewrite the FULL
  // payload, so acting on the snapshot could silently roll back the newer record
  // (Codex audit 2026-07-10, finding 4). This resolver swaps in the FRESHEST
  // record from the live published-records feed (matched by record id) at the
  // moment of the action; the snapshot is only the fallback when the feed hasn't
  // caught up or the id is absent.
  const affordanceRowsRef = useRef(affordanceRows);
  affordanceRowsRef.current = affordanceRows;
  const freshRemovalRef = useCallback(
    (ref: NonNullable<ShelfEntry['removalRef']>): NonNullable<ShelfEntry['removalRef']> => {
      if (!ref.id) return ref;
      const live = affordanceRowsRef.current.find((row) => row.id === ref.id);
      return live
        ? { id: live.id, ...(live.source_address ? { source_address: live.source_address } : {}), payload: live.payload }
        : ref;
    },
    [],
  );


  // "New action…" authoring — the shared editor emits a draft; the panel publishes it
  // live via write-batch. The saved record streams back through published-records, so
  // the new action appears on its channels with zero redeploy. What a new action can
  // run + where it can show are caller DATA rows (maximally-capable default, L083).
  const [actionEditorOpen, setActionEditorOpen] = useState(false);
  const [actionEditorRunId, setActionEditorRunId] = useState('');
  // OWNER-PUBLISHED catalogs (F7): runnable definitions are
  // `affordance-definition-option` records the producing packages ship;
  // channels are `affordance-channel` records each owning surface ships.
  // The hardcoded producer block + cross-named composition channel this
  // replaces made every new producer/surface a code edit here (L090/L093).
  const affordanceDefinitionOptions = useMemo<AffordanceDefinitionOption[]>(
    () => foldAffordanceDefinitionOptions(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  const affordanceChannelOptions = useMemo<AffordanceChannelOption[]>(
    () => foldAffordanceChannelOptions(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  // EDIT-in-place session: the SAME editor opens prefilled from the record's decoded
  // draft (draftOfActionAffordanceRecord); save rebuilds the record but keeps the
  // ORIGINAL identity + address (buildActionAffordanceEditWriteItem) so a rename never
  // mints a duplicate. null → the blank "New action" flow.
  const [actionEditorEdit, setActionEditorEdit] = useState<{
    draft: ActionAffordanceDraft;
    existing: { id?: string; source_address?: string; payload?: unknown };
  } | null>(null);
  const openActionEditor = useCallback(() => {
    setActionEditorEdit(null);
    setActionEditorRunId(newId('ua'));
    setActionEditorOpen(true);
  }, []);
  const openActionEditorForEdit = useCallback((tool: ShelfEntry) => {
    if (!tool.removalRef) return;
    const ref = freshRemovalRef(tool.removalRef);
    const runId = newId('ua');
    const draft = draftOfActionAffordanceRecord(ref.payload, runId);
    if (!draft) {
      showNotice(`"${tool.label}" cannot be edited here.`);
      return;
    }
    setActionEditorEdit({ draft, existing: { ...(ref.id ? { id: ref.id } : {}), ...(ref.source_address ? { source_address: ref.source_address } : {}), payload: ref.payload } });
    setActionEditorRunId(runId);
    setActionEditorOpen(true);
  }, [showNotice, freshRemovalRef]);
  const saveAuthoredAction = useCallback(async (draft: ActionAffordanceDraft) => {
    try {
      if (actionEditorEdit) {
        const item = buildActionAffordanceEditWriteItem(draft, actionEditorEdit.existing);
        if (!item) throw new Error('The action could not be saved.');
        await writeActionAffordanceItemLive(item, partitionLabel);
        showNotice(`"${draft.label}" was updated.`, 'success');
      } else {
        await writeActionAffordanceLive(draft, partitionLabel);
        showNotice(`"${draft.label}" is now in your actions.`, 'success');
      }
    } catch (error) {
      console.error('[group] save action failed:', error);
      showNotice('The action could not be saved.', 'error');
    }
  }, [actionEditorEdit, partitionLabel, showNotice]);

  // ⌘K command palette catalog (#171) — the SAME BatchActionCapability rows the bulk
  // bar renders, remapped as palette DATA (enum-dissolution: the palette never names an
  // action, it reads the accepted set), plus a few always-available board commands. Only
  // rows with a direct `run` are included (panel-`editor` rows need the bar's popover
  // host, not a one-shot dispatch). A new bulk row appears in the palette for free.
  // Declared AFTER the present controller so its deps are all in scope (useMemo runs
  // eagerly during render — an earlier placement would TDZ on enterPresent).
  // The board's insight-lens registry, built ONCE per board-data change (not per render) so panning/zooming/
  // selecting does not recompute PageRank/forecast/critical-path (P2). `nowFrame` is intentionally captured at
  // build time — time-only staleness is fine because the board re-renders (and rebuilds this) on every edit.
  // Shared by the Insights menu AND the command palette below (L069: one registry, two surfaces).
  const insightLenses = useMemo(
    () => boardInsightLenses({
      nodeItems, items, now: nowFrame, nodeRects, frameRects, selectedIdsRef, setSelectedIds,
      commit, graphRef, currentRefRef, applyBatch, reorderFrameById, rollupSpecRaw: currentBoardEntry?.rollupSpec,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nowFrame captured on purpose; selection is read via selectedIdsRef.current at render time (so a click does NOT rebuild the registry); frameRects/applyBatch/reorderFrameById/commit are stable useCallbacks and graphRef/currentRefRef/selectedIdsRef are refs.
    [nodeItems, items, nodeRects, currentBoardEntry],
  );

  const commandItems = useMemo(() => {
    // Insight lenses (b220) — each AVAILABLE panel lens is one ⌘K command that opens it (the SAME registry the
    // Insights menu renders). Distinct from the spatial wash lenses below (section "View"): these open a
    // read-only analytics panel (section "Insights"). A new lens auto-adds here for free (L069).
    const insightPanelRows = insightLenses
      .filter((l) => l.available)
      .map((l) => ({ id: `cmd-insight-${l.key}`, label: l.label, icon: 'Sparkles', section: 'Insights', run: () => setActiveInsightKey(l.key) }));
    const selectionRows = batchActions
      .filter((a) => typeof a.run === 'function')
      .map((a) => ({
        id: `cmd-sel-${a.id}`,
        label: a.label,
        icon: a.icon,
        section: 'Selection',
        run: () => { void a.run?.(selectedRefs, {} as never); },
      }));
    // The commands the board's table offers in the palette, with their keys, aliases and scores from that one table.
    const tableCommands = tablePaletteItems(BOARD_COMMANDS, { 'zoom-to-fit': () => zoomToFit(), 'reset-zoom': () => resetZoom(), 'keyboard-shortcuts': () => setShortcutsOpen(true) });
    const boardCommands = [
      ...tableCommands,
      { id: 'cmd-shortcut-tips', label: tipsOff ? 'Turn shortcut tips on' : 'Turn shortcut tips off', icon: 'Keyboard', section: 'Help', run: toggleTips },
      ...(frames.length > 0
        ? [{ id: 'cmd-present', label: 'Present frames', icon: 'Presentation', section: 'View', run: () => enterPresent() }]
        : []),
      // Insight lenses (b113/b115) — one ⌘K command per DATA lens row, plus a clear. Toggling a lens on/off
      // is a pure VIEW-state flip (no data mutation); the wash renders under the cards. A new lens auto-adds.
      ...INSIGHT_LENSES.map((l) => ({
        id: `cmd-lens-${l.id}`,
        label: `Insights: ${l.label}`,
        icon: 'Sparkles',
        section: 'View',
        run: () => setInsightLensId((cur) => (cur === l.id ? undefined : l.id)),
      })),
      ...(insightLensId
        ? [{ id: 'cmd-lens-off', label: 'Insights: off', icon: 'EyeOff', section: 'View', run: () => setInsightLensId(undefined) }]
        : []),
    ];
    const actionRows = [
      ...boardAffordancePaletteItems(affordanceRows, runAffordanceTool),
      { id: 'cmd-new-action', label: 'New action…', icon: 'Sparkles', section: 'Actions', run: () => openActionEditor() },
    ];
    return [...boardCommands, ...insightPanelRows, ...actionRows, ...selectionRows];
  }, [insightLenses, batchActions, selectedRefs, zoomToFit, resetZoom, enterPresent, frames.length, affordanceRows, runAffordanceTool, openActionEditor, tipsOff, toggleTips]);

  // #164 keyboard mind-mapping — the 2nd/3rd callers of the #159 connectNewNote
  // primitive (the drag gesture is the 1st). Spawn a child note linked from
  // `parentMemberId`, positioned to the RIGHT of the parent and stacked below its
  // existing children (directChildCount → row offset) so siblings never overlap.
  // Selects + opens the new note to type, as ONE undoable commit. No-op if the
  // parent isn't on the board. Tab passes the selected node; Enter passes the
  // selected node's parent (so the new note is a sibling). Pure topology + position
  // is DATA the shell computes; connectNewNote stays blind (L069/L090).
  const addMindMapChild = useCallback((parentMemberId: string) => {
    const items = readItems(graphRef.current, currentRefRef.current);
    const parent = items.find((i) => i.memberId === parentMemberId);
    if (!parent) return;
    const NOTE_W = parent.w ?? 220;
    const ROW_PITCH = 200; // default note height (160) + gap (40)
    const COL_GAP = 80;
    const row = directChildCount(items, parentMemberId);
    const noteMemberId = newId('m');
    const connectorMemberId = newId('c');
    let { graph: next } = connectNewNote(graphRef.current, currentRefRef.current, {
      boardId,
      fromMemberId: parentMemberId,
      x: parent.x + NOTE_W + COL_GAP,
      y: parent.y + row * ROW_PITCH,
      noteMemberId,
      noteItemId: newId('i'),
      connectorMemberId,
      connectorItemId: newId('i'),
    });
    // #167 — inherit the parent's branch colour so the #165/#166 rainbow stays LIVE as you
    // keyboard-build (MindNode/XMind canon): a new child of a coloured node + its connector
    // adopt that colour, folded into the SAME undoable commit. A child of the neutral root
    // (no fill) stays uncoloured until "Color branches" assigns the next palette hue. The
    // DECISION (does it inherit + what fill/colour) is the pure, tested `inheritedBranchStyle`
    // engine (SSOT in item-fill); the panel only plumbs its result through patchItem.
    const inherited = inheritedBranchStyle(parent);
    if (inherited) {
      const p = currentRefRef.current;
      next = patchItem(next, p, noteMemberId, { visualLayerStack: inherited.fillStack });
      next = patchItem(next, p, connectorMemberId, { color: inherited.connectorColor });
    }
    setSelectedIds(new Set([noteMemberId]));
    void commit(next);
    setEditingId(noteMemberId);
  }, [boardId, commit]);

  // Selection gestures (P1) + nudge (P2): ⌘/Ctrl-A selects every item in the
  // current group; ⌘/Ctrl-D duplicates the selection in place (+24/+24); ⌘/Ctrl-G
  // groups the selection into a section, ⌘⇧G ungroups the selected section(s);
  // Escape clears; arrow keys move the whole selection by 1px (10px with Shift) as
  // ONE undoable batch. All ignored while editing a note. Shift+1/2/0 frame the camera.
  // Tab = add child to the selected node, Enter = add sibling (#164 mind-mapping).
  useEffect(() => {
    const onKey = withKeyboardClaim((e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const key = e.key;
      // #169 Present mode — while presenting, arrows / space / PageUp-Down WALK the story
      // path (frame to frame via the camera) and Escape exits. Captured BEFORE every board
      // shortcut below so the deck owns the keyboard; present mode swallows the rest.
      if (presentIndexRef.current !== null) {
        if (key === 'Escape') { e.preventDefault(); exitPresent(); return; }
        if (key === 'ArrowRight' || key === 'ArrowDown' || key === ' ' || key === 'PageDown') { e.preventDefault(); goPresent(1); return; }
        if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'PageUp') { e.preventDefault(); goPresent(-1); return; }
        return;
      }
      // ⌘K / Ctrl-K — the command palette (Raycast/Linear/Figma actions menu). The
      // keyboard-first launcher over the board's live action catalog; toggles.
      if ((e.metaKey || e.ctrlKey) && (key === 'k' || key === 'K')) {
        e.preventDefault();
        setCommandOpen((o) => !o);
        return;
      }
      // ⌘F / Ctrl-F (override the browser's native find) AND "/" (the GitHub/Slack quick-search canon)
      // focus the board's search field. focusSearch() reports whether it focused — false on a board too
      // small to have a search field, so we DON'T preventDefault and the browser's own find still works.
      if (((e.metaKey || e.ctrlKey) && (key === 'f' || key === 'F')) || (!e.metaKey && !e.ctrlKey && !e.altKey && key === '/')) {
        if (boardFocusBarRef.current?.focusSearch()) {
          e.preventDefault();
          return;
        }
      }
      // P — enter Present mode (Keynote/Canva/Figma canon) when the board has ≥1 frame.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (key === 'p' || key === 'P')) {
        e.preventDefault();
        enterPresent();
        return;
      }
      // "?" (Shift+/) toggles the keyboard-shortcuts cheat sheet — the
      // discoverability layer for every shortcut below. No modifier; the editing
      // guard above already blocks it while typing.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && key === '?') {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      // #164 mind-mapping: Tab = add a CHILD to the single selected node; Enter =
      // add a SIBLING (a child of that node's parent). Only fires with exactly one
      // non-section, non-connector node selected; the editing guard above means
      // neither ever fires mid-type. Composes #159 via addMindMapChild. preventDefault
      // stops Tab from moving browser focus / Enter from any default.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (key === 'Tab' || key === 'Enter')) {
        const sel = selectedIdsRef.current;
        if (sel.size !== 1) return;
        const id = [...sel][0]!;
        const items = readItems(graphRef.current, currentRefRef.current);
        const node = items.find((i) => i.memberId === id);
        if (!node || node.isSection || itemIsConnector(node)) return;
        if (key === 'Tab') {
          e.preventDefault();
          addMindMapChild(id);
        } else {
          const parent = parentViaConnectors(items, id);
          if (!parent) return; // a root has no sibling in a single tree — grow it with Tab
          e.preventDefault();
          addMindMapChild(parent);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelectedIds(new Set(readItems(graphRef.current, currentRefRef.current).filter((i) => !itemIsConnector(i)).map((i) => i.memberId)));
        return;
      }
      // ⌥⌘C / ⌥⌘V — copy/paste STYLE (appearance only), FigJam "copy/paste
      // properties". Keyed on e.code: Option+C emits 'ç' as e.key on macOS, so
      // key.toLowerCase() would never match — e.code is modifier-independent.
      // Placed BEFORE the plain ⌘C/⌘V branch so the alt variant wins.
      if (e.altKey && (e.metaKey || e.ctrlKey) && e.code === 'KeyC') {
        if (selectedIdsRef.current.size === 0) return;
        e.preventDefault();
        copyStyle();
        return;
      }
      if (e.altKey && (e.metaKey || e.ctrlKey) && e.code === 'KeyV') {
        if (!getStyleClipboard() || selectedIdsRef.current.size === 0) return;
        e.preventDefault();
        pasteStyle();
        return;
      }
      // ⌘C — copy the selection into the cross-board clipboard (a session singleton,
      // so a copy here pastes on ANY board you switch to). PASTE (⌘V) is NOT handled
      // here: it lives in the single `paste` ClipboardEvent authority (see onPaste
      // above), which gives an external OS image precedence over internal members on
      // one ⌘V. A keydown ⌘V branch here would double-fire with that handler.
      if ((e.metaKey || e.ctrlKey) && key.toLowerCase() === 'c') {
        if (selectedIdsRef.current.size === 0) return;
        // Not prevented: the browser's own copy event follows, and onCopy (beside onPaste) puts the bundle on the
        // system clipboard too, so another tab or window of Trillion can paste it.
        copySelected([...selectedIdsRef.current]);
        return;
      }
      // ⌘X / Ctrl+X — CUT the selection (copy then remove; FigJam/Figma/Miro canon).
      // Completes the clipboard triad next to ⌘C above and the ⌘V paste authority.
      // `cutSelected` composes copySelected + deleteSelected, so it inherits the
      // same lock + connector semantics (locked items are never cut). Guard on
      // !alt/!shift so it never clobbers a different modifier chord.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key.toLowerCase() === 'x') {
        if (selectedIdsRef.current.size === 0) return;
        e.preventDefault();
        cutSelected();
        return;
      }
      // ⌘D / Ctrl+D — duplicate the selection in place (Figma/Sketch/Canva/Keynote
      // canon): the copy lands +24/+24 offset. A SECOND caller of the SAME
      // duplicateSelected primitive the bulk-bar Duplicate row dispatches (Alt-drag
      // takes a different path — the lower-level cloneItemsInto, committed with the
      // drag gesture). Keyboard adds zero engine code. preventDefault overrides the
      // browser bookmark default.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key.toLowerCase() === 'd') {
        if (selectedIdsRef.current.size === 0) return;
        e.preventDefault();
        duplicateSelected([...selectedIdsRef.current]);
        return;
      }
      // ⌘⇧G / Ctrl+Shift+G — UNGROUP: dissolve every SELECTED section back into the
      // parent (its items rejoin). Folds the existing ungroupItems engine over all
      // selected sections as ONE undoable commit (the selection-bar button does one
      // at a time). Checked BEFORE plain ⌘G so the shift variant wins. preventDefault
      // overrides the browser find-previous default.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && key.toLowerCase() === 'g') {
        const ids = new Set(selectedIdsRef.current);
        const sections = readItems(graphRef.current, currentRefRef.current).filter((i) => ids.has(i.memberId) && i.isSection);
        if (!sections.length) return;
        e.preventDefault();
        let next = graphRef.current;
        for (const s of sections) next = ungroupItems(next, currentRefRef.current, s.memberId);
        setSelectedIds(new Set());
        void commit(next);
        return;
      }
      // ⌘G / Ctrl+G — GROUP the selection (≥2) into a section. Reuses the existing
      // groupSelected callback (the same one the bulk-bar Group row dispatches).
      // preventDefault overrides the browser find-next default.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && key.toLowerCase() === 'g') {
        if (selectedIdsRef.current.size < 2) return;
        e.preventDefault();
        groupSelected();
        return;
      }
      if (key === 'Escape' && openConsoleRef.current) {
        // Close the drilldown console panel first (it's the topmost surface).
        e.preventDefault();
        setOpenConsole(null);
        return;
      }
      if (key === 'Escape' && activeEmbeddedSurfaceIdRef.current) {
        // Exit an entered embedded surface first (keep it selected — Esc only leaves
        // interactive mode); a second Esc then clears the selection below.
        e.preventDefault();
        setActiveEmbeddedSurfaceId(null);
        return;
      }
      if (key === 'Escape') {
        if (selectedIdsRef.current.size === 0) return;
        e.preventDefault();
        setSelectedIds(new Set());
        return;
      }
      // Camera framing (Figma canon): Shift+1 fit all · Shift+2 fit selection ·
      // Shift+0 reset to 100%. `e.code` is layout-independent (Shift+1 = '!').
      if (e.shiftKey && !(e.metaKey || e.ctrlKey || e.altKey)) {
        if (e.code === 'Digit1') { e.preventDefault(); zoomToFit(); return; }
        if (e.code === 'Digit2') { e.preventDefault(); zoomToSelection(); return; }
        if (e.code === 'Digit0') { e.preventDefault(); resetZoom(); return; }
      }
      // Zoom in / out (Figma/Miro/Sketch canon): + / = zoom in, - zoom out (NumPad
      // +/- too). ⌘/Ctrl variants MUST preventDefault to stop the BROWSER page-zoom
      // from hijacking the keys; plain +/- also zoom since the text-input guard above
      // blocks them while typing. Reuses the toolbar's ±10% snapped stepper — one zoom
      // SSOT, so keyboard and buttons land on the same tidy 10% grid.
      if (!e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        const out = e.code === 'Minus' || e.code === 'NumpadSubtract';
        stepZoomRef.current(out ? -1 : 1);
        return;
      }
      // Overview minimap toggle (Fibery/Miro "M" canon).
      if (key === 'm' && !(e.metaKey || e.ctrlKey || e.altKey)) {
        e.preventDefault();
        setMinimapOpen((o) => !o);
        return;
      }
      // Z-order layering (Figma/Sketch/Canva canon): ⌘] / ⌘[ move the selection ONE
      // step toward front / back; add Shift for all-the-way front / back. `e.code` is
      // layout-independent (Shift turns ] into }, but the code stays 'BracketRight').
      // A second caller of the same z-order primitives the bulk-bar rows dispatch.
      if ((e.metaKey || e.ctrlKey) && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        if (selectedIdsRef.current.size === 0) return;
        e.preventDefault();
        const toFront = e.code === 'BracketRight';
        if (e.shiftKey) applyBatch((g, ids, p) => reorderZ(g, p, ids, toFront ? 'front' : 'back'));
        else applyBatch((g, ids, p) => reorderZStep(g, p, ids, toFront ? 'forward' : 'backward'));
        return;
      }
      // Keyboard NODE NAVIGATION (a11y gap #5) via the spatial-nav primitive — makes canvas nodes
      // keyboard-selectable without colliding with the full existing keymap. Two non-colliding entries:
      //  • Alt+Arrow HOPS the selection to the adjacent node in that direction (from the single selected
      //    node, else from the viewport centre) — a free chord, works whether or not something is selected.
      //  • a plain Arrow on an EMPTY selection ENTERS the board (nudge needs a selection, so arrows are
      //    otherwise dead there) — select the nearest node to the viewport centre in that direction.
      const NAV_DIR: Record<string, NavDir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      const navDir = NAV_DIR[key];
      const navRects = (): NavRect[] => [...nodeRectsRef.current].map(([id, r]) => ({ id, x: r.x, y: r.y, w: r.w, h: r.h }));
      if (navDir && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const sel = [...selectedIdsRef.current];
        const from = sel.length === 1 ? sel[0] : viewportCenterRef.current();
        const next = nearestInDirection(navRects(), navDir, from);
        if (next) { selectItem(next, false); revealNodeRef.current(next); }
        return;
      }

      const NUDGE: Record<string, { dx: number; dy: number }> = {
        ArrowLeft: { dx: -1, dy: 0 },
        ArrowRight: { dx: 1, dy: 0 },
        ArrowUp: { dx: 0, dy: -1 },
        ArrowDown: { dx: 0, dy: 1 },
      };
      const step = NUDGE[key];
      if (step && selectedIdsRef.current.size > 0) {
        e.preventDefault();
        const scale = e.shiftKey ? 10 : 1;
        applyBatch((g, ids, p) => {
          const want = new Set(ids);
          // A locked item never moves — keyboard nudge respects the lock exactly like pointer
          // drag/resize/group-move (the lock protects from ALL accidental mutation, not just the mouse).
          // ONE batch patch (O(M+K)) instead of folding patchItem per selected item on every arrow-key press.
          const patches = readItems(g, p)
            .filter((it) => want.has(it.memberId) && !itemIsLocked(it))
            .map((it) => ({ memberId: it.memberId, patch: { x: it.x + step.dx * scale, y: it.y + step.dy * scale } }));
          return patchItems(g, p, patches);
        });
      } else if (navDir && selectedIdsRef.current.size === 0) {
        e.preventDefault();
        const next = nearestInDirection(navRects(), navDir, viewportCenterRef.current());
        if (next) { selectItem(next, false); revealNodeRef.current(next); }
      }
    });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyBatch, copySelected, cutSelected, duplicateSelected, groupSelected, commit, copyStyle, pasteStyle, zoomToFit, zoomToSelection, resetZoom, addMindMapChild, enterPresent, goPresent, exitPresent, selectItem]);

  // #88 — load the surface's saved text-style palette once (board-surface scoped).
  useEffect(() => {
    let cancelled = false;
    void readTextStylePalette(partitionLabel, boardId)
      .then((styles) => {
        if (!cancelled) setSavedTextStyles(styles);
      })
      .catch(() => {
        /* honest empty palette on read failure — no fake styles */
      });
    return () => {
      cancelled = true;
    };
  }, [partitionLabel, boardId]);

  // Crop mode: Escape commits-and-exits (the live drag already persisted each step).
  useEffect(() => {
    if (!cropTargetId) return;
    const onKey = withKeyboardClaim((e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setCropTargetId(null);
      }
    });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cropTargetId]);

  // #88 — persist a newly captured style: append to the palette DATA + write it back.
  // The toolbar captured the composite bundle from the live selection; we own only
  // the naming + storage. Read-modify-write the whole palette record (SSOT address).
  const saveTextStyle = useCallback(
    (name: string, composite: Record<string, string>) => {
      const next: SavedTextStyle[] = [
        ...savedTextStylesRef.current,
        { id: newId('ts'), name: name.trim() || 'Untitled style', composite },
      ];
      setSavedTextStyles(next);
      void writeTextStylePalette(boardId, next).catch(() => {
        /* leave optimistic state; next mount re-reads canonical palette */
      });
    },
    [boardId],
  );

  // #88 — the note toolbar commands: the built-in rich-text set PLUS a data-driven
  // "Styles" command whose options ARE the saved styles (each carries its composite
  // bundle), and whose capture/save contract lets a selection become a new style.
  const noteCommands = useMemo<ReadonlyArray<FormatCommand>>(
    () => [
      ...RICH_FORMAT_COMMANDS,
      {
        id: 'styles',
        label: 'Styles',
        icon: Bookmark,
        command: '',
        options: savedTextStyles.map((s) => ({
          label: s.name,
          value: s.id,
          composite: s.composite,
          previewStyle: s.composite,
        })),
        captureProperties: TEXT_STYLE_CAPTURE_PROPERTIES,
        onSaveComposite: saveTextStyle,
      },
    ],
    [savedTextStyles, saveTextStyle],
  );

  // Opens the shared inspector (InspectorSidebar over the board's field rows) on one item; set once the
  // inspection registry exists further down, read when the menu row is chosen.
  const openDetailsRef = useRef<(memberId: string) => void>(() => {});
  const stylePack = useMemo<NodeActionPack>(
    () => [
      {
        id: 'details',
        label: 'Edit details…',
        icon: 'SlidersHorizontal',
        priority: 1,
        accepts: () => true,
        run: (nodeRef: NodeRef) => openDetailsRef.current(nodeRef.parts.member),
      },
      {
        id: 'style',
        label: 'Background & edge…',
        icon: 'Layers',
        priority: 0,
        accepts: () => true,
        editor: (nodeRef: NodeRef, close: () => void) => {
          const memberId = nodeRef.parts.member;
          const item = itemsRef.current.find((i) => i.memberId === memberId);
          const rec = item?.extra?.visualLayerStack as VisualLayerStackRecord | undefined;
          // The color-filter chip row appears only for IMAGE items; `imageFilter` is a
          // top-level presentation key (like `crop`), the chosen preset's CSS string. The
          // editor stays blind — it gets the preset catalog as DATA and reports an id.
          const isImage = !!item?.src && boardItemContentType(item).startsWith('image/');
          const activeFilterId = isImage
            ? presetIdForCss(typeof item?.extra?.imageFilter === 'string' ? item.extra.imageFilter : '')
            : undefined;
          return (
            <LayerStackEditor
              layers={rec?.layers ?? []}
              clip={rec?.clip as CapabilityInvocation | undefined}
              capabilities={builtinVisualLayerCapabilities}
              registry={BOARD_ITEM_LAYER_REGISTRY}
              onChange={(next) => writeItemStack(memberId, (r) => ({ ...r, layers: [...next] }))}
              onClipChange={(c) => writeItemStack(memberId, (r) => ({ ...r, clip: c ?? undefined }))}
              frame={rec?.frame as FrameDef | undefined}
              onFrameChange={(f) => writeItemStack(memberId, (r) => ({ ...r, frame: f }))}
              filterPresets={isImage ? BOARD_FILTER_PRESETS : undefined}
              imageFilterId={activeFilterId}
              onFilterChange={
                isImage
                  ? (id) =>
                      void commit(
                        patchItem(graphRef.current, currentRefRef.current, memberId, { imageFilter: filterCssById(id) || undefined }),
                      )
                  : undefined
              }
              pickSubject={pickLayerSubject}
              onDone={close}
              emptyMessage="No layers yet. Add a color, gradient, or image — then give it an edge above."
            />
          );
        },
      },
    ],
    [writeItemStack, pickLayerSubject, commit],
  );
  // #129 — the right-click menu hosts the style editor PLUS the whole batch-action
  // pack, surfaced at the cursor (FigJam/Figma canon). The batch rows act on the
  // current selection (reconciled on open); the `minCount` gate curates per context.
  const refsForMenu = useCallback(
    (): NodeRef[] => [...selectedIdsRef.current].map((m) => ({ family: BOARD_ITEM_FAMILY, parts: { member: m } })),
    [],
  );
  // Un-isolate lives in the item menu too (a user's bug: after Isolate, the only
  // "Show all" was a toolbar button — undiscoverable). Board-level, so it only
  // accepts when SOMETHING is hidden (reads live via itemsRef → no stale closure,
  // no dep churn). Exiting isolation === un-hiding everything (#150 inverse).
  const isolationExitPack = useMemo<NodeActionPack>(
    () => [
      {
        id: 'exit-isolation',
        label: 'Show all (exit isolation)',
        icon: 'Eye',
        priority: -10,
        accepts: () => itemsRef.current.some((i) => i.extra?.hidden === true),
        run: () => showAllItems(),
      },
    ],
    [showAllItems],
  );
  // Progress + Time in the RIGHT-CLICK menu — where the user actually looks for a
  // per-card action (a user: "i have no idea where to access the progress or time
  // thing"). They previously lived ONLY in the SelectedItemToolbar, which R53
  // correctly stopped auto-opening — but that buried these two primary per-item
  // actions behind the "Open selection inspector" button (3 clicks + jargon). They
  // open the SAME draggable MetricPanel/TimeLogPanel via the SAME anchor state and
  // starter-metric seed the toolbar uses (SSOT — one handler, two entry points).
  // `accepts` reuses the canonical metric-target predicate (real content card, not
  // a connector/furniture), so the rows show only where a goal/timer makes sense.
  const metricTimePack = useMemo<NodeActionPack>(
    () => {
      const acceptsCard = (nodeRef: NodeRef): boolean => {
        const it = itemsRef.current.find((i) => i.memberId === nodeRef.parts.member);
        return !!it && itemIsMetricTarget(it);
      };
      return [
        {
          id: 'track-progress',
          label: 'Progress',
          icon: 'Target',
          priority: -3,
          accepts: acceptsCard,
          run: (nodeRef: NodeRef) => {
            const memberId = nodeRef.parts.member;
            if (metricOf(graphRef.current, currentRefRef.current, memberId) === null) {
              void commit(setItemMetric(graphRef.current, currentRefRef.current, memberId, { current: 0, target: 10 }));
            }
            setMetricAnchorId(memberId);
          },
        },
        {
          id: 'log-time',
          label: 'Time',
          icon: 'Timer',
          priority: -3,
          accepts: acceptsCard,
          run: (nodeRef: NodeRef) => setTimeAnchorId(nodeRef.parts.member),
        },
      ];
    },
    [commit],
  );
  // A note opens as a document (the host's `openAsDocument`): one runner for both places it is offered, the selection
  // toolbar and the right-click menu, where a person looks for a per-card action first.
  const openNoteAsDocument = useCallback(
    async (memberId: string) => {
      if (!openAsDocument) return;
      const item = readItems(graphRef.current, currentRefRef.current).find(one => one.memberId === memberId);
      if (!item) return;
      const patch = await openAsDocument.run(item);
      if (patch) await commit(patchItem(graphRef.current, currentRefRef.current, memberId, patch));
    },
    [openAsDocument, commit],
  );
  const asDocumentPack = useMemo<NodeActionPack>(
    () => openAsDocument ? [{
      id: 'open-as-document',
      label: openAsDocument.label,
      icon: 'FileText',
      priority: -2,
      accepts: (nodeRef: NodeRef) => {
        const it = itemsRef.current.find((i) => i.memberId === nodeRef.parts.member);
        return !!it && it.kind === 'note' && !it.isSection;
      },
      // A menu row closes as it runs, so what went wrong is said in a notice (the toolbar button says it in itself).
      run: (nodeRef: NodeRef) => {
        openNoteAsDocument(nodeRef.parts.member).catch((error: unknown) => showNotice(errorWords(error), 'error'));
      },
    }] : [],
    [openAsDocument, openNoteAsDocument, showNotice],
  );
  const itemMenuPack = useMemo<NodeActionPack>(
    () => [
      ...isolationExitPack,
      ...asDocumentPack,
      ...metricTimePack,
      ...stylePack,
      ...boardAffordanceContextActions(affordanceRows, runAffordanceTool),
      ...batchActionsAsNodeActions(batchPack, refsForMenu),
    ],
    [isolationExitPack, asDocumentPack, metricTimePack, stylePack, batchPack, refsForMenu, affordanceRows, runAffordanceTool],
  );
  const styleMenu = useNodeContextMenu(itemMenuPack);
  const openStyle = useCallback(
    (memberId: string, anchor: { x: number; y: number }) => {
      // Reconcile selection so the batch rows act on the right thing: keep the
      // current multi-selection if this item is part of it (right-click a selected
      // item → act on ALL); otherwise select only it (right-click an unselected
      // item → act on it). Standard canvas behavior.
      if (!selectedIdsRef.current.has(memberId)) selectItem(memberId, false);
      styleMenu.openFor({ family: BOARD_ITEM_FAMILY, parts: { member: memberId } }, anchor);
    },
    [selectItem, styleMenu],
  );

  // CONSUME seam: for any pending item still awaiting a producer (status pending
  // or unconfigured, no src yet), read the producer's result/error record and
  // reflect it onto the item — image src on success, an honest message otherwise.
  // The board stays blind to the producer; it only matches on request id.
  const hasAddresses = (e: Record<string, unknown> | undefined): e is { statusAddresses: ProducerStatusAddresses } =>
    !!e && typeof (e.statusAddresses as ProducerStatusAddresses | undefined)?.resultAddress === 'string';
  const awaitingKey = JSON.stringify(
    items
      // Awaiting a producer = it carries status addresses AND is still pending/unconfigured.
      // (No `!i.src` gate: an IDENTITY-PRESERVING enrichment card — e.g. a link card being
      // OG-fetched — already holds its href in `src` yet is still awaiting its patch. The
      // status gate alone is the real "still waiting" signal; a settled card flips to
      // status:'done' and drops out, and a plain card has no statusAddresses.)
      .filter((i) => hasAddresses(i.extra) && (i.extra?.status === 'pending' || i.extra?.status === 'unconfigured'))
      .map((i) => ({
        memberId: i.memberId,
        // Where the trigger item sits — a MULTI-item producer lays its results out
        // around this origin (it replaces the single placeholder with N items).
        origin: { x: i.x, y: i.y },
        addresses: (i.extra as { statusAddresses: ProducerStatusAddresses }).statusAddresses,
        // Fail-closed DATA (L117/SP5): the owner's producer descriptor may set how long
        // to wait before a never-answering run is declared failed; the board stays blind.
        timeoutMs: typeof i.extra?.timeoutMs === 'number' ? i.extra.timeoutMs : undefined,
        // The owner's HONEST dispatch stamp — the SAME `started_at` the elapsed
        // timer reads (SSOT). The fail-closed clock measures from real submit
        // time, not from when this session first saw the card. `submittedAtMs`
        // was a phantom key written nowhere; reading it silently disabled that.
        startedAtMs: typeof i.extra?.started_at === 'number' ? i.extra.started_at : undefined,
        // The owner's output EFFECT (append vs authoritative reconcile) rides along
        // opaquely so the poll can route this run's result; absent → append (default).
        effect: typeof i.extra?.effect === 'string' ? i.extra.effect : undefined,
      })),
  );
  useEffect(() => {
    const awaiting: Array<{
      memberId: string; origin: { x: number; y: number }; addresses: ProducerStatusAddresses;
      timeoutMs?: number; startedAtMs?: number; effect?: string;
    }> = JSON.parse(awaitingKey);
    if (!awaiting.length) return;
    let live = true;
    const poll = async () => {
      for (const { memberId, origin, addresses, timeoutMs, startedAtMs, effect } of awaiting) {
        const status = await readProducerStatus(partitionLabel, addresses);
        if (!live) return;
        if (status.state === 'done' && 'items' in status && effect === 'reconcile') {
          // AUTHORITATIVE RECONCILE (action DATA `effect:"reconcile"`): the agent returned
          // the COMPLETE desired board. Items ECHOING an existing memberId edit that card in
          // place (text updates, position kept); items with no memberId are new notes laid
          // out around the origin; existing members the agent OMITTED are removed. This is
          // the "reorganize + fill the empty notes" path — not a blind append. Blind on the
          // opaque `effect` string; the board names no action (L090). The trigger placeholder
          // is removed first so it does not survive as a stray member.
          // Ids currently on the board — so an agent that HALLUCINATES a memberId (echoes
          // an id that is not really here) lands a placed NEW note instead of a phantom
          // unplaced card at (0,0). Only a real echoed id edits in place.
          const existingIds = new Set(
            membersOf(graphRef.current, currentRefRef.current).map((m) => m.memberId),
          );
          const output = reconcileOutputFromItems(
            producerItemsToReconcileItems(status.items),
            currentRefRef.current,
            origin,
            () => newId('m'),
            () => itemRef(boardId, newId('item')),
            existingIds,
          );
          // FAIL-SAFE: the agent result is UNTRUSTED — if it produced zero items (failure,
          // refusal, timeout, malformed JSON), the board is preserved untouched instead of
          // being wiped (a flaky model response must never delete the user's board).
          await commit(status.incomplete
            ? applyPartialProducerOutput(graphRef.current, output, memberId)
            : reconcileBoardGraphFromUntrustedResult(removeItem(graphRef.current, currentRefRef.current, memberId), output));
        } else if (status.state === 'done' && 'items' in status && isIdentityPreserving(status.items)) {
          // IDENTITY-PRESERVING producer (enrichment): the result names EXISTING members
          // to patch in place (a link card's OG title/thumbnail landing on the very card
          // that was pasted). Merge the presentation patch by memberId — the trigger card
          // stays put, keeps its href/position, and only grows its DATA. New cards
          // in a mixed result use the shared layout; the trigger is retained.
          // The awaited card settles (status:'done') and drops
          // out of the poll. Reuses the SAME applyProducerOutput merge bridge (L069).
          const output = layoutMixedProducerOutput(status.items, currentRefRef.current, memberId, origin,
            () => newId('m'), () => itemRef(boardId, newId('item')),
          );
          await commit(status.incomplete ? applyPartialProducerOutput(graphRef.current, output, memberId)
            : applyProducerOutput(graphRef.current, output));
        } else if (status.state === 'done' && 'items' in status) {
          // GENERATIVE producer (remote / source pull): replace the single placeholder
          // with the laid-out produced items, atomically — remove the trigger, apply the
          // producer output. Same bridge the local fill uses.
          const drafts: ProducerDraft[] = status.items.map((it) => ({
            kind: it.kind ?? 'note',
            text: it.text,
            src: it.src,
            contentType: it.contentType,
            extra: it.extra,
          }));
          const output = layoutDraftsToOutput(
            drafts,
            currentRefRef.current,
            origin,
            () => newId('m'),
            () => itemRef(boardId, newId('item')),
          );
          await commit(status.incomplete ? applyPartialProducerOutput(graphRef.current, output, memberId)
            : applyProducerOutput(removeItem(graphRef.current, currentRefRef.current, memberId), output));
          // STREAMING REVEAL (item #9): flag the freshly-produced TEXT members so their
          // notes type the result in on mount (the same reveal composition does). The
          // note reads `revealText` and drives the shared useRevealedLength scheduler;
          // cleared after the animation window so a later remount never replays it.
          const revealIds = output.items
            .filter((_, i) => typeof drafts[i]?.text === 'string' && (drafts[i]!.text as string).trim().length > 0)
            .map((it) => it.memberId);
          if (revealIds.length > 0) {
            setRevealMemberIds(new Set(revealIds));
            window.setTimeout(() => setRevealMemberIds(new Set()), 8000);
          }
        } else if (status.state === 'done') {
          // Single-artifact producer (image): the result fills `src` on the item.
          // #216: size the landed image to its true aspect ratio (the placeholder was a
          // guess — a 16:9 or 9:16 generation would otherwise squish into it). Same
          // imageFootprint SSOT the pick/drop paths use; a decode failure keeps the size.
          const dims = status.contentType?.startsWith('image/') ? await measureImageUrlNaturalSize(status.src, status.contentType) : null;
          const footprint = dims ? imageFootprint(dims.w, dims.h) : null;
          await commit(patchItem(graphRef.current, currentRefRef.current, memberId, { src: status.src, contentType: status.contentType, status: 'done', ...(footprint ? { w: footprint.w, h: footprint.h } : {}) }), graphRef.current, { undoable: false });
        } else if (status.state === 'error') {
          await commit(patchItem(graphRef.current, currentRefRef.current, memberId, { status: 'error', message: status.message }), graphRef.current, { undoable: false });
        } else {
          // FAIL-CLOSED (L063/L117/SP5): a producer that never writes a result/error
          // record would otherwise spin forever. Declare it failed once it has been
          // pending past its DATA limit, measured from the owner's submit stamp when
          // present, else from when THIS session first observed it (so pre-existing
          // orphans — submitted before this safety net existed — also resolve on open).
          // It becomes the normal removable error card; no infinite spinner, no trap.
          const seen = firstSeenRef.current;
          const nowMs = Date.now();
          // First-seen is the fallback only for stamp-less legacy orphans — a
          // real `started_at` never touches the Map, so a stamped card keeps no
          // per-session state and resolves from its true dispatch time on reopen.
          const hasStamp = typeof startedAtMs === 'number' && startedAtMs > 0;
          const firstSeenMs = hasStamp ? nowMs : (seen.get(memberId) ?? (seen.set(memberId, nowMs), nowMs));
          const startMs = producerStartMs(startedAtMs, firstSeenMs);
          if (producerTimedOut(startMs, nowMs, producerLimitMs(timeoutMs))) {
            seen.delete(memberId);
            await commit(patchItem(graphRef.current, currentRefRef.current, memberId, { status: 'error', message: undefined }), graphRef.current, { undoable: false });
          }
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [awaitingKey, partitionLabel, commit, boardId]);

  /** Place a produced item draft at a world position in the CURRENT group
   *  (the open section, or the board root) — shared by Add + drop. */
  const placeDraftAt = useCallback(
    (draft: BoardItemDraft, worldX: number, worldY: number) => {
      const placement = buildDraftPlacement(draft, worldX, worldY, boardId, currentBoardAppearanceRef.current);
      // R2b — the default new-item footprint flows through the appearance cascade (board
      // default → global 220×160), dissolving the hardcoded `DEFAULTS`. A draft that declares
      // its own w/h (a live surface, a natural-aspect image) still wins. Zero-regression: with
      // no board override this resolves to exactly 220×160.
      void commit(
        placeItem(graphRef.current, currentRefRef.current, {
          ...placement,
          text: draft.text,
          src: draft.src,
          // contentType + any producer extra (requestId/status) ride the opaque
          // presentation so the renderer dispatches without a kind branch (L090).
          extra: { ...(draft.extra ?? {}), ...(draft.contentType ? { contentType: draft.contentType } : {}) },
        }),
      );
      return placement.memberId;
    },
    [boardId, commit],
  );
  /** Text canvas-tool: the `text.place` intent. Drop a note at the exact click
   *  point, select it, AND open its inline editor immediately so you can type at
   *  once (FigJam/Figma canon — place-and-type). The note seeds empty; setting
   *  `editingId` to the new member in the SAME commit means NoteItem mounts already
   *  in edit mode, and its `editing` effect focuses the contentEditable with the
   *  caret ready. The focus is durable because the placement pointerdown calls
   *  `preventDefault` (see the `text.place` arm) — that suppresses the browser's
   *  default focus-stealing on the gesture, the same mechanism the rich-text
   *  toolbar uses to keep the editor focused. The Text tool stays active for
   *  repeated placement. */
  const placeTextAt = useCallback(
    (clientX: number, clientY: number) => {
      const world = screenToWorld(clientX, clientY);
      const memberId = placeDraftAt({ kind: 'note', text: '' }, world.x, world.y);
      setSelectedIds(new Set([memberId]));
      setEditingId(memberId);
    },
    [placeDraftAt, screenToWorld],
  );
  const placeTextAtRef = useRef(placeTextAt);
  placeTextAtRef.current = placeTextAt;

  /** Double-click EMPTY canvas → drop a note at the cursor and open it for typing
   *  (Miro/FigJam/Mural canon — the fastest blank-space→idea path, zero tool switch).
   *  A THIRD trigger of `placeTextAt`, gated to the default Select (move) tool so the
   *  Text/Draw/Connector/Hand tools keep their own semantics. Only fires on bare
   *  canvas: an item, a connector path (svg), or a drawing mark owns its OWN
   *  double-click (edit / crop / drill-in / label), so we bail if the target sits
   *  inside a board member node or any `svg` overlay.
   *
   *  CRITICAL — scope the "owns its double-click" guard to nodes INSIDE the viewport.
   *  The studio embeds this whole panel inside a screen-arrangement node that ALSO
   *  carries `[data-node-ref]`, and that host wrapper is an ANCESTOR of the viewport.
   *  An unscoped `closest('[data-node-ref]')` walks UP past the viewport and matches
   *  that host wrapper on EVERY click, so the feature would never fire in studio
   *  (the live failure mode this guard exists to avoid). `e.currentTarget` is the
   *  CanvasViewport: a real board member / connector svg is a DESCENDANT of it
   *  (`contains` → bail); the host wrapper CONTAINS it (`contains` false → empty,
   *  create the note). This is correct both embedded (wrapper present) and
   *  standalone (no wrapper). */
  const onStageDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (toolApiRef.current.activeToolId !== 'move') return;
      const viewport = e.currentTarget;
      const owned = (e.target as Element).closest?.('[data-node-ref], svg');
      if (owned && viewport.contains(owned)) return;
      placeTextAt(e.clientX, e.clientY);
    },
    [placeTextAt],
  );

  /** Center of the current viewport in world coordinates. */
  const viewportCenter = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect();
    return screenToWorld(
      (rect?.left ?? 0) + (rect?.width ?? 600) / 2,
      (rect?.top ?? 0) + (rect?.height ?? 400) / 2,
    );
  }, [screenToWorld]);

  /**
   * Fill the board with MANY produced items at once (a paste / source / remote
   * producer) through the REAL producer→group bridge: lay the drafts out in a
   * grid, build a ProducerOutput, and apply it. This is the live UI consumer of
   * `applyProducerOutput` — the same seam a remote producer uses.
   */
  const fillFromDrafts = useCallback(
    (drafts: readonly BoardItemDraft[]) => {
      if (drafts.length === 0) return;
      const c = viewportCenter();
      void commit(
        applyProducerOutput(
          graphRef.current,
          layoutDraftsToOutput(drafts, currentRefRef.current, c, () => newId('m'), () => itemRef(boardId, newId('item'))),
        ),
      );
    },
    [boardId, commit, viewportCenter],
  );
  // Ref so the window `paste` listener (a stable effect) can place N sticky drafts
  // from a text paste without re-subscribing on every render.
  const fillFromDraftsRef = useRef(fillFromDrafts);
  fillFromDraftsRef.current = fillFromDrafts;

  // Place a Markdown-import TREE (headings → drill-in sections, bullets → nested cards) through the SHIPPED
  // `materializeItems` deep-copy engine — the SAME primitive the template applier + board deep-copy use, so
  // section-nesting / id-minting / fail-closed depth guards are reused, ZERO new placement code (L093/L069).
  // This is the hierarchy-preserving inverse of the Markdown export; the flat paste path stays for
  // section-less docs.
  const placeMarkdownTree = useCallback(
    (items: readonly TemplateItem[]) => {
      if (items.length === 0) return;
      void commit(materializeItems(graphRef.current, boardId, currentRefRef.current, items, () => newId('md')));
    },
    [boardId, commit],
  );
  const placeMarkdownTreeRef = useRef(placeMarkdownTree);
  placeMarkdownTreeRef.current = placeMarkdownTree;

  // MULTI-FIELD action form on the board (item #15): a tool carrying `formFields`
  // opens the shared blind ActionForm to collect an answers bag before firing its
  // producer. `pendingAnswersRef` carries those answers into `addItem`'s producer
  // resolution; `affordanceForm` is the open form (null = closed).
  const [affordanceForm, setAffordanceForm] = useState<{ tool: ShelfEntry } | null>(null);
  const pendingAnswersRef = useRef<Record<string, unknown> | null>(null);
  // Members that JUST landed a producer text result — their notes stream the text in
  // on mount (item #9). A Set the poll fills and clears after the animation window.
  const [revealMemberIds, setRevealMemberIds] = useState<ReadonlySet<string>>(() => new Set());

  // Resolve a form field's options through the ONE shared descriptor resolver
  // (resolveAskFieldOptions) — the same grammar the composition surface uses:
  // options_source descriptors (kind / entries / titled pools), the legacy
  // options_address shorthand, and inline options. The near-duplicate by-kind
  // fold this replaces was the third copy of the logic (F7); the blind form
  // stays blind (L090/no-god-package).
  const boardOptionSourceRecords = useMemo<OptionSourceRecord[]>(() => {
    const rows: OptionSourceRecord[] = [];
    for (const row of Array.isArray(publishedRecordsRaw) ? publishedRecordsRaw : []) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      const address = typeof r.address === 'string' ? r.address : undefined;
      let payload: Record<string, unknown> | null = null;
      if (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) payload = r.payload as Record<string, unknown>;
      else if (typeof r.payload === 'string' && r.payload.trim().startsWith('{')) {
        try { const parsed = JSON.parse(r.payload); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed; } catch { /* not a record row */ }
      }
      if (!payload) continue;
      rows.push({ address, payload });
    }
    return rows;
  }, [publishedRecordsRaw]);
  const boardAffordanceFieldOptions = useCallback(
    (field: AskField): AskFieldOption[] => resolveAskFieldOptions(field, boardOptionSourceRecords),
    [boardOptionSourceRecords],
  );

  // Save the current form configuration as a reusable PRESET: curry the base
  // action's raw record with the filled answers into a new, more-specialized
  // action-affordance and publish it through the SAME live user-actions write path
  // (buildActionPresetWriteItem → writeActionAffordanceItemLive). The
  // published-records feed re-reads and the preset appears in the board's actions.
  const saveActionPreset = useCallback(async (baseRecord: unknown, answers: Record<string, unknown>, name: string) => {
    if (!baseRecord || typeof baseRecord !== 'object') {
      showNotice('This action cannot be saved as a preset.');
      return;
    }
    try {
      const item = buildActionPresetWriteItem(baseRecord as Record<string, unknown>, answers, {
        name,
        runId: newId('up'),
      });
      await writeActionAffordanceItemLive(item, partitionLabel);
      showNotice(`"${name}" is now in your actions.`);
    } catch {
      showNotice(`Could not save the preset "${name}".`);
    }
  }, [partitionLabel, showNotice]);

  // Remove (archive) a custom action from the popover: soft-delete through the
  // owning live write path (`is_active:false` at the record's OWN address — the
  // log keeps history; every surface re-reads and the action vanishes). Only rows
  // carrying a removalRef (a resolvable live write address) offer the control.
  // The confirmation carries "Undo" — the restore configuration of the SAME
  // liveness primitive (`is_active:true` at the same address) brings it back.
  // Both directions act on the FRESH record (freshRemovalRef), never a stale
  // render-time snapshot.
  const removeAction = useCallback(async (tool: ShelfEntry) => {
    if (!tool.removalRef) return;
    const ref = freshRemovalRef(tool.removalRef);
    try {
      await archiveActionAffordanceLive(ref, partitionLabel);
      showNotice(`"${tool.label}" was removed.`, 'info', {
        label: 'Undo',
        onAction: () => {
          // The archived record is INACTIVE, so it is absent from the live rows —
          // `ref` (the freshest pre-archive bytes) is exactly what restore rewrites.
          void setActionAffordanceActiveLive(ref, true, partitionLabel)
            .then(() => showNotice(`"${tool.label}" is back.`))
            .catch(() => showNotice(`Could not restore "${tool.label}".`, 'error'));
        },
      });
    } catch {
      showNotice(`Could not remove "${tool.label}".`, 'error');
    }
  }, [partitionLabel, showNotice, freshRemovalRef]);

  /**
   * Add an item via its shelf-declared strategy (item-add-strategies). The canvas
   * is blind: it runs ADD_STRATEGIES[tool.addStrategy] (empty / pick-a-file /
   * produce / paste-source / …) and places whatever comes back — ONE draft via
   * placeDraftAt, or MANY (a producer fill) via the producer→group bridge. New
   * produce-behavior = one strategy row + one shelf row; ZERO switch(kind).
   */
  // The "Live surface" tool offers whatever surfaces the app has PUBLISHED —
  // discovered from the shared placeable-surface catalog (the same one
  // screen-arrangement mounts), never a hardcoded product list. A new published
  // surface appears here automatically; picking one drops a live package surface as
  // a board node (its `extra.placeableSurface` seed → the blind PlaceableSurfaceHost).
  // Absent any published surface → the tool is simply not shown (honest empty).
  const liveSurfaceTools = useMemo<ShelfEntry[]>(() => {
    const variants = placeableSurfaceVariants(readPublishedRecords(publishedRecordsRaw));
    if (variants.length === 0) return [];
    return [{
      kind: 'note',
      label: 'Live surface',
      icon: AppWindow,
      addStrategy: 'empty',
      defaultExtra: variants[0].defaultExtra,
      defaultW: variants[0].defaultW,
      defaultH: variants[0].defaultH,
      variants,
    }];
  }, [publishedRecordsRaw]);
  const surfaceIntentCatalog = useMemo(
    () => placeableSurfaceCatalogForViewer(findPlaceableSurfaces(readPublishedRecords(publishedRecordsRaw)), viewerAccessRefs),
    [publishedRecordsRaw, viewerAccessRefs],
  );
  const placeIntentPayload = useCallback((payload: Parameters<typeof commitAddressedPlaceableSurface>[0]['payload'], deliveryRef?: string) => {
    // Both the reader and this owner boundary check the live catalog. The second
    // check prevents a revoked row from mutating a graph between render and emit.
    const center = viewportCenter();
    return commitAddressedPlaceableSurface({
      payload,
      catalog: surfaceIntentCatalog,
      deliveryRef,
      graph: graphRef.current,
      parentRef: currentRefRef.current,
      boardId,
      appearance: currentBoardAppearanceRef.current,
      centerX: center.x,
      centerY: center.y,
      newId,
      persist: (after, before) => commit(after, before, { undoable: false }),
    }).then((result) => result.accepted);
  }, [boardId, commit, surfaceIntentCatalog, viewportCenter]);

  const addItem = useCallback(
    async (tool: ShelfEntry, answers?: Record<string, unknown>) => {
      // A MULTI-FIELD action not yet filled → open the blind ActionForm first; its
      // submit re-enters addItem with the collected answers. (Back-compat: a tool with
      // no formFields runs the single-text produce path unchanged.)
      if (tool.formFields && tool.formFields.length > 0 && !answers) {
        setAffordanceForm({ tool });
        return;
      }
      // A status-less action-affordance is a direct Workflow action, not a
      // producer. It uses the SAME channel, form, selection, and binding
      // primitives, but correctly creates no fake pending board item.
      if (tool.directAffordance) {
        const requestId = newId('act');
        const { target, payload } = buildDispatchPayload(
          tool.directAffordance.affordance,
          tool.directAffordance.trigger.id,
          {
            run: { id: requestId },
            surface: { channel: tool.invokeChannel ?? BOARD_CHANNELS.shelf },
            typed: {
              text: selectedSubjectTextRef.current,
              items_text: idAnnotatedSubjectTextRef.current,
            },
            answers: answers ?? {},
            selection: ownerSelectionContext(currentRefRef.current, selectedIdsRef.current),
          },
        );
        try {
          await sendRequestToBitfieldTarget({ target, payload });
          showNotice(`"${tool.label}" started.`, 'info');
        } catch (error) {
          console.error('[group-board] direct action-affordance failed', error);
          showNotice(`Could not start "${tool.label}".`, 'error');
        }
        return;
      }
      // Fail-closed subject gate (L117): a ONE-CLICK action whose template binds the
      // board subject, on an EMPTY board, would fire a doomed run over nothing and
      // paint a fake "Working…" card. Say so honestly instead. Derived purely from
      // the tool's DATA (ask/form/template) + the live subject — no action is named.
      if (actionNeedsMissingSubject(tool, selectedSubjectTextRef.current)) {
        showNotice(`Add or select some cards first — "${tool.label}" works on the board's content`, 'info');
        return;
      }
      // The collected answers ride into the producer's input resolution via this ref
      // (read by submitProducer's invoke context) — so `{from:'answers'}` bindings in
      // the action's input_template compose the real prompt. Cleared in finally.
      pendingAnswersRef.current = answers ?? null;
      try {
        // The producer is DATA: a tool may carry its own, else the panel's wired
        // producer (from the composition mount) backs producer strategies. The board
        // never names the producer — it only forwards the descriptor.
        const toolForStrategy = { ...tool, producer: tool.producer ?? producer };
        const produced = await addStrategyFor(tool.addStrategy)({
          tool: toolForStrategy,
          pickFiles: pickBoardFiles,
          storeBytes: (bytes, ct) => storeBoardBytes(bytes, ct),
          // #215: decode an image's natural size so it places at its true aspect ratio.
          measureImage: measureImageNaturalSize,
          // Wall-clock injected so the strategy leaf stays pure — a fired producer
          // stamps a REAL dispatch time for the card's elapsed timer (never faked).
          now: () => Date.now(),
          // Fire ANY producer (DATA descriptor on the tool) generically — the panel
          // only supplies the requestId + target group; it never names the producer.
          // If the fire fails, degrade gracefully: return undefined so the strategy
          // places a plain item (never a stuck "pending" — board-owned, no
          // producer knowledge). The producer owns whether a result/error follows.
          submitProducer: async (desc, input) => {
            try {
              const resolvedDesc = onBuildProducerDescriptor
                ? (onBuildProducerDescriptor(desc.definitionId, input) ?? desc)
                : desc;
              const requestId = newId('gen');
              // If the action carries its raw template, resolve it against a live invoke
              // context whose SUBJECT (`typed.text`) is the selected cards' text — so the
              // action composes `instruction + selection` and ACTS ON THE SELECTION rather
              // than firing an empty prompt (the "nothing to translate" bug). Resolved
              // values (the composed instruction_text) win over the raw ask input.
              const tpl = desc.inputTemplate;
              const resolvedInput =
                tpl && typeof tpl === 'object'
                  ? (resolveBindingTemplate(tpl, {
                      run: { id: requestId },
                      // The REAL door this tool was derived from (palette / context-menu /
                      // shelf) — a channel-sensitive template must not be told "shelf"
                      // when invoked from ⌘K (Codex 2026-07-10, finding 4). Tools without
                      // a channel (built-ins) keep the shelf default.
                      surface: { channel: tool.invokeChannel ?? BOARD_CHANNELS.shelf },
                      // `typed.text` = the subject (Flavor A); `typed.items_text` = the
                      // same board as `[memberId] text` lines so a reconcile action can ask
                      // the agent to echo ids and edit cards in place (Flavor B). Opt-in per
                      // action template; unused bindings cost nothing.
                      typed: {
                        text: selectedSubjectTextRef.current,
                        items_text: idAnnotatedSubjectTextRef.current,
                      },
                      // Multi-field answers collected by the ActionForm — so an action's
                      // `{from:'answers'}` bindings compose the real prompt (empty for a
                      // single-text action, which composes from typed.text alone).
                      answers: pendingAnswersRef.current ?? {},
                      // The selection remains owner-local data: downstream owner
                      // targets receive the current board root plus member ids and
                      // must exact-read/materialize it themselves.  Member ids are
                      // deliberately not misrepresented as global Engine refs.
                      selection: ownerSelectionContext(currentRefRef.current, selectedIdsRef.current),
                    }) as Record<string, unknown>)
                  : {};
              const finalInput = { ...input, ...resolvedInput };
              const submission = await submitProducerRequest(resolvedDesc, {
                requestId,
                input: finalInput,
                targetGroupRef: groupKey(currentRefRef.current),
              });
              return { requestId: submission.requestId, submitted: true, statusAddresses: submission.statusAddresses };
            } catch {
              return undefined;
            }
          },
          // A multi-field action already collected its answers via the ActionForm; the
          // produce strategy's single-text ask is skipped (a non-empty placeholder that
          // the resolved input_template overrides).
          askText: (label) => {
            if (pendingAnswersRef.current) return Promise.resolve(tool.label ?? 'run');
            // Selection-subject content action + a live selection → the selection IS the
            // content, and its ask answer is DISCARDED by the resolved template anyway
            // (submitProducer sets typed.text = the selection). Skip the redundant prompt
            // and run directly on the selection — "translate the things I selected".
            const subject = selectedSubjectTextRef.current;
            if (typeof subject === 'string' && subject.trim().length > 0
              && templateBindsTypedText(tool.producer?.inputTemplate)) {
              return Promise.resolve(subject);
            }
            return askText(label);
          },
        });
        if (!produced) return;
        if (Array.isArray(produced)) {
          fillFromDrafts(produced);
          return;
        }
        const c = viewportCenter();
        // Center the new item on the viewport using its ACTUAL footprint (a draft's own w/h,
        // else the board's cascade default) — so a board that presets a larger default note
        // still lands centered, not offset. Zero-regression at 220×160 → the old -110/-80.
        const drawn = produced as BoardItemDraft;
        const size = boardDefaultItemSize(currentBoardAppearanceRef.current);
        const w = typeof drawn.w === 'number' ? drawn.w : size.w;
        const h = typeof drawn.h === 'number' ? drawn.h : size.h;
        placeDraftAt(drawn, c.x - w / 2, c.y - h / 2);
      } catch (error) {
        console.error('[group-board] add item failed', error);
      } finally {
        pendingAnswersRef.current = null;
      }
    },
    [placeDraftAt, fillFromDrafts, viewportCenter, producer, askText, onBuildProducerDescriptor, showNotice],
  );
  addItemRef.current = (tool) => { void addItem(tool); };

  /**
   * Route an imported text through the ONE registry (`routeImport`) and place the result at a world anchor —
   * the SHARED body of "a document arrived" for all three import channels: paste, file drop, and the Import
   * button (L063, one import path). A recognized doc lands as a tree (markdown sections), flat drafts (csv /
   * icalendar), or a graph fragment (mermaid, positioned + connectors); an unrecognized `.txt` falls back to
   * one-note-per-line. Returns true iff anything was placed (the caller advances its stacking offset).
   */
  const importTextAtWorld = useCallback((text: string, worldX: number, worldY: number): boolean => {
    const placement = routeImport(text);
    if (placement?.kind === 'tree') {
      placeMarkdownTreeRef.current(markdownTreeToTemplateItems(placement.nodes, worldX, worldY));
      return true;
    }
    if (placement?.kind === 'drafts') {
      fillFromDraftsRef.current(placement.drafts);
      return true;
    }
    if (placement?.kind === 'items') {
      return placeBoardItemsAtRef.current(placement.items, worldX, worldY);
    }
    const noteDrafts = textToNoteDrafts(text); // plain text with no recognized structure → one note per line
    if (noteDrafts.length > 0) {
      fillFromDraftsRef.current(noteDrafts);
      return true;
    }
    return false;
  }, []);
  const importTextAtWorldRef = useRef(importTextAtWorld);
  importTextAtWorldRef.current = importTextAtWorld;

  /**
   * Open the sanctioned OS file picker (filtered to the registry's extensions — the SSOT
   * `IMPORT_TEXT_EXTENSIONS`, never a hardcoded list) and import each chosen file's text through the shared
   * `importTextAtWorld` path, landing at the viewport centre. The discoverable partner of drop/paste — the
   * user who has a `.md`/`.csv`/`.mmd`/`.ics` file but doesn't think to drag it still gets it in.
   */
  const importFromFile = useCallback(async () => {
    const chosen = await chooseLocalFiles({ prompt: 'Import a document', multiple: true, includeBytes: true, allowedExtensions: [...IMPORT_TEXT_EXTENSIONS] });
    const center = viewportCenterRef.current();
    let offset = 0;
    for (const file of chosen) {
      if (!file.bytes || file.bytes.byteLength === 0) continue;
      const text = new TextDecoder().decode(file.bytes);
      if (text.length > 0 && importTextAtWorldRef.current(text, center.x + offset, center.y + offset)) offset += 24;
    }
  }, []);
  const importFromFileRef = useRef(importFromFile);
  importFromFileRef.current = importFromFile;

  /**
   * Files dragged from Finder onto the canvas → stored content-addressed → placed
   * at the drop point. All media land as kind `media` (the renderer dispatches by
   * contentType), so there is no content-type→kind branch here.
   */
  const dropFilesAt = useCallback(
    async (files: readonly File[], clientX: number, clientY: number) => {
      const origin = screenToWorld(clientX, clientY);
      let offset = 0;
      for (const file of files) {
        try {
          // A dropped TEXT-DOCUMENT file (a registered import extension via `isImportableTextFile` — the
          // registry SSOT, not a second hardcoded list — or a text/* mime) is STRUCTURED content, not a media
          // blob → route it through the SHARED import path (`importTextAtWorld`, the same body the Import
          // button and paste use). A genuine image keeps the media path below.
          const isTextDoc = isImportableTextFile(file.name) || file.type.startsWith('text/');
          if (isTextDoc) {
            const text = await file.text();
            if (importTextAtWorldRef.current(text, origin.x + offset, origin.y + offset)) offset += 24;
            continue; // handled as text (or empty) — never store a text doc as a media blob
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.byteLength === 0) continue;
          const src = await storeBoardBytes(bytes, file.type, file.name);
          // #215: a dropped/pasted image sizes to its true aspect ratio (the File is a
          // Blob → measure directly). Non-images / decode failure → default footprint.
          const dims = await measureImageNaturalSize(file, file.type);
          const footprint = dims ? imageFootprint(dims.w, dims.h) : null;
          placeDraftAt(
            {
              kind: 'media',
              src,
              contentType: file.type,
              text: file.name,
              ...(footprint ? { w: footprint.w, h: footprint.h } : {}),
            },
            origin.x - 110 + offset,
            origin.y - 80 + offset,
          );
          offset += 24;
        } catch (error) {
          console.error('[group-board] drop failed', error);
        }
      }
    },
    [placeDraftAt, screenToWorld],
  );
  const dropFilesAtRef = useRef(dropFilesAt);
  dropFilesAtRef.current = dropFilesAt;
  const pasteClipboardRef = useRef(pasteClipboard);
  pasteClipboardRef.current = pasteClipboard;
  const importCapsuleRef = useRef(importCapsule);
  importCapsuleRef.current = importCapsule;
  const placeBoardItemsAtRef = useRef(placeBoardItemsAt);
  placeBoardItemsAtRef.current = placeBoardItemsAt;
  const placeDraftAtRef = useRef(placeDraftAt);
  placeDraftAtRef.current = placeDraftAt;
  const viewportCenterRef = useRef(viewportCenter);
  viewportCenterRef.current = viewportCenter;

  /** Fire the link-enrichment producer (DATA descriptor from the mount) for a freshly
   *  pasted link card: dispatch `action:enrich-link-preview` with the card's OWN
   *  memberId + href, then stamp the card `status:'pending'` + the producer's status
   *  addresses so the #208 identity poller watches it and merges the OG result in
   *  place. Producer-blind: the board forwards the opaque descriptor and never names
   *  the def. Degrades gracefully — no producer wired, or a submit failure, leaves the
   *  card a plain favicon+domain link (never a stuck spinner: `pending` is only written
   *  on a successful submit). */
  const fireLinkEnrich = useCallback(
    async (memberId: string, href: string) => {
      if (!linkEnrichProducer) return;
      try {
        const requestId = newId('enrich');
        const resultAddress = linkEnrichProducer.resultAddressTemplate.split('{id}').join(requestId);
        const submission = await submitProducerRequest(linkEnrichProducer, {
          requestId,
          input: { href, member_id: memberId, result_address: resultAddress },
          targetGroupRef: groupKey(currentRefRef.current),
        });
        await commit(
          patchItem(graphRef.current, currentRefRef.current, memberId, {
            statusAddresses: submission.statusAddresses,
            status: 'pending',
            started_at: Date.now(),
          }),
          graphRef.current,
          { undoable: false },
        );
      } catch {
        // Blind + fail-open: the card stays a usable plain link (manual "Edit card" still works).
      }
    },
    [linkEnrichProducer, commit],
  );
  const fireLinkEnrichRef = useRef(fireLinkEnrich);
  fireLinkEnrichRef.current = fireLinkEnrich;

  /** THE SINGLE PASTE AUTHORITY (⌘V / Ctrl+V) — one event, one precedence, no
   *  double-fire. The board has TWO clipboards: the OS clipboard (external images,
   *  reachable ONLY via the native `paste` ClipboardEvent — a keydown cannot read
   *  clipboard file bytes) and the INTERNAL board clipboard (members copied with
   *  ⌘C, a JS session singleton). A real ⌘V on the board fires this `paste` event
   *  (verified: target=BODY on non-editable focus), so BOTH paste paths live here
   *  with an explicit precedence — an external image WINS over internal members:
   *    1. editable focus  → return (native text paste into a note is sacred)
   *    2. OS image present → drop it at the viewport centre (2nd caller of the
   *       `dropFilesAt` drag-drop primitive — storeBoardBytes → media draft)
   *    3. else internal clipboard present → paste the copied members at the cursor
   *  The ⌘V *keydown* branch was DELETED (L030): two paste handlers on one gesture
   *  double-fired (members + image) whenever both clipboards held content. With one
   *  authority that is structurally impossible (L063). Miro/FigJam/Mural canon. */
  useEffect(() => {
    // The copied selection also goes on the system clipboard under the board's own type beside its words
    // (board-clipboard.ts writeBoardClipboard), so it pastes in another tab or window, not only in this session.
    const onCopy = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (!e.clipboardData || selectedIdsRef.current.size === 0) return;
      const clip = getBoardClipboard();
      if (!clip) return;
      e.preventDefault();
      writeBoardClipboard(e.clipboardData, clip);
    };
    const onPaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const dt = e.clipboardData;
      // A board bundle another tab or window copied wins over everything else on this paste: it is this session's
      // clipboard from now on, pasted through the same clone pipeline (clipboardToDrafts budgets and sanitizes it).
      const carried = dt ? readBoardClipboard(dt) : null;
      if (carried) {
        e.preventDefault();
        setBoardClipboard(carried);
        pasteClipboardRef.current();
        return;
      }
      const files: File[] = [];
      if (dt) {
        for (const item of Array.from(dt.items)) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const f = item.getAsFile();
            if (f) files.push(f);
          }
        }
        // Some browsers expose images only via `.files` (no `.items` file entries).
        for (const f of Array.from(dt.files)) {
          if (f.type.startsWith('image/') && !files.some((g) => g.name === f.name && g.size === f.size)) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        const rect = stageRef.current?.getBoundingClientRect();
        const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
        const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
        void dropFilesAtRef.current(files, cx, cy);
        return;
      }
      // A pasted LONE URL → a link card at the viewport centre (Milanote/Bento canon).
      // Precedence: external images first (above), then a bare URL, then internal
      // members. `isSingleUrl` rejects note-text-with-a-link so normal text paste is
      // unaffected. The link kind is DATA; ITEM_RENDERERS['link'] renders the card and
      // (once enriched) reads extra.linkPreview — the panel stays blind (L090).
      const pastedText = dt?.getData('text/plain') ?? '';
      // A pasted SHARE LINK → import its capsule's items onto THIS board (the receive side of
      // "Copy link"). A capsule link IS a URL, so this MUST precede the link-card branch —
      // else the share link would become a link card instead of importing. Guarded by
      // !getBoardClipboard() so a ⌘C of internal members still pastes those members.
      if (!getBoardClipboard() && hasCapsuleLink(pastedText)) {
        e.preventDefault();
        importCapsuleRef.current(pastedText);
        return;
      }
      if (isSingleUrl(pastedText) && !getBoardClipboard()) {
        e.preventDefault();
        const c = viewportCenterRef.current();
        const href = pastedText.trim();
        const id = placeDraftAtRef.current(linkCardDraft(href), c.x, c.y);
        // Select the pasted card (Figma/Miro canon — you act on what you just pasted),
        // so its "Edit card" control is immediately reachable, like placeTextAt selects
        // a new note.
        setSelectedIds(new Set([id]));
        // AUTO-ENRICH (Milanote/Bento canon): fire the enrichment producer so the card's
        // bare-domain title flips to the real page title + og:image once the fetch lands.
        // Blind + fail-open — a no-op if no enrich producer is wired.
        void fireLinkEnrichRef.current(id, href);
        return;
      }
      // A pasted STRUCTURED document (Markdown or CSV) → STRUCTURED content, the round-trip partner of the
      // board exports. `routeImport` (the ONE import router shared with file drop, L063) recognizes the format
      // via the blind `DOCUMENT_IMPORTS` registry and returns a placement: a `tree` with SECTIONS (`##`
      // markdown headings) is placed hierarchically via the shipped `materializeItems` engine (drill-in
      // sections); `drafts` (a section-less tree, or CSV's flat cards) drop through the shared `fillFromDrafts`
      // grid. Adding an import format is one registry row, ZERO change here (L069/L090). This PRECEDES the
      // plain one-note-per-line branch; every recognizer is conservative (a plain paste matches none).
      if (!getBoardClipboard()) {
        const placement = routeImport(pastedText);
        if (placement?.kind === 'tree') {
          e.preventDefault();
          const center = viewportCenterRef.current();
          placeMarkdownTreeRef.current(markdownTreeToTemplateItems(placement.nodes, center.x, center.y));
          return;
        }
        if (placement?.kind === 'drafts') {
          e.preventDefault();
          fillFromDraftsRef.current(placement.drafts);
          return;
        }
        if (placement?.kind === 'items') {
          // A GRAPH-bearing document (a Mermaid flowchart, b135) parses to positioned node cards + connector
          // items — placed via the shared clone pipeline so the diagram lands at the viewport center with fresh
          // ids + re-anchored connectors. Just another placement kind through the ONE router (no bespoke branch).
          e.preventDefault();
          const center = viewportCenterRef.current();
          placeBoardItemsAtRef.current(placement.items, center.x, center.y);
          return;
        }
      }
      // Plain multi-line (or single-line) text with NO internal member clipboard →
      // one sticky note per line, laid out in a tidy grid (Miro/FigJam "bulk create":
      // paste a brain-dump list → a note each). Guarded by `!getBoardClipboard()` so a
      // ⌘C of board MEMBERS still pastes those members (they take precedence). Reuses
      // the SAME `fillFromDrafts` multi-place primitive the producer fill uses — one
      // commit, one undo, the sqrt-grid layout (L093). Empty text → [] → falls through.
      const noteDrafts = textToNoteDrafts(pastedText);
      if (noteDrafts.length > 0 && !getBoardClipboard()) {
        e.preventDefault();
        fillFromDraftsRef.current(noteDrafts);
        return;
      }
      // No external image / URL / text → fall back to the internal board clipboard.
      if (getBoardClipboard()) {
        e.preventDefault();
        pasteClipboardRef.current();
      }
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('copy', onCopy);
    return () => { window.removeEventListener('paste', onPaste); window.removeEventListener('copy', onCopy); };
  }, []);

  // ── Item drag + resize (world-space deltas account for zoom) ──
  const dragRef = useRef<{
    memberId: string;
    grabDX: number;
    grabDY: number;
    moved: boolean;
    startWorldX: number;
    startWorldY: number;
    /** Every member moving with this drag + its start position and size. One entry
     *  for a plain drag; the whole (unlocked) selection for a group move. Size is
     *  carried so the snap pass can union the moving bounding box. */
    group: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>;
  } | null>(null);
  const resizeRef = useRef<{ memberId: string; edge: ResizeEdge; startX: number; startY: number; startW: number; startH: number; grabX: number; grabY: number; rotation: number; resized: boolean } | null>(null);
  // Free rotation: dragging the rotate grip above a single selected item. `center`
  // is the item's world center (rotation pivot); `startAngle` is the pointer angle
  // about the center at grab; `startRotation` is the item's rotation at grab. Mirrors
  // resizeRef — set on grip press, read in the stage move/up handlers.
  const rotateRef = useRef<{ memberId: string; center: { x: number; y: number }; startAngle: number; startRotation: number; rotated: boolean } | null>(null);
  // Group-resize: scaling the WHOLE selection from a bounding-box handle (≥2 items).
  const groupResizeRef = useRef<{
    handle: GroupResizeHandle;
    anchor: { x: number; y: number };
    bounds: GroupRect;
    members: Array<{ id: string; x: number; y: number; w: number; h: number }>;
    grabX: number;
    grabY: number;
    resized: boolean;
  } | null>(null);
  // Group rotation: spinning the WHOLE selection (≥2 items) about the selection's
  // centre. Each snapshot item's centre ORBITS the pivot and the item also spins on
  // its own axis by the same delta. Mirrors groupResizeRef — set on grip press, read
  // in the stage move/up handlers.
  const groupRotateRef = useRef<{
    pivot: { x: number; y: number };
    startAngle: number;
    items: Array<{ id: string; cx: number; cy: number; w: number; h: number; rotation: number }>;
    rotated: boolean;
  } | null>(null);
  // Image crop: dragging a CropOverlay handle. `startCrop` is the crop window at grab;
  // pointer deltas are normalized by the item's on-board size into 0..1 source space and
  // fed to `resizeCrop`. Committed on pointer-up (one undoable step). Mirrors resizeRef.
  const cropDragRef = useRef<{
    memberId: string;
    edge: ResizeEdge;
    startCrop: Crop;
    itemW: number;
    itemH: number;
    grabX: number;
    grabY: number;
    cropped: boolean;
  } | null>(null);
  // The committed graph snapshotted at a gesture's START — the correct `before` to
  // diff against at commit, since the optimistic preview overwrites the live graph.
  const gestureBeforeRef = useRef<GroupGraph | null>(null);
  const lastPointerRef = useRef({ x: 0, y: 0 });

  // ── Empty-canvas context menu (#140) — right-click bare canvas → a menu of
  //    canvas-level actions at the cursor. Reuses the SAME generic context-menu
  //    primitive as the item menu (useNodeContextMenu): we open it imperatively for
  //    a synthetic BOARD-ROOT NodeRef, and a canvas-action pack supplies actions
  //    that `accept` that root family. Each action composes an existing primitive
  //    (pasteClipboard / placeTextAt / select-all) — zero new behaviour, zero new
  //    menu UI. `accepts` gating (clipboard non-empty, board non-empty) keeps dead
  //    rows out of the menu. The right-click point is held in canvasMenuPointRef.
  const canvasMenuPointRef = useRef({ x: 0, y: 0 });
  // #185 — Import outline → mind-map (the inverse of #184). Read an indented outline from
  // the system clipboard, plan a tidy tree via the pure `planOutlineMindMap`, and mint one
  // note per line + one connector per parent→child edge in ONE undoable commit, anchored at
  // the right-click point. Round-trips #184's exact Markdown. The panel owns the minting
  // (like connectSelected); the plan is pure.
  const importOutlineFromClipboard = useCallback(
    async (clientX: number, clientY: number) => {
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        showNotice('Clipboard unavailable', 'error');
        return;
      }
      const plan = planOutlineMindMap(text);
      if (plan.nodes.length === 0) {
        showNotice('No outline on the clipboard', 'info');
        return;
      }
      const origin = screenToWorld(clientX, clientY);
      const cur = currentRefRef.current;
      const before = graphRef.current;
      // Mint node ids up front so the edges (below) can reference them by index. TWO batch placements
      // (O(M+K) each) instead of folding placeItem per node + per edge — a large outline was O(N^2).
      const memberIds = plan.nodes.map(() => newId('i'));
      let next = placeItems(
        before,
        cur,
        plan.nodes.map((n, idx) => ({
          memberId: memberIds[idx],
          nodeRef: itemRef(boardId, newId('i')),
          kind: 'note',
          x: Math.round(origin.x + n.x),
          y: Math.round(origin.y + n.y),
          w: 200,
          h: 90,
          text: n.text,
          extra: {},
        })),
      );
      next = placeItems(
        next,
        cur,
        plan.edges.map((e) => ({
          memberId: newId('c'),
          nodeRef: itemRef(boardId, newId('i')),
          kind: 'connector',
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          extra: { fromMemberId: memberIds[e.from], toMemberId: memberIds[e.to] },
        })),
      );
      if (next === before) return;
      void commit(next, before);
      setSelectedIds(new Set(memberIds));
      showNotice(`Imported ${plan.nodes.length} nodes`, 'success');
    },
    [boardId, commit, screenToWorld, showNotice],
  );
  const canvasMenuPack = useMemo<NodeActionPack>(() => {
    const isRoot = (ref: { family: string }) => ref.family === BOARD_ROOT_FAMILY;
    const nonConnectorIds = () =>
      readItems(graphRef.current, currentRefRef.current).filter((i) => !itemIsConnector(i)).map((i) => i.memberId);
    return [
      {
        id: 'canvas.paste',
        label: 'Paste here',
        icon: 'Clipboard',
        priority: 0,
        accepts: (ref) => isRoot(ref) && !!getBoardClipboard(),
        run: () => {
          lastPointerRef.current = { ...canvasMenuPointRef.current };
          pasteClipboard();
        },
      },
      {
        id: 'canvas.add-note',
        label: 'Add note',
        icon: 'Type',
        priority: 1,
        accepts: isRoot,
        run: () => {
          const p = canvasMenuPointRef.current;
          placeTextAt(p.x, p.y);
        },
      },
      {
        id: 'canvas.select-all',
        label: 'Select all',
        icon: 'BoxSelect',
        priority: 2,
        accepts: (ref) => isRoot(ref) && nonConnectorIds().length > 0,
        run: () => setSelectedIds(new Set(nonConnectorIds())),
      },
      {
        // #185 — paste an indented outline from the clipboard as a tidy mind-map at the
        // cursor (inverse of the #184 Copy-as-outline row). Always offered on bare canvas;
        // an empty/non-outline clipboard just shows a Notice rather than gating the row
        // (clipboard reads are async, so we can't cheaply gate on content here).
        id: 'canvas.import-outline',
        label: 'Paste outline as mind map',
        icon: 'ListTree',
        priority: 3,
        accepts: isRoot,
        run: () => {
          const p = canvasMenuPointRef.current;
          void importOutlineFromClipboard(p.x, p.y);
        },
      },
      {
        // #189 — copy the WHOLE board's mind-map(s) as a Markdown outline, no selection
        // needed (the read-symmetry of #185's paste-outline). Reuses the #184 copyOutline
        // over every non-connector node; gated on the board actually having connectors so a
        // plain sticky wall (no tree) never offers a meaningless "outline" (L118).
        id: 'canvas.copy-outline',
        label: 'Copy board as outline',
        icon: 'ListTree',
        priority: 4,
        accepts: (ref) =>
          isRoot(ref) && readItems(graphRef.current, currentRefRef.current).some(itemIsConnector),
        run: () => copyOutline(nonConnectorIds()),
      },
      {
        // #191 — fold EVERY mind-map branch to its roots in one click (MindNode/XMind "fold
        // all"). Board-wide sibling of the #162 collapse-branch row; shown only when a real
        // mind-map exists AND some non-root is still visible to fold (L118).
        id: 'canvas.fold-all',
        label: 'Fold all branches',
        icon: 'ChevronsDownUp',
        priority: 5,
        accepts: (ref) => {
          if (!isRoot(ref)) return false;
          const live = readItems(graphRef.current, currentRefRef.current);
          const hidden = new Set(live.filter((it) => it.extra?.hidden === true).map((it) => it.memberId));
          return mindMapNonRootIds(live).some((id) => !hidden.has(id));
        },
        run: () => foldAllBranches(),
      },
      {
        // #191 — unfold everything (the bulk inverse); reuses #150's Show-all. Shown only
        // when at least one item is currently hidden.
        id: 'canvas.unfold-all',
        label: 'Unfold all branches',
        icon: 'ChevronsUpDown',
        priority: 6,
        accepts: (ref) =>
          isRoot(ref) && readItems(graphRef.current, currentRefRef.current).some((it) => it.extra?.hidden === true),
        run: () => showAllItems(),
      },
      // DATA-composed rows: published action-affordance records whose context-menu
      // trigger declares the 'board' placement land here — a new bare-canvas menu
      // row = ONE published record, zero code edits (same composition, same one
      // run path the selection menu uses; L069/L090).
      ...boardAffordanceContextActions(affordanceRows, runAffordanceTool, {}, BOARD_MENU_PLACEMENTS.board),
    ];
  }, [pasteClipboard, placeTextAt, importOutlineFromClipboard, copyOutline, foldAllBranches, showAllItems, affordanceRows, runAffordanceTool]);
  const canvasMenu = useNodeContextMenu(canvasMenuPack);

  // Connector creation (Connector tool): press an item, drag onto another → relate
  // them. Mirrors dragRef — set on press, read in stage move/up. The live dashed
  // preview is state (it re-renders the edge layer); the source is a ref.
  const connectorDragRef = useRef<{ fromMemberId: string; fromCenter: { x: number; y: number } } | null>(null);
  const [connectorPreview, setConnectorPreview] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  // Alignment guides shown live while dragging — the snap primitive's output. Empty
  // when not dragging (cleared on drag start + pointer-up); a blind render overlay.
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  // Connector RE-ANCHOR: dragging one endpoint handle of a SELECTED connector to
  // rewire that end. `fixedCenter` = the OTHER endpoint's item center (the preview's
  // anchor); `otherId` = that item, excluded as a drop target. Mirrors connectorDragRef.
  const connectorAnchorRef = useRef<{ memberId: string; which: 'from' | 'to'; fixedCenter: { x: number; y: number }; otherId: string } | null>(null);
  // A bend-point drag in flight (#194/#195): which connector + which waypoint index.
  // `before` snapshots the pre-drag graph so the whole drag commits as ONE undo step.
  const waypointDragRef = useRef<{ memberId: string; index: number; before: GroupGraph } | null>(null);

  /** Begin re-anchoring one endpoint of a selected connector. Looks up the connector
   *  member + its FIXED (other) endpoint's item center, then drives the same dashed
   *  preview + itemUnder release path as connector creation — re-anchor is the SAME
   *  edge-endpoint primitive seeded from an existing edge instead of a source item. */
  const onConnectorEndpointDown = useCallback(
    (memberId: string, which: 'from' | 'to', clientX: number, clientY: number) => {
      const conn = readItems(graphRef.current, currentRefRef.current).find((i) => i.memberId === memberId);
      if (!conn) return;
      const otherId = String(which === 'from' ? conn.extra?.toMemberId : conn.extra?.fromMemberId);
      const other = readItems(graphRef.current, currentRefRef.current).find((i) => i.memberId === otherId);
      if (!other) return;
      const fixedCenter = { x: other.x + other.w / 2, y: other.y + other.h / 2 };
      connectorAnchorRef.current = { memberId, which, fixedCenter, otherId };
      setEditingId(null);
      const world = screenToWorld(clientX, clientY);
      setConnectorPreview({ from: fixedCenter, to: world });
      setGrabbing(true);
    },
    [screenToWorld],
  );

  /** Name a relationship: double-click a connector → the board's in-app text input
   *  (askText, works in every shell) pre-filled with the current label → Save writes
   *  `extra.label` via the generic patchItem. Empty string clears it. */
  const onConnectorLabelEdit = useCallback(
    async (memberId: string) => {
      const conn = readItems(graphRef.current, currentRefRef.current).find((i) => i.memberId === memberId);
      if (!conn) return;
      const current = typeof conn.extra?.label === 'string' ? conn.extra.label : '';
      const value = await askText('Name this connection', current, 'Save');
      if (value === null) return;
      void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { label: value }));
    },
    [askText, commit],
  );

  /** Begin dragging a bend point of a waypointed connector (#194/#195). Snapshots the
   *  pre-drag graph so the whole reposition commits as ONE undo step; the stage
   *  pointer-move updates `extra.waypoints[index]` optimistically, pointer-up commits. */
  const onConnectorWaypointDown = useCallback(
    (memberId: string, index: number, _clientX: number, _clientY: number) => {
      waypointDragRef.current = { memberId, index, before: graphRef.current };
      setEditingId(null);
      setGrabbing(true);
    },
    [],
  );

  /** Delete a bend point (double-click its handle, #194/#195). One undoable step via
   *  the generic patchItem — the line reflows through the remaining bends. */
  const onConnectorWaypointRemove = useCallback(
    (memberId: string, index: number) => {
      const conn = readItems(graphRef.current, currentRefRef.current).find((i) => i.memberId === memberId);
      if (!conn) return;
      const next = removeWaypoint(readWaypoints(conn.extra?.waypoints), index);
      void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { waypoints: next }));
    },
    [commit],
  );

  /** Insert a bend at the connector's current midpoint, nudged perpendicular so it is
   *  immediately visible and grabbable, and switch routing to 'waypoints' (#195 format
   *  bar "Add bend"). Reads the two endpoint rects to compute the live geometry. */
  const onConnectorAddBend = useCallback(
    (memberId: string) => {
      const conn = readItems(graphRef.current, currentRefRef.current).find((i) => i.memberId === memberId);
      if (!conn) return;
      const e = connectorEndpoints(conn);
      if (!e) return;
      const a = nodeRects.get(e.from);
      const b = nodeRects.get(e.to);
      if (!a || !b) return;
      const wps = readWaypoints(conn.extra?.waypoints);
      const previewRouting = typeof conn.extra?.routing === 'string' ? conn.extra.routing : 'straight';
      // 'avoid' routing needs the other node boxes so the seeded bend lands on the actual dodged path.
      const previewObstacles =
        previewRouting === 'avoid'
          ? [...nodeRects].filter(([id]) => id !== e.from && id !== e.to).map(([, r]) => r)
          : undefined;
      const geo = connectorPath(
        previewRouting,
        a,
        b,
        readConnectorAnchor(conn.extra?.fromAnchor),
        readConnectorAnchor(conn.extra?.toAnchor),
        wps,
        undefined,
        previewObstacles,
      );
      // Nudge the new bend perpendicular to the chord so it is not colinear (invisible).
      const dx = geo.p2.x - geo.p1.x;
      const dy = geo.p2.y - geo.p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const off = 36;
      const bend = { x: geo.mid.x + (-dy / len) * off, y: geo.mid.y + (dx / len) * off };
      const next = insertBendAt(geo.p1, wps, geo.p2, bend);
      void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { routing: 'waypoints', waypoints: next }));
    },
    [commit, nodeRects],
  );

  /** Clear every bend and restore a straight line (#195 format bar "Clear bends"). */
  const onConnectorClearBends = useCallback(
    (memberId: string) => {
      void commit(patchItem(graphRef.current, currentRefRef.current, memberId, { routing: 'straight', waypoints: [] }));
    },
    [commit],
  );

  /** The topmost NON-connector item whose world rect contains (worldX,worldY),
   *  excluding `excludeId` — the connect target under the cursor. Reverse order so
   *  the last-painted (top) item wins, matching what the user sees. */
  const itemUnder = useCallback((worldX: number, worldY: number, excludeId: string): BoardItem | null => {
    const siblings = readItems(graphRef.current, currentRefRef.current);
    for (let i = siblings.length - 1; i >= 0; i--) {
      const s = siblings[i];
      if (s.memberId === excludeId) continue;
      if (itemIsConnector(s)) continue; // skip edges (canonical shape predicate)
      if (worldX >= s.x && worldX <= s.x + s.w && worldY >= s.y && worldY <= s.y + s.h) return s;
    }
    return null;
  }, []);

  /** The section (if any) whose world rect contains (worldX,worldY), excluding the
   *  dragged member — the drop target for "drag an item into a folder". */
  const sectionUnder = useCallback((worldX: number, worldY: number, excludeId: string): BoardItem | null => {
    const siblings = readItems(graphRef.current, currentRefRef.current);
    return (
      siblings.find(
        (s) => s.isSection && s.memberId !== excludeId && worldX >= s.x && worldX <= s.x + s.w && worldY >= s.y && worldY <= s.y + s.h,
      ) ?? null
    );
  }, []);

  // ── Inspection (lane E): alt-click ANY item → the generic InspectorSidebar over
  // the item's inspection sources. WHICH fields exist per family is DATA — the
  // inspection-field-descriptor-set published records (Generic Gate: new field
  // = one DATA row, zero code here). A surface mounted inside an item resolves
  // through its own stamps first (nearest-first — the ui primitive owns the walk).
  const [inspectSources, setInspectSources] = useState<readonly InspectionSource[] | null>(null);
  const inspectionRegistry = useMemo(
    () =>
      createBoardInspectionRegistry(
        (memberId) => itemsRef.current.find((i) => i.memberId === memberId) ?? null,
        readInspectionFieldSets(readPublishedRecords(publishedRecordsRaw)),
      ),
    [publishedRecordsRaw],
  );
  // §9.2 — WHICH live facet lenses the arrangement library offers is DATA (the
  // `arrangement-lens-catalog` published record in group's `things`), never hardcoded
  // (SSOT / Physics-vs-Society). Read here, threaded into readSavedArrangementLibrary.
  const arrangementLensCatalog = useMemo(
    () => readArrangementLensCatalog(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  // R3/P2 — the EFFECTIVE marker catalog: built-in markers + user-defined DATA rows
  // (marker-catalog published-records), so "which bullets exist" is DATA (SSOT, mirrors the
  // arrangement-lens catalog). Threaded into every note renderer + the outline marker picker.
  const markerCatalog = useMemo(
    () => readMarkerCatalog(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  // R2/P1 — the EFFECTIVE background catalog: built-in surfaces + user-defined DATA rows
  // (background-catalog published-records), via the SAME generic mergeCatalog primitive as
  // markers. So "which board surfaces exist" is DATA (L069/L063 — one primitive, N catalogs).
  const backgroundCatalog = useMemo(
    () => readBackgroundCatalog(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  // The active board's surface look (a catalog id on its index member) → the blind CanvasSurface
  // DATA, resolved against the effective (DATA-extensible) catalog. Unset/unknown → dots default.
  const currentBackground = useMemo(
    () => backgroundById(currentBoardEntry?.background, backgroundCatalog),
    [currentBoardEntry?.background, backgroundCatalog],
  );
  // R2/P1 — the EFFECTIVE appearance-preset catalog (built-in looks + DATA presets), via the
  // SAME mergeCatalog primitive — a THIRD catalog on one primitive (markers, backgrounds, this).
  const appearancePresetCatalog = useMemo(
    () => readAppearancePresetCatalog(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  // Saved FOCUS VIEWS for the CURRENT board (named filter selections) — a FIFTH catalog on the
  // SAME mergeCatalog primitive, scoped to this board (no cross-board leak) + tombstones dropped.
  const savedFocusViews = useMemo(
    () => readFocusViews(readPublishedRecords(publishedRecordsRaw), currentBoardId),
    [publishedRecordsRaw, currentBoardId],
  );
  // Save the CURRENT focus (facets + search) as a named, board-scoped view — mirrors saveCurrentLook
  // (live write-batch via write-focus-view-live; the record streams back through published-records so
  // the view appears in the Views cluster with zero redeploy).
  const saveFocusView = useCallback(async () => {
    if (!hasActiveFacets(focusFacets) && searchQuery.trim() === '') {
      showNotice('Set a focus (pick a tag/color/type or search) first, then save it.', 'info');
      return;
    }
    const name = await askText('Save this view as', 'My view', 'Save');
    if (name === null) return;
    const view = makeFocusView(newId('view'), name.trim() || 'My view', currentBoardIdRef.current, focusFacets, searchQuery);
    try {
      await writeFocusViewLive(view, partitionLabel);
      showNotice(`"${view.name}" saved as a view.`, 'success');
    } catch (error) {
      console.error('[group] save focus view failed:', error);
      showNotice('This view could not be saved.', 'error');
    }
  }, [askText, partitionLabel, showNotice, focusFacets, searchQuery]);
  // Apply a saved view — sanitize its facet keys against the board's LIVE facets first (an unknown
  // selected facet fails closed in matchesFacets and would hide every item; Codex guard).
  const applyFocusView = useCallback((view: FocusView) => {
    const clean = sanitizeFocusView(view, Object.keys(BOARD_ITEM_FACETS));
    setFocusFacets(clean.facets);
    setSearchQuery(clean.query ?? '');
  }, []);
  // Delete a saved view — rewrite its OWN address with an active:false tombstone (readFocusViews
  // drops it); mergeCatalog cannot remove, so deletion is a tombstone, not an absent row.
  const deleteFocusView = useCallback(async (view: FocusView) => {
    try {
      await writeFocusViewLive(archiveFocusView(view), partitionLabel);
      showNotice(`"${view.name}" deleted.`, 'info');
    } catch (error) {
      console.error('[group] delete focus view failed:', error);
      showNotice('Could not delete the view.', 'error');
    }
  }, [partitionLabel, showNotice]);
  // R3/#204 — the EFFECTIVE stamp catalog (built-in emoji stamps + DATA rows) via the SAME
  // mergeCatalog primitive; the add-item toolbar's Stamp flyout is built from it, so a
  // user-defined stamp appears in the shelf. A FOURTH catalog on one primitive.
  const stampCatalog = useMemo(
    () => readStampCatalog(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  // R26-R28: shapes + note colours join stamps on the SAME mergeCatalog primitive —
  // the shelf's Shape/Note flyouts now surface user-defined published-record rows too.
  const shapeCatalog = useMemo(
    () => readShapeCatalog(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  const fillSwatchCatalog = useMemo(
    () => readFillSwatchCatalog(readPublishedRecords(publishedRecordsRaw)),
    [publishedRecordsRaw],
  );
  const itemShelf = useMemo(
    () => buildItemShelf(stampCatalog, shapeCatalog, fillSwatchCatalog),
    [stampCatalog, shapeCatalog, fillSwatchCatalog],
  );
  /** Serve `board-item::<id>` reads from the live graph; fill derived via the
   *  SAME itemFillColor the quick-color chip reads (SSOT). */
  openDetailsRef.current = (memberId: string) => {
    const resolve = inspectionRegistry.get(BOARD_ITEM_FAMILY);
    setInspectSources(resolve?.({ family: BOARD_ITEM_FAMILY, parts: { member: memberId } }, document.body) ?? []);
  };
  const loadInspectionRecord = useCallback(async (recordAddress: string) => {
    const memberId = recordAddress.startsWith('board-item::')
      ? recordAddress.slice('board-item::'.length)
      : null;
    const item = memberId ? itemsRef.current.find((i) => i.memberId === memberId) : null;
    if (!item) throw new Error('This is no longer on the board.');
    // The board is single-writer (read-group-board.ts): edits patch the live graph
    // and persist per-changed-group unconditionally, so there is no per-read CAS
    // basis to guard on. `basis: undefined` => the sidebar dispatches an unguarded
    // write, which is correct here. A multi-writer / per-record surface returns its
    // read-time payload hash as `basis` to make concurrent edits fail closed.
    return { record: boardItemRecordProjection(item, itemFillColor(item)), basis: undefined };
  }, []);
  /** The panel's write-op registry: each op binds a descriptor-named key to an
   *  EXISTING mutation seam (patchItem+textToHtml, setStackFill — SSOT with the
   *  inline editor and quick-color chip). Descriptor DATA picks the op by key;
   *  a new op = one register() row here + one DATA row, no dispatch edits. */
  const boardWriteOps = useMemo(() => {
    const ops = createBoardWriteOpRegistry();
    const lockedGuard = (memberId: string) => {
      const item = readItems(graphRef.current, currentRefRef.current).find((i) => i.memberId === memberId);
      if (!item || itemIsLocked(item)) throw new Error('This item is locked.');
      return item;
    };
    // Every inspector write: (1) guard locked items (a locked item is never edited
    // via the inspector — same policy as drag/resize), (2) commit, (3) THROW if the
    // live persistence failed so the sidebar reports the real error instead of a
    // false "Saved" (the write-failure facade, L117). A failed commit reverts the
    // optimistic graph inside applyGraph; the throw propagates to InspectorSidebar.
    const commitOrThrow = async (after: GroupGraph) => {
      const error = await commit(after, graphRef.current);
      if (error) throw new Error(error);
    };
    ops.register('set-text', async (memberId, value) => {
      lockedGuard(memberId);
      const text = String(value ?? '');
      await commitOrThrow(patchItem(graphRef.current, currentRefRef.current, memberId, { text, html: textToHtml(text) }));
    });
    ops.register('set-fill', async (memberId, value) => {
      const item = lockedGuard(memberId);
      const p = currentRefRef.current;
      const stack = (item.extra?.visualLayerStack as VisualLayerStackRecord | undefined) ?? emptyStack(p);
      const color = typeof value === 'string' && value.length > 0 ? value : null;
      await commitOrThrow(patchItem(graphRef.current, p, memberId, {
        visualLayerStack: setStackFill(stack, color, BOARD_ITEM_LAYER_REGISTRY),
      }));
    });
    // A frame key (corners, opacity) on the item's layer stack, the same record the Background & edge editor writes.
    ops.register('set-frame', async (memberId, value, config) => {
      const item = lockedGuard(memberId);
      const key = typeof config.key === 'string' ? config.key : null;
      if (!key) throw new Error('This change is not supported here.');
      const p = currentRefRef.current;
      const stack = (item.extra?.visualLayerStack as VisualLayerStackRecord | undefined) ?? emptyStack(p);
      await commitOrThrow(patchItem(graphRef.current, p, memberId, {
        visualLayerStack: { ...stack, frame: { ...((stack.frame as Record<string, unknown> | undefined) ?? {}), [key]: value } },
      }));
    });
    ops.register('set-presentation', async (memberId, value, config) => {
      lockedGuard(memberId);
      const key = typeof config.key === 'string' ? config.key : null;
      if (!key) throw new Error('This change is not supported here.');
      await commitOrThrow(patchItem(graphRef.current, currentRefRef.current, memberId, { [key]: value }));
    });
    return ops;
  }, [commit]);
  /** kind → transport is a registry lookup too (no closed write-kind branch):
   *  this host carries one row (its own board-model kind); a foreign kind has
   *  no row → honest fail-closed error, same as an unknown op. */
  const writeTransports = useMemo(() => {
    const transports = createBlindRegistry<(input: Record<string, unknown>) => Promise<void>>();
    transports.register(BOARD_MODEL_WRITE_KIND, (input) =>
      dispatchBoardModelWrite(input, boardWriteOps, 'This change is not supported here.'));
    return transports;
  }, [boardWriteOps]);
  const dispatchInspectionWrite = useCallback(
    async (write: InspectionWriteDescriptor, input: Record<string, unknown>) => {
      const transport = writeTransports.get(write.kind);
      if (!transport) throw new Error('This change is not supported here.');
      await transport(input);
    },
    [writeTransports],
  );

  const beginItemDrag = useCallback(
    (e: React.PointerEvent, item: BoardItem) => {
      // Alt-press = inspect (design-edit) instead of drag — resolves the pressed
      // element's inspection chain and opens the sidebar. Alt is free on items
      // (existing alt shortcuts are keyboard-only or meta+alt combos).
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        e.stopPropagation();
        e.preventDefault();
        setInspectSources(resolveInspection(e.target as Element, inspectionRegistry));
        return;
      }
      // ── Canvas-tool primitive: the ACTIVE TOOL owns what a press on an object
      // means, not the object. Only the Move tool's node.drag = node.move claims
      // the press (drag the item). Under Select-area / Hand / Space the node.drag
      // resolves to marquee / pan, so we DON'T stop propagation — the press falls
      // through to the stage interpreter, which rubber-bands or pans even though
      // an item is under the cursor. This is the dense-board dissolution.
      const intent = nodeIntentKind(e, 'node');
      // Connector tool: press an item, drag onto another → relate them. The press
      // starts a connector gesture (source recorded; preview follows the cursor);
      // pointer move/up on the stage finish it. Same capture model as a node drag.
      if (intent === 'connector.start') {
        e.stopPropagation();
        setEditingId(null);
        const fromCenter = { x: item.x + item.w / 2, y: item.y + item.h / 2 };
        connectorDragRef.current = { fromMemberId: item.memberId, fromCenter };
        const world = screenToWorld(e.clientX, e.clientY);
        setConnectorPreview({ from: fromCenter, to: world });
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        setGrabbing(true);
        return;
      }
      if (intent !== 'node.move') return;
      e.stopPropagation();
      setEditingId(null); // starting any drag leaves inline edit mode
      // Shift-click toggles this item in the multi-selection and does NOT drag —
      // that's how you pick the ≥2 items to Group. A plain click selects just this
      // one (clearing any multi-selection) and begins a drag.
      if (e.shiftKey) {
        selectItem(item.memberId, true);
        return;
      }
      // Alt/Option-drag = stamp a copy (Figma/Canva canon): duplicate the dragged
      // selection IN PLACE, select the COPIES, and drag them so the originals stay
      // put. The copy + move commit as ONE undoable step — `gestureBefore` is
      // snapshotted before the copy, the copies are placed optimistically (no commit),
      // and onStagePointerUp commits the whole gesture. Connectors between two cloned
      // nodes ARE duplicated (re-anchored to the clones via cloneItemsInto/planPaste,
      // #190); a connector to an un-cloned item is dropped, not dangled. Locked items
      // are excluded. The drag anchor is the grabbed item's own clone (by srcId).
      if (e.altKey && !itemIsLocked(item)) {
        const sel0 = selectedIdsRef.current;
        const srcIdSet = sel0.has(item.memberId) ? sel0 : new Set([item.memberId]);
        const src = readItems(graphRef.current, currentRefRef.current)
          .filter((i) => srcIdSet.has(i.memberId) && !itemIsLocked(i));
        if (src.length === 0) return;
        const preClone = graphRef.current;
        const { graph: next, placed } = cloneItemsInto(preClone, currentRefRef.current, src, 0, 0);
        if (placed.length === 0) return; // nothing cloneable (e.g. only orphan connectors)
        gestureBeforeRef.current = preClone; // before the copy → undo removes copies
        setGraph(next); // optimistic; committed on pointer-up
        setSelectedIds(new Set(placed.map((p) => p.id)));
        const anchor = placed.find((p) => p.srcId === item.memberId) ?? placed[0];
        const world = screenToWorld(e.clientX, e.clientY);
        dragRef.current = {
          memberId: anchor.id,
          grabDX: world.x - anchor.x,
          grabDY: world.y - anchor.y,
          moved: true, // a copy IS a change even without movement (duplicate-in-place)
          startWorldX: world.x,
          startWorldY: world.y,
          group: placed,
        };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        setGrabbing(true);
        return;
      }
      // If the grabbed item is already part of a multi-selection, KEEP that
      // selection and drag the whole group together; otherwise select just this
      // one. (This is what lets you marquee N items then move them as one.)
      const sel = selectedIdsRef.current;
      const groupDrag = sel.size > 1 && sel.has(item.memberId);
      if (!groupDrag) selectItem(item.memberId, false);
      // A locked item selects (so you can Unlock it) but never drags.
      if (itemIsLocked(item)) return;
      gestureBeforeRef.current = graphRef.current; // snapshot before optimistic moves
      const world = screenToWorld(e.clientX, e.clientY);
      // The members that will move with this drag (the unlocked selection, or just
      // this item), captured at their start positions so we apply ONE shared delta.
      // FigJam section-move: if the dragged set includes a presentation frame,
      // `withFrameContents` widens it to carry every item inside that frame — the
      // SAME shared-delta translate then moves the contents with zero new move code
      // (connectors auto-follow their moved endpoints; locked children still resist
      // via the `!itemIsLocked` filter below).
      const all = readItems(graphRef.current, currentRefRef.current);
      const moveIds = withFrameContents(all, groupDrag ? sel : new Set([item.memberId]));
      const group = all
        .filter((i) => moveIds.has(i.memberId) && !itemIsLocked(i))
        .map((i) => ({ id: i.memberId, x: i.x, y: i.y, w: i.w, h: i.h }));
      dragRef.current = {
        memberId: item.memberId,
        grabDX: world.x - item.x,
        grabDY: world.y - item.y,
        moved: false,
        startWorldX: world.x,
        startWorldY: world.y,
        group,
      };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setGrabbing(true);
    },
    [screenToWorld, selectItem, nodeIntentKind, cloneItemsInto, inspectionRegistry],
  );

  /** Begin a resize from ANY edge/corner (the grabbed `edge`). The strip already
   *  stopped propagation (no node drag); we snapshot the start rect + grab point and
   *  let the stage pointer-move/up handlers drive it through `applyResizeGeom`, so a
   *  top/left grab moves the origin while a bottom/right grab grows the box. */
  const beginItemResize = useCallback(
    (e: React.PointerEvent, item: BoardItem, edge: ResizeEdge) => {
      // Only the Move tool resizes; under Select-area/Hand/Space a press on a
      // resize strip marquees / pans (fall through to the stage interpreter).
      if (nodeIntentKind(e, 'resizeHandle') !== 'node.resize') return;
      e.stopPropagation();
      setEditingId(null);
      selectItem(item.memberId, false);
      // A locked item selects but never resizes.
      if (itemIsLocked(item)) return;
      gestureBeforeRef.current = graphRef.current; // snapshot before optimistic resizes
      const world = screenToWorld(e.clientX, e.clientY);
      resizeRef.current = { memberId: item.memberId, edge, startX: item.x, startY: item.y, startW: item.w, startH: item.h, grabX: world.x, grabY: world.y, rotation: Number(item.extra?.rotation) || 0, resized: false };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setGrabbing(true);
    },
    [screenToWorld, selectItem, nodeIntentKind],
  );

  /** Begin a free-rotation gesture from the rotate grip above a single selected
   *  item. Snapshots the item's world center (the pivot), the pointer's angle about
   *  it, and the item's current rotation; the stage move/up handlers then drive
   *  `extra.rotation` and commit. Mirrors `beginItemResize` (grip press → stage drag). */
  const beginRotate = useCallback(
    (memberId: string, center: { x: number; y: number }, clientX: number, clientY: number, pointerId: number, target: HTMLElement | SVGElement) => {
      const item = readItems(graphRef.current, currentRefRef.current).find((i) => i.memberId === memberId);
      if (!item || itemIsLocked(item)) return;
      gestureBeforeRef.current = graphRef.current;
      const world = screenToWorld(clientX, clientY);
      rotateRef.current = {
        memberId,
        center,
        startAngle: Math.atan2(world.y - center.y, world.x - center.x),
        startRotation: Number(item.extra?.rotation) || 0,
        rotated: false,
      };
      target.setPointerCapture?.(pointerId);
      setGrabbing(true);
    },
    [screenToWorld],
  );

  /** Begin a GROUP resize from a selection-bounding-box handle (≥2 items). The
   *  bounding box is computed from ALL selected items (matches the overlay), and
   *  the scale is applied to the UNLOCKED ones around the opposite corner/edge as
   *  ONE optimistic transaction (committed on pointer-up). */
  const beginGroupResize = useCallback(
    (e: React.PointerEvent, handle: GroupResizeHandle) => {
      e.stopPropagation();
      setEditingId(null);
      const sel = selectedIdsRef.current;
      const selected = readItems(graphRef.current, currentRefRef.current).filter((i) => sel.has(i.memberId) && !itemIsConnector(i));
      const bounds = selectionBounds(selected.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h })));
      const members = selected
        .filter((i) => !itemIsLocked(i))
        .map((i) => ({ id: i.memberId, x: i.x, y: i.y, w: i.w, h: i.h }));
      if (!bounds || members.length === 0) return;
      gestureBeforeRef.current = graphRef.current;
      const world = screenToWorld(e.clientX, e.clientY);
      groupResizeRef.current = {
        handle,
        anchor: anchorForHandle(bounds, handle),
        bounds,
        members,
        grabX: world.x,
        grabY: world.y,
        resized: false,
      };
      // Capture on the handle (like single-item resize) — pointer events then
      // bubble up to the stage's onPointerMove. Capturing on the stage directly
      // does not deliver moves to the bound handler.
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      setGrabbing(true);
    },
    [screenToWorld],
  );

  /** Begin a GROUP rotation from the rotate grip above the selection box (≥2 items).
   *  The pivot is the selection bounding-box centre; each unlocked, non-connector
   *  item's centre + own rotation are snapshotted so the stage move handler can orbit
   *  them about the pivot and spin each by the same delta. One undoable transaction. */
  const beginGroupRotate = useCallback(
    (clientX: number, clientY: number, pointerId: number, target: HTMLElement | SVGElement) => {
      const sel = selectedIdsRef.current;
      const selected = readItems(graphRef.current, currentRefRef.current).filter((i) => sel.has(i.memberId) && !itemIsConnector(i));
      // The pivot is the bounding centre of ALL non-connector selected items
      // (locked included) so it stays stable when the selection mixes locked +
      // unlocked items; only the unlocked items actually orbit (a locked item is a
      // fixed reference point, never moved). Single-item selection → pivot = its
      // own centre → an in-place spin.
      const bounds = selectionBounds(selected.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h })));
      const items = selected
        .filter((i) => !itemIsLocked(i))
        .map((i) => ({ id: i.memberId, cx: i.x + i.w / 2, cy: i.y + i.h / 2, w: i.w, h: i.h, rotation: Number(i.extra?.rotation) || 0 }));
      if (!bounds || items.length === 0) return;
      const pivot = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
      gestureBeforeRef.current = graphRef.current;
      const world = screenToWorld(clientX, clientY);
      groupRotateRef.current = {
        pivot,
        startAngle: Math.atan2(world.y - pivot.y, world.x - pivot.x),
        items,
        rotated: false,
      };
      target.setPointerCapture?.(pointerId);
      setGrabbing(true);
    },
    [screenToWorld],
  );

  /** Double-click a section → drill into it (push the nav stack). Non-sections
   *  do nothing (a leaf has nothing to open). The breadcrumb walks back out. */
  const drillInto = useCallback((item: BoardItem) => {
    if (!item.isSection) return;
    setSelectedIds(new Set());
    setNavStack((prev) => [...prev, { ref: item.nodeRef, label: item.text || 'Section' }]);
  }, []);

  /** Jump to a breadcrumb depth (0 = board root, n = keep first n sections). */
  const navTo = useCallback((depth: number) => {
    setSelectedIds(new Set());
    setNavStack((prev) => prev.slice(0, depth));
  }, []);

  // ── Canvas pan (⌘/middle-drag empty space) + marquee select (plain left-drag) ──
  const panRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  // Active rubber-band selection: the drag origin (client px) + the selection that
  // existed when it began (shift adds to it). null = not marqueeing.
  const marqueeRef = useRef<{ startX: number; startY: number; base: ReadonlySet<string> } | null>(null);

  const onStagePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) return;
    if (e.button === 2) return; // right-click → let the context menu handle it
    // R42 root: a press on floating CHROME (walkthrough card, metric/time
    // popover, comment thread) drawn over the canvas is NOT a canvas gesture.
    // Without this guard the press bubbles here, resolves to a marquee, and the
    // stage's setPointerCapture (below) steals the pointer — so the panel's
    // button never gets its click (dead Next/Skip/Close/timer). Chrome stamps
    // data-stage-chrome; nodes already stop their own events, so this only ever
    // catches floating panels, never the empty canvas.
    if (pressIsOnStageChrome(e.target)) return;
    // Canvas-tool primitive: the effective tool (Space/middle fold into Hand)
    // decides what a press on EMPTY canvas means — pan vs marquee. No hardcoded
    // ⌘/middle branch; the modifiers are DATA in TEMPORARY_TOOLS.
    const button = e.button === 1 ? 'middle' : 'primary';
    const tool = toolApiRef.current.effectiveTool({ button });
    const intent = resolveToolIntent(tool, 'empty', 'drag').kind;
    if (intent === 'viewport.pan') {
      panRef.current = { startX: e.clientX, startY: e.clientY, panX: cameraRef.current.panX, panY: cameraRef.current.panY };
      setGrabbing(true);
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      return;
    }
    // Text tool: a press resolves to the `text.place` CLICK intent → drop an
    // editable note at the cursor (works anywhere, even over an item — the new
    // note lands at the click point). One generic dispatch arm, no kind branch.
    // preventDefault suppresses the browser's default focus move on this gesture,
    // so the new note's editor (focused on mount) keeps focus instead of the
    // trailing pointerup/click stealing it back to the body.
    if (resolveToolIntent(tool, 'empty', 'click').kind === 'text.place') {
      e.preventDefault();
      placeTextAtRef.current(e.clientX, e.clientY);
      return;
    }
    if (intent !== 'selection.marquee') return; // draw/noop handled elsewhere
    if (e.button !== 0) return;
    // Marquee: shift keeps the current selection as the base (additive), else fresh.
    const base: ReadonlySet<string> = e.shiftKey ? selectedIdsRef.current : new Set<string>();
    if (!e.shiftKey) setSelectedIds(new Set());
    // Drop any stray native text selection the press may have begun, so the board
    // never shows highlighted note text while you rubber-band.
    if (typeof window !== 'undefined') window.getSelection?.()?.removeAllRanges();
    marqueeRef.current = { startX: e.clientX, startY: e.clientY, base };
    setMarqueeing(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onStagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      // Image crop handle in flight: the pointer delta (normalized by the item's
      // on-board size into 0..1 source space) resizes the crop WINDOW; the image
      // re-renders cropped live. Owns the pointer over everything else while cropping.
      const crop = cropDragRef.current;
      if (crop) {
        const world = screenToWorld(e.clientX, e.clientY);
        crop.cropped = true;
        const dx01 = (world.x - crop.grabX) / Math.max(1, crop.itemW);
        const dy01 = (world.y - crop.grabY) / Math.max(1, crop.itemH);
        const nextCrop = resizeCrop(crop.startCrop, crop.edge, dx01, dy01);
        setGraph((g) => patchItem(g, currentRefRef.current, crop.memberId, { crop: nextCrop }));
        return;
      }
      // Connector creation in flight: the dashed preview follows the cursor and
      // SNAPS to a hovered item's center (with a ring) so "will connect here" is
      // obvious. Highest-priority branch — a connector drag owns the pointer.
      const conn = connectorDragRef.current;
      if (conn) {
        const world = screenToWorld(e.clientX, e.clientY);
        const target = itemUnder(world.x, world.y, conn.fromMemberId);
        const to = target ? { x: target.x + target.w / 2, y: target.y + target.h / 2 } : world;
        setConnectorPreview({ from: conn.fromCenter, to });
        setDropTargetId(target ? target.memberId : null);
        return;
      }
      const anchor = connectorAnchorRef.current;
      if (anchor) {
        const world = screenToWorld(e.clientX, e.clientY);
        const target = itemUnder(world.x, world.y, anchor.otherId);
        const to = target ? { x: target.x + target.w / 2, y: target.y + target.h / 2 } : world;
        setConnectorPreview({ from: anchor.fixedCenter, to });
        setDropTargetId(target ? target.memberId : null);
        return;
      }
      // Bend-point drag in flight (#195): the grabbed waypoint follows the cursor;
      // moveWaypoint rewrites just that index and the routed line reflows live. One
      // optimistic patch per move; onStagePointerUp commits the whole drag as one undo.
      const wpDrag = waypointDragRef.current;
      if (wpDrag) {
        const world = screenToWorld(e.clientX, e.clientY);
        setGraph((g) => {
          const conn = readItems(g, currentRefRef.current).find((i) => i.memberId === wpDrag.memberId);
          if (!conn) return g;
          const next = moveWaypoint(readWaypoints(conn.extra?.waypoints), wpDrag.index, world);
          return patchItem(g, currentRefRef.current, wpDrag.memberId, { waypoints: next });
        });
        return;
      }
      const groupResize = groupResizeRef.current;
      if (groupResize) {
        const world = screenToWorld(e.clientX, e.clientY);
        const { sx, sy } = scaleForHandleDrag(
          groupResize.bounds,
          groupResize.handle,
          world.x - groupResize.grabX,
          world.y - groupResize.grabY,
          e.shiftKey,
        );
        const scaled = scaleRectsAroundAnchor(groupResize.members, groupResize.anchor, sx, sy, MIN_ITEM_W, MIN_ITEM_H);
        groupResize.resized = true;
        // ONE batch patch (O(M+K)) per frame instead of folding patchItem per member (per-frame O(N^2)).
        setGraph((g) => patchItems(g, currentRefRef.current, scaled.map((r) => ({ memberId: r.id, patch: { x: r.x, y: r.y, w: r.w, h: r.h } }))));
        return;
      }
      // Group rotation in flight: the pointer's angle about the selection-box centre
      // (pivot) sets a single delta Δ; every snapshot item ORBITS the pivot by Δ and
      // spins its own rotation by Δ (Shift snaps Δ to 15°). w/h never change. One
      // optimistic patch per move, committed on pointer-up. Owns the pointer over single
      // rotate/resize because the group grip is only present with ≥2 selected.
      const groupRotate = groupRotateRef.current;
      if (groupRotate) {
        const world = screenToWorld(e.clientX, e.clientY);
        groupRotate.rotated = true;
        const ang = Math.atan2(world.y - groupRotate.pivot.y, world.x - groupRotate.pivot.x);
        let deltaDeg = ((ang - groupRotate.startAngle) * 180) / Math.PI;
        if (e.shiftKey) deltaDeg = Math.round(deltaDeg / 15) * 15;
        const deltaRad = (deltaDeg * Math.PI) / 180;
        setLiveRotation(Math.round(deltaDeg)); // HUD shows the live delta while rotating
        // ONE batch patch (O(M+K)) per frame instead of folding patchItem per member (per-frame O(N^2)).
        setGraph((g) =>
          patchItems(
            g,
            currentRefRef.current,
            groupRotate.items.map((it) => {
              const c = orbitPoint({ x: it.cx, y: it.cy }, groupRotate.pivot, deltaRad);
              const rot = (((it.rotation + deltaDeg) % 360) + 360) % 360;
              return {
                memberId: it.id,
                patch: { x: Math.round(c.x - it.w / 2), y: Math.round(c.y - it.h / 2), rotation: Math.round(rot * 10) / 10 },
              };
            }),
          ),
        );
        return;
      }
      // Free rotation in flight: the pointer's angle about the item's fixed center
      // sets the item's rotation (Shift snaps to 15° increments). Optimistic patch
      // of `extra.rotation`; committed on pointer-up. Owns the pointer over resize.
      const rotate = rotateRef.current;
      if (rotate) {
        const world = screenToWorld(e.clientX, e.clientY);
        rotate.rotated = true;
        const ang = Math.atan2(world.y - rotate.center.y, world.x - rotate.center.x);
        const deltaDeg = ((ang - rotate.startAngle) * 180) / Math.PI;
        let rot = rotate.startRotation + deltaDeg;
        if (e.shiftKey) rot = Math.round(rot / 15) * 15;
        rot = ((rot % 360) + 360) % 360; // normalize to [0,360)
        const rounded = Math.round(rot * 10) / 10;
        setLiveRotation(rounded); // HUD shows the live angle while rotating
        setGraph((g) => patchItem(g, currentRefRef.current, rotate.memberId, { rotation: rounded }));
        return;
      }
      const resize = resizeRef.current;
      if (resize) {
        const world = screenToWorld(e.clientX, e.clientY);
        resize.resized = true;
        let next: { x: number; y: number; w: number; h: number };
        // Shift on a CORNER preserves the item's aspect ratio (Figma/Canva canon) —
        // images don't distort. Both aspect-lock and rotation route through the same
        // `resizeRotated` (θ=0 is identical to the plain resize), so there is ONE
        // resize path; peer snapping is SKIPPED in both (a constrained diagonal /
        // rotated AABB can't also snap to world-axis peer lines).
        const lockAspect = e.shiftKey && resize.edge.length === 2;
        if (resize.rotation !== 0 || lockAspect) {
          next = resizeRotated(
            { x: resize.startX, y: resize.startY, w: resize.startW, h: resize.startH },
            resize.rotation,
            resize.edge,
            { x: world.x - resize.grabX, y: world.y - resize.grabY },
            MIN_ITEM_W,
            MIN_ITEM_H,
            lockAspect,
          );
          setSnapGuides([]);
        } else {
          const raw = applyResizeGeom(
            resize.edge,
            { x: resize.startX, y: resize.startY, w: resize.startW, h: resize.startH },
            world.x - resize.grabX,
            world.y - resize.grabY,
            MIN_ITEM_W,
            MIN_ITEM_H,
          );
          // Resize-edge snapping — the snap primitive's SECOND caller (L069): the
          // active edge snaps to peer edges/centers (same magenta guides as a drag).
          const rPeers: SnapRect[] = [];
          for (const [id, r] of nodeRectsRef.current) if (id !== resize.memberId) rPeers.push(r);
          const snapped = computeResizeSnap(
            raw,
            resize.edge,
            rPeers,
            SNAP_PX / Math.max(cameraRef.current.zoom, 0.0001),
            MIN_ITEM_W,
            MIN_ITEM_H,
          );
          next = snapped.rect;
          setSnapGuides(snapped.guides);
        }
        setGraph((g) => {
          const sized = resizeItem(g, currentRefRef.current, resize.memberId, next.w, next.h);
          // Top/left edges move the origin as they resize; bottom/right leave it.
          return next.x === resize.startX && next.y === resize.startY
            ? sized
            : moveItem(sized, currentRefRef.current, resize.memberId, Math.round(next.x), Math.round(next.y));
        });
        return;
      }
      const drag = dragRef.current;
      if (drag) {
        const world = screenToWorld(e.clientX, e.clientY);
        // #179 — Shift-drag axis lock: while Shift is held DURING the move, constrain the
        // delta to its dominant axis so the drag stays perfectly horizontal or vertical
        // (Figma/FigJam/Miro precision canon). Read live off the move event so pressing/
        // releasing Shift mid-drag toggles the lock; the press-time Shift gesture
        // (multi-select) is untouched because a drag only ever arms on a plain press.
        const rawDx = Math.round(world.x - drag.startWorldX);
        const rawDy = Math.round(world.y - drag.startWorldY);
        const { dx, dy } = e.shiftKey ? constrainToAxis(rawDx, rawDy) : { dx: rawDx, dy: rawDy };
        drag.moved = true;
        // Alignment snap: the moving bounding box (the union of the dragged group at
        // its candidate position) snaps its edges/centers onto the nearest peer
        // item's lines within a screen-constant radius; the returned guides render
        // live. One pure primitive (L069) over the peer rects we already memoize.
        const movingIds = new Set(drag.group.map((m) => m.id));
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const m of drag.group) {
          minX = Math.min(minX, m.x + dx); minY = Math.min(minY, m.y + dy);
          maxX = Math.max(maxX, m.x + dx + m.w); maxY = Math.max(maxY, m.y + dy + m.h);
        }
        const movingBounds: SnapRect = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        const peers: SnapRect[] = [];
        for (const [id, r] of nodeRectsRef.current) if (!movingIds.has(id)) peers.push(r);
        const snap = computeSnap(movingBounds, peers, SNAP_PX / Math.max(cameraRef.current.zoom, 0.0001));
        setSnapGuides(snap.guides);
        // #179 — when an axis is Shift-locked (its delta is 0), suppress the snap
        // correction on THAT axis so the frozen coordinate stays exact; snapping along
        // the movement axis is kept (it still aligns the moving edge to peers).
        const sdx = e.shiftKey && dx === 0 ? 0 : snap.dx;
        const sdy = e.shiftKey && dy === 0 ? 0 : snap.dy;
        // #202 — snap-to-grid: when THIS board opts in (per-board DATA), round the
        // moving box's origin to the fixed BOARD_GRID lattice on any axis the peer
        // snap did NOT already claim. Peer alignment (contextual, with a magenta
        // guide) always wins; the grid is the FALLBACK that catches the rest — the
        // 3rd snap source (L069). Shift-locked axes keep their exact frozen coord
        // (same suppression as the peer snap), so precision drags stay precise.
        let gdx = 0, gdy = 0;
        if (gridSnapRef.current) {
          const g = snapRectToGrid({ x: movingBounds.x + sdx, y: movingBounds.y + sdy, w: movingBounds.w, h: movingBounds.h }, BOARD_GRID);
          if (snap.dx === 0 && !(e.shiftKey && dx === 0)) gdx = g.dx;
          if (snap.dy === 0 && !(e.shiftKey && dy === 0)) gdy = g.dy;
        }
        // Apply ONE shared delta (+ the snap/grid correction) to every member in the
        // group (one item for a plain drag) — they keep their relative layout. ONE batch position patch
        // (O(M+K)) instead of folding moveItem per member — this fires on EVERY pointer-move frame, so a
        // multi-item drag was re-spreading the whole members map K times per frame (O(K*M) per frame).
        setGraph((g) =>
          patchItems(
            g,
            currentRefRef.current,
            drag.group.map((m) => ({ memberId: m.id, patch: { x: m.x + dx + sdx + gdx, y: m.y + dy + sdy + gdy } })),
          ),
        );
        // Drag-into-folder only makes sense for a single item; a group move never
        // re-parents (it would scatter the group across sections).
        if (drag.group.length <= 1) {
          const target = sectionUnder(world.x, world.y, drag.memberId);
          setDropTargetId(target ? target.memberId : null);
        }
        return;
      }
      const marq = marqueeRef.current;
      if (marq) {
        const stageEl = stageRef.current;
        const box = stageEl?.getBoundingClientRect();
        if (!stageEl || !box) return;
        // Client-space drag rect → overlay rect in viewport-local px + DOM hit-test.
        const r = rectFromPoints({ x: marq.startX, y: marq.startY }, { x: e.clientX, y: e.clientY });
        setSelectionRect({ left: r.left - box.left, top: r.top - box.top, width: r.right - r.left, height: r.bottom - r.top });
        const hits = refsInRect(stageEl, r, { families: new Set([BOARD_ITEM_FAMILY]) });
        const ids = new Set(marq.base);
        for (const ref of hits) {
          const m = ref.parts?.member;
          if (m) ids.add(m);
        }
        setSelectedIds(ids);
        return;
      }
      const pan = panRef.current;
      if (!pan) return;
      setCamera((c) => ({ ...c, panX: pan.panX + (e.clientX - pan.startX), panY: pan.panY + (e.clientY - pan.startY) }));
    },
    [screenToWorld, sectionUnder, itemUnder],
  );

  const onStagePointerUp = useCallback(() => {
    // A finished connector drag: if released over a DIFFERENT item, relate the two
    // by placing a connector member (kind:'connector', endpoint refs in extra) —
    // reusing the SAME place/commit/undo path as any item, ZERO bespoke persistence.
    // Released over empty space or the source → cancel (no member created).
    const conn = connectorDragRef.current;
    if (conn) {
      connectorDragRef.current = null;
      setConnectorPreview(null);
      setDropTargetId(null);
      setGrabbing(false);
      const world = screenToWorld(lastPointerRef.current.x, lastPointerRef.current.y);
      const target = itemUnder(world.x, world.y, conn.fromMemberId);
      if (target && target.memberId !== conn.fromMemberId) {
        const id = newId('c');
        const next = placeItem(graphRef.current, currentRefRef.current, {
          memberId: id,
          nodeRef: itemRef(boardId, newId('i')),
          kind: 'connector',
          x: 0,
          y: 0,
          w: 0,
          h: 0,
          extra: { fromMemberId: conn.fromMemberId, toMemberId: target.memberId },
        });
        setSelectedIds(new Set([id]));
        void commit(next);
      } else if (!target) {
        // #159 mind-map quick-create: released on EMPTY canvas → spawn a NEW note at the
        // release point AND a connector source→newNote, as ONE undoable commit, then open
        // the note to type the child's label. Gate on a real drag (≥24 world-units from the
        // source centre) so a mere click on the source never spawns a stray note.
        const dist = Math.hypot(world.x - conn.fromCenter.x, world.y - conn.fromCenter.y);
        if (dist >= 24) {
          const noteMemberId = newId('m');
          const { graph: next } = connectNewNote(graphRef.current, currentRefRef.current, {
            boardId,
            fromMemberId: conn.fromMemberId,
            x: world.x,
            y: world.y,
            noteMemberId,
            noteItemId: newId('i'),
            connectorMemberId: newId('c'),
            connectorItemId: newId('i'),
          });
          setSelectedIds(new Set([noteMemberId]));
          void commit(next);
          setEditingId(noteMemberId);
        }
      }
      return;
    }
    // A finished endpoint RE-ANCHOR: if released over a DIFFERENT, valid item (not the
    // fixed endpoint's item), rewire that end via the generic patchItem. Drop on empty/
    // same/invalid → no change (revert). One endpoint ref changes; the edge reflows.
    const anchor = connectorAnchorRef.current;
    if (anchor) {
      connectorAnchorRef.current = null;
      setConnectorPreview(null);
      setDropTargetId(null);
      setGrabbing(false);
      const world = screenToWorld(lastPointerRef.current.x, lastPointerRef.current.y);
      const target = itemUnder(world.x, world.y, anchor.otherId);
      if (target && target.memberId !== anchor.otherId) {
        const key = anchor.which === 'from' ? 'fromMemberId' : 'toMemberId';
        void commit(patchItem(graphRef.current, currentRefRef.current, anchor.memberId, { [key]: target.memberId }));
      }
      return;
    }
    // A finished bend-point drag (#195): the waypoint was moved live during the drag;
    // commit the final graph against the pre-drag snapshot so the whole reposition is
    // ONE undo step.
    const wpDrag = waypointDragRef.current;
    if (wpDrag) {
      waypointDragRef.current = null;
      setGrabbing(false);
      void commit(graphRef.current, wpDrag.before);
      return;
    }
    // A finished marquee: the selection was applied live during the drag; just drop
    // the rubber-band. (A bare click — down/up with no move — also lands here and
    // simply clears the empty rect.)
    if (marqueeRef.current) {
      marqueeRef.current = null;
      setSelectionRect(null);
      setMarqueeing(false);
      setGrabbing(false);
      return;
    }
    const groupResize = groupResizeRef.current;
    groupResizeRef.current = null;
    const groupRotate = groupRotateRef.current;
    groupRotateRef.current = null;
    const crop = cropDragRef.current;
    cropDragRef.current = null;
    const resize = resizeRef.current;
    resizeRef.current = null;
    const rotate = rotateRef.current;
    rotateRef.current = null;
    const drag = dragRef.current;
    dragRef.current = null;
    panRef.current = null;
    setGrabbing(false);
    setDropTargetId(null);
    setSnapGuides([]); // drop the alignment guides when the drag ends
    setLiveRotation(null); // drop the live-angle readout when a rotate ends
    // The gesture optimistically overwrote the live graph; diff against the snapshot
    // taken at gesture start so the persisted delta is real (not empty).
    const before = gestureBeforeRef.current ?? undefined;
    gestureBeforeRef.current = null;
    // A finished GROUP resize persists the optimistic scaled rects as one undoable step.
    if (groupResize && groupResize.resized) {
      void commit(graphRef.current, before);
      return;
    }
    // A finished GROUP rotation persists the optimistic orbited centres + per-item
    // rotations as one undoable step.
    if (groupRotate && groupRotate.rotated) {
      void commit(graphRef.current, before);
      return;
    }
    // A finished crop-handle drag persists the optimistic `extra.crop` as one undoable
    // step (crop mode stays open — the user keeps adjusting or clicks Done).
    if (crop && crop.cropped) {
      void commit(graphRef.current, before);
      return;
    }
    // A finished resize persists the optimistic final size.
    if (resize && resize.resized) {
      void commit(graphRef.current, before);
      return;
    }
    // A finished rotation persists the optimistic `extra.rotation` as one undoable step.
    if (rotate && rotate.rotated) {
      void commit(graphRef.current, before);
      return;
    }
    if (!drag || !drag.moved) return;
    // A GROUP move (≥2 items) just persists the new positions — never re-parents
    // (that would scatter the group across folders).
    if (drag.group.length > 1) {
      void commit(graphRef.current, before);
      return;
    }
    // Single item: dropped onto a section → move it into that folder. Else persist
    // the final free position. ONE drop, two outcomes; the leaf refuses cycles.
    const world = screenToWorld(lastPointerRef.current.x, lastPointerRef.current.y);
    const target = sectionUnder(world.x, world.y, drag.memberId);
    if (target) {
      // Re-parent the item into the section, THEN grow the section (grow-only) to swallow it if it landed
      // past the frame edge — the Miro/FigJam "frame grows to contain what you drop into it" behaviour.
      const moved = moveItemToGroup(graphRef.current, currentRefRef.current, target.nodeRef, drag.memberId);
      void commit(growSectionToFit(moved, target), before);
    } else void commit(graphRef.current, before);
  }, [commit, screenToWorld, sectionUnder, itemUnder, boardId, growSectionToFit]);

  // ── Trackpad wheel: PINCH (ctrl/⌘) zooms gently toward the cursor; a plain
  //    two-finger SCROLL pans. The old code zoomed 1.1× on EVERY wheel event
  //    (incl. scroll) and compounded → violent. A damped exponential keyed to the
  //    actual deltaY makes pinch feel like Arc; scroll never zooms. ──
  const ZOOM_WHEEL_SENSITIVITY = 0.0018; // gentle: a full pinch tick ≈ a few %
  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const cam = cameraRef.current;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!e.ctrlKey && !e.metaKey) {
      // Two-finger scroll = pan (natural-direction: content follows fingers).
      setCamera((c) => ({ ...c, panX: c.panX - e.deltaX, panY: c.panY - e.deltaY }));
      return;
    }
    // Zoom toward the CURSOR via the shared anchor-invariant primitive (same SSOT the
    // +/- buttons and reset use through zoomAroundCenter) — no hand-rolled inverse math.
    const factor = Math.exp(-e.deltaY * ZOOM_WHEEL_SENSITIVITY);
    const cx = e.clientX - (rect?.left ?? 0);
    const cy = e.clientY - (rect?.top ?? 0);
    setCamera(zoomAroundPoint(cam, { x: cx, y: cy }, cam.zoom * factor, MIN_ZOOM, MAX_ZOOM));
  }, []);

  const setZoom = useCallback(
    (z: number) => setCamera((c) => ({ ...c, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) })),
    [],
  );

  /** Step the zoom by a clean ±10% snapped to a 10% grid (Arc-style buttons),
   *  keeping the displayed % tidy (…90 → 100 → 110…) instead of 1.2× jumps. */
  const ZOOM_STEP = 0.1;
  const stepZoom = useCallback((dir: 1 | -1) => {
    setCamera((c) => {
      const snapped = Math.round(c.zoom / ZOOM_STEP) * ZOOM_STEP;
      const next = Math.round((snapped + dir * ZOOM_STEP) * 100) / 100;
      return { ...c, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) };
    });
  }, []);
  // Ref so the keyboard handler (declared earlier in the body) can reach the latest
  // stepZoom without listing a later-declared const in its dep array (which would
  // TDZ-crash). Stable ref = the file's idiom for early-handler → late-callback.
  const stepZoomRef = useRef(stepZoom);
  stepZoomRef.current = stepZoom;

  // Plain function call (not JSX) so the idle case stays literal null and the
  // CanvasViewport renders no overlay wrapper — exactly as the old ternary did.
  const overlay = BoardStatusOverlay({ isLoading, empty, error: error ?? loadError, onRetry: retryLoad });

  return (
    <MarkSessionProvider>
    <>
    {surfaceIntentReader && <SurfaceIntentReader
      records={normalizeAddressedSurfaceIntentRecords(surfaceIntentReaderValue)}
      intentPath={surfaceIntentReader.intentPath}
      keyPath={surfaceIntentReader.keyPath}
      dispositionRoutes={surfaceIntentReader.dispositionRoutes}
      defaultRoute={surfaceIntentReader.defaultRoute}
      allowList={[]}
      permit={(payload) => surfaceIntentMatchesCatalogPayload(payload, surfaceIntentCatalog)}
      emit={placeIntentPayload}
    />}
    {surfaceIntentDestinationRef && <AddressedSurfaceIntentRecipient destinationRef={surfaceIntentDestinationRef} allowList={[]} permit={(payload) => surfaceIntentMatchesCatalogPayload(payload, surfaceIntentCatalog)} emit={placeIntentPayload} />}
    <Container layout="vertical" gap="none" height="full" minHeight="0" width="full" minWidth="0" position="relative" data-canvas-host>
      {/* Top bar — #3: `wrap` so on a narrow screen the toolbar group drops to a
          second line instead of the tool labels escaping the bar (it was NOWRAP +
          w-auto, so title+tools grew to ~696px and overflowed the ~512px bar). */}
      <Container layout="horizontal" justifyContent="between" alignItems="center" padding="md" wrap minWidth="0">
        <Container layout="horizontal" gap="xs" alignItems="center">
          {/* #220 — "← Back" to the previously-viewed board (browser-like nav history).
              Shown only when there is somewhere to go back to; a board change via the
              switcher OR the #218 board-link chip pushes onto the stack. */}
          {boardBackStack.length > 0 ? (
            <Button variant="ghost" size="sm" aria-label="Back to previous board" onClick={goBackBoard}>
              <Icon icon={ArrowLeft} size="sm" />
            </Button>
          ) : null}
          {/* R16 — the "who's on this board" facepile (renders nothing when solo). */}
          <PresenceRoster participants={presencePeers} />
          {/* Board switcher — the title IS a Dropdown of boards (+ New board). One
              surface, many boards; the index is a group, each board a member. */}
          <BoardSwitcherMenu
            boards={boards}
            archivedBoards={archivedBoards}
            currentBoardId={currentBoardId}
            currentBoardTitle={currentBoardTitle}
            onNewBoard={newBoard}
            onNewFromTemplate={() => setTemplatesOpen(true)}
            onRenameBoard={() => void renameCurrentBoard()}
            onDuplicateBoard={duplicateCurrentBoard}
            onExportSvg={exportBoardSvg}
            onExportPng={() => void exportBoardPng()}
            onExportDeck={exportBoardDeck}
            onCopyPng={() => void copyBoardPng()}
            onArchiveBoard={archiveCurrentBoard}
            onArchiveOthers={archiveOtherBoards}
            onEmptyArchive={emptyArchive}
            onRestoreBoard={restoreArchivedBoard}
            onSwitchBoard={switchBoard}
          />
          <BoardChromeMenu
            label="Board"
            dismissWhen={exportOpen}
            groups={[
              {
                label: 'Collaborate',
                defaultOpen: true,
                children: (
                  <>
          {/* Comments triage toggle: opens the all-threads review panel. The count is
              the open comments across the board (the same reducer the pin badge uses). */}
          {(() => {
            const openN = allCommentReviewRows.reduce((sum, row) => sum + (row.summary.open ? row.summary.count : 0), 0);
            return (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCommentsPanelOpen((v) => !v)}
                aria-label="Review all comments"
              >
                <Icon icon={MessageSquare} size="sm" /> {openN > 0 ? `Comments · ${openN}` : 'Comments'}
              </Button>
            );
          })()}
          {commentsPanelOpen ? (
            <Container position="absolute" style={{ right: 12, top: 56, zIndex: 62 }}>
              <CommentsReviewPanel
                rows={allCommentReviewRows}
                onJumpTo={(anchorId) => {
                  setSelectedIds(new Set([anchorId]));
                  setCommentAnchorId(anchorId);
                  setCommentDraft('');
                  const r = nodeRects.get(anchorId);
                  if (r) frameRects([r]);
                  setCommentsPanelOpen(false);
                }}
                onClose={() => setCommentsPanelOpen(false)}
              />
            </Container>
          ) : null}
          {/* Dot-voting toggle: start/stop a voting round. While active, every idea shows a +/-
              chip and this label shows the voter's remaining dots (the same budget the chips gate on). */}
          {(() => {
            const left = actorBudgetRemaining(boardTallies(nodeItems), LOCAL_VOTER, VOTE_BUDGET);
            return (
              <Button
                variant={votingMode ? 'primary' : 'ghost'}
                size="sm"
                onClick={() => {
                  // Entering a round: one plain sentence explaining the pills + budget that are
                  // about to appear (R24) — without it the mode is incomprehensible.
                  if (!votingMode) {
                    showNotice(`Voting is on — click any card to spend one of your ${VOTE_BUDGET} votes. Press "Finish voting" when you're done.`, 'info');
                  }
                  setVotingMode((v) => !v);
                }}
                aria-label={votingMode ? 'Finish voting' : 'Start voting'}
              >
                <Icon icon={ThumbsUp} size="sm" /> {votingMode ? `Finish voting · ${left} left` : 'Vote'}
              </Button>
            );
          })()}
          {/* Dot-voting results: a "Top voted" ranking (most-voted ideas first), shown once any
              votes exist. Reuses the SAME RankedJumpList as the comments triage panel. */}
          {(() => {
            const total = totalVotes(boardTallies(nodeItems));
            if (total === 0) return null;
            return (
              <>
                <Button variant="ghost" size="sm" onClick={() => setVoteResultsOpen((v) => !v)} aria-label="Show top voted">
                  Results
                </Button>
                {voteResultsOpen ? (
                  <Container position="absolute" style={{ right: 12, top: 56, zIndex: 62 }}>
                    <VoteRankingPanel
                      rows={voteRankingRows(nodeItems)}
                      onJumpTo={(memberId) => {
                        setSelectedIds(new Set([memberId]));
                        const r = nodeRects.get(memberId);
                        if (r) frameRects([r]);
                        setVoteResultsOpen(false);
                      }}
                      onClose={() => setVoteResultsOpen(false)}
                    />
                  </Container>
                ) : null}
              </>
            );
          })()}
                  </>
                ),
              },
              {
                label: 'Overview & insights',
                children: (
                  <>
          {/* Whole-board task rollup: total steps done across every item's checklist — the goal-board
              "how far along is everything" readout. Shown once any item has steps. */}
          {(() => {
            const roll = boardRollup(nodeItems);
            if (roll.total === 0) return null;
            return (
              <Text variant="body-sm" tone="muted" aria-label={`Board tasks ${roll.done} of ${roll.total} done`}>
                {`☑ ${roll.done}/${roll.total}`}
              </Text>
            );
          })()}
          {/* Whole-board metric rollup: how many measured goals are complete + the mean percent across
              them — the quantitative sibling of the task rollup. Shown once any card carries a metric. */}
          {(() => {
            const sum = boardMetricSummary(nodeItems);
            if (sum.tracked === 0) return null;
            return (
              <Text variant="body-sm" tone="muted" aria-label={`Board goals ${sum.complete} of ${sum.tracked} complete, ${sum.avgPct}% average`}>
                {`◎ ${sum.complete}/${sum.tracked} · ${sum.avgPct}%`}
              </Text>
            );
          })()}
          {/* Whole-board CARD-EQUAL completion: how many CARDS are done + the mean completion across every
              card that tracks progress (metric OR checklist, one vote each — the unified sibling of the
              step-count ☑ and metric-goal ◎ chips). Shown once any card tracks completion. */}
          {(() => {
            const c = boardCompletion(nodeItems);
            return c.tracked === 0 ? null : <BoardCompletionChip complete={c.complete} tracked={c.tracked} avgPct={c.avgPct} />;
          })()}
          {/* Insights: ONE toolbar entry point consolidating the board's read-only insight lenses (Due soon,
              Agenda, Review, Progress, Time, Forecast, Streaks, Core ideas, Outline, Critical path, Diversity,
              Balance, Frames, Tidiness, Tag map, Hubs) behind a single "Insights" menu — the toolbar stops growing per lens (L063 eliminates the "one
              button per lens" category; L118 caps toolbar clutter). Each lens self-gates via `available`;
              picking one opens its own anchored panel, which owns its close/jump. Adding a lens is one
              InsightLens descriptor row, ZERO menu code (L069/L090). Interactive editors (Roll-up, Cadence,
              Export/Import, inline metric/time editors) stay as their own controls — the menu is lenses only. */}
          {/* The lens registry is the memoized `insightLenses` (pure `boardInsightLenses` builder) — shared with
              the ⌘K command palette. `activeInsightKey` is lifted here so both the menu picker and the palette
              open a lens (b220). Adding a lens is a row in the builder, ZERO change here (L069/L090). */}
          <InsightsMenu lenses={insightLenses} activeKey={activeInsightKey} onActiveKeyChange={setActiveInsightKey} />
                  </>
                ),
              },
              {
                label: 'Organize & transfer',
                children: (
                  <>
          <Button variant="ghost" size="sm" onClick={() => { setActiveTour(null); setTourIndex(0); }} aria-label="Start walkthrough">
            Guide
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelectionInspectorOpen(true)} aria-label="Open saved queries">
            Saved queries
          </Button>
          {boardHasReadingOrder(nodeItems) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const labelOf = (id: string) => nodeItems.find((it) => it.memberId === id)?.text?.trim() || id;
                setActiveTour(readingTour(nodeItems, labelOf));
                setTourIndex(0);
              }}
              aria-label="Read the board card by card in reading order"
            >
              Read in order
            </Button>
          ) : null}
          {/* Habit cadence — set how OFTEN a habit should happen (daily / weekly / 3x a week / monthly), so
              a non-daily habit reads honestly instead of looking "broken". Shown when exactly one content
              card is selected; writes extra.habitCadence DATA (clearing returns it to the daily streak).
              The preset list is a UI convenience — the engine accepts any {period, times}. */}
          {(() => {
            if (selectedIds.size !== 1) return null;
            const id = [...selectedIds][0];
            const item = nodeItems.find((it) => it.memberId === id);
            if (!item || !itemIsHabitTarget(item)) return null;
            const cad = cadenceOfItem(item);
            const OFF = '__cadence-off__';
            const value = cad ? `${cad.period}:${cad.times}` : OFF;
            const applyCadence = (v: string): void => {
              const next: Cadence | null =
                v === OFF ? null : (() => { const [p, t] = v.split(':'); return { period: p as Cadence['period'], times: Number(t) }; })();
              void commit(setHabitCadence(graphRef.current, currentRefRef.current, id, next));
            };
            return (
              <Dropdown
                items={[
                  { value: 'day:1', label: 'Daily', icon: 'Flame' },
                  { value: 'week:1', label: 'Weekly', icon: 'Flame' },
                  { value: 'week:3', label: '3x per week', icon: 'Flame' },
                  { value: 'week:5', label: '5x per week', icon: 'Flame' },
                  { value: 'month:1', label: 'Monthly', icon: 'Flame' },
                  ...(cad ? [{ value: OFF, label: 'No cadence', icon: 'X' }] : []),
                ]}
                value={value}
                onValueChange={applyCadence}
                align="start"
                aria-label="Set how often this habit should happen"
                customTrigger={
                  <Button variant="ghost" size="sm" aria-label="Set how often this habit should happen">
                    <Icon icon={Flame} size="sm" /> {cad ? `Cadence: ${cadenceLabel(cad)}` : 'Cadence'}
                  </Button>
                }
              />
            );
          })()}
          {/* Import: the discoverable partner of Export — pull a Markdown / CSV / Mermaid / iCalendar file in
              through the sanctioned OS picker (accept list = the import registry's extensions, SSOT). Routes
              through the SAME `importTextAtWorld` path as paste + drop (L063, one import path). Ungated — the
              primary way to populate an EMPTY board from an existing document. A new format is a registry row,
              ZERO change here (L069/L090). */}
          <Button variant="ghost" size="sm" onClick={() => importFromFileRef.current()} aria-label="Import a document onto the board">
            <Icon icon={Upload} size="sm" /> Import
          </Button>
          {/* Export: lift the whole board into a portable document — Markdown (sections -> headings, cards
              -> bullets + checklists) or a Calendar (.ics) feed of the goals' due dates. The panel is blind
              over the document-export registry (pick a format chip, it serializes + shows the text + Copy);
              a new format is a registry row, ZERO change here (L069/L090). Shown once the board has content. */}
          {nodeItems.length > 0 ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setExportOpen((v) => !v)} aria-label="Export the board">
                <Icon icon={FileText} size="sm" /> Export
              </Button>
            </>
          ) : null}
          {/* Hubs / Islands / Cycles / Do-order / Load-bearing lenses moved into the InsightsMenu above. */}
          {/* Forecast / Critical path / Core ideas / Tree outline / Diversity + the ranking lenses all moved into
              the consolidated <InsightsMenu> above. */}
          {/* Roll up (goal hierarchy): choose which connector relation means "sub-goal contributes to
              goal", so a vision's badge aggregates its children's progress. Board DATA on the index member;
              shown once the board has typed connectors. No default kind (a bare link is too ambiguous to be
              hierarchy) — off until chosen; a direction toggle flips which connector end is the sub-goal. */}
          {(() => {
            const kinds = relationKinds(relationGraph);
            if (kinds.length === 0) return null;
            const spec = rollupSpecFromRaw(currentBoardEntry?.rollupSpec);
            const OFF = '__rollup-off__';
            return (
              <>
                <Dropdown
                  items={[
                    ...kinds.map((k) => ({ value: k, label: k, icon: 'GitBranch' })),
                    ...(spec ? [{ value: OFF, label: 'Turn off rollup', icon: 'X' }] : []),
                  ]}
                  value={spec?.relationKind ?? ''}
                  onValueChange={(v) => setBoardRollup(v === OFF || v === '' ? null : { relationKind: v, childEndpoint: spec?.childEndpoint ?? 'from' })}
                  align="start"
                  aria-label="Roll up goal progress along a relation"
                  customTrigger={
                    <Button variant="ghost" size="sm" aria-label="Roll up goal progress along a relation">
                      <Icon icon={GitBranch} size="sm" /> {spec ? `Roll up · ${spec.relationKind}` : 'Roll up'}
                    </Button>
                  }
                />
                {spec ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setBoardRollup({ relationKind: spec.relationKind, childEndpoint: spec.childEndpoint === 'from' ? 'to' : 'from' })}
                    aria-label="Flip which end of the connector is the sub-goal"
                  >
                    {spec.childEndpoint === 'from' ? 'child: source' : 'child: target'}
                  </Button>
                ) : null}
              </>
            );
          })()}
          {/* Work on next — the actionable capstone: one recommendation composed from the critical-path
              bottleneck (highest-leverage) or, absent a hierarchy, the most at-risk goal by forecast.
              Clicking jumps to + frames that goal. Shown only when something is genuinely actionable. */}
          {(() => {
            const spec = rollupSpecFromRaw(currentBoardEntry?.rollupSpec);
            const pick = nextFocus(nodeItems, spec, nowFrame);
            if (!pick) return null;
            return (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Work on next: ${pick.label} — ${pick.reason}`}
                onClick={() => {
                  setSelectedIds(new Set([pick.memberId]));
                  const r = nodeRects.get(pick.memberId);
                  if (r) frameRects([r]);
                }}
              >
                <Icon icon={Target} size="sm" /> {`Next: ${pick.label}`}
              </Button>
            );
          })()}
                  </>
                ),
              },
              {
                label: 'View',
                children: (
                  <>
          {/* Board background — the surface look (color + pattern) for THIS board.
              A popover of SurfaceSwatch preview tiles, one per catalog row (the
              #117 ui-stays-blind catalog pattern: the catalog is feature DATA, the
              tile is blind). The chosen id persists on the board's index member, so
              each board remembers its own surface. */}
          <BoardBackgroundPicker
            open={bgPickerOpen}
            onToggleOpen={() => setBgPickerOpen((o) => !o)}
            onDismiss={() => setBgPickerOpen(false)}
            currentBackgroundId={currentBackground.id}
            backgrounds={backgroundCatalog}
            appearancePresets={appearancePresetCatalog}
            onChooseBackground={chooseBackground}
            gridSnap={currentGridSnap}
            onToggleGridSnap={toggleGridSnap}
            onApplyAppearancePreset={applyBoardAppearancePreset}
            boardAppearance={currentBoardAppearance}
            onSetBoardDefault={setBoardAppearanceDefault}
            onSaveLook={saveCurrentLook}
          />
          {/* Objects / Layers panel (#151) — the Figma/Miro side list of every placed
              item, top-most z first, each row select + visibility + lock. A popover
              anchored to this button (same pattern as the background picker). */}
          <BoardObjectsButton
            open={layersOpen}
            onToggleOpen={() => setLayersOpen((o) => !o)}
            onClose={() => setLayersOpen(false)}
            nodes={layerTree}
            onSelect={selectItem}
            onToggleHidden={toggleItemHidden}
            onToggleLocked={toggleItemLocked}
            onRename={renameLayer}
            onToggleExpand={toggleLayerExpand}
            onReorder={reorderLayers}
          />
                  </>
                ),
              },
            ]}
          />
        </Container>
        {/* The persistent board controls form one compact peer group beside the
            title. The parent owns responsive wrapping, so this group drops only
            when the pane is genuinely narrow rather than claiming a full second
            row at every desktop width. */}
        <Container layout="horizontal" gap="sm" alignItems="center" wrap minWidth="0">
          {/* Only the BUILT-IN item tools render inline. The open-ended custom / AI
              action set (`extraTools`) used to render inline too and flooded the header
              so it no longer fit and buried the board (a user's report) — it now lives
              behind the "Custom actions" popover below. */}
          {sourceAdds ? (
            <Button variant="secondary" size="sm" onClick={() => { setAddsWords(''); setAddsOpen(true); }} data-board-source-add>
              <Icon icon={Plus} size="sm" /> {sourceAdds.label}
            </Button>
          ) : null}
          <BoardChromeMenu
            label="Add"
            groups={[
              {
                label: 'Create',
                defaultOpen: true,
                children: (
                  <>
                    {[...itemShelf, ...liveSurfaceTools].map((tool) => (
                      <ShelfToolButton key={tool.label} tool={tool} appearance="menu" onAdd={addItem} onCreateVariant={createCatalogVariant} />
                    ))}
                    <Button variant="ghost" size="sm" onClick={addSection} aria-label="Add an empty section">
                      <Icon icon={FolderPlus} size="sm" /> Section
                    </Button>
                  </>
                ),
              },
              {
                label: 'Custom actions',
                children: (
                  <>
          {/* R10 action-as-DATA: the board's custom actions, collapsed into one button
              with a searchable, scrollable popover (pinned search + pinned "Create new
              action"). Renders only when there is ≥1 custom action; the "New action"
              button below is the always-present create path when there are none yet. */}
          <BoardActionsButton actions={extraTools} onRun={addItem} onCreateNew={openActionEditor} onRemove={(t) => { void removeAction(t); }} onEdit={openActionEditorForEdit} archived={archivedActionRestoreRows} />
          {/* VISIBLE authoring entry for custom actions (L083) — but ONLY while the
              Actions popover is absent (zero custom actions yet). Once actions exist,
              BoardActionsButton renders with its pinned "Create new action" row and a
              second standalone "New action" button is pure duplication (R38 — a user
              flagged the redundancy). One visible create path at all times, never two. */}
          {extraTools.length === 0 ? (
            <Button variant="ghost" size="sm" onClick={openActionEditor} aria-label="Create a new action">
              <Icon icon={Sparkles} size="sm" /> New action
            </Button>
          ) : null}
                  </>
                ),
              },
            ]}
          />
          {/* Share the board (or a scope of it) as a self-contained link — the "missing
              button". The picker chooses board / selection / tag / a certain type; the
              link carries the content so it opens with no server (public hosting is the
              public-scene-share owner's job, not group's). */}
          <ShareScopeControl onShare={(kind) => void shareBoard(kind)} />
          {/* Per-item controls now live in the single selection inspector below.
              Keeping them out of the persistent header prevents a click from
              turning the canvas toolbar into a second row of item metadata. */}
          {/* Canvas tool picker (pointer-meaning SSOT): Move / Select area / Hand
              / Draw as DATA-driven tools. Select-area marquees over a DENSE board;
              Hand (or hold Space) pans; Draw arms the addressed-marks session via
              DrawToolBinder. One primitive replaces the old ⌘/middle pan modifier +
              the BoardDrawToggle button (enum-dissolution). */}
          {/* The canvas tools and the zoom are one dock: in a wide pane it sits in this header row; in a
              narrow pane (a phone, the Mac panel, a thin split) screen-look canvas-dock.css floats it as one
              pill at the bottom of the canvas, so the cards start right under a short header and every tool
              stays one tap away. */}
          <Container layout="horizontal" gap="sm" alignItems="center" wrap minWidth="0" data-canvas-dock>
          <CanvasToolPicker
            tools={boardTools}
            activeToolId={toolApi.activeToolId}
            onSelect={toolApi.setActiveTool}
          />
          {/* Compact zoom cluster — one self-contained unit so it never wraps
              apart on a small screen (a user's bug): [-] [bare track] 79% [+].
              The bare RangeInput (no label card) replaces the heavy settings-row
              Slider that printed the raw 0.78… decimal and drew a 2nd border. */}
          <BoardZoomCluster
            zoom={camera.zoom}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            onStepZoom={stepZoom}
            onSetZoom={setZoom}
            onResetZoom={resetZoom}
            onZoomToFit={zoomToFit}
            showPresent={frames.length > 0}
            onPresent={enterPresent}
            onCarousel={openFrameCarousel}
          />
          </Container>
        </Container>
      </Container>

      {/* Breadcrumb — only when drilled into a nested section. Walk back out by
          clicking any crumb. "Board" returns to the root. */}
      {navStack.length > 0 ? (
        <BoardBreadcrumb
          boardTitle={currentBoardTitle}
          crumbs={navStack.map((crumb) => crumb.label)}
          onNavTo={navTo}
        />
      ) : null}

      {/* Focus bar (Mural "Find" / Miro / Leonardo canon): ONE place to narrow a dense
          board. A free-text search (matching items bright, rest dim) + the board's distinct
          tags as toggle chips. Both feed ONE focus predicate — an item is focused iff it
          passes EVERY active filter (search AND tags); non-focused items dim via the same
          generic CanvasNode.opacity. Shown once the board is taggable OR big enough to search.
          The search query is transient VIEW state (never persisted); the chips are DATA. */}
      {boardTags.length > 0 || nodeItems.length >= 4 || hiddenIds.size > 0 || (relationFacetValues.relationKind?.length ?? 0) >= 2 ? (
        <BoardFocusBar
          ref={boardFocusBarRef}
          showSearch={boardTags.length > 0 || nodeItems.length >= 4 || (relationFacetValues.relationKind?.length ?? 0) >= 2}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          foundCount={
            hasActiveFacets(focusFacets) || searchQuery.trim() !== ''
              ? nodeItems.filter((it) => boardFocusMatch(it, focusFacets, searchQuery)).length
              : null
          }
          matchCursor={matchCursorPos}
          onStepMatch={stepMatch}
          onReplace={(find, replaceWith) => {
            const { graph: next, matchCount } = applyTextReplace(graphRef.current, currentRefRef.current, { find, replaceWith });
            if (matchCount > 0) void commit(next);
          }}
          facets={BOARD_FOCUS_FACETS}
          facetValuesFor={(key) => focusFacetValues[key] ?? []}
          facetCountsFor={(key) => focusFacetCounts[key] ?? {}}
          facetColorsFor={(key) => focusFacetColors[key] ?? {}}
          facetSelection={focusFacets}
          onToggleFacet={toggleFocusFacet}
          connectorFocusFacets={CONNECTOR_FOCUS_FACETS}
          connectorFacetValuesFor={(key) => relationFacetValues[key] ?? []}
          connectorFacetCountsFor={(key) => relationFacetCounts[key] ?? {}}
          connectorFacetSelection={relationFocus}
          onToggleConnectorFacet={toggleRelationFocus}
          onSelectRelationship={selectFocusedConnectors}
          relationMatchCount={hasActiveFacets(relationFocus) ? focusedConnectorIds(connectorItems, relationFocus).length : 0}
          onSelectDownstream={singleSelectedNodeId ? selectDownstreamViaFocus : undefined}
          onSelectUpstream={singleSelectedNodeId ? selectUpstreamViaFocus : undefined}
          onHideUnrelated={hideUnrelatedConnectors}
          hasActiveFocus={hasActiveFacets(focusFacets) || hasActiveFacets(relationFocus) || searchQuery.trim() !== ''}
          onClearFocus={() => {
            setFocusFacets({});
            setRelationFocus({});
            setSearchQuery('');
            setMatchCursorId(null);
          }}
          onSelectFocused={() => setSelectedIds(new Set(focusedItemIds(nodeItems, focusFacets, searchQuery)))}
          onHideOthers={hideNonFocused}
          views={savedFocusViews}
          onSaveView={saveFocusView}
          onApplyView={applyFocusView}
          onDeleteView={deleteFocusView}
          hiddenCount={hiddenIds.size}
          showHidden={showHidden}
          onToggleShowHidden={() => setShowHidden((v) => !v)}
          onShowAll={showAllItems}
        />
      ) : null}

      {/* Canvas */}
      <CanvasViewport
        ref={stageRef}
        acceptsExternalFiles
        aria-label={`${title} canvas`}
        data-reach-role="board-canvas"
        fill
        minHeight={420}
        // R51: while marquee-selecting or panning, suppress native text selection
        // document-wide so the drag never highlights text in floating panels.
        interacting={marqueeing || grabbing}
        cursor={
          marqueeing
            ? 'crosshair'
            : grabbing
              ? 'grabbing'
              : toolApi.spaceHeld
                ? 'grab'
                : toolApi.activeTool.cursor
        }
        overlay={overlay}
        selectionRect={selectionRect}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onDoubleClick={onStageDoubleClick}
        onContextMenu={(e) => {
          // The item menu (CanvasNode onContextMenu) stops propagation, so this only
          // fires on EMPTY canvas. Guard anyway: a real member under the cursor owns
          // its own menu. Otherwise open the canvas menu for the synthetic root ref.
          const owned = (e.target as Element).closest?.('[data-node-ref]');
          if (owned && e.currentTarget.contains(owned)) return;
          // stopPropagation is REQUIRED: without it the event bubbles past the
          // viewport to the studio screen-arrangement container's OWN context menu
          // (an ancestor), which opens on top of ours. The board owns the right-click
          // on its own canvas. preventDefault alone (no stopPropagation) was the bug.
          e.preventDefault();
          e.stopPropagation();
          canvasMenuPointRef.current = { x: e.clientX, y: e.clientY };
          canvasMenu.openFor({ family: BOARD_ROOT_FAMILY, parts: {} }, { x: e.clientX, y: e.clientY });
        }}
        onWheel={onWheel}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer?.files ?? []);
          if (files.length === 0) return;
          e.preventDefault();
          void dropFilesAt(files, e.clientX, e.clientY);
        }}
      >
        <CanvasSurface panX={camera.panX} panY={camera.panY} zoom={camera.zoom} color={currentBackground.color} tile={currentBackground.tile} />
        <CanvasWorldTransform panX={camera.panX} panY={camera.panY} zoom={camera.zoom}>
          {/* Insight lens (b113/b115) paints FIRST — a read-only analysis wash (cluster hulls / density
              heatmap / votes treemap) UNDER the connectors + cards; world-coordinate `<g>` aligned to the
              node rects. undefined lens → renders nothing (zero cost / zero regression when off). */}
          <InsightLensSvg items={items} lensId={insightLensId} />
          {/* Edge layer FIRST so relationship lines paint UNDER the cards (graph-
              canvas canon), touching each box border. Resolves endpoints from the
              live node rects; reactive to every move/resize/delete. */}
          <ConnectorLayer
            connectors={focusedConnectorModels}
            rects={nodeRects}
            preview={connectorPreview}
            onSelect={selectItem}
            onEndpointDown={onConnectorEndpointDown}
            onLabelEdit={onConnectorLabelEdit}
            onWaypointDown={onConnectorWaypointDown}
            onWaypointRemove={onConnectorWaypointRemove}
            idleColor={resolveAppearanceKey('connectorColor', undefined, currentBoardAppearance) as string}
            defaultWidth={Number(resolveAppearanceKey('connectorWidth', undefined, currentBoardAppearance)) || undefined}
            defaultArrow={resolveAppearanceKey('connectorArrow', undefined, currentBoardAppearance) as 'end' | 'both' | 'none'}
            defaultRouting={resolveAppearanceKey('connectorRouting', undefined, currentBoardAppearance) as string}
            defaultDashed={resolveAppearanceKey('connectorDashed', undefined, currentBoardAppearance) as boolean}
            defaultRoughness={Number(resolveAppearanceKey('connectorRoughness', undefined, currentBoardAppearance)) || undefined}
            defaultStrokeStyle={resolveAppearanceKey('connectorStrokeStyle', undefined, currentBoardAppearance) as string}
            jumps={resolveAppearanceKey('connectorJumps', undefined, currentBoardAppearance) === 'on'}
            roundedCorners={resolveAppearanceKey('connectorCorners', undefined, currentBoardAppearance) === 'round'}
            defaultArrowHead={resolveAppearanceKey('connectorArrowHead', undefined, currentBoardAppearance) as string}
          />
          {/* R42b: the walkthrough overlay is mounted in the HUD layer BELOW (after the
              minimap) — not here inside the world transform — so its Next/Skip/Done
              buttons paint ABOVE the minimap and stay clickable even when a step's target
              sits in the bottom-right minimap zone. It is passed a world→screen `project`
              so its spotlight ring still grips the drawn note exactly. */}
          {/* R16 — every OTHER participant's live cursor + selection ring, in the
              SAME world-space container as items (world coords match the published
              cursor). Renders nothing when solo — zero cost for the single-window case. */}
          {presencePeers.length > 0 ? (
            <PresenceLayer participants={presencePeers} itemRects={Object.fromEntries(nodeRects)} />
          ) : null}
          {/* Anchored comments (R-comments): a pin on every item with an OPEN thread +
              the thread popover for the selected anchor. Pins render in the SAME
              world-space container as items, so nodeRects (world coords) position them
              exactly (like WalkthroughOverlay). Add/resolve go through the tested bridge. */}
          {(() => {
            const pins: CommentPin[] = allCommentReviewRows
              .filter(({ summary }) => summary.open)
              .map(({ anchorId, summary }) => ({ anchorId, rect: nodeRects.get(anchorId), summary }))
              .filter((p): p is CommentPin => !!p.rect);
            const selRect = commentAnchorId ? nodeRects.get(commentAnchorId) : null;
            const legacyThread = commentAnchorId ? commentThreadOf(graphRef.current, currentRefRef.current, commentAnchorId) : null;
            const selectedRecord = commentAnchorId ? groupRecordAddress(itemRef(currentBoardId, commentAnchorId)) : null;
            const selectedSharedEntries = selectedRecord ? sharedCommentEntries.filter(entry => entry.record === selectedRecord) : [];
            const mergedEntries = [...(legacyThread?.entries ?? []), ...selectedSharedEntries].sort((a, b) => a.at - b.at);
            const selThread = commentAnchorId && (legacyThread || selectedSharedEntries.length)
              ? { entries: mergedEntries, resolved: selectedRecord && sharedThreadResolutions[selectedRecord] !== undefined ? sharedThreadResolutions[selectedRecord] : selectedSharedEntries.length ? selectedSharedEntries.every(entry => entry.resolved) : legacyThread?.resolved ?? false }
              : null;
            if (pins.length === 0 && !commentAnchorId) return null;
            return (
              <BoardCommentsLayer
                pins={pins}
                selectedAnchorId={commentAnchorId}
                selectedRect={selRect ?? null}
                selectedThread={selThread}
                draft={commentDraft}
                onSelectPin={(id) => { setCommentAnchorId(id); setCommentDraft(''); }}
                onDraftChange={setCommentDraft}
                onAddComment={() => {
                  const text = commentDraft.trim();
                  if (!commentAnchorId || text === '') return;
                  if (addResponse && readResponseThread && readResponseSummaries) {
                    const address = groupRecordAddress(itemRef(currentBoardId, commentAnchorId));
                    void addResponse(address, text).then(async () => {
                      const thread = await readResponseThread(address);
                      setSharedCommentEntries(thread.entries);
                      setSharedThreadResolutions(current => ({ ...current, [address]: thread.resolved }));
                      setSharedCommentSummaries(await readResponseSummaries());
                      setCommentDraft('');
                    }).catch(error => console.error('[board-responses] comment could not be added', error));
                  } else {
                    void commit(addCommentToItem(graphRef.current, currentRefRef.current, commentAnchorId, { id: crypto.randomUUID(), author: 'You', text, at: Date.now() }));
                    setCommentDraft('');
                  }
                }}
                onToggleResolved={(resolved) => {
                  if (!commentAnchorId) return;
                  if (setResponseResolved) {
                    const address = groupRecordAddress(itemRef(currentBoardId, commentAnchorId));
                    void setResponseResolved(address, resolved).then(async () => {
                      setSharedThreadResolutions(current => ({ ...current, [address]: resolved }));
                      const thread = await readResponseThread?.(address);
                      if (thread) {
                        setSharedThreadResolutions(current => ({ ...current, [address]: thread.resolved }));
                        setSharedCommentEntries(thread.entries);
                      }
                      const summaries = await readResponseSummaries?.();
                      if (summaries) setSharedCommentSummaries(summaries);
                    }).catch(error => console.error('[board-responses] thread state could not be saved', error));
                  } else void commit(setItemThreadResolved(graphRef.current, currentRefRef.current, commentAnchorId, resolved));
                }}
              />
            );
          })()}
          {/* Dot-voting (Codex-ranked): a vote chip on every item with votes (read-only) and, while
              a voting round is active, a +/- on every idea gated by the voter's budget. Chips render in
              the SAME world-space container as items, so nodeRects position them exactly. Casts go
              through the tested bridge (budget enforced there) + commit(), board-undo-safe. */}
          {(() => {
            const tallies = boardTallies(nodeItems);
            const chips: VoteChip[] = tallies
              .map((t) => ({ memberId: t.id, rect: nodeRects.get(t.id), count: voteCount(t.tally), mine: t.tally[LOCAL_VOTER] ?? 0 }))
              .filter((c): c is VoteChip => !!c.rect);
            if (!votingMode && chips.every((c) => c.count === 0)) return null;
            const remaining = actorBudgetRemaining(tallies, LOCAL_VOTER, VOTE_BUDGET);
            return (
              <BoardVotesLayer
                chips={chips}
                voting={votingMode}
                budgetRemaining={remaining}
                onVote={(memberId, delta) => void commit(castVoteOnItem(graphRef.current, currentRefRef.current, memberId, LOCAL_VOTER, delta, VOTE_BUDGET))}
              />
            );
          })()}
          {/* Checklist (vision -> action): a done/total progress pill on every item that has steps
              (click to open its panel), plus the ChecklistPanel for the open item. Pills render in the
              SAME world-space container as items, so nodeRects position them exactly. Mutations go
              through the tested bridge + commit(), board-undo-safe. */}
          {(() => {
            const pills: ChecklistPill[] = boardChecklists(nodeItems)
              .map((c) => ({ memberId: c.id, rect: nodeRects.get(c.id), progress: checklistProgress(c.checklist) }))
              .filter((p) => !!p.rect && p.progress.total > 0)
              .map((p) => ({ memberId: p.memberId, rect: p.rect!, done: p.progress.done, total: p.progress.total }));
            const selRect = checklistAnchorId ? nodeRects.get(checklistAnchorId) : null;
            if (pills.length === 0 && !checklistAnchorId) return null;
            return (
              <>
                <BoardChecklistLayer
                  pills={pills}
                  onOpen={(id) => { setChecklistAnchorId(id); setChecklistDraft(''); }}
                />
                {checklistAnchorId && selRect ? (
                  <Container position="absolute" style={{ left: selRect.x + selRect.w + 12, top: selRect.y, zIndex: 60 }} {...{ [STAGE_CHROME_ATTR]: '' }}>
                    <ChecklistPanel
                      checklist={checklistOf(graphRef.current, currentRefRef.current, checklistAnchorId)}
                      draft={checklistDraft}
                      onDraftChange={setChecklistDraft}
                      onToggle={(stepId) => void commit(toggleStepOnItem(graphRef.current, currentRefRef.current, checklistAnchorId, stepId))}
                      onAdd={() => {
                        const text = checklistDraft.trim();
                        if (text === '') return;
                        void commit(addStepToItem(graphRef.current, currentRefRef.current, checklistAnchorId, { id: crypto.randomUUID(), text, done: false }));
                        setChecklistDraft('');
                      }}
                      onRemove={(stepId) => void commit(removeStepFromItem(graphRef.current, currentRefRef.current, checklistAnchorId, stepId))}
                      onClose={() => setChecklistAnchorId(null)}
                    />
                  </Container>
                ) : null}
              </>
            );
          })()}
          {/* Due dates (vision -> when): a relative-time badge on every item with a due date, tinted by
              urgency. Badges render in the SAME world-space container as items, so nodeRects position
              them exactly. Clicking a badge selects the item so its DatePicker is reachable. */}
          {(() => {
            const now = nowFrame;
            const badges: DueBadge[] = boardDueItems(nodeItems)
              .map((d) => ({ memberId: d.id, rect: nodeRects.get(d.id), rel: relativeDue(d.due, now) }))
              .filter((b) => !!b.rect)
              .map((b) => ({ memberId: b.memberId, rect: b.rect!, label: b.rel.label, urgency: b.rel.urgency }));
            if (badges.length === 0) return null;
            return <BoardDueDateLayer badges={badges} onOpen={(id) => setSelectedIds(new Set([id]))} />;
          })()}
          {/* Habits (vision -> how consistently): a streak badge on every tracked-habit item that IS the
              one-tap "log today" toggle (🔥 N, filled when today is logged). Badges render in the SAME
              world-space container as items, so nodeRects position them exactly. Toggling flows through
              the tested bridge + commit(), board-undo-safe. */}
          {(() => {
            const now = nowFrame;
            // Cadence-aware (via the shared habitBadgeOf): a 3x/week habit shows "🔥 2 · 2/3", never a false
            // "🔥 0" for lacking consecutive days. Daily habits are byte-identical (no cadence field).
            const pills: HabitPill[] = [];
            for (const it of nodeItems) {
              if (!itemIsHabitTarget(it)) continue;
              const badge = habitBadgeOf(it, now);
              const rect = nodeRects.get(it.memberId);
              if (badge === null || !rect) continue;
              pills.push({ memberId: it.memberId, rect, streak: badge.streak, loggedToday: badge.loggedToday, cadence: badge.cadence ? { done: badge.cadence.done, target: badge.cadence.target } : undefined });
            }
            if (pills.length === 0) return null;
            return (
              <BoardHabitLayer
                pills={pills}
                onToggleToday={(id) => void commit(toggleHabitToday(graphRef.current, currentRefRef.current, id, Date.now()))}
              />
            );
          })()}
          {/* Metrics (vision -> how far): a progress-bar pill on every card with a measured target (click
              to open its editor), plus the MetricPanel for the open card. Pills render in the SAME
              world-space container as items, so nodeRects position them exactly. The editor's ± stepper /
              set / clear flow through the tested bridge + commit(), board-undo-safe. */}
          {(() => {
            const pills: MetricPill[] = boardMetrics(nodeItems)
              .map((m) => ({ memberId: m.id, rect: nodeRects.get(m.id), metric: m.metric }))
              .filter((p) => !!p.rect)
              .map((p) => ({ memberId: p.memberId, rect: p.rect!, pct: progressPct(p.metric), value: formatValue(p.metric), complete: metricIsComplete(p.metric) }));
            const anchorMetric = metricAnchorId ? metricOf(graphRef.current, currentRefRef.current, metricAnchorId) : null;
            const selRect = metricAnchorId ? nodeRects.get(metricAnchorId) : null;
            if (pills.length === 0 && !metricAnchorId) return null;
            return (
              <>
                <BoardMetricLayer pills={pills} onOpen={(id) => setMetricAnchorId(id)} />
                {metricAnchorId && anchorMetric && selRect ? (
                  <AnchoredOverlay
                    open
                    anchorPoint={worldToScreen(selRect.x + selRect.w, selRect.y)}
                    placement="below"
                    gap={8}
                    draggable
                    title="Progress"
                    measureKey={camera}
                  >
                    <MetricPanel
                      metric={anchorMetric}
                      onBump={(delta) => void commit(bumpItemMetric(graphRef.current, currentRefRef.current, metricAnchorId, delta))}
                      onSetCurrent={(value) => {
                        const m = metricOf(graphRef.current, currentRefRef.current, metricAnchorId);
                        if (m) void commit(setItemMetric(graphRef.current, currentRefRef.current, metricAnchorId, metricSetCurrent(m, value)));
                      }}
                      onSetTarget={(value) => {
                        const m = metricOf(graphRef.current, currentRefRef.current, metricAnchorId);
                        if (m) void commit(setItemMetric(graphRef.current, currentRefRef.current, metricAnchorId, metricSetTarget(m, value)));
                      }}
                      onClear={() => { void commit(setItemMetric(graphRef.current, currentRefRef.current, metricAnchorId, null)); setMetricAnchorId(null); }}
                      onClose={() => setMetricAnchorId(null)}
                    />
                  </AnchoredOverlay>
                ) : null}
              </>
            );
          })()}
          {/* Effort (vision -> how much work): a total-time pill on every card with logged time (click to
              open its editor), plus the TimeLogPanel for the open card. Pills render in the SAME
              world-space container as items, so nodeRects position them exactly. Timer/quick-add/undo/
              clear flow through the tested bridge + commit(), board-undo-safe. */}
          {(() => {
            const now = nowFrame;
            const pills: TimePill[] = boardTimeLogs(nodeItems)
              .map((t) => ({ memberId: t.id, rect: nodeRects.get(t.id), log: t.log }))
              .filter((p) => !!p.rect)
              .map((p) => ({ memberId: p.memberId, rect: p.rect!, label: formatDuration(totalDurationMs(p.log)) }));
            const anchorLog = timeAnchorId ? timeLogOf(graphRef.current, currentRefRef.current, timeAnchorId) : [];
            const selRect = timeAnchorId ? nodeRects.get(timeAnchorId) : null;
            if (pills.length === 0 && !timeAnchorId) return null;
            const lastEnd = lastWorkedAtMs(anchorLog);
            return (
              <>
                <BoardTimeLayer pills={pills} onOpen={(id) => setTimeAnchorId(id)} />
                {timeAnchorId && selRect ? (
                  <AnchoredOverlay
                    open
                    anchorPoint={worldToScreen(selRect.x + selRect.w, selRect.y)}
                    placement="below"
                    gap={8}
                    draggable
                    title="Time"
                    measureKey={camera}
                  >
                    <TimeLogPanel
                      totalLabel={formatDuration(totalTimeOf(graphRef.current, currentRefRef.current, timeAnchorId))}
                      sessions={anchorLog.length}
                      lastAgoLabel={lastEnd !== null ? formatDuration(Math.max(0, now - lastEnd)) : undefined}
                      onLogSession={(startMs, durationMs) => void commit(logSession(graphRef.current, currentRefRef.current, timeAnchorId, { startMs, durationMs }))}
                      onQuickAdd={(minutes) => void commit(logMinutes(graphRef.current, currentRefRef.current, timeAnchorId, minutes, Date.now()))}
                      onRemoveLast={() => void commit(removeLastSession(graphRef.current, currentRefRef.current, timeAnchorId))}
                      onClear={() => { void commit(clearTimeLog(graphRef.current, currentRefRef.current, timeAnchorId)); setTimeAnchorId(null); }}
                      onClose={() => setTimeAnchorId(null)}
                    />
                  </AnchoredOverlay>
                ) : null}
              </>
            );
          })()}
          {/* Rollup badges (goal hierarchy): a rolled-up-progress badge on every card that HAS sub-goals
              under the board's chosen relation, plus the breakdown panel for the open one. Only when a
              rollup relation is configured (board DATA). Badges + breakdown compose relationship-graph +
              metric through the blind tree reducer; jumping to a sub-goal frames it. */}
          {(() => {
            const spec = rollupSpecFromRaw(currentBoardEntry?.rollupSpec);
            if (!spec) return null;
            const pills: RollupPill[] = [];
            for (const r of rollupParents(nodeItems, spec)) {
              const rect = nodeRects.get(r.memberId);
              if (!rect) continue;
              pills.push({
                memberId: r.memberId,
                rect,
                pct: r.result.fraction !== undefined ? Math.round(r.result.fraction * 100) : undefined,
                contributing: r.result.contributingChildCount,
                childCount: r.result.childCount,
              });
            }
            const selRect = rollupAnchorId ? nodeRects.get(rollupAnchorId) : null;
            if (pills.length === 0 && !rollupAnchorId) return null;
            const parentLabel = (() => {
              const t = nodeItems.find((it) => it.memberId === rollupAnchorId)?.text;
              const trimmed = typeof t === 'string' ? t.trim() : '';
              return trimmed !== '' ? trimmed : (rollupAnchorId ?? '');
            })();
            return (
              <>
                <BoardRollupLayer pills={pills} onOpen={(id) => setRollupAnchorId(id)} />
                {rollupAnchorId && selRect ? (
                  <Container position="absolute" style={{ left: selRect.x + selRect.w + 12, top: selRect.y, zIndex: 60 }} {...{ [STAGE_CHROME_ATTR]: '' }}>
                    <RollupPanel
                      parentLabel={parentLabel}
                      summary={rollupOfItem(nodeItems, rollupAnchorId, spec)}
                      children={rollupChildren(nodeItems, rollupAnchorId, spec)}
                      onJumpTo={(memberId) => {
                        setSelectedIds(new Set([memberId]));
                        const r = nodeRects.get(memberId);
                        if (r) frameRects([r]);
                        setRollupAnchorId(null);
                      }}
                      onClose={() => setRollupAnchorId(null)}
                    />
                  </Container>
                ) : null}
              </>
            );
          })()}
          {nodeItems.map((item) => {
            // Visibility (#149): a hidden item is removed from the canvas entirely —
            // unless the board is revealing hidden items, in which case it renders as a
            // selectable ghost (low opacity + an EyeOff chip) so it can be un-hidden.
            const isHidden = item.extra?.hidden === true;
            if (isHidden && !showHidden) return null;
            const Renderer = rendererForKind(item.kind);
            const editing = editingId === item.memberId;
            const fr = itemFrame(item);
            // Board focus = the conjunction of every active filter source (tags AND
            // search). An item is FOCUSED iff it passes them all; when any filter is
            // active, a non-focused item dims (the spatial map is preserved — Mural/
            // FigJam canon — instead of hiding/reflowing). The dim wins over the item's
            // own #116 opacity; with no filter, the item's own opacity (if any) applies.
            const focused = boardFocusMatch(item, focusFacets, searchQuery);
            const dimmed = (hasActiveFacets(focusFacets) || searchQuery.trim() !== '') && !focused;
            return (
              <CanvasNode
                key={item.memberId}
                x={item.x}
                y={item.y}
                width={item.w}
                height={item.h}
                // Free rotation rides self-describing DATA (`extra.rotation`); the
                // blind CanvasNode applies the angle about its center (absent → none).
                rotation={Number(item.extra?.rotation) || undefined}
                // Flip rides self-describing DATA (`extra.flipX`/`extra.flipY`); the
                // blind CanvasNode mirrors the node in its own frame (absent → none).
                flipX={item.extra?.flipX === true || undefined}
                flipY={item.extra?.flipY === true || undefined}
                // Opacity rides the stack-root `frame.opacity` DATA (same path as the
                // #90 corner/border control); the blind CanvasNode fades the content
                // only (the selection ring stays crisp). Absent → fully opaque.
                opacity={dimmed ? 0.12 : isHidden ? 0.4 : typeof fr?.opacity === 'number' ? fr.opacity : undefined}
                // Geometric shape (#213): the chosen `extra.shape` now renders as a
                // bbox-FILLING path via the `ui` CanvasShape primitive inside the item
                // renderer (live == export), NOT a content clip — so a circle fills its
                // box instead of collapsing into a dome. The CanvasNode no longer clips.
                // The universal addressed handle → stamps `data-node-ref` so the
                // generic marquee (refsInRect) and node-action layers can find &
                // address this item with ZERO board-specific hit-testing.
                nodeRef={{ family: BOARD_ITEM_FAMILY, parts: { member: item.memberId } }}
                // A card drawn from a source shows a dot per kind of line it sends (right) and takes (left), in that
                // kind's colour, where its typed connectors attach (board-source.ts).
                ports={sourcePortsOf(item)}
                dataAttributes={responseSpaceId
                  ? { 'data-response-record': groupRecordAddress(itemRef(currentBoardId, item.memberId)) }
                  : { 'data-share-record': groupRecordAddress(itemRef(currentBoardId, item.memberId)) }}
                // Screen-reader accessibility (Codex gap #5): every node announces a meaningful
                // name ("Note: buy milk" / "Link: example.com") + its selection state via the pure
                // `nodeAriaLabel` SSOT, as a labelled `group`. So assistive tech reads the board
                // instead of anonymous boxes. role="group" names a region without claiming a
                // keyboard-widget semantic the board's taken keymap can't fulfil.
                ariaRole="group"
                ariaLabel={nodeAriaLabel(item, { selected: selectedIds.has(item.memberId) })}
                // Selection chrome is the generic node ring (Figma/Miro canon) —
                // crisp accent outline, never a card-background swap. Drop-target
                // also shows the ring (signals "drop here").
                selected={selectedIds.has(item.memberId) || dropTargetId === item.memberId}
                // A locked item shows a small muted padlock chip in the top-right
                // corner (Mobbin canon: Adobe Express / IKEA / Figma) so "why won't
                // this move?" is answered at a glance. Driven purely by the DATA flag.
                cornerAdornment={
                  isHidden ? (
                    <Badge variant="muted" size="sm" aria-label="Hidden">
                      <Icon icon={EyeOff} size="xs" />
                    </Badge>
                  ) : itemIsLocked(item) ? (
                    <Badge variant="muted" size="sm" aria-label="Locked">
                      <Icon icon={Lock} size="xs" />
                    </Badge>
                  ) : sourceStateOf(item) ? (
                    // A card drawn from a source (board-source.ts) shows its record's live state, in the words and
                    // tone the source gives (a workflow step working, done or stuck), changing as the record does.
                    <Badge variant={badgeVariantForSourceTone(sourceStateOf(item)!.tone)} size="sm" data-source-state={sourceStateOf(item)!.pulse ? 'live' : 'still'}>
                      {sourceStateOf(item)!.label}
                    </Badge>
                  ) : null
                }
                // A linked item shows a clickable source chip in the bottom-left
                // corner (Pinterest/Milanote canon: "↗ host") that opens the source
                // in a new tab — read purely from the `extra.href` DATA (absent →
                // nothing). It stops propagation so a click opens the link instead of
                // starting a node drag/select.
                cornerActions={(() => {
                  // Called as a plain function (not JSX) so the no-chip case stays
                  // `null` and CanvasNode renders NO overlay wrapper (same as before).
                  const boardLinkId = itemBoardLink(item);
                  const boardTarget = boardLinkId ? boards.find((b) => b.boardId === boardLinkId) : undefined;
                  return NodeCornerActions({
                    branchToggle: branchToggles.get(item.memberId),
                    onToggleBranch: (collapse) =>
                      void commit(setBranchHidden(graphRef.current, currentRefRef.current, item.memberId, collapse)),
                    href: itemHref(item) || null,
                    onOpenLink: openExternalHref, // #210: anchor-click, never navigates the shell frame
                    boardLinkTitle: boardTarget?.title ?? null,
                    onOpenBoardLink: () => {
                      if (boardTarget) switchBoard(boardTarget.boardId);
                    },
                    actions: sourceActionsOf(item),
                    ...(onSourceAction ? { onAction: (actionId: string) => onSourceAction(item, actionId) } : {}),
                  });
                })()}
                appearDelayMs={appearDelays.get(item.memberId)}
                isDragging={dragRef.current?.memberId === item.memberId}
                // Locked → 'default' cursor (signals not-draggable); else grab.
                cursor={editing ? 'text' : activeEmbeddedSurfaceId === item.memberId ? 'default' : itemIsLocked(item) ? 'default' : 'grab'}
                // While editing OR while this node is the active embedded surface, the
                // node yields pointer events to its content (no canvas drag start).
                onPointerDown={(editing || activeEmbeddedSurfaceId === item.memberId) ? undefined : (e) => beginItemDrag(e, item)}
                // A section drills in; any other item opens its inline editor.
                onDoubleClick={() => {
                  // Section → drill in; image → enter CROP mode; note → inline edit.
                  if (item.isSection) { drillInto(item); return; }
                  if (!itemIsLocked(item) && !!item.src && boardItemContentType(item).startsWith('image/')) {
                    setEditingId(null);
                    setCropTargetId(item.memberId);
                    return;
                  }
                  // A live-feed node with a drilldown console configured → OPEN the
                  // tabbed console overlay SCOPED to this node's record, INSTEAD of
                  // entering the glanceable card. The scope is DERIVED from the node's
                  // OWN `placeableSurface.surfaceInput` (the SAME id the card renders
                  // with — SSOT, no stored/lagging duplicate), so it works for every
                  // existing member with zero re-seed. This is "click a worker → its
                  // console opens": the card stays a clean identity tile; the console is
                  // the big multi-tab surface. Guarded on `consoleDrilldown` so a board
                  // with no console config keeps the normal enter-embedded path.
                  {
                    const surf = consoleDrilldown ? readPlaceableSurface(item) : null;
                    const cardInput = surf?.surfaceInput;
                    if (
                      consoleDrilldown &&
                      cardInput &&
                      typeof cardInput === 'object' &&
                      !Array.isArray(cardInput)
                    ) {
                      const firstIdValue = Object.values(cardInput).find((v) => typeof v === 'string' && v.trim().length > 0);
                      const label = item.text?.trim()
                        ? item.text.trim()
                        : (typeof firstIdValue === 'string' ? firstIdValue : 'Worker');
                      setEditingId(null);
                      setSelectedIds(new Set([item.memberId]));
                      setOpenConsole({
                        label,
                        // The card's surfaceInput carries the record id (e.g. { agentId }).
                        // The console's tabs each read the scope key they know (agent-card
                        // → agentId; execution-history → agentId/subjectRef) — one shared
                        // subject, blindly forwarded; a `label` rides along for the header.
                        surfaceInput: { tabs: consoleDrilldown.tabs, subject: { ...cardInput, label } },
                      });
                      return;
                    }
                  }
                  // A live placeable surface → ENTER embedded mode (the surface gets its
                  // own pointer events) instead of a note editor. Select it so the
                  // selection-sync effect auto-exits when focus leaves; Esc also exits.
                  if (readPlaceableSurface(item)) {
                    setEditingId(null);
                    setSelectedIds(new Set([item.memberId]));
                    setActiveEmbeddedSurfaceId(item.memberId);
                    return;
                  }
                  setEditingId(item.memberId);
                }}
                // Right-click an item → its style/layers editor at the cursor (the
                // board-card equivalent of a container's layers popover).
                onContextMenu={
                  item.isSection
                    ? undefined
                    : (e) => {
                        // Stop the parent region's context menu from also catching
                        // this — the ITEM's own style menu must win on an item.
                        e.preventDefault();
                        e.stopPropagation();
                        openStyle(item.memberId, { x: e.clientX, y: e.clientY });
                      }
                }
                // Any item (unless locked) resizes from ANY edge/corner —
                // invisible strips, cursor-only on hover. Resize stays available
                // WHILE a note's text is focused (Figma/FigJam parity: you can
                // always grab a selected item's handles). The strips stop
                // propagation + sit at the 9px edges, so they never steal a text
                // click. Gating on `!editing` was the bug that made a note stuck
                // in edit mode un-resizable.
                onResizeStart={
                  !itemIsLocked(item) ? (e, edge) => beginItemResize(e, item, edge) : undefined
                }
              >
                <Renderer
                  item={item}
                  selected={selectedIds.has(item.memberId) || dropTargetId === item.memberId}
                  editing={editing}
                  embeddedActive={activeEmbeddedSurfaceId === item.memberId}
                  noteCommands={noteCommands}
                  onEditHtml={(html, text) =>
                    // Typing has native in-note undo; don't flood the board history
                    // with a step per keystroke (it would bury delete/move steps).
                    void commit(patchItem(graphRef.current, currentRefRef.current, item.memberId, { html, text }), graphRef.current, { undoable: false })
                  }
                  // Id-scoped so a DEFERRED end (the editor waits a frame for focus to
                  // settle before deciding a portaled popover really left the session)
                  // can never clear a DIFFERENT note that started editing in the meantime.
                  onEndEdit={() => setEditingId((cur) => (cur === item.memberId ? null : cur))}
                  onAutoHeight={autoHeightNote}
                  boardAppearance={currentBoardAppearance}
                  markerCatalog={markerCatalog}
                  revealText={revealMemberIds.has(item.memberId) ? item.text : undefined}
                  highlightQuery={searchQuery.trim() !== '' ? searchQuery : undefined}
                />
              </CanvasNode>
            );
          })}
          {/* Multi-select bounding box + group-resize handles (≥2 items). Drag a
              corner to scale the whole selection (Shift = aspect-preserving), an
              edge to scale one axis — one undoable transaction. */}
          {groupBounds ? (
            <SelectionBoundsOverlay bounds={groupBounds} zoom={camera.zoom} onHandleDown={beginGroupResize} />
          ) : null}
          {/* Alignment guides paint ON TOP of the items (Figma canon) — magenta
              lines shown live while a drag is snapping; empty otherwise. */}
          <SnapGuideLayer guides={snapGuides} zoom={camera.zoom} />
          {/* Selection dimension pill — live W×H (one item) / N-selected (group),
              below the selection bounds; empty when nothing is selected. */}
          <SelectionHud bounds={hud.bounds} label={hud.label} zoom={camera.zoom} />
          {/* Free-rotation grip — a circular handle above a single selected item's
              top edge (Figma/Canva canon). Drag to rotate (Shift snaps to 15°); the
              angle persists as `extra.rotation` DATA. Hidden for multi-select/locked. */}
          <RotateHandle
            rect={rotateTarget?.rect ?? null}
            rotation={rotateTarget?.rotation ?? 0}
            zoom={camera.zoom}
            onRotateStart={(clientX, clientY, pointerId, target) => {
              if (!rotateTarget) return;
              const center = {
                x: rotateTarget.rect.x + rotateTarget.rect.w / 2,
                y: rotateTarget.rect.y + rotateTarget.rect.h / 2,
              };
              beginRotate(rotateTarget.memberId, center, clientX, clientY, pointerId, target);
            }}
            onReset={() => {
              if (!rotateTarget || rotateTarget.rotation === 0) return;
              void commit(patchItem(graphRef.current, currentRefRef.current, rotateTarget.memberId, { rotation: 0 }));
            }}
          />
          {/* Group-rotation grip — the SAME RotateHandle over the selection box when
              ≥2 items are selected. The box is axis-aligned (rotation=0); dragging spins
              the whole selection about its centre (each item orbits + spins by Δ).
              Mutually exclusive with the single-item grip (selection count). */}
          {selectedIds.size >= 2 && groupBounds ? (
            <RotateHandle
              rect={groupBounds}
              rotation={0}
              zoom={camera.zoom}
              onRotateStart={(clientX, clientY, pointerId, target) =>
                beginGroupRotate(clientX, clientY, pointerId, target)
              }
            />
          ) : null}
          {/* Image crop mode — a dimmed surround + crop window with 8 handles over the
              double-clicked image. Dragging a handle resizes `extra.crop` (normalized);
              Done / double-click the window / Escape commits & exits. */}
          {(() => {
            if (!cropTargetId) return null;
            const it = readItems(graph, currentRef).find((i) => i.memberId === cropTargetId);
            if (!it || !it.src) return null;
            const cropWin = isCrop(it.extra?.crop) ? (it.extra.crop as Crop) : FULL_CROP;
            return (
              <CropOverlay
                item={{ x: it.x, y: it.y, w: it.w, h: it.h }}
                crop={cropWin}
                zoom={camera.zoom}
                onHandleDown={(e, handle) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const item = readItems(graphRef.current, currentRefRef.current).find((i) => i.memberId === cropTargetId);
                  if (!item) return;
                  gestureBeforeRef.current = graphRef.current;
                  const world = screenToWorld(e.clientX, e.clientY);
                  const startCrop = isCrop(item.extra?.crop) ? (item.extra.crop as Crop) : FULL_CROP;
                  cropDragRef.current = { memberId: cropTargetId, edge: handle, startCrop, itemW: item.w, itemH: item.h, grabX: world.x, grabY: world.y, cropped: false };
                  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                  setGrabbing(true);
                }}
                onDone={() => setCropTargetId(null)}
              />
            );
          })()}
        </CanvasWorldTransform>
        {/* Drawing tools (addressed-marks) over the board world — group owns the
            camera/geometry, addressed-marks owns the ink. Inert until the floating
            toolbar turns drawing on, so it never blocks pan/drag. */}
        <DrawToolBinder active={toolApi.activeToolId === 'draw'} />
        <BoardMarkLayers stageRef={stageRef} camera={camera} screenToWorld={screenToWorld} boardId={currentBoardId} onDone={() => toolApiRef.current.setActiveTool('move')} />
        {/* Overview minimap (#123) — a bottom-right window onto the whole board:
            every item as a dot-rect + the current viewport outline, click/drag to
            jump. The exact answer to the dense-board "where am I / where's that
            item" problem. Appears once the board is big enough to wander (toggle
            with "M"). Pure composition of the generic CanvasMinimap primitive. */}
        {minimapOpen && minimapFrames.length >= 6 && viewportSize.w > 0 ? (
          <CanvasMinimap
            corner="bottom-right"
            frames={minimapFrames}
            panX={camera.panX}
            panY={camera.panY}
            zoom={camera.zoom}
            viewportWidth={viewportSize.w}
            viewportHeight={viewportSize.h}
            selectedId={selectedIds.size === 1 ? [...selectedIds][0] : null}
            onJump={jumpToWorld}
          />
        ) : null}
        {/* R42b Walkthrough overlay — mounted HERE in the HUD layer (after the minimap)
            rather than inside the world transform, so its buttons paint above the minimap
            and receive clicks even over the bottom-right minimap zone. `project` converts
            the target's world rect to screen coords so the spotlight ring still grips the
            drawn note (world→screen: x*zoom+pan). */}
        {tourIndex !== null ? (() => {
          const runningTour = activeTour ?? boardTour;
          const target = runningTour.steps[tourIndex]?.target;
          const frame = target ? nodeRects.get(target) : undefined;
          return (
            <WalkthroughOverlay
              tour={runningTour}
              index={tourIndex}
              targetRect={frame}
              // R34a: the spotlight grips the card as DRAWN, not the member frame —
              // measured from the target's stamped data-node-ref element (offset
              // geometry, world space; falls back to the frame when unmeasurable).
              renderedRect={target && frame
                ? renderedTargetRect(
                    stageRef.current,
                    serializeNodeRef({ family: BOARD_ITEM_FAMILY, parts: { member: target } }),
                    frame,
                  )
                : undefined}
              project={(r) => ({
                x: r.x * camera.zoom + camera.panX,
                y: r.y * camera.zoom + camera.panY,
                w: r.w * camera.zoom,
                h: r.h * camera.zoom,
              })}
              onNext={() => setTourIndex((i) => (i === null ? null : tourNext(runningTour, i)))}
              onPrev={() => setTourIndex((i) => (i === null ? null : tourPrev(runningTour, i)))}
              onClose={() => { setTourIndex(null); setActiveTour(null); }}
            />
          );
        })() : null}
        {/* #169 Present mode — walk the board's frames as a story path. The pure
            present controller owns the index + camera; this blind bar renders the
            position + routes ◀ ▶ ✕. Shown only while presenting; if the deck emptied
            underneath us (frame deleted) the controller collapses to null. */}
        {presentIndex !== null && frames.length > 0 ? (
          <CanvasPresentBar
            index={Math.min(presentIndex, frames.length - 1)}
            total={frames.length}
            title={frames[Math.min(presentIndex, frames.length - 1)]?.text ?? ''}
            caption={presentationCaptionOf(frames[Math.min(presentIndex, frames.length - 1)]) ?? undefined}
            atFirst={presentIndex <= 0}
            atLast={presentAtLast}
            onPrev={() => goPresent(-1)}
            onNext={() => goPresent(1)}
            onExit={exitPresent}
          />
        ) : null}
        {/* "?" keyboard-shortcuts cheat sheet (#134) — the discoverability layer
            for the whole keyboard layer. Blind ui ShortcutSheet rendering the
            board's DATA catalog; FloatingPanel owns Escape/× close. */}
        <ShortcutSheet
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
          title="Keyboard shortcuts"
          groups={BOARD_SHORTCUTS}
        />
        {/* ⌘K command palette (#171) — the keyboard-first launcher over the board's
            live action catalog (BatchActionCapability rows + board commands), all as
            blind DATA. Opens with ⌘K; FloatingPanel owns Escape close. */}
        {sourceAdds ? (
          // The source's palette: what it can add, searched by the source as the person types, added where they look.
          <CommandPalette
            open={addsOpen}
            onClose={() => setAddsOpen(false)}
            placeholder={sourceAdds.placeholder ?? sourceAdds.label}
            onQueryChange={setAddsWords}
            items={addsRows.map(row => ({ ...row, run: () => sourceAdds.add(row.id, viewportCenterRef.current(), addsWords) }))}
          />
        ) : null}
        <CommandPalette
          open={commandOpen}
          onClose={() => setCommandOpen(false)}
          items={commandItems}
          onChoose={item => coachShortcut((item as { command?: string }).command)}
          placeholder="Search actions…"
        />
      </CanvasViewport>

      <FloatingPanel open={exportOpen && nodeItems.length > 0} onClose={() => setExportOpen(false)} title="Export board" width={576}>
        <BoardExportPanel items={exportItems} now={nowFrame} title={currentBoardTitle} tree={{ graph, rootRef: currentRef }} destinations={getBoardExportDestinationsWithTargets(readPublishedRecords(publishedRecordsRaw), askText)} imageExports={boardImageExports} onNotice={showNotice} onClose={() => setExportOpen(false)} />
      </FloatingPanel>

      <FloatingPanel open={carouselOpen} onClose={() => setCarouselOpen(false)} title="Presentation frames" width={1000}>
        {publishFrameMedia ? (
          <Container layout="vertical" gap="xs" padding="sm">
            <Container layout="horizontal" gap="xs" wrap alignItems="center">
              <Button variant="secondary" size="sm" disabled={publishingFrames || Boolean(framePublication)} onClick={() => publishFrames()}>
                {publishingFrames ? 'Sharing images…' : framePublication ? 'Images shared' : 'Share frame images'}
              </Button>
              {framePublication ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => copyTextToClipboard(framePublication.pageUrl).then(copied => showNotice(copied ? 'Link copied' : 'Could not copy link', copied ? 'success' : 'error'))}>Copy link</Button>
                  <Button variant="ghost" size="sm" onClick={() => stopFramePublication()}>Stop sharing</Button>
                </>
              ) : null}
            </Container>
            {framePublication ? <Text variant="body-xs">Saved image link: {framePublication.pageUrl}</Text> : null}
          </Container>
        ) : null}
        <MediaCarousel
          ariaLabel="Presentation frames in story order"
          items={carouselItems}
          showLabels
          showControls
          showEdgeFade
          renderItem={(item) => (
            <div className="bf-media-carousel__frame">
              <img
                alt={item.alt}
                className="bf-media-carousel__media"
                decoding="async"
                src={item.src}
                style={{ aspectRatio: 'auto', height: 'auto', maxHeight: 'min(58vh, 560px)', objectFit: 'contain' }}
              />
              {item.label ? (
                <div className="bf-media-carousel__label">
                  <strong>{item.label}</strong>
                </div>
              ) : null}
            </div>
          )}
        />
      </FloatingPanel>

      {/* DRILLDOWN CONSOLE — the tabbed worker tool surface opened by double-clicking a
          node that carries a `consoleSubject`. The shared FloatingPanel keeps the board
          usable while its blind PlaceableSurfaceHost mounts `consoleDrilldown.surface`
          with `{ tabs, subject }`. The console owns its tab strip + per-tab surfaces. */}
      {openConsole && consoleDrilldown ? (
        <FloatingPanel
          open
          onClose={() => setOpenConsole(null)}
          title={openConsole.label}
          kind="group-worker-console"
          width={1100}
        >
          <Container style={{ width: 'min(82vw, 1060px)', height: 'min(70vh, 720px)', minWidth: 360, minHeight: 260, position: 'relative' }}>
            <PlaceableSurfaceHost
              packageName={consoleDrilldown.surface.packageName}
              entryName={consoleDrilldown.surface.entryName}
              surfaceInput={{ frame_fit: 'fill', ...openConsole.surfaceInput }}
              fill
              interactive
            />
          </Container>
        </FloatingPanel>
      ) : null}

      {/* R13 — the sparring verdict for the selected text cards. Floats bottom-right; a
          Close button dismisses it. Only opens when 2+ text cards were selected and Spar
          was pressed (and auto-hides if the selection drops below two). */}
      {showSparring && sparringDrafts.length >= 2 ? (
        <Container position="absolute" style={{ right: 16, bottom: 16, maxWidth: 300, zIndex: 20 }}>
          <Card variant="popover" padding="md">
            <Container layout="vertical" gap="sm">
              <DraftSparringView drafts={sparringDrafts} onKeepWinner={keepWinnerDrafts} />
              <Button variant="ghost" size="sm" aria-label="Close sparring" onClick={() => setShowSparring(false)}>
                Close
              </Button>
            </Container>
          </Card>
        </Container>
      ) : null}

      {/* Single-note text affordances (bottom-right, mutually exclusive with 2+ sparring):
          R14 Refine (cut→rewrite→keep best) for any text note, and R3 Outline (indent/outdent/
          reorder rows) for a multi-line note. The launcher chips show only when neither editor
          is open; each editor floats in the same slot and writes back onto the note. */}
      {refineTarget && !showRefine && !outlineEdit ? (
        <Container position="absolute" layout="horizontal" gap="xs" style={{ right: 16, bottom: 16, zIndex: 20 }}>
          <Button variant="ghost" size="sm" aria-label="Refine this note's writing" onClick={() => setShowRefine(true)}>
            Refine writing
          </Button>
          {outlineCandidate ? (
            <Button variant="ghost" size="sm" aria-label="Edit this note as an outline" onClick={() => setOutlineEdit({ id: outlineCandidate.id, items: parseOutline(outlineCandidate.text), marker: outlineCandidate.marker, multiLevel: outlineCandidate.multiLevel })}>
              Outline
            </Button>
          ) : null}
        </Container>
      ) : null}
      {refineTarget && showRefine ? (
        <Container position="absolute" style={{ right: 16, bottom: 16, maxWidth: 300, zIndex: 20 }}>
          <Card variant="popover" padding="md">
            <Container layout="vertical" gap="sm">
              <RewriteLoopView draft={refineTarget.text} onUseVersion={(text) => useRewriteVersion(refineTarget.id, text)} />
              <Button variant="ghost" size="sm" aria-label="Close refine" onClick={() => setShowRefine(false)}>
                Close
              </Button>
            </Container>
          </Card>
        </Container>
      ) : null}
      {outlineEdit ? (
        <Container position="absolute" style={{ right: 16, bottom: 16, maxWidth: 360, zIndex: 20 }}>
          <Card variant="popover" padding="md">
            <Container layout="vertical" gap="sm">
              <ListBlockEditor items={outlineEdit.items} onChange={(items) => setOutlineEdit({ ...outlineEdit, items })} />
              {/* R3 in-flow marker: pick the bullet/number right here; the preview shows the
                  marked, per-level-numbered result before Apply. '' = No marker. */}
              <Container layout="horizontal" gap="xs" alignItems="center">
                <MarkerPicker value={outlineEdit.marker} includeNone markers={markerCatalog} onPick={(markerId) => setOutlineEdit({ ...outlineEdit, marker: markerId })} />
                {/* Multi-level: each nesting level gets its own marker (1. → a) → i.), the legal-
                    outline convention — one toggle, no per-level picking needed. */}
                <Button
                  variant={outlineEdit.multiLevel ? 'primary' : 'ghost'}
                  size="sm"
                  aria-label="Toggle multi-level outline numbering"
                  aria-pressed={outlineEdit.multiLevel}
                  onClick={() => setOutlineEdit({ ...outlineEdit, multiLevel: !outlineEdit.multiLevel })}
                >
                  Multi-level (1. a. i.)
                </Button>
              </Container>
              <OutlineDisplay
                text={serializeOutline(outlineEdit.items)}
                marker={markerById(outlineEdit.marker || undefined, markerCatalog)}
                levelMarkers={outlineEdit.multiLevel ? resolveLevelMarkers([...DEFAULT_OUTLINE_MARKER_IDS], markerCatalog) : undefined}
              />
              <Container layout="horizontal" gap="xs">
                <Button variant="primary" size="sm" aria-label="Apply the outline to the note" onClick={() => applyOutline(outlineEdit.id, outlineEdit.items, outlineEdit.marker, outlineEdit.multiLevel)}>
                  Apply
                </Button>
                <Button variant="ghost" size="sm" aria-label="Close outline" onClick={() => setOutlineEdit(null)}>
                  Close
                </Button>
              </Container>
            </Container>
          </Card>
        </Container>
      ) : null}

      {/* #33 immersive: the selected media opens large in a movable, resizable
          panel beside the board; the board stays usable. Content-blind — the
          panel never inspects the MediaFrame inside it. */}
      <FloatingPanel open={!!immersiveItem?.src} onClose={() => setImmersiveId(null)} label={immersiveItem?.text ?? 'Board media'} width={1024}>
        {immersiveItem?.src ? (
          <MediaFrame
            url={immersiveItem.src}
            mediaType={boardItemContentType(immersiveItem)}
            label={immersiveItem.text ?? 'Board media'}
          />
        ) : null}
      </FloatingPanel>

      {/* Per-item STYLE editor — opens in the SAME click-anchored glass popover a
          container/region uses (ui/ NodeContextMenu), right where you clicked. */}
      {styleMenu.contextMenu}
      {/* #140: the EMPTY-canvas context menu (Paste here / Add note / Select all),
          opened imperatively for the synthetic board-root ref on right-click of
          bare canvas. Same ui/ NodeContextMenu primitive as the item menu. */}
      {canvasMenu.contextMenu}

      {/* In-app text input — replaces window.prompt (dead in the macOS WKWebView) so
          producer tools / link / Paste as cards / new-board / rename all work in any shell. */}
      <TextInputModal request={inputRequest} />
      <ActionAffordanceEditor
        open={actionEditorOpen}
        onClose={() => setActionEditorOpen(false)}
        runId={actionEditorRunId}
        initialDraft={actionEditorEdit?.draft ?? null}
        definitionOptions={affordanceDefinitionOptions}
        channelOptions={affordanceChannelOptions}
        onSave={saveAuthoredAction}
      />

      {/* Item #15: the shared BLIND multi-field action form on the board. A tool with
          `formFields` (an action-affordance's ask.fields) opens this instead of the
          single-text produce ask; submit re-enters addItem with the answers (which
          compose the producer prompt), and Save-as-preset curries them into a new
          reusable action. Same form host + preset primitive the composition surface uses. */}
      {affordanceForm ? (
        <ActionForm
          open
          title={affordanceForm.tool.formTitle ?? affordanceForm.tool.label}
          fields={affordanceForm.tool.formFields ?? []}
          optionsFor={boardAffordanceFieldOptions}
          submitLabel={affordanceForm.tool.formSubmitLabel ?? 'Run'}
          onCancel={() => setAffordanceForm(null)}
          onSubmit={(answers) => {
            const form = affordanceForm;
            setAffordanceForm(null);
            if (form) void addItem(form.tool, answers);
          }}
          onSavePreset={(name, answers) => {
            void saveActionPreset(affordanceForm?.tool.affordanceRecord, answers, name);
          }}
          onMaterialize={materializeActionFormFile}
        />
      ) : null}

      {/* Lane E: the generic edit sidebar (alt-click an item). Right rail overlay;
          data-floating-layer inside the sidebar keeps edit sessions alive (#211). */}
      <FloatingPanel open={inspectSources !== null} onClose={() => setInspectSources(null)} title="Edit details" width={320}>
        <InspectorSidebar
          sources={inspectSources ?? []}
          loadRecord={loadInspectionRecord}
          dispatchWrite={dispatchInspectionWrite}
          onClose={() => setInspectSources(null)}
          title={null}
        />
      </FloatingPanel>

      {/* #145: transient export/copy confirmation — "Copied to clipboard" /
          "Exported as SVG" / error / empty. Self-contained (no ToastProvider),
          auto-dismissed by showNotice's timer. #208: pinned BOTTOM-center so it
          never covers the always-present top toolbar (Note/Media/Section/export);
          bottom-center is the canonical transient-toast location. */}
      <Notice text={notice?.text ?? null} tone={notice?.tone} action={notice?.action} placement="bottom-center" />

      {/* Templates & saved layouts — the full Saved Arrangement Library (built-in
          templates + the user's saved collections + board snapshots), read live from
          `graph`. Use applies onto a fresh board; the footer saves THIS board into the
          library; rename/archive/duplicate route to the DATA-keyed manage controller. */}
      <SavedArrangementGallery
        open={templatesOpen}
        arrangements={readSavedArrangementLibrary(graph, cidx, { includeTemplates: true, lensCatalog: arrangementLensCatalog })}
        onAction={onLibraryAction}
        onClose={() => setTemplatesOpen(false)}
        title="Templates & saved layouts"
        description="Start from a template, or reuse a layout you saved"
        onSaveCurrent={saveCurrentBoardToLibrary}
      />

      {/* One opt-in selection inspector. A card click produces only the compact
          "N selected" trigger; opening it reveals Basic / Relations / Arrange /
          Analyze disclosures. This replaces the former automatic right rail,
          bottom batch bar, and bottom-left relation card. */}
      {/* R53: HIDE the tools rail while a note is being EDITED. Editing a card also selects
          it, so this heavy analytics/smart-set panel used to slam open the instant the user
          started writing ("this menu on the right appeared, it felt so overwhelming, why is it
          appearing immediately"). Writing is a focus task — the rail returns the moment editing
          ends and the card is still selected. */}
      {boardSelectionChromeVisible({ hasSelection: selectedIds.size >= 1, editing: !!editingId, explicitlyOpened: selectionInspectorOpen }) ? (
        <Container position="absolute" style={{ right: 12, top: 72, zIndex: 61, ...(selectionInspectorOpen ? { width: 300, maxHeight: 'calc(100% - 88px)', overflowY: 'auto' } : {}) }}>
          {selectionInspectorOpen ? (
            <Card variant="popover" padding="none">
          <BoardToolsPanel
            items={nodeItems}
            selectedIds={[...selectedIds]}
            pinnedIds={pinnedToolIds}
            onClear={() => { setSelectedIds(new Set()); setSelectionInspectorOpen(false); }}
            primaryControls={(
              <Container layout="horizontal" gap="xs" wrap>
                <SelectedItemToolbar
                  selectedItem={selectedItem}
                  boards={boards}
                  currentBoardId={currentBoardId}
                  markerCatalog={markerCatalog}
                  multipleNodesSelected={multipleNodesSelected}
                  showMoveOut={!!parentRef && selectedIds.size > 0}
                  onView={setImmersiveId}
                  onOpenStyle={openStyle}
                  onSetLink={(memberId, current) => void setItemLink(memberId, current)}
                  onSetBoardLink={setItemBoardLink}
                  onSetItemAppearance={setItemAppearanceKey}
                  onSetMarker={setItemMarker}
                  onArrange={arrangeSelection}
                  onComment={(memberId) => { setCommentAnchorId(memberId); setCommentDraft(''); }}
                  onChecklist={(memberId) => { setChecklistAnchorId(memberId); setChecklistDraft(''); }}
                  onSetDueDate={(memberId, dueMs) => void commit(setItemDueDate(graphRef.current, currentRefRef.current, memberId, dueMs))}
                  onLogHabitToday={(memberId) => void commit(toggleHabitToday(graphRef.current, currentRefRef.current, memberId, Date.now()))}
                  onSetMetric={(memberId) => {
                    if (metricOf(graphRef.current, currentRefRef.current, memberId) === null) {
                      void commit(setItemMetric(graphRef.current, currentRefRef.current, memberId, { current: 0, target: 10 }));
                    }
                    setMetricAnchorId(memberId);
                  }}
                  onLogTime={(memberId) => setTimeAnchorId(memberId)}
                  onEditLinkCard={(memberId) => void setItemLinkPreview(memberId)}
                  onSetTags={(memberId, current) => void setItemTags(memberId, current)}
                  onMoveOut={moveSelectedOut}
                  onRenameSection={(memberId, current) => void renameItem(memberId, current)}
                  onUngroupSection={ungroupSelected}
                  {...(openAsDocument ? { openAsDocument: { label: openAsDocument.label, run: openNoteAsDocument } } : {})}
                />
              </Container>
            )}
            relationControls={primaryId &&
              (relationGraph.out[primaryId]?.length ?? 0) + (relationGraph.inc[primaryId]?.length ?? 0) > 0 ? (
                <RelationInspector
                  graph={relationGraph}
                  memberId={primaryId}
                  titleOf={titleForMember}
                  onSelectImpact={(memberIds) => {
                    setSelectedIds(new Set(memberIds));
                    const rs = memberIds
                      .map((id) => nodeRects.get(id))
                      .filter((r): r is NonNullable<typeof r> => Boolean(r));
                    if (rs.length) frameRects(rs);
                  }}
                />
              ) : undefined}
            batchControls={(
              <Container layout="vertical" gap="xs">
                <BulkSelectBar
                  placement="top"
                  selectedCount={selectedIds.size}
                  onClearAll={() => setSelectedIds(new Set())}
                  maxInline={0}
                  actions={batchActions.map((a) => ({
                    label: a.label,
                    variant: a.tone ? ('danger' as const) : ('default' as const),
                    onClick: () => void a.run?.(selectedRefs, { primary: selectedRefs[selectedRefs.length - 1] ?? null }),
                  }))}
                />
                <Container layout="horizontal" gap="xs" wrap>
                  {fillTargets.length > 0 ? <BoardFillControls color={fillAnchorColor} onPick={fillSelected} /> : null}
                  {fillTargets.length > 0 ? <BoardShapeControls shape={shapeAnchor} onPick={shapeSelected} /> : null}
                  {fillTargets.length > 1 ? (
                    <ItemStylePicker
                      itemExtra={undefined}
                      onSet={styleSelected}
                      scopeLabel={`These ${fillTargets.length} notes`}
                      ariaLabel="Note look — style, text size, density for the selected notes"
                    />
                  ) : null}
                  {singleConnector ? (
                    <ConnectorFormatControls
                      color={singleConnector.color}
                      dashed={singleConnector.dashed}
                      arrow={(singleConnector.arrow ?? 'end') as ConnectorArrow}
                      routing={(singleConnector.routing ?? 'straight') as ConnectorRouting}
                      thickness={singleConnector.thickness}
                      hasBends={(singleConnector.waypoints?.length ?? 0) > 0}
                      onAddBend={() => onConnectorAddBend(singleConnector.memberId)}
                      onClearBends={() => onConnectorClearBends(singleConnector.memberId)}
                      onPatch={(patch, opts) => void commit(
                        patchItem(graphRef.current, currentRefRef.current, singleConnector.memberId, patch),
                        graphRef.current,
                        {
                          undoable: opts?.undoable !== false,
                          // A finished live gesture (colour wheel) is ONE step back to the values from
                          // when the gesture began, not to the last preview.
                          ...(opts?.from ? { stepFrom: patchItem(graphRef.current, currentRefRef.current, singleConnector.memberId, opts.from) } : {}),
                        },
                      )}
                    />
                  ) : null}
                  {presetPickerOpen ? <SavedPresetsRow presets={savedPresets} onApply={applyPreset} /> : null}
                  {aspectTargetIds ? <FrameAspectRow onPick={applyFrameAspect} /> : null}
                  <CollectionSaveButton count={selectedIds.size} onSave={() => void saveSelectionAsCollection()} />
                  <Button variant="ghost" size="sm" disabled={selectedIds.size <= 0} onClick={addSelectionToBasket}>
                    Add to collection
                  </Button>
                  {sparringDrafts.length >= 2 ? (
                    <Button variant="ghost" size="sm" onClick={() => setShowSparring(true)}>Spar drafts</Button>
                  ) : null}
                  <CollectionBasketBar
                    itemCount={basketItemCount()}
                    boardCount={basketBoardCount()}
                    onSave={() => void saveBasketAsCollection()}
                    onShare={() => void shareBasketAsLink()}
                    onClear={clearCollectionBasket}
                  />
                </Container>
              </Container>
            )}
            onSelect={(ids) => setSelectedIds(new Set(ids))}
            onPin={() => setPinnedToolIds([...selectedIds])}
            onUnpin={() => setPinnedToolIds(null)}
            onCombine={(ids) => setSelectedIds(new Set(ids))}
            smartSets={readActiveSmartSets(graph, smartSetIndexRef())}
            unavailableSmartSets={readUnavailableSmartSets(graph, smartSetIndexRef())}
            archivedSmartSets={readArchivedSmartSets(graph, smartSetIndexRef())}
            onRenameSmartSet={(memberId, name) => { void commit(renameSmartSet(graphRef.current, smartSetIndexRef(), memberId, name)); }}
            onRestoreSmartSet={(memberId) => { void commit(restoreSmartSet(graphRef.current, smartSetIndexRef(), memberId)); }}
            smartSetExtractors={BOARD_ITEM_FACETS}
            currentSmartQuery={{ selection: focusFacets }}
            onReplaceSmartQuery={async (memberId, expected, replacement) => {
              const change = replaceSmartSetQuery(graphRef.current, smartSetIndexRef(), memberId, expected, replacement);
              return change.error ?? await commit(change.graph);
            }}
            smartSetFacetLabels={Object.fromEntries(BOARD_FOCUS_FACETS.map(facet => [facet.key, facet.label]))}
            onSaveSmartSet={hasActiveFacets(focusFacets) ? () => {
              // save the CURRENT focus-facet query as a re-resolving smart set (skip an empty "everything" set)
              if (!hasActiveFacets(focusFacets)) return;
              const query = { selection: focusFacets };
              const id = newId('smart');
              void commit(saveSmartSet(graphRef.current, smartSetIndexRef(), { memberId: id, smartSetId: id, name: smartQueryText(query), query }));
            } : undefined}
            onApplySmartSet={(ids) => setSelectedIds(new Set(ids))}
            onFocusSmartSet={(query) => setFocusFacets(query.selection)}
            onArchiveSmartSet={(memberId) => { void commit(archiveSmartSet(graphRef.current, smartSetIndexRef(), memberId)); }}
          />
            </Card>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Open selection inspector for ${selectedIds.size} selected`}
              onClick={() => setSelectionInspectorOpen(true)}
            >
              <Icon icon={SlidersHorizontal} size="sm" />
              {selectedIds.size} selected
            </Button>
          )}
        </Container>
      ) : null}
    </Container>
    </>
    </MarkSessionProvider>
  );
}

function messageOf(e: unknown): string {
  return errorWords(e, 'Something went wrong saving your board.');
}

// Show the recoverable slow-load warning after five seconds. The watched open
// keeps running and can still replace that warning with its completed board.
export const BOARD_LOAD_TIMEOUT_MS = 5000;

