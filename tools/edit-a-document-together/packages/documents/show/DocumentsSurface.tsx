import * as React from 'react';
import { DocumentImportDialog } from './DocumentImportDialog';
import { DocumentConflictComparison } from './DocumentConflictComparison';
import { pageReferencesToCheck } from '../read-data/page-references';
import { checkPageReferences, referenceKey, type ReferenceOwnerCheck } from '../../../read-data/check-page-references';
import { readDocumentIndex } from '../../../read-data/document-index';
import { emitPlaceableSurfaceIntent } from '../../../../ui/show/placeable-surface-intent/placeable-surface-intent';
import { sameImportedPage, revisionHashFor, planImportedPageReplacement } from '../do-work/imported-document.mjs';
import { ChevronDown, ChevronRight, FileText, Plus, Sparkles, X } from 'lucide-react';

import {
  Button,
  CanvasHud,
  CanvasMinimap,
  Container,
  Dropdown,
  DragHandleMenu,
  EmptyPlaceholder,
  ErrorBoundary,
  HoverRevealGroup,
  HoverRevealItem,
  Icon,
  NamedIcon,
  SafeErrorCard,
  sanitizeErrorText,
  AnchoredOverlay,
  ConditionEditor,
  SpacingEditor,
  SceneFrame,
  SceneResizeHandles,
  SplitDividers,
  Spinner,
  Input,
  Text,
  Textarea,
  claimKeyboardEvent,
  keyboardEventClaimed,
  type CanvasMinimapFrame,
  type ConditionDraft,
  type PersistenceTone,
  type SceneResizeRect,
  type SceneResizeHandleId,
  type SpacingFieldView,
} from '../../../../ui';
import { useToastContext } from '../../../../ui/show/toast';
import {
  appendCapturedRasterFallback,
  applySceneStyleToElement,
  createCapturedSceneElement,
  sceneStyleToCss,
  type CapturedSceneElementData,
} from '../../../../ui/show/composition-scene-style';
import { mountedSurfaceRegistry } from '../../../../ui/show/mounted-surface-registry';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { SourceBytesScreenMount } from '../../../../ui';
import {
  canvasGridPosition,
  canvasGridSize,
  materialMatchesQuery,
  nextMenuIndex,
  nodeAuthorsOrigin,
  readCompositionContent,
  materializeCompositionBoundFeeds,
  readMaterialDescriptors,
  readPlaceableSurfaceMaterials,
  resolveStageViewport,
  applyFormatToStyle,
  isFormatActive,
  textDecorationLine,
  readFormatDescriptors,
  readConnectionKinds,
  readSpacingFields,
  readStyleNumber,
  writeStyleNumber,
  spacingFieldsForNode,
  connectionKindFor,
  nextConnectionKind,
  DEFAULT_VIEWPORT,
  matchAutoformat,
  matchInputShortcut,
  materializeEmptyStateSeed,
  readEmptyStateSeed,
  composeEmptyBlockPlaceholder,
  composerAskCopy,
  splitMarkdownLines,
  foldAutoformatToNodes,
  mergeNodeProps,
  type AutoformatRule,
  type InputShortcut,
  type AutoformatMatch,
  type AutoformatContext,
  type CompositionContent,
  type FormatDescriptor,
  type NumericStyleField,
  type ConnectionKind,
  type EdgeConnection,
  type CompositionSnapshot,
  type CompositionTransaction,
  type MaterialDescriptor,
  type SceneNode,
  type ScenePatch,
  type Viewport,
} from '../read-data/documents';
import { AddressedSurfaceIntentReader, AddressedSurfaceIntentRecipient, placeableSurfaceCatalogForViewer, surfaceIntentMatchesCatalogPayload, ViewerAccessRefsContext, type SurfaceIntentReaderConfig } from '../../../../ui/show/placeable-surface-intent';
import { resolveInDirection, resolveGoalColumn, candidatesInRect, marqueeRect, navDiagnostics, type Direction } from '../../../../documents/read-data/cursor-nav';
import { escalateScope, subtreeIds, ancestorChainToCeiling } from '../../../read-data/containment-scope';
import {
  whatEnterDoesInThisBlock,
  markerToStartTheNextOneWith,
  type ContinuableShortcutRule,
} from '../read-data/what-enter-does-in-this-block';
import { AppSidebar } from '../../../../sidebar/show/AppSidebar';
import type { AppSidebarProps } from '../../../../sidebar/show/AppSidebar';
import defaultSidebarCapabilities from '../../../data/sidebar-config.json';
import {
  buildDocumentsPageSidebarProjection,
  documentHeadings,
  DOCUMENTS_PAGE_SIDEBAR_SCOPE,
  DOCUMENTS_SIDEBAR_ACTIONS,
} from './documents-page-sidebar';
import { resolveCursorCommand, CURSOR_COMMANDS, type CursorCommand } from '../../../../documents/read-data/cursor-commands';
import { matchSelectionOp, selectionOpPatches, type SelectionOp } from '../../../../documents/read-data/selection-ops';

import { hydrateCompositionScene } from '../do-work/hydrate-composition-scene';
import { DEFAULT_STRUCTURAL_MATERIALS } from '../read-data/default-structural-materials';
import { resolveComponentDeliveryDisposition, stampComponentDeliveryRef } from '../../../read-data/delivery-placement';
import { decodeCompositionSnapshotReply } from '../do-work/send-composition-transaction';
import { createPersistingTransactionQueue } from '../../../show/persisting-transaction-queue';
// Attach / put-on-board / export are all PROJECTIONS over the one
// authored-composition-unit primitive (one addressed unit, N data-described
// projections) — the surface configures a projection, it does not orchestrate verbs.
import {
  materializeAuthoredCompositionIntent,
  type ProjectionDescriptor,
  type ProjectionRunnerMap,
} from '../../../../documents/do-work/materialize-authored-composition-intent';
import {
  foldProjectionActions,
  buildProjectionDispatch,
  fillSuccessTemplate,
  type ProjectionActionRow,
} from '../../../read-data/projection-actions';
import { encodeRefToken, hasRefToken, hasEmphasisMarker, parseInlineRuns, insertRefTokenIntoText, type InlineMark } from '../read-data/inline-tokens';
import { makeRefChip, renderBlockRuns, serializeBlockElement, readBlockText } from '../read-data/inline-chip-dom';
import { composerKeyAction } from '../../../read-data/composer-key-action';
import { visibleTextLines } from '../../../../documents/do-work/project-scene-to-file-request';
import { readPublishedRecords } from '../../../../ui/show/placeable-surface-intent';
import { findPlaceableSurfaces } from '../../../../ui/show/placeable-surface-intent/placeable-surface-record';
import { normalizeFeedRows } from '../../../read-data/normalize-feed-rows';
import { useTypewriterReveal } from '../../../../ui/show/text-reveal';
import {
  readActionAffordances,
  readActionAffordanceConfigurations,
  actionAskHasRequiredAnswers,
  resolveActionAskInitialAnswers,
  resolveActionAsk,
  getPath,
  ActionAffordanceEditor,
  ActionForm,
  materializeActionFormFile,
  writeActionAffordanceLive,
  writeActionAffordanceItemLive,
  writeActionAffordanceConfigurationLive,
  buildActionPresetWriteItem,
  archiveActionAffordanceLive,
  resolveActionAffordanceWriteAddress,
  type ActionAffordanceDraft,
  type AffordanceChannelOption,
  type AffordanceDefinitionOption,
  type AskField,
  type ActionAffordanceAsk,
  type AskFieldOption,
  type AffordanceInvokeContext,
  LOCAL_DESKTOP_ACTOR,
  type OptionSourceRecord,
  foldAffordanceChannelOptions,
  foldAffordanceDefinitionOptions,
  resolveAskFieldOptions,
  resolveBindingTemplate,
} from '../../../../ui/show/action-affordance';
import {
  affordanceRowMatchesQuery,
  affordanceSlashRows,
  artifactsToInsertPatches,
  buildAffordanceRun,
  COMPOSITION_SLASH_CHANNEL,
  ownerSelectionContext,
  type AffordanceSlashRow,
} from '../../../../documents/read-data/affordance-materials';
import { runActionAffordance } from '../do-work/run-action-affordance';
import { resolveDestinationActionReadback, type DestinationActionReadback } from '../../../../documents/read-data/action-result-readback';
// Blind reuse of process-session's live-output primitive: composition hands it an
// opaque stream handle read from the interim payload and renders the returned
// growing text. It knows NOTHING of event feeds, deltas, or stream addresses.
import { useProcessSessionLiveOutput } from '../../../../process-session/show/use-process-session-live-output';
import { readProcessSessionStreamHandle, type ProcessSessionStreamHandle } from '../../../../process-session/read-data/accumulate-process-session-output';
import { composerConfigGroups, dispatchComposerConfigSelect, readComposerConfigCurrent, resolveConfigDefaultFrom, resolvePreamble, writeComposerPreambleLive } from '../do-work/composer-config';
// Browser-direct live streaming: when the selected agent is a `process_session`
// CLI, composition fires start_session directly (the workflow ask-step →
// compute.process_session path never spawns the CLI) and hands the live feed to
// the SAME useProcessSessionLiveOutput panel. Selection is resolved from DATA on
// the shortcut; the render + fire are process-session's blind generic primitives.
import { resolveStreamingLaunch } from '../do-work/resolve-streaming-launch';
import { startProcessSession, type ProcessSessionSender } from '../../../../process-session/envelope-client/start-process-session';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { buildResizeTransaction } from '../../../../documents/do-work/build-resize-transaction';
import { buildFloatTransaction, repositionFromDrag, buildRepositionTransaction, panFromDrag, zoomAtPoint, CANVAS_ZOOM_LIMITS, isCanvasRoot, buildWorkspaceCanvasArrangement, workspaceHasCanvasLayout, zoomByFactor, zoomToActualSize, fitCamera, framesBoundingBox, cameraCenteredOnWorld, type WorldRect } from '../../../do-work/build-float-transaction';
import {
  readSplitParts,
  isSplitNode,
  readSplitAxis,
  readSplitGap,
  visibleDividerPairs,
  applySplitDividerDrag,
  buildSplitDividerTransaction,
  splitDividerScreenRects,
  splitAvailableMainPx,
  type SplitPart,
} from '../../../do-work/build-split-transaction';
import {
  resolveVisibility,
  readNodeVisibilityCondition,
  buildBindVisibilityTransaction,
  buildClearVisibilityTransaction,
} from '../../../do-work/build-visibility-binding';
import { VISIBILITY_OPERATORS } from '../../../read-data/visibility-operators';
import {
  isTableNode,
  buildTableColumnDragTransaction,
  buildInsertTableRowTransaction,
  buildRemoveTableRowTransaction,
  buildInsertTableColumnTransaction,
  buildRemoveTableColumnTransaction,
} from '../do-work/build-table-transaction';
import {
  isPanelNode,
  isCollapsedPanel,
  collapsePanelTransaction,
  expandPanelTransaction,
} from '../../../do-work/build-panel-group-transaction';
import { CompositionWriteConflictError } from '../do-work/write-composition-documents';
import {
  resolveComponentInstances,
  collapseInstances,
  definitionsMapFrom,
  instanceDefinitionId,
  DEFINITION_REF_PROP,
  PROP_OVERRIDES_PROP,
  type ComponentDefinitionRecord,
} from '../../../read-data/resolve-component-instances';
import { buildCreateComponentTransaction } from '../../../do-work/build-create-component-transaction';
import { FloatingPanel } from '../../../../screen-arrangement/show/FloatingPanel';

// A component definition becomes an insertable slash-menu material whose node is
// an INSTANCE ref (definition_ref), NOT the inlined subtree — inserting it creates
// a linked instance the resolver expands. freshIds (materialNode) gives each
// inserted instance a fresh root id; applyMaterial resolves + registers it.
function componentMaterial(def: ComponentDefinitionRecord): MaterialDescriptor {
  return {
    id: `component:${def.id}`,
    label: def.label,
    match_terms: def.match_terms,
    group: def.group ?? 'Components',
    node: {
      id: `node:component-instance:${def.id}`,
      kind: def.node.kind,
      props: { [DEFINITION_REF_PROP]: def.id, [PROP_OVERRIDES_PROP]: {} },
      visible: true,
      children: [],
    },
  };
}

type DocumentsSurfaceProps = {
  // Scene address for bound feed materialization. Used to properly resolve which
  // bind nodes to materialize from the template. If absent, falls back to a generic
  // address (documents scenes only, not per-scope). Passed from mount
  // when the surface is wired to a specific scene via surfaceInput.scene_address.
  sceneAddress?: string;
  /** Explicit mounted-view identity supplied by the composition owner. */
  mountedViewRef?: string | null;
  documentRows: unknown;
  documentIndexRows?: unknown;
  materialRows: unknown;
  placeableSurfaceRows?: unknown;
  // Scoped content-pool rows (action affordances, projection actions, option
  // descriptors). Keep these separate from the registry feed: the latter owns
  // placeable surfaces and editor shortcut rules, not action definitions.
  allPublishedRows?: unknown;
  titledPoolRows?: unknown;
  // Live format descriptor rows (a package can publish its own formats/colours as DATA —
  // same channel shape as materialRows). Merged with the built-in set by readFormatDescriptors.
  formatRows?: unknown;
  // Live connection-kind rows (a package can publish its own connection meanings as DATA).
  // Merged with the built-in seed by readConnectionKinds; optional → seed-only when absent
  // (built-in meanings are unconditionally available, cold-client-safe — same as #27).
  connectionKindRows?: unknown;
  // Live numeric-style-field rows (a package can publish its own spacing/box fields as DATA —
  // e.g. add a border-radius stepper). Falls back to the built-in SPACING_FIELDS when absent.
  spacingFieldRows?: unknown;
  // Live input-shortcut rules (# -> H1, ~> -> spark, and ANY user/package-authored
  // rule) already decoded from the feed BY KIND in the mount (read-by-kind: any
  // package that ships a `kind:"input-shortcut"` record, or a live write-batch, is
  // picked up with zero surface code). This is the ONLY autoformat rule source —
  // there is no code-constant table. Absent → no shorthand fires (honest empty).
  inputShortcuts?: AutoformatRule[];
  // The FULL input-shortcut registry (menu/picker/composer/dispatch rows, not only effect) —
  // drives the command-composer: which prefix opens a menu/picker, which gesture dispatches to
  // an envelope target. Read by kind across the whole feed in the mount. The surface stays blind
  // (never names a prefix/target/package). Absent → composer disabled, autoformat still works.
  inputShortcutsFull?: InputShortcut[];
  checkReferenceOwner?: ReferenceOwnerCheck;
  // The inline-mark table (marker pair → render element, e.g. `**`→strong, `~~`→s), read live
  // BY KIND from the feed in the mount. The render/serialize pair compiles whatever rows are
  // present — this surface never names a marker or a tag (L090). Absent/empty → plain text.
  inlineMarks?: InlineMark[];
  selectionOps?: SelectionOp[];
  // The spatial-nav gesture table (gesture→direction/land-edge), read live BY KIND from the feed in the
  // mount (seed const + any `cursor-command` DATA rows). Absent → the surface falls back to the shipped
  // CURSOR_COMMANDS const, so arrow-nav always works; a DATA row rebinds/extends it (e.g. PageDown).
  cursorCommands?: CursorCommand[];
  sidebarPanelRows: unknown;
  sidebarInstanceId?: string;
  sidebarCapabilities?: AppSidebarProps['capabilities'];
  // Partition label for the name/export/put-on-board record writers. Absent →
  // those menu rows do not render (the surface stays read/author-only).
  partitionLabel?: string;
  // The projection runner pack, injected by the mount (composition wiring chooses
  // the pack; the generic materialize core never names one). Absent → the shipped
  // default pack, so a standalone render still works.
  projectionRunners?: ProjectionRunnerMap;
  // Empty-block placeholder copy (Society DATA, from CompositionRuntimeConfig).
  // Absent ⇒ the capable default below. Shown only on the focused empty block.
  blockPlaceholder?: string;
  sendTransaction: (transaction: CompositionTransaction) => Promise<unknown>;
  loadDocuments: () => Promise<CompositionContent | null>;
  readDocumentSnapshot?: () => Promise<{ content: CompositionContent | null; documentHash: string | null }>;
  expectedDocumentRevision?: string;
  writeDocuments: (content: CompositionContent) => Promise<unknown>;
  applyMountedScenePatch?: (request: unknown) => Promise<unknown>;
  surfaceIntentReader?: SurfaceIntentReaderConfig | null;
  surfaceIntentDestinationRef?: string | null;
};

const EMPTY_CAMERA = { pan_x: 0, pan_y: 0, zoom: 1 };
// Identity-stable empty mark table (the table's identity keys the compiled-matcher memo).
const EMPTY_INLINE_MARKS: readonly InlineMark[] = [];
// DEFAULT_VIEWPORT (the pre-measure fallback) + resolveStageViewport now live in
// read-data — the engine viewport is the stage's REAL measured size (see the
// stageViewportRef + ResizeObserver below), never a hardcoded desktop constant.
// Bounded retries for a dropped viewport-reflow send so the kernel viewport
// converges to the measured size without waiting for the next nav (Codex Q8).
const REFLOW_MAX_RETRIES = 3;

// The persistence lifecycle of a write is an algebraic state (not-started /
// in-flight / saved / failed) — Physics, closed like a Promise. The user-facing
// WORDS are Society, mapped here; the generic PersistenceStatus primitive stays
// blind to them. 'conflict' (a failed write whose guarded basis was superseded)
// 'conflict' = a concurrent writer advanced the log basis under our guarded
// write, so the engine rejected it. The store owns that translation (L098): it
// re-reads to verify, re-syncs its basis, and throws CompositionWriteConflictError
// — recoverFromWriteError maps that one type to 'conflict', everything else to
// 'error'. See observations/2026-06-20-conflict-detection-*.md.
type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';
// CS-065 locked copy. This surface owns LOCAL persistence: a guarded write lands
// in the on-device log (the SSOT), so 'saved' = "Saved on this device". 'error'
// reassures that the in-flight value is not lost (Pattern 58: it lives in the
// contenteditable DOM). 'conflict' = a concurrent writer advanced the basis.
// CS-065 also lists "Waiting to sync" — that describes CROSS-DEVICE sync
// propagation, a concern this surface has NO input for (a landed local write only
// proves local durability, never replication state). Hardcoding a state that can
// never truthfully fire would be an L117 fake-state violation. Converged with
// Codex GPT-5.5 (convergence/2026-06-21-codex-waiting-to-sync-reserve-vs-wire.md):
// "Waiting to sync" is owned by a future sync-status layer and is satisfied when
// this surface composes SaveState + SyncState; the local SaveState stays the
// local-durability authority. Until a replication target exists, the state does
// not occur product-wide, so it is reserved here, not enumerated.
const SAVE_VIEW: Record<Exclude<SaveState, 'idle'>, { tone: PersistenceTone; label: string; busy?: boolean }> = {
  saving: { tone: 'neutral', label: 'Saving…', busy: true },
  saved: { tone: 'success', label: 'Saved on this device' },
  // Inline = TERSE ambient word + tone (Mobbin reference: Confluence/Substack show
  // a terse word, "never a banner"). The full CS-065 recovery SENTENCE is banner/
  // toast copy — it lives in recoverFromWriteError's toast, not crammed into this
  // ambient rail-header primitive (Codex-converged 2026-06-21, Verdict A). Putting
  // the sentence here (or in PersistenceStatus.detail) recreates the rail overflow.
  error: { tone: 'error', label: "Couldn't save" },
  conflict: { tone: 'warning', label: 'Conflict' },
};

const EMPTY_SNAPSHOT: CompositionSnapshot = {
  tree: null,
  frames: {},
  camera: EMPTY_CAMERA,
  visible_edge_routes: [],
};

type ActiveMenu = {
  nodeId: string;
  query: string;
};

// Fail-closed default: the generic surface owns NO projection registry. When an
// owner (the mount / composition root) does not inject a runner pack, the surface
// offers no authoring outputs rather than compile-time-owning the shipped pack —
// so a new projection is added by owner wiring + DATA, never by editing this core
// (enum-dissolution: the extensible list lives OUTSIDE the generic consumer).
const EMPTY_PROJECTION_RUNNERS: ProjectionRunnerMap = Object.freeze({});

export function DocumentsSurface({
  sidebarInstanceId,
  sidebarCapabilities = defaultSidebarCapabilities,
  sceneAddress = 'package::documents::documents::main',
  mountedViewRef = null,
  documentRows,
  documentIndexRows,
  materialRows,
  placeableSurfaceRows,
  allPublishedRows,
  titledPoolRows,
  formatRows,
  connectionKindRows,
  spacingFieldRows,
  inputShortcuts,
  inputShortcutsFull,
  checkReferenceOwner = sendRequestToBitfieldTarget,
  inlineMarks,
  selectionOps,
  cursorCommands,
  partitionLabel,
  projectionRunners = EMPTY_PROJECTION_RUNNERS,
  blockPlaceholder,
  sendTransaction,
  loadDocuments,
  readDocumentSnapshot,
  expectedDocumentRevision,
  writeDocuments,
  applyMountedScenePatch,
  surfaceIntentReader = null,
  surfaceIntentDestinationRef = null,
}: DocumentsSurfaceProps) {
  const localSidebarId = React.useId();
  const persistentSidebarId = sidebarInstanceId ?? mountedViewRef;
  const { showError, showSuccess } = useToastContext();
  // Presentation eligibility only: this narrows the visible/receivable surface
  // catalog as defense in depth. Product Access and Hosted closure authorize the
  // buyer; this surface never decides a purchase.
  const viewerAccessRefs = React.useContext(ViewerAccessRefsContext);
  // The empty-block placeholder shown on the FOCUSED empty block. Precedence (all DATA):
  //   1. blockPlaceholder — an explicit CompositionRuntimeConfig override (author's exact copy).
  //   2. composeEmptyBlockPlaceholder — a PROJECTION of the live input-shortcut registry: every
  //      row with a `presentation.hint` self-advertises (space→AI, "/"→commands, …), so the hint
  //      can NEVER silently disagree with the actual live shortcuts and a new shortcut updates the
  //      placeholder with zero code change (L090/L124).
  //   3. DEFAULT_BLOCK_PLACEHOLDER — a capable static fallback (L083) so the box is never bare
  //      even if no row advertises.
  const editorPlaceholder =
    blockPlaceholder ?? composeEmptyBlockPlaceholder(inputShortcutsFull ?? []) ?? DEFAULT_BLOCK_PLACEHOLDER;
  // Input-shortcut rules (autoformat + slash + @ + space-for-AI), decoded from the
  // feed BY KIND in the mount and passed in. Held in a ref so the per-block keydown
  // closures always read the LATEST live set without re-binding — a package that
  // writes a new `input-shortcut` record live is honored on the next keystroke,
  // zero remount. This ref is the ONLY autoformat rule source in the surface.
  const inputShortcutsRef = React.useRef<AutoformatRule[]>([]);
  inputShortcutsRef.current = inputShortcuts ?? [];
  // The full registry ref (menu/picker/composer/dispatch) for the command-composer open/dispatch
  // paths — read live so a package's newly-written shortcut is honored on the next keystroke.
  const inputShortcutsFullRef = React.useRef<InputShortcut[]>([]);
  inputShortcutsFullRef.current = inputShortcutsFull ?? [];
  // The live inline-mark table, ref-held like the shortcut registry so render/serialize
  // closures always compile against the LATEST rows (a live-written mark row takes effect
  // on the next render, zero remount). Empty table = plain-text behavior everywhere.
  // STABLE identity fallback (module const, not a fresh []) — the table's identity keys
  // both the compiled-matcher memo and block effects; a per-render [] would thrash them.
  const inlineMarksRef = React.useRef<readonly InlineMark[]>(EMPTY_INLINE_MARKS);
  inlineMarksRef.current = inlineMarks ?? EMPTY_INLINE_MARKS;
  const getInlineMarks = React.useCallback(() => inlineMarksRef.current, []);
  const selectionOpsRef = React.useRef<SelectionOp[]>([]);
  selectionOpsRef.current = selectionOps ?? [];
  // The live spatial-nav gesture table, held in a ref so the per-block keydown closures read the LATEST
  // set without re-binding. Falls back to the shipped CURSOR_COMMANDS const when the prop is absent so
  // arrow-nav is NEVER dead (L083 capable default); a live `cursor-command` DATA row rebinds/extends it.
  const cursorCommandsRef = React.useRef<readonly CursorCommand[]>(CURSOR_COMMANDS);
  cursorCommandsRef.current = cursorCommands && cursorCommands.length > 0 ? cursorCommands : CURSOR_COMMANDS;
  // Read the raw composition content, then materialize any bound feeds
  const boundFeedRows = useBitfieldData('item-records') ?? [];
  const seedContent = React.useMemo(() => {
    const content = readCompositionContent(documentRows);
    // Use the passed sceneAddress to materialize bound feed children properly.
    // This allows scenes in different partitions/addresses to bind and resolve
    // their template nodes correctly (e.g., tribes-feed scene in the tribes partition).
    // A browser clock is an INPUT the log records, so a surface reads its own;
    // only a derivation replayed against the log takes it from the runtime.
    return materializeCompositionBoundFeeds(content, boundFeedRows, sceneAddress, Date.now());
  }, [documentRows, boundFeedRows, sceneAddress]);
  // First-paint seed captured in a ref so the load effect can read it WITHOUT
  // depending on it. Every keystroke saves → the published-records feed updates
  // → documentRows/seedContent get a new reference; if the load effect depended
  // on seedContent it would re-run the FULL reload on every save, closing the "/"
  // menu and snapping the cursor to the first page mid-typing. The effect must
  // fire only on mount + explicit retry (reloadToken).
  const seedContentRef = React.useRef(seedContent);
  seedContentRef.current = seedContent;
  // The durable document is the idempotency authority for addressed placement.
  // It advances only after a durable read or a successful write; a failed local
  // engine snapshot remains distinguishable so its retry persists that same node.
  const lastKnownDurableContentRef = React.useRef<CompositionContent | null>(null);
  const conflictScope = JSON.stringify([partitionLabel ?? null, sceneAddress ?? null]);
  const pendingConflictContent = React.useRef<{ content: CompositionContent; scope: string } | null>(null);
  const [conflictComparison, setConflictComparison] = React.useState<{ local: CompositionContent; current: CompositionContent | null; scope: string } | null>(null);
  const documentHashRef = React.useRef<string | null>(null);
  // Component definitions live IN the document (CompositionContent.definitions —
  // file-scoped like Figma, persisted by the existing writeDocuments path). State
  // drives the slash menu reactively (declared BEFORE the materials memo that reads
  // it — a later declaration would be a temporal-dead-zone crash); refs mirror it
  // for the async load/persist closures. instanceRoots maps each engine-resolved
  // instance-root id -> its definition id, so collapse (at persist) folds them back.
  const [componentDefinitions, setComponentDefinitions] = React.useState<ComponentDefinitionRecord[]>([]);
  const componentDefinitionsRef = React.useRef<ComponentDefinitionRecord[]>([]);
  const definitionsByIdRef = React.useRef<Map<string, SceneNode>>(new Map());
  const instanceRootsRef = React.useRef<Map<string, string>>(new Map());
  // The slash menu is data over {label, match_terms, node}. Structural blocks
  // (columns/split) are just more descriptors whose node is a layout node —
  // no special insert path, no backend "column" type (the engine lays out a
  // mode:split node by fraction). Mounted-surface materials come from live data.
  const materials = React.useMemo(() => [
    ...DEFAULT_STRUCTURAL_MATERIALS,
    ...readMaterialDescriptors(materialRows),
    ...readPlaceableSurfaceMaterials(placeableSurfaceRows),
    // User-created components are just more materials — inserting one creates a
    // linked instance (its node carries definition_ref; applyMaterial resolves it).
    ...componentDefinitions.map(componentMaterial),
  ], [materialRows, placeableSurfaceRows, componentDefinitions]);
  // Text formats are DATA too: live published format rows merged with the built-ins by
  // the reader, so adding a format/colour is genuinely a DATA row on the LIVE surface
  // (not just the built-in constant). FormatBar renders whatever this yields, blindly.
  const formatDescriptors = React.useMemo(() => readFormatDescriptors(formatRows), [formatRows]);
  // Connection MEANINGS as DATA (seed + any live rows). The EdgeLayer reads {label, tone}
  // from these; the default (first) kind is applied when a connection is drawn (#37).
  const connectionKinds = React.useMemo(() => readConnectionKinds(connectionKindRows ?? null), [connectionKindRows]);
  const connectionKindsRef = React.useRef<ConnectionKind[]>(connectionKinds);
  connectionKindsRef.current = connectionKinds;
  // Numeric box-spacing fields as DATA (seed + any live rows). The SpacingEditor renders a
  // stepper per field; padding affects any node, gap only a multi-child container (filtered
  // per-node by spacingFieldsForNode). Adding a field (border radius, …) is a DATA row.
  const spacingFields = React.useMemo<NumericStyleField[]>(() => readSpacingFields(spacingFieldRows ?? null), [spacingFieldRows]);
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error' | 'revision-warning'>('loading');
  const [revisionWarning, setRevisionWarning] = React.useState<string | null>(null);
  const acknowledgedRevision = React.useRef<string | null>(null);
  const [loadErrorText, setLoadErrorText] = React.useState<string | null>(null);
  // Save status: 'saving' on each write, 'saved' when the guarded write lands,
  // 'error' on failure. Drives the quiet PersistenceStatus indicator (proof strip).
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [pageSaveStates, setPageSaveStates] = React.useState<Record<string, Exclude<SaveState, 'idle'>>>({});
  const [reloadToken, setReloadToken] = React.useState(0);
  // The ONLY snapshot source is the engine's transaction reply (plan §2).
  // One tree (correction #4): no document unit — the rail renders the engine
  // root's children; selecting frames a child with the camera, nothing else.
  const [snapshot, setSnapshot] = React.useState<CompositionSnapshot>(EMPTY_SNAPSHOT);
  const [framedNodeId, setFramedNodeId] = React.useState<string | null>(null);
  // #38 — the "canvas" is NOT a mode/view (line-21 locked: no modes, no views to switch;
  // an "optional canvas view" was the explicitly REJECTED attempt 2). It is purely WHICH
  // node is framed: framing the workspace ROOT — whose own LayoutMode is Absolute — shows
  // every page as a positioned card on one plane; framing a page shows that page. Framing
  // is navigation (Mobbin: Figma "Pages" list + Fibery/ClickUp "Fit to screen"), available
  // for ANY node via `frameNode`. Canvas-ness is emergent (`isCanvasRoot(framedPage)`), never
  // a boolean. On load it is reconstructed from self-describing data (a page carrying
  // layout.x/y ⇒ frame the root), never a stored flag (L090).
  // The pages rail is the OWNED sidebar (`packages/sidebar` plus `group`), the
  // same primitive the shell nav uses, not a documents-local one. Panel geometry
  // is NOT held here: docking, floating, width, hide and auto-hide are durable
  // `sidebar-placement` records the person owns, so a page rail moved to the
  // right edge stays there. Only the search NEEDLE is local, because the sidebar
  // owns the field and the caller owns the predicate.
  const [pagesSearch, setPagesSearch] = React.useState('');
  const [activeMenu, setActiveMenu] = React.useState<ActiveMenu | null>(null);
  // The command-composer (space on an EMPTY block): a small inline prompt whose Ask-AI submit
  // dispatches the renderer:"composer" input-shortcut (space→ai-records-producer by default) and
  // places the produced blocks. Which shortcut fires is DATA (found by renderer shape), never named.
  // `phase` is the Notion in-place idiom: 'input' = the prompt row; 'working' = the SAME panel
  // shows the run happening where the writing will land (spinner + Stop) — never a status toast
  // floating elsewhere. The produced blocks appearing IS the completion feedback. 'failed' keeps
  // the SAME panel honest when the run errors, times out, or returns nothing: the message + Try
  // again live where the writing would have landed — the panel NEVER silently vanishes (live
  // incident 2026-07-10: a timed-out ask closed with nothing placed and zero feedback). `prompt`
  // is retained across working/failed so Try again re-runs the exact ask.
  const [activeComposer, setActiveComposer] = React.useState<{ nodeId: string; phase: 'input' | 'working' | 'failed'; prompt?: string; failure?: string } | null>(null);
  // LIVE progress for the composer working panel. When a producer run reports itself
  // still in progress (runActionAffordance's onInterim), streamingRun holds the node it
  // belongs to plus an OPAQUE handle. process-session's blind hook turns that handle into
  // growing text that renders token-by-token where the "Writing:" spinner is. Cleared when
  // the run settles (the placed blocks are the completion feedback). composition knows
  // NOTHING of sessions/feeds/deltas — it shows a growing string that finishes.
  const [streamingRun, setStreamingRun] = React.useState<{ nodeId: string; runId: string; handle: ProcessSessionStreamHandle } | null>(null);
  const liveOutput = useProcessSessionLiveOutput(streamingRun?.handle ?? null);
  // FINALIZE-FROM-STREAM: a streaming run has no producer terminal-result (the workflow
  // ends at the interim pointer) — the live stream IS the truth. Gate on `complete`
  // (session terminal AND every engine-written byte folded), NOT merely `done` — else
  // the terminal HEAD flips `done` while the last deltas are still folding and the
  // placed answer is truncated. When complete, place the FULL accumulated answer as
  // block(s) through the SAME insertion rail one-shot uses (each non-blank line an item;
  // markdown autoformats). insertResultArtifacts reuses the invoking (streamed-into) node's
  // own identity for the first produced block — the node that was just SHOWING the growing
  // text keeps showing it, it just becomes persisted instead of a live override — so there is
  // no frame where the streamed block goes blank while a separate freshly-minted block appears
  // elsewhere with the same words (the "double-insert" the working panel used to produce).
  // Guarded to fire once (streamingRun cleared).
  React.useEffect(() => {
    if (!streamingRun || !liveOutput.complete) return;
    const { nodeId, runId } = streamingRun;
    const answer = liveOutput.text.trim();
    if (answer) {
      const items = answer.split('\n').map((t) => ({ text: t })).filter((i) => i.text.trim().length > 0);
      insertResultArtifacts({ items }, 'items', nodeId, runId);
    }
    setStreamingRun(null);
    setActiveComposer((current) => (current?.nodeId === nodeId ? null : current));
  }, [streamingRun, liveOutput.complete, liveOutput.text]);
  const [composerText, setComposerText] = React.useState('');
  // Stop abandons THIS run: the completion callback checks the token and places nothing.
  const composerRunCancelledRef = React.useRef<{ cancelled: boolean } | null>(null);
  // The composer's DISCLOSURE config (L115: the default row stays one prompt + one button;
  // everything configurable lives behind the chevron). All names — the option kind, the
  // current-choice ask, the select dispatch — are the shortcut row's `presentation.config`
  // DATA; the panel renders blind (composer-config.ts). null = closed.
  const [composerConfigOpen, setComposerConfigOpen] = React.useState(false);
  const [composerConfigCurrent, setComposerConfigCurrent] = React.useState<string | null>(null);
  // Non-null while the writing-instructions preamble is being edited in the panel; Save
  // writes it back to the LIVE registry record (writeComposerPreambleLive) so the change
  // takes effect on the very next ask, zero redeploy.
  const [composerPreambleDraft, setComposerPreambleDraft] = React.useState<string | null>(null);
  // Overlay anchoring is the LIVE BLOCK DOM ELEMENT, not snapshot.frames world coords. The scene
  // render localizes every rect against the framed page (see pageOrigin), so world coords are the
  // wrong space for plane chrome — the exact category bug behind "the / menu opened 500px below
  // the block" on any page whose world origin isn't 0. The DOM rect is post-localization AND
  // post-camera-transform, so the shared AnchoredOverlay (portal + fixed coords + re-measure)
  // is correct at any page origin, any zoom, any scroll. Getter-refs resolve the element at
  // MEASURE time (blocks re-render freely; no stale element).
  const composerBoxRef = React.useRef<HTMLDivElement>(null);
  // The root of THIS surface instance. All node-anchor queries scope to it — a bare
  // `document.querySelector([data-node-id="X"])` can match an element with the same node id
  // in ANOTHER open surface (e.g. a second composition pane, or a CRM/board surface that also
  // uses data-node-id) that renders ABOVE this one, anchoring the composer overlay over the
  // wrong surface (incident 2026-07-23: the "Ask AI" bar floated at the top over the CRM view).
  // Scoping the lookup to this surface's own subtree makes a foreign match structurally
  // impossible; when the node is genuinely gone from THIS surface the query returns null and
  // the shared AnchoredOverlay hides (it already refuses to paint at (0,0)).
  const surfaceRootRef = React.useRef<HTMLDivElement>(null);
  const scopedNodeQuery = (selector: string): HTMLElement | null =>
    (surfaceRootRef.current ?? document).querySelector<HTMLElement>(selector);
  const scopedNodeQueryAll = (selector: string): HTMLElement[] =>
    Array.from((surfaceRootRef.current ?? document).querySelectorAll<HTMLElement>(selector));
  const blockAnchorEl = (nodeId: string | null | undefined): HTMLElement | null =>
    nodeId ? scopedNodeQuery(`.ca-text-node[data-node-id="${nodeId}"]`) : null;
  // The composer's anchor mirrors the spacing/condition editors' 2026-07-09 overlay-anchor
  // category fix: prefer the block's live editable TEXT element, but FALL BACK to the node's
  // FRAME (`[data-node-id]`, any node type) when the text element isn't in the DOM — the
  // composer opened on a non-text node (the "Ask AI" affordance), or the block's element was
  // momentarily absent (unmounted / re-created on finalize). Both lookups are scoped to THIS
  // surface (surfaceRootRef), so the fallback can never match a foreign surface's node frame.
  // Without a fallback the anchor resolves null, and the shared AnchoredOverlay then paints at
  // window (0,0): the composer flew to the top-left corner over the traffic lights (incident
  // 2026-07-19). The frame is the same safety fall-back `editorNodeAnchorEl` already uses, so
  // (0,0) is now structurally impossible for the composer while its node is rendered.
  const composerAnchorEl = (nodeId: string | null | undefined): HTMLElement | null =>
    blockAnchorEl(nodeId) ?? (nodeId ? scopedNodeQuery(`[data-node-id="${nodeId}"]`) : null);
  const composerAnchorRef = React.useMemo(
    () => ({ get current() { return composerAnchorEl(activeComposer?.nodeId); } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeComposer],
  );
  // The @-mention picker: a renderer:"picker" input-shortcut opened inline while typing after the
  // prefix. Its options come from live feeds named as DATA (option_sources by kind); picking inserts
  // a reference token (token_template). Which shortcut/feeds/token are DATA — the surface names none.
  // `range` (composer only) = the flat-text offsets of the `@`-token that opened the picker, so the pick
  // splices EXACTLY that token even when it's mid-prompt (Codex C3). Absent → trailing-`@` replace (block).
  const [activePicker, setActivePicker] = React.useState<{ nodeId: string; query: string; for?: 'block' | 'composer'; range?: { start: number; end: number } } | null>(null);
  const [pickerIndex, setPickerIndex] = React.useState(0);
  // Menu/picker anchors: block-scoped → the block's live element; composer-scoped → the COMPOSER
  // PANEL element (the overlay must sit below the composer the user is typing in, not the shorter
  // block hidden behind it). Getter-refs resolve at measure time — same rationale as the composer's.
  const menuAnchorRef = React.useMemo(
    () => ({
      get current() {
        if (activeMenu && activeComposer && activeMenu.nodeId === activeComposer.nodeId) return composerBoxRef.current;
        return blockAnchorEl(activeMenu?.nodeId);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeMenu, activeComposer],
  );
  const pickerAnchorRef = React.useMemo(
    () => ({
      get current() {
        if (activePicker?.for === 'composer') return composerBoxRef.current;
        return blockAnchorEl(activePicker?.nodeId);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activePicker],
  );
  // Contextual format bar (The owner: it must NOT always show — Notion surfaces it only on a text
  // SELECTION, not on mere caret focus). Track a live non-collapsed selection; the bar renders
  // only while text is highlighted. `selectionchange` is the canonical browser signal — no poll.
  const [hasTextSelection, setHasTextSelection] = React.useState(false);
  React.useEffect(() => {
    const onSelectionChange = () => {
      const selection = typeof window !== 'undefined' ? window.getSelection() : null;
      setHasTextSelection(!!selection && !selection.isCollapsed && selection.toString().trim().length > 0);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);
  // Click-outside dismiss for the slash menu (The owner: "in notion if u just click somewhere
  // else it dismisses"). While the menu is open, a pointerdown anywhere outside `.ca-menu`
  // closes it. Clicks ON a menu row are guarded by the `.ca-menu` ancestor check, so row
  // selection still works. Capture phase so we see the event before node handlers consume it.
  const activeMenuOpen = activeMenu !== null;
  React.useEffect(() => {
    if (!activeMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && target.closest('.ca-menu')) return;
      setActiveMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [activeMenuOpen]);
  // Highlighted row in the insert menu; ArrowUp/Down move it, Enter commits it.
  // Resets to the top whenever the query changes or a new menu opens.
  const [menuIndex, setMenuIndex] = React.useState(0);
  // "Show when …": which node is having its conditional visibility authored, and
  // the in-progress condition draft. The bound condition is engine DATA (the
  // node's `visible` binding the kernel resolves); this is just the editor UI.
  const [conditionNodeId, setConditionNodeId] = React.useState<string | null>(null);
  const [conditionDraft, setConditionDraft] = React.useState<ConditionDraft>({ path: '', op: 'op:core.equals', value: '' });
  // "Spacing …": which node is having its padding/gap edited. The values are
  // engine-honored style numbers (UPDATE_PROPS); this is just the popover's anchor.
  const [spacingNodeId, setSpacingNodeId] = React.useState<string | null>(null);
  // Spacing/condition editors anchor to the node's GRIP — the exact origin the user
  // invoked them from (the picker replaces the grip menu in place, the Notion idiom) —
  // via the SAME shared AnchoredOverlay as the / menu, never world frames (the 2026-07-09
  // overlay-anchor category fix; live incident images #71/#74: "Spacing" opened at the
  // node's raw WORLD y — over a different page's pixels — so the click looked dead).
  // The anchor must NOT be the node's frame: a frame's height is arbitrary (a stretched
  // split column measured 786px live; a long paragraph or panel is just as tall), so
  // "below the frame" lands the editor hundreds of px from the click, pinned at the
  // viewport bottom — still reads as "nothing happened". The grip is a ~24px strip at
  // the node's top-left interaction origin and exists on every menu-bearing node (the
  // editors are only reachable through its menu); the frame stays as the safety fall-back.
  // Getter-refs resolve at measure time, so the live DOM element is always current.
  const editorNodeAnchorEl = (nodeId: string | null | undefined): HTMLElement | null => {
    if (!nodeId) return null;
    const frame = scopedNodeQuery(`[data-node-id="${nodeId}"]`);
    if (!frame) return null;
    // The node's own grip precedes any descendant's grip in document order (the handle
    // renders before children inside SceneFrame), so first-match is this node's grip.
    return frame.querySelector<HTMLElement>('.ca-grip') ?? frame;
  };
  const spacingAnchorRef = React.useMemo(
    () => ({ get current() { return editorNodeAnchorEl(spacingNodeId); } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spacingNodeId],
  );
  const conditionAnchorRef = React.useMemo(
    () => ({ get current() { return editorNodeAnchorEl(conditionNodeId); } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conditionNodeId],
  );
  // Ephemeral pointer chrome (selection + text focus). Like contenteditable
  // focus, this is interaction state of THIS surface's pointer, not scene or
  // layout truth — the engine snapshot still decides everything rendered.
  const [focusedNodeId, setFocusedNodeId] = React.useState<string | null>(null);
  const hydratedSelectionScene = React.useRef<string | null>(null);
  const currentSelection = React.useRef({pageId: framedNodeId, blockId: focusedNodeId});
  currentSelection.current = {pageId: framedNodeId, blockId: focusedNodeId};
  // CANONICAL selection (SSOT): a SET of selected node ids. Single-select is a set of one; the
  // escalating Cmd+A (N3) and marquee (N4) fill it with the block/container/page or a marquee's
  // intersected blocks. The single-node contextual surfaces derive `selectedNodeId` from it.
  const [selectedNodeIds, setSelectedNodeIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const selectedNodeId = selectedNodeIds.size === 1 ? [...selectedNodeIds][0] : null;
  const setSelectedNodeId = React.useCallback((id: string | null) => {
    setSelectedNodeIds(id ? new Set([id]) : new Set());
  }, []);
  // A pointerdown OUTSIDE the editor (and outside any floating overlay) ENDS the selection
  // session: highlight cleared, escalation ladder reset. Required because the stage keyboard
  // contract is a WINDOW listener whose Cmd+A guard treats an active session as ownership —
  // without this clear, clicking into another surface would leave the session live and the
  // editor would keep swallowing that surface's Cmd+A (Codex guard-too-broad defect).
  const hasBlockSelection = selectedNodeIds.size > 0;
  React.useEffect(() => {
    if (!hasBlockSelection) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const insideEditor = !!(viewportRef.current && target && viewportRef.current.contains(target));
      const insideOverlay = !!(target && target.closest && target.closest('[data-floating-layer]'));
      if (insideEditor || insideOverlay) return;
      setSelectedNodeIds(new Set());
      selectionScopeRef.current = null;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [hasBlockSelection]);
  // Escalating-Cmd+A scope (N3): the anchor block + current containment level (0=content/text,
  // 1=block, 2=container, …). A ref because keydown reads+advances it synchronously. Reset to null
  // whenever the user re-focuses/clicks a block so the next Cmd+A starts from that block's content.
  const selectionScopeRef = React.useRef<{ anchorId: string; level: number } | null>(null);
  // Browsers perform the first text select as the default action after keydown. Test DOMs do not,
  // so remember that request explicitly and advance the same ladder on the next press.
  const textSelectAllRequestedRef = React.useRef(false);
  // Marquee drag-select (N4): the live drag box in SCREEN coords while dragging, else null. The box
  // selects the top-level blocks it overlaps via candidatesInRect (same Rect primitive as arrow nav).
  const [marqueeBox, setMarqueeBox] = React.useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const snapshotRef = React.useRef(snapshot);
  const selectedNodeIdsRef = React.useRef(selectedNodeIds);
  const selectionRevisionRef = React.useRef(0);
  const selectionKeyRef = React.useRef('');
  // Render ordering and durability ordering are deliberately separate. A raw
  // navigation reply may supersede the picture, but it cannot enter the durable
  // mutation stream.
  //   renderSequence — bumped by EVERY send (edits AND navigation: camera, reflow).
  //     Gates setSnapshot so the newest send's reply wins the on-screen snapshot.
  //   persistingTransactionQueue — serializes every tracked engine transaction
  //     and its matching durable write. No successful mutation is superseded or
  //     skipped: each caller resolves only after its own snapshot is durable.
  const renderSequence = React.useRef(0);
  const persistingTransactionQueue = React.useRef(createPersistingTransactionQueue()).current;
  // The engine viewport = the stage's REAL measured size (read-data/resolveStageViewport).
  // Held in a ref (not state): every transaction reads the CURRENT size with no stale
  // closure and no re-render — the snapshot reply drives render, not this value. Starts
  // at the desktop fallback until the ResizeObserver (attachStage) reports a real size.
  const stageViewportRef = React.useRef<Viewport>(DEFAULT_VIEWPORT);
  // sendTransaction kept in a ref so the reflow path + the stage ResizeObserver stay
  // identity-stable across renders (a churning callback ref would detach/reattach the
  // observer every render and spam reflows).
  const sendTransactionRef = React.useRef(sendTransaction);
  const stageObserverRef = React.useRef<ResizeObserver | null>(null);
  const [visualLayoutSettled, setVisualLayoutSettled] = React.useState(() => typeof ResizeObserver === 'undefined');
  const visualLayoutSettledRef = React.useRef(typeof ResizeObserver === 'undefined');
  const visualLayoutTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const visualLayoutRevisionRef = React.useRef(0);
  const markVisualLayoutDirty = React.useCallback(() => {
    if (typeof ResizeObserver === 'undefined') return;
    visualLayoutRevisionRef.current += 1;
    visualLayoutSettledRef.current = false;
    if (visualLayoutTimerRef.current) clearTimeout(visualLayoutTimerRef.current);
    visualLayoutTimerRef.current = null;
    setVisualLayoutSettled(false);
  }, []);
  const revealSettledVisualLayout = React.useCallback(() => {
    if (visualLayoutTimerRef.current) clearTimeout(visualLayoutTimerRef.current);
    const revision = visualLayoutRevisionRef.current;
    // Text blocks measure after two frames; wait for the last viewport and height
    // reply before exposing absolute frames that still belong to the old width.
    visualLayoutTimerRef.current = setTimeout(() => {
      if (revision === visualLayoutRevisionRef.current) {
        visualLayoutSettledRef.current = true;
        setVisualLayoutSettled(true);
      }
    }, 350);
  }, []);
  React.useEffect(() => () => {
    if (visualLayoutTimerRef.current) clearTimeout(visualLayoutTimerRef.current);
  }, []);

  React.useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  React.useEffect(() => {
    selectedNodeIdsRef.current = selectedNodeIds;
    const key = [...selectedNodeIds].sort().join('\u0000');
    if (key !== selectionKeyRef.current) {
      selectionKeyRef.current = key;
      selectionRevisionRef.current += 1;
    }
  }, [selectedNodeIds]);

  React.useEffect(() => {
    if (!mountedViewRef) return undefined;
    return mountedSurfaceRegistry.register(mountedViewRef, {
      readContext: () => ({
        surface_ref: sceneAddress,
        view_ref: mountedViewRef,
        document_ref: sceneAddress,
        ...(documentHashRef.current ? { document_hash: documentHashRef.current } : {}),
        selection_refs: [...selectedNodeIdsRef.current].sort(),
        selection_revision: `selection:${selectionRevisionRef.current}`,
        scene_revision: `render:${renderSequence.current}`,
        camera: snapshotRef.current.camera,
        graph_observations: {
          tree: snapshotRef.current.tree,
          frames: snapshotRef.current.frames,
        },
      }),
      setSelection: ({ expected_selection_revision, selection_refs }) => {
        const currentRevision = `selection:${selectionRevisionRef.current}`;
        if (expected_selection_revision !== currentRevision) {
          return { outcome: 'conflict', current_selection_revision: currentRevision };
        }
        const knownIds = sceneNodeIdSet(snapshotRef.current.tree);
        const missing = selection_refs.filter((ref) => !knownIds.has(ref));
        if (missing.length > 0) {
          return { outcome: 'invalid-selection', missing_refs: missing, current_selection_revision: currentRevision };
        }
        const next = new Set(selection_refs);
        const nextKey = [...next].sort().join('\u0000');
        if (nextKey !== selectionKeyRef.current) {
          selectionKeyRef.current = nextKey;
          selectionRevisionRef.current += 1;
        }
        selectedNodeIdsRef.current = next;
        setSelectedNodeIds(next);
        return {
          outcome: 'selected',
          selection_revision: `selection:${selectionRevisionRef.current}`,
          selection_refs: [...next].sort(),
        };
      },
      ...(applyMountedScenePatch ? { applyPatch: applyMountedScenePatch } : {}),
    });
  }, [applyMountedScenePatch, mountedViewRef, sceneAddress]);

  React.useEffect(() => {
    componentDefinitionsRef.current = componentDefinitions;
    definitionsByIdRef.current = definitionsMapFrom(componentDefinitions);
  }, [componentDefinitions]);

  React.useEffect(() => {
    sendTransactionRef.current = sendTransaction;
  }, [sendTransaction]);

  React.useEffect(() => {
    let cancelled = false;
    const sequence = ++renderSequence.current;
    setLoadState('loading');
    globalThis.performance?.mark('documents:open:read-start');
    void (readDocumentSnapshot
      ? readDocumentSnapshot().then((stored) => {
          documentHashRef.current = stored.documentHash;
          return stored.content;
        })
      : loadDocuments())
      .then(async (stored) => {
        globalThis.performance?.mark('documents:open:read-complete');
        if (expectedDocumentRevision && !stored) throw new Error('This document is no longer available.');
        const content = stored ?? seedContentRef.current;
        if (stored) lastKnownDurableContentRef.current = stored;
        if (cancelled || sequence !== renderSequence.current) return null;
        if (pendingConflictContent.current?.scope === conflictScope) {
          setConflictComparison({ local: pendingConflictContent.current.content, current: stored ? JSON.parse(JSON.stringify(stored)) : null, scope: conflictScope });
          pendingConflictContent.current = null;
        }
        if (expectedDocumentRevision) {
          const actual = revisionHashFor(content);
          const warningKey = JSON.stringify([sceneAddress, expectedDocumentRevision, actual]);
          if (actual !== expectedDocumentRevision && acknowledgedRevision.current !== warningKey) {
            setRevisionWarning(warningKey);
            setLoadState('revision-warning');
            return null;
          }
        }
        setRevisionWarning(null);
        globalThis.performance?.mark('documents:open:hydrate-start');
        const hydrated = await hydrateCompositionScene({
          content,
          session: sceneAddress,
          viewport: stageViewportRef.current,
          sendTransaction,
          transformChildren: normalizeLoadedMarkdown,
        });
        globalThis.performance?.mark('documents:open:hydrate-complete');
        componentDefinitionsRef.current = hydrated.definitions;
        definitionsByIdRef.current = hydrated.definitionsById;
        instanceRootsRef.current = hydrated.instanceRoots;
        setComponentDefinitions(hydrated.definitions);
        authoredEdges.current = hydrated.authoredEdges;
        const workspaceIsCanvas = workspaceHasCanvasLayout(hydrated.authoredRoot);
        const handoffSnapshot = hydrated.snapshot;
        // Reopen a canvas workspace AS a canvas (L116 — survives reload): re-flip the engine
        // root to an Absolute canvas (and slot any unplaced page). Pages keep their persisted
        // x/y, so this only restores the root mode — a no-op for a normal flow document.
        if (workspaceIsCanvas && handoffSnapshot?.tree) {
          const arrange = buildWorkspaceCanvasArrangement(handoffSnapshot.tree, {
            width: stageViewportRef.current.w, height: stageViewportRef.current.h,
          });
          if (arrange.scene_patches.length > 0) {
            const canvasSnapshot = await decodeCompositionSnapshotReply(
              await sendTransaction({ ...arrange, viewport: stageViewportRef.current }),
            );
            return { snapshot: canvasSnapshot, canvas: true };
          }
          return { snapshot: handoffSnapshot, canvas: true };
        }
        return { snapshot: handoffSnapshot, canvas: false };
      })
      .then((result) => {
        if (!result || cancelled || sequence !== renderSequence.current) return;
        const nextSnapshot = result.snapshot;
        if (!nextSnapshot) return;
        setActiveMenu(null);
        const firstChild = nextSnapshot.tree?.children?.[0] ?? null;
        // A saved canvas reopens framed on the workspace ROOT (the overview — all pages as
        // cards); a normal document reopens framed on its first page. Framing, not a mode.
        const previous = hydratedSelectionScene.current === sceneAddress ? currentSelection.current : null;
        const retainedPage = previous?.pageId === nextSnapshot.tree?.id ? nextSnapshot.tree
          : nextSnapshot.tree?.children?.find(page => page.id === previous?.pageId);
        const selectedPage = retainedPage ?? (result.canvas ? nextSnapshot.tree : firstChild);
        const retainedBlock = selectedPage && previous?.blockId ? findNodeById(selectedPage, previous.blockId) : null;
        setFramedNodeId(selectedPage?.id ?? null);
        setFocusedNodeId(retainedBlock?.id ?? (selectedPage ? firstTextNode(selectedPage)?.id ?? null : null));
        setSelectedNodeIds(ids => new Set(previous && selectedPage
          ? [...ids].filter(id => findNodeById(selectedPage, id)) : []));
        selectionScopeRef.current = null;
        hydratedSelectionScene.current = sceneAddress;
        snapshotRef.current = nextSnapshot;
        markVisualLayoutDirty();
        setSnapshot(nextSnapshot);
        globalThis.performance?.mark('documents:open:ready');
        setLoadState('ready');
        setLoadErrorText(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadState('error');
        // Humane detail only; a raw transport/engine error gates to the fallback so the
        // card never shows "...SendRequestToBitfieldTarget... status=3..." (L114).
        setLoadErrorText(errorMessage(error) || HUMANE_LOAD_FALLBACK);
      });
    return () => {
      cancelled = true;
    };
    // reloadToken re-runs load + handoff (recovery path). seedContent is read via
    // seedContentRef (NOT a dep) so a save-driven feed update never re-triggers the
    // full reload mid-edit (the "/"-menu-closes-and-cursor-jumps bug).
  }, [loadDocuments, readDocumentSnapshot, reloadToken, sendTransaction, expectedDocumentRevision, sceneAddress, conflictScope]);

  // Persist = one record: the engine root's children + camera, verbatim.
  // The same write path covers typing, inserting, deleting, AND page
  // operations — they are the same operations (plan §4.5).
  const persistSnapshot = React.useCallback((nextSnapshot: CompositionSnapshot) => {
    // Collapse the engine (resolved) tree back to the authored SSOT: instance
    // subtrees fold to ref nodes and any local edits become prop_overrides. This
    // keeps the ref form alive across saves (never persist the expanded tree — the
    // resolved-id persistence drift that would kill propagation). IDENTITY when no
    // instances exist, so non-component documents persist byte-identically.
    const authored = collapseInstances(nextSnapshot.tree, instanceRootsRef.current, definitionsByIdRef.current);
    const content: CompositionContent = {
      children: (authored?.children ?? []) as SceneNode[],
      edges: authoredEdges.current,
      camera: nextSnapshot.camera,
      ...(componentDefinitionsRef.current.length ? { definitions: componentDefinitionsRef.current } : {}),
    };
    const durablePages = new Map((lastKnownDurableContentRef.current?.children ?? []).map(page => [page.id, page]));
    const changedPages = content.children.filter(page => !sameImportedPage(durablePages.get(page.id) ?? null, page)).map(page => page.id);
    const markPages = (state: Exclude<SaveState, 'idle'>) => setPageSaveStates(current => {
      const next = {...current};
      for (const id of changedPages) next[id] = state;
      return next;
    });
    markPages('saving');
    return Promise.resolve().then(() => writeDocuments(content)).then(async (result) => {
      if (readDocumentSnapshot) documentHashRef.current = (await readDocumentSnapshot()).documentHash;
      lastKnownDurableContentRef.current = content;
      setSaveState('saved');
      markPages('saved');
      return result;
    }).catch(error => {
      if (error instanceof CompositionWriteConflictError) pendingConflictContent.current = { content: JSON.parse(JSON.stringify(content)), scope: conflictScope };
      markPages(error instanceof CompositionWriteConflictError ? 'conflict' : 'error');
      throw error;
    });
  }, [readDocumentSnapshot, writeDocuments, conflictScope]);

  const recoverFromWriteError = React.useCallback((error: unknown) => {
    const conflict = error instanceof CompositionWriteConflictError;
    setSaveState(conflict ? 'conflict' : 'error');
    // The full CS-065 recovery SENTENCE lives HERE (the roomy toast channel), not in
    // the terse ambient rail indicator (Codex Verdict A). Exact contract strings:
    // "Conflict: this page changed elsewhere" / "Could not save. Your edits are still here."
    showError(conflict
      ? 'Conflict: this page changed elsewhere. Reloading the latest version.'
      : `Could not save. Your edits are still here.${appendDetail(error)}`);
    // Reload from the log ONLY on a real CONFLICT (re-sync to the concurrent
    // writer's state). For a TRANSIENT (non-conflict) failure — a momentary
    // engine/network blip during rapid typing — reloading would REVERT the very
    // edits that just failed to persist (the in-flight text lives only in the
    // engine/contenteditable, not yet in the log), directly contradicting the
    // "your edits are still here" promise. So we keep the edits on screen and
    // let the next keystroke's save retry the persist. (Codex-converged
    // 2026-07-04: the reverted-edits bug was deterministic in THIS recovery
    // path, not a basis race — the log store's serial chain already makes basis
    // atomic.)
    if (conflict) setReloadToken((token) => token + 1);
  }, [showError]);

  // Every persisting USER write goes through here so the save indicator reflects
  // it ('saving' now → 'saved' when persistSnapshot lands → 'error' on failure).
  // Boot/handoff sends and camera-only navigation use the raw prop and stay
  // silent — they are not saves.
  const trackedSend = React.useCallback((transaction: CompositionTransaction) => {
    setSaveState('saving');
    return sendTransaction(transaction);
  }, [sendTransaction]);

  // The only durable mutation path. Queue the engine mutation AND persist of its
  // returned snapshot as one unit; otherwise a later snapshot can reach the log
  // before an earlier write resolves and make a receipt claim durability too soon.
  const runPersistingTransaction = React.useCallback((transaction: CompositionTransaction | (() => CompositionTransaction | null)) => {
    if (expectedDocumentRevision && loadState !== 'ready') return Promise.reject(new Error('Open the current document before editing.'));
    const sequence = ++renderSequence.current;
    return persistingTransactionQueue.enqueue(async () => {
      // decodeCompositionSnapshotReply is async (it unwraps a possibly-Promise
      // reply), so it MUST be awaited. An un-awaited call assigns a Promise to
      // nextSnapshot, so `nextSnapshot.tree` is undefined, setSnapshot stores a
      // Promise, and railNodes reads `snapshot.tree?.children ?? []` as [], so the
      // page silently never renders ("New page does nothing"). The other three
      // decode sites (816/1851/2935) await or .then; this one had regressed.
      const prepared = typeof transaction === 'function' ? transaction() : transaction;
      const nextSnapshot = prepared === null ? snapshotRef.current
        : await decodeCompositionSnapshotReply(await trackedSend(prepared));
      snapshotRef.current = nextSnapshot;
      if (sequence === renderSequence.current) {
        setSnapshot(nextSnapshot);
      }
      await persistSnapshot(nextSnapshot);
      return nextSnapshot;
    });
  }, [persistSnapshot, persistingTransactionQueue, trackedSend, loadState, expectedDocumentRevision]);

  const retryPersistingSnapshot = React.useCallback(() => {
    setSaveState('saving');
    // Read at execution time, not request time. A user edit already queued
    // ahead of this retry may advance the owner snapshot before this operation
    // runs; persisting a captured older snapshot afterward would revert it.
    return persistingTransactionQueue.enqueue(() => persistSnapshot(snapshotRef.current));
  }, [persistSnapshot, persistingTransactionQueue]);

  const matchingMaterials = activeMenu
    ? activeMenu.query
      ? materials.filter((material) => materialMatchesQuery(material, activeMenu.query))
      : materials
    : [];
  // Action rows for the "/" menu (R10/P7): every published action-affordance
  // record bound to this surface's slash channel, decoded blind from the same
  // published-record stream the placeable-surface materials ride. Records in →
  // actions appear; records gone → honest empty. Zero action names in source.
  const affordanceRows = React.useMemo(() => {
    const decoded = readActionAffordances(readPublishedRecords(allPublishedRows));
    // Dedup by identity id, keeping the LAST occurrence — a soft-deleted record
    // (is_active:false) is already dropped by readActionAffordances, but the
    // published feed can also surface stale historical copies of the same id;
    // collapsing by id keeps exactly one live row per action.
    const byId = new Map(decoded.map((a) => [a.id, a]));
    const rows = affordanceSlashRows([...byId.values()]);
    console.log(`[action-affordance] composition slash rows: ${rows.length} of ${decoded.length} affordances`);
    return rows;
  }, [allPublishedRows]);
  const matchingAffordances = activeMenu
    ? activeMenu.query
      ? affordanceRows.filter((row) => affordanceRowMatchesQuery(row, activeMenu.query))
      : affordanceRows
    : [];
  React.useEffect(() => {
    setMenuIndex(0);
  }, [activeMenu?.query, activeMenu?.nodeId]);
  // ONE keyboard-indexed list across BOTH insert materials AND action rows (Codex wiring step 4):
  // the highlight + Enter commit walk materials [0..M) then affordances [M..M+A). Previously only
  // materials were reachable — action rows rendered but were click-only. Now the whole menu is
  // keyboard-navigable, and it works even when a query filters down to only action rows.
  const menuRowCount = matchingMaterials.length + matchingAffordances.length;
  const menuActiveIndex = menuRowCount > 0
    ? ((menuIndex % menuRowCount) + menuRowCount) % menuRowCount
    : 0;

  function applyTextChange(nodeId: string, value: string, caretOffset?: number) {
    setFocusedNodeId(nodeId);
    // The insert/command menu opens from the LIVE DATA registry, not a hardcoded "/" — a
    // `renderer:"menu"` input-shortcut (shortcut:slash by default; any package may ship another)
    // matched inline while typing opens the menu with the query after its prefix. This is the
    // DATA-driven replacement of the old readSlashQuery special-case (L030). Picker/composer rows
    // are handled by their own renderers (not this menu); non-menu prefixes fall through as text.
    // The caret offset lets the matcher's `at:"caret-token"` scope fire the shortcut MID-BLOCK (not
    // only at block start) — DATA-driven scope, so `@`/`/` open anywhere the caret is (Notion parity).
    const open = matchInputShortcut(value, 'inline', inputShortcutsFullRef.current, caretOffset);
    if (open && open.renderer === 'menu') {
      setActiveMenu({ nodeId, query: open.query.trim().toLowerCase() });
      setActivePicker(null);
    } else if (open && open.renderer === 'picker') {
      // @-mention: open the reference picker over its DATA-named live feeds, keyed on the query typed
      // after the prefix. Same inline-open path as the menu — routed by renderer SHAPE, never named.
      // `open.range` (the caret-token span) is carried so insertReferenceToken splices the chip EXACTLY
      // where the caret is (mid-block precision), via the shared insertRefTokenIntoText primitive.
      setActivePicker({ nodeId, query: open.query, range: open.range });
      setActiveMenu(null);
    } else if (value.length > 0) {
      // Real typed text (not a command) → dismiss any open insert menu / picker.
      setActiveMenu(null);
      setActivePicker(null);
    }
    // value === '' → leave the menu untouched. A menu opened EXPLICITLY (the
    // Insert toolbar button / a grip "Add") lives on an empty block; the engine's
    // async reply fires an empty onChange as the fresh node settles, and closing
    // here would nuke the menu the toolbar just opened (the "Insert does nothing"
    // bug). Escape and outside-click still close it.
    commitTextPatch(nodeId, value);
  }

  // Engine snapshots are the ONLY layout/scene truth (plan §2, locked).
  // Every patch goes to the engine; the reply snapshot is what renders.
  // The in-flight keystroke lives only in contenteditable's own DOM.
  async function commitPatchesAndPersist(patches: ScenePatch[]): Promise<boolean> {
    try {
      await runPersistingTransaction({ scene_patches: patches });
      return true;
    } catch (error) { recoverFromWriteError(error); return false; }
  }
  function commitPatches(patches: ScenePatch[]) {
    void commitPatchesAndPersist(patches);
  }

  // Coalesce synchronous input per node without depending on a paint frame.
  // Hidden native windows can suspend rAF while an edit still needs saving.
  const pendingText = React.useRef<{ nodeId: string; value: string; scheduled: boolean }>({
    nodeId: '',
    value: '',
    scheduled: false,
  });

  function commitTextPatch(nodeId: string, value: string) {
    const pending = pendingText.current;
    if (pending.scheduled && pending.nodeId !== nodeId) flushTextPatch();
    pending.nodeId = nodeId;
    pending.value = value;
    if (pending.scheduled) return;
    pending.scheduled = true;
    queueMicrotask(flushTextPatch);
  }

  function flushTextPatch() {
    const pending = pendingText.current;
    if (!pending.scheduled) return;
    pending.scheduled = false;
    const { nodeId, value } = pending;
    runPersistingTransaction(() => {
      const tree = snapshotRef.current.tree;
      const node = tree ? findNodeById(tree, nodeId) : null;
      if (!node) return null;
      return { scene_patches: [{
        type: 'UPDATE_PROPS',
        node_id: nodeId,
        changes: { props: { ...node.props, text: value } },
      }] };
    }).catch(recoverFromWriteError);
  }

  // ── Autoformat (input-shorthand → block transform) — the generic engine ──────
  // Apply a matched autoformat rule to a block. The rule's effect is an OPEN scene-patch
  // template (DATA); we resolve it against the ctx bag via the SAME resolveBindingTemplate
  // the affordance system uses, merge any UPDATE_PROPS over the block's CURRENT props (so
  // unrelated props + style survive, exactly like commitFormat), and commit. The surface is
  // BLIND to what the effect does — a heading, a divider, a future toggle all flow here.
  // Returns the block's NEW text (so the caller can optimistically sync the focused DOM,
  // which the engine round-trip can't overwrite while focused) — or null when the effect
  // REPLACED the block (divider), in which case focus moves to the fresh trailing block.
  // Blind shortcut matcher handed to every text block. It closes over the LIVE
  // DATA rule set (inputShortcutsRef — read-by-kind from the feed, the ONLY rule
  // source) so the child never sees the rule table (L098 translation boundary): the
  // child asks "does `${before}` match a shortcut for this trigger?", the parent
  // answers. A package writing a new input-shortcut record live is honored on the
  // next keystroke with zero remount, zero surface code.
  const matchShortcut = React.useCallback(
    (before: string, trigger: 'space' | 'enter'): AutoformatMatch | null =>
      matchAutoformat(before, trigger, inputShortcutsRef.current),
    [],
  );

  // Fire a renderer:none DISPATCH shortcut (e.g. !! -> a deterministic workflow) to ANY envelope
  // target. The target + payload are DATA on the shortcut (dispatch.target + dispatch.payload_template);
  // we resolve the payload against the invoke ctx via the SAME resolveBindingTemplate the action rail
  // uses, then send through the SAME runActionAffordance rail the slash actions use. The surface is
  // BLIND to what the target does — workflow, AI, schedule, write-batch all flow here (L090). No
  // feature-package import: the target is an opaque address string in the DATA row.
  // `inPlace` = the invoking surface shows the run WHERE the output will land (the Notion
  // composer idiom): no "Running…"/"added N blocks" toasts — the working panel and the blocks
  // appearing ARE the feedback — and a Stop token that abandons placement. Errors still toast
  // (they are exceptional and the panel closes). Absent ⇒ toast feedback (slash actions).
  // WHERE the ask is happening, as STRUCTURED FACTS for the row's template to frame:
  // { title, body } — the invoking page's title (its first non-empty block) and the
  // preceding sibling block texts. The surface emits ONLY facts; every word of framing
  // prose ("Document title: ", "Content so far:") lives in the row's instruction_text
  // template as `$kind:'group'` DATA parts, so a package rewords/translates/extends the
  // prompt with zero code (F2 gauntlet correction — prompt Society was living in TS).
  // The sibling budget is row DATA too (dispatch.document_context.max_preceding_blocks);
  // absent → all preceding blocks (the template owns its own economy). Chip tokens
  // serialize to their @label (parseInlineRuns) so the model reads references as words,
  // never raw token syntax. Absent facts are '' — the group parts collapse cleanly.
  function documentFactsFor(nodeId: string, budget?: number): { title: string; body: string } {
    const tree = snapshotRef.current.tree;
    const page = (framedNodeId ? findNodeById(tree ?? null, framedNodeId) : null) ?? tree?.children?.[0] ?? null;
    if (!page) return { title: '', body: '' };
    const readable = (raw: unknown): string => {
      if (typeof raw !== 'string' || raw.trim() === '') return '';
      return parseInlineRuns(raw).map((run) => (run.type === 'text' ? run.text : `@${run.label}`)).join('').trim();
    };
    const blocks = (page.children ?? [])
      .map((child) => ({ id: child.id, text: readable(child.props?.text) }))
      .filter((b) => b.text !== '');
    const invokeIndex = (page.children ?? []).findIndex((child) => child.id === nodeId);
    const preceding = blocks.filter((b) => {
      const i = (page.children ?? []).findIndex((child) => child.id === b.id);
      return invokeIndex === -1 || i < invokeIndex;
    });
    const budgeted = typeof budget === 'number' && budget > 0 ? preceding.slice(-budget) : preceding;
    const title = blocks[0]?.text ?? '';
    const body = budgeted.filter((b) => b.text !== title).map((b) => b.text).join('\n');
    return { title, body };
  }

  async function dispatchInputShortcut(
    shortcut: InputShortcut,
    capturedText: string,
    nodeId: string,
    inPlace?: { cancelToken: { cancelled: boolean }; onOutcome: (failure: string | null) => void },
    localSelections?: Record<string, string>,
  ) {
    const dispatch = shortcut.dispatch;
    const target = dispatch && typeof dispatch.target === 'string' ? dispatch.target : null;
    if (!partitionLabel || !target) { inPlace?.onOutcome(null); return; }
    const runId = `ca-${crypto.randomUUID()}`;
    // PER-ASK config selections (`config_selection` ctx bag): every select-less config
    // group's value = the session's EXPLICIT pick, else '' (the producer's documented
    // no-override no-op). An untouched group MUST send '' — never the default_from-derived
    // value — so an ordinary ask stays byte-identical to today (plan §10c/L083): the
    // substrate already resolves the selected agent + its launch itself, and eagerly
    // echoing the derived model back could reroute a profile whose custom launch is not
    // pinned to that model id (plan FMEA row 5). default_from is DISPLAY truth (the
    // panel's "Agent's model" annotation), never an implicit dispatch value.
    const configSelection: Record<string, string> = {};
    for (const group of composerConfigGroups(
      (shortcut.presentation?.config ?? {}) as Record<string, unknown>,
      placeableSurfaceRows,
    )) {
      if (group.hasSelect || !group.key) continue;
      configSelection[group.key] = localSelections?.[group.key] ?? '';
    }
    // `config` = the row's own presentation.config (so its payload_template can bind the
    // writing-instructions preamble); `document` = where the ask is happening as FACTS
    // ({title, body}) the row's template frames with its own `$kind:'group'` prose parts,
    // so the model knows it is writing INTO a document, not chatting (user incident: the
    // reply offered to "create a file or output it here in the chat"). The preceding-blocks
    // budget is the row's own DATA (dispatch.document_context.max_preceding_blocks). Facts
    // resolve to '' when absent so rows that don't bind them are byte-identical.
    const docCfg = dispatch && typeof dispatch.document_context === 'object' && dispatch.document_context !== null
      ? (dispatch.document_context as Record<string, unknown>) : null;
    const docBudget = typeof docCfg?.max_preceding_blocks === 'number' ? docCfg.max_preceding_blocks : undefined;
    // The preamble the template binds (config.preamble) is resolved LIVE at dispatch:
    // preamble_source reads the dedicated instructions record from the feed (a save
    // moments ago rides THIS ask), falling back to the config's literal (F6/T6).
    const rowConfig = shortcut.presentation?.config ?? {};
    const livePreamble = resolvePreamble(rowConfig as Record<string, unknown>, Array.isArray(placeableSurfaceRows) ? placeableSurfaceRows : []);
    const ctx = {
      run: { id: runId },
      surface: { channel: COMPOSITION_SLASH_CHANNEL, target_ref: nodeId, scene_address: sceneAddress },
      captured: { text: capturedText },
      typed: { text: capturedText },
      config: livePreamble != null ? { ...rowConfig, preamble: livePreamble } : rowConfig,
      config_selection: configSelection,
      document: documentFactsFor(nodeId, docBudget),
      answers: {},
    } as unknown as AffordanceInvokeContext;
    const payload = dispatch?.payload_template
      ? resolveBindingTemplate(dispatch.payload_template, ctx)
      : {};
    // A result-bearing dispatch (e.g. space→AI) carries a `status` template + an
    // `output_contract`. Resolve the status addresses (fill `{id}` with the run id — the
    // SAME id the payload binds as request_id) so runActionAffordance polls the producer's
    // result, then place the produced blocks through the ONE shared insertion rail. Absent
    // status ⇒ fire-and-forget (e.g. `!!`→checkpoint). Blind to the target either way (L090).
    const statusRaw = dispatch && typeof dispatch.status === 'object' && dispatch.status !== null
      ? (dispatch.status as Record<string, unknown>) : null;
    const statusAddresses = statusRaw
      && typeof statusRaw.result_address_template === 'string'
      && typeof statusRaw.error_address_template === 'string'
      ? {
          resultAddress: statusRaw.result_address_template.split('{id}').join(runId),
          errorAddress: statusRaw.error_address_template.split('{id}').join(runId),
          ...(statusRaw.address_mode === 'label-hash' || statusRaw.address_mode === 'identity-text'
            ? { addressMode: statusRaw.address_mode } : {}),
          ...(typeof statusRaw.result_partition_label === 'string'
            ? { resultPartitionLabel: statusRaw.result_partition_label } : {}),
        }
      : null;
    // Poll budget is Society DATA on the row (status.timeout_ms) — an action that legitimately
    // runs long (a deep-reasoning agent) declares its own budget; absent → the rail's default.
    const timeoutMs = typeof statusRaw?.timeout_ms === 'number' && statusRaw.timeout_ms > 0
      ? statusRaw.timeout_ms : undefined;
    const outputContract = dispatch && typeof dispatch.output_contract === 'object' && dispatch.output_contract !== null
      ? (dispatch.output_contract as Record<string, unknown>) : null;
    const artifactsPath = typeof outputContract?.artifacts_path === 'string' ? outputContract.artifacts_path : 'items';
    const label = shortcut.id.replace(/^shortcut:/, '');
    if (!inPlace) showSuccess(`Running "${label}"…`);
    // In-place runs report EVERY outcome through onOutcome(failure) — the panel renders success
    // (null → close; the placed blocks are the feedback) or failure IN PLACE (message + Try
    // again). It never both-toasts-and-panels, and it never silently vanishes: an error, a
    // timeout, and an empty result are all failures the user must SEE where the writing was
    // going to land (live incident 2026-07-10: a timed-out ask closed with zero feedback).
    const settle = (failure: string | null) => {
      // The run is over — detach the live-output panel for this node (whether it
      // streamed or not). The placed blocks (or the failure message) are the feedback.
      setStreamingRun((run) => (run?.nodeId === nodeId ? null : run));
      if (inPlace) inPlace.onOutcome(failure);
      else if (failure) showError(failure);
    };
    // BROWSER-DIRECT LIVE STREAMING (before the workflow one-shot below): if the
    // shortcut declares `dispatch.streaming_launch` DATA and the selected agent
    // resolves to a `process_session` CLI, fire start_session directly and hand its
    // live feed to the SAME streaming panel. The workflow ask-step →
    // compute.process_session path never spawns the CLI, so a streaming agent MUST
    // take this path. Any miss (no DATA, nothing selected, a non-streaming agent,
    // a launch failure) falls through to the existing runActionAffordance one-shot —
    // byte-identical to today for every non-streaming agent (L090 blind: this names
    // no agent/cli; process-session renders + fires; selection is DATA).
    const streamingCfg = dispatch && typeof dispatch.streaming_launch === 'object' && dispatch.streaming_launch !== null
      ? (dispatch.streaming_launch as Record<string, unknown>) : null;
    if (streamingCfg) {
      try {
        const rendered = await resolveStreamingLaunch(streamingCfg, { prompt: capturedText });
        if (rendered) {
          const started = await startProcessSession(rendered.descriptor, {
            target: 'compute.process_session',
            sender: sendRequestToBitfieldTarget as ProcessSessionSender,
          });
          // Hand BOTH the HEAD (event_feed_address — read for terminal state +
          // authoritative bytesWritten) AND the per-event delta stream
          // (event_stream_address). The live-output hook subscribes the stream
          // IMMEDIATELY and folds every delta losslessly (no HEAD-discovery delay
          // → no cold-start delta drop-out). Passing only the HEAD forced a late,
          // current-value tail that dropped ~62% of a fast answer.
          const headAddress = started.eventFeedAddress ?? started.eventStreamAddress;
          const handle = headAddress
            ? readProcessSessionStreamHandle({
                session_id: started.sessionId,
                event_feed_address: headAddress,
                ...(started.eventStreamAddress ? { event_stream_address: started.eventStreamAddress } : {}),
                ...(started.terminalOutputAddress ? { terminal_output_address: started.terminalOutputAddress } : {}),
                ...(rendered.streamParseSpec ? { stream_parse_spec: rendered.streamParseSpec } : {}),
              })
            : null;
          if (handle) {
            // The live stream now owns the panel; the finalize-from-stream effect
            // (on liveOutput.complete) places the full accumulated answer + closes
            // the composer.
            setStreamingRun({ nodeId, runId, handle });
            return;
          }
        }
      } catch (error) {
        // A live launch that fails is said in plain words. Falling through to the one-shot run below hid that the stream never started.
        settle(`Live streaming could not start: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    try {
      const outcome = await runActionAffordance({
        target, payload, statusAddresses, partitionLabel, timeoutMs,
        // A still-in-progress run (final:false) hands us the opaque result payload;
        // process-session reads its own stream handle out of it, and this node's working
        // panel renders the live growing text where the "Writing:" spinner is. The poll
        // then yields (state:'streaming') and the finalize-from-stream effect places the
        // accumulated answer when the session ends (a run with no handle just stays a
        // spinner and finalizes off the terminal result below as usual).
        onInterim: (resultPayload) => {
          const handle = readProcessSessionStreamHandle(resultPayload);
          if (handle) setStreamingRun({ nodeId, runId, handle });
        },
      });
      if (inPlace?.cancelToken.cancelled) return; // user pressed Stop — place nothing, say nothing
      // Streaming run — the live stream now owns the panel + finalize; nothing to settle
      // here (settling would close the panel mid-stream). The finalize-from-stream effect
      // places the answer + closes the composer when the session ends.
      if (outcome.state === 'streaming') return;
      if (outcome.state === 'error') {
        settle(outcome.message || 'That action could not finish.');
        return;
      }
      if (outcome.state === 'timeout') {
        settle("This is taking too long — the run is still queued or working. Try again, or ask again in a moment.");
        return;
      }
      const failure = resultFailureMessage((outcome as { resultPayload?: unknown }).resultPayload);
      if (failure) {
        settle(`"${label}" couldn't finish: ${failure}`);
        return;
      }
      if (statusAddresses && outcome.state === 'done') {
        const placed = insertResultArtifacts(outcome.resultPayload, artifactsPath, nodeId, runId);
        if (placed === 0) {
          settle(`"${label}" finished but produced nothing to place.`);
          return;
        }
        if (!inPlace) showSuccess(`"${label}" added ${placed} ${placed === 1 ? 'block' : 'blocks'}.`);
      }
      settle(null);
    } catch (error) {
      if (!inPlace?.cancelToken.cancelled) {
        const raw = error instanceof Error ? error.message : String(error);
        console.error('[documents] action run failed:', raw);
        settle('That action could not run.');
      }
    }
  }

  // Blind terminated-dispatch matcher handed to each text block (mirrors matchShortcut): the block
  // asks "does `${before}` complete a dispatch shortcut on this key?"; if yes we fire it and return
  // true so the keydown consumes the gesture. Reads the live full registry (renderer:none + dispatch).
  const tryDispatchShortcut = (before: string, trigger: 'space' | 'enter', nodeId: string): boolean => {
    const m = matchInputShortcut(before, trigger, inputShortcutsFullRef.current);
    if (!m || m.renderer !== 'none' || !m.shortcut.dispatch) return false;
    void dispatchInputShortcut(m.shortcut, m.captured.text, nodeId);
    return true;
  };

  // The composer shortcut = the live registry's renderer:"composer" row (space→AI by default).
  // Found by SHAPE, never named — a package can ship its own composer row and this picks it up.
  const composerShortcut = React.useMemo(
    () => (inputShortcutsFull ?? []).find((s) => s.presentation?.renderer === 'composer') ?? null,
    [inputShortcutsFull],
  );
  // The composer's dialog/submit label + input placeholder are a PROJECTION of the
  // registry rows (the row's own presentation.ask field + the inline rows' hints) —
  // never JSX literals (F3: the JSX duplicated copy the DATA already owned).
  const composerCopy = React.useMemo(
    () => composerAskCopy(composerShortcut, inputShortcutsFull ?? []),
    [composerShortcut, inputShortcutsFull],
  );
  // The disclosure panel's GROUPS, folded from the row's config DATA over the live
  // published-records stream: the bag itself (sticky select-dispatching choice — the
  // agent) plus every shape-matching nested bag (per-ask local choices — e.g. Model).
  // A group WITH `select` dispatches a global write; one WITHOUT collects into the
  // per-session config_selection bag the dispatch binds (`from:'config_selection'`).
  // The fold names nothing — a package ships a new group as one DATA key (L090).
  const composerConfig = composerShortcut?.presentation?.config;
  const composerConfigGroupsData = React.useMemo(
    () => composerConfigGroups(composerConfig, placeableSurfaceRows),
    [composerConfig, placeableSurfaceRows],
  );
  const composerConfigViewData = composerConfigGroupsData.length ? composerConfigGroupsData[0].view : null;
  // PER-ASK local selections, keyed by group key. Reset when a composer session opens
  // (openComposer) — the choice scopes to ONE ask; the sticky default IS the agent
  // profile (plan F3: no global selected-model SSOT). '' = follow the derived default.
  const [composerLocalSelections, setComposerLocalSelections] = React.useState<Record<string, string>>({});
  // Derived defaults for select-less groups (default_from DATA: selected agent →
  // model_refs.0 → the option row it maps to), read fresh each panel open.
  const [composerGroupDefaults, setComposerGroupDefaults] = React.useState<Record<string, string>>({});
  // Read the CURRENT choice when the panel opens (a point read via the config's DATA ask —
  // fresh every open, so an update from any other surface shows honestly) + resolve each
  // select-less group's derived default from its default_from recipe.
  React.useEffect(() => {
    if (!composerConfigOpen || !composerConfig) return;
    let cancelled = false;
    void readComposerConfigCurrent(composerConfig).then((value) => {
      if (!cancelled) setComposerConfigCurrent(value);
    });
    for (const group of composerConfigGroupsData) {
      if (group.hasSelect || !group.defaultFrom) continue;
      void resolveConfigDefaultFrom(group.defaultFrom, placeableSurfaceRows).then((value) => {
        if (cancelled || value == null) return;
        setComposerGroupDefaults((current) => ({ ...current, [group.key]: value }));
      });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerConfigOpen, composerConfig, composerConfigGroupsData]);
  async function chooseComposerConfigOption(option: { value: string; label: string }) {
    setComposerConfigCurrent(option.value);
    setComposerConfigOpen(false);
    try {
      await dispatchComposerConfigSelect(composerConfig, option);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[documents] switch config failed:', raw);
      showError('Couldn\'t switch.');
    }
  }
  // A select-less group's row click: record the per-ask choice locally, close. No
  // global write — the choice rides ONLY this session's dispatch ctx.
  function chooseComposerLocalOption(groupKey: string, value: string) {
    setComposerLocalSelections((current) => ({ ...current, [groupKey]: value }));
    setComposerConfigOpen(false);
  }
  // Save the edited writing-instructions preamble to its OWN dedicated LIVE record
  // (the one preamble_source reads — F6: the old whole-registry rewrite could clobber
  // a concurrent rules[] edit from a stale feed row). The by-kind readers pick it up
  // on the feed's next delivery, so the very next ask carries the new instructions —
  // no redeploy, no restart.
  async function saveComposerPreamble() {
    const draft = composerPreambleDraft;
    if (draft === null || !composerShortcut || !partitionLabel) { setComposerPreambleDraft(null); return; }
    try {
      const wrote = await writeComposerPreambleLive(
        composerConfig, draft, placeableSurfaceRows, partitionLabel);
      if (!wrote) showError("These instructions couldn't be saved.");
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      console.error('[documents] save preamble failed:', raw);
      showError('Couldn\'t save instructions.');
    } finally {
      setComposerPreambleDraft(null);
    }
  }
  // Open the composer when a keystroke matches the composer shortcut's OWN DATA trigger — its
  // `match.key` (default ' ') on its `match.at` block-state (default 'empty-block', Notion "press space
  // for AI"). The key + block-state are DATA (never a hardcoded `event.key === ' '`), so a package can
  // re-key the composer via its row (L090 / enum-dissolution). Returns true only when it actually opens,
  // so the text node consumes the key; false ⇒ ordinary typing.
  const openComposer = (nodeId: string, key: string, isEmpty: boolean): boolean => {
    if (!composerShortcut) return false;
    if (key !== (composerShortcut.match.key ?? ' ')) return false;
    if (composerShortcut.match.at === 'empty-block' && !isEmpty) return false;
    setActiveMenu(null);
    setComposerText('');
    // Per-ask choices (Model, any select-less config group) scope to ONE session:
    // a fresh composer starts from the derived defaults again (plan F3).
    setComposerLocalSelections({});
    setActiveComposer({ nodeId, phase: 'input' });
    return true;
  };
  // Submit the composer prompt through the composer shortcut's dispatch (result-bearing → the
  // produced blocks are placed on the invoking block via the shared insertion rail). The panel
  // does NOT close on submit — it flips to the WORKING phase in place (Notion: the prompt row
  // becomes the run indicator right where the writing will land) and closes when the run
  // settles. Stop abandons the run: the token makes the completion place nothing.
  function submitComposer() {
    const composer = activeComposer;
    // The composer stores references as ⟦ref:…⟧ chip tokens; the AI prompt needs readable text, so
    // serialize each chip back to its @label (parseInlineRuns) before dispatch.
    const prompt = parseInlineRuns(composerText)
      .map((run) => (run.type === 'text' ? run.text : `@${run.label}`))
      .join('')
      .trim();
    if (!composer || !composerShortcut || !prompt) {
      setActiveComposer(null);
      setComposerText('');
      return;
    }
    setComposerText('');
    runComposerPrompt(composer.nodeId, prompt);
  }
  // One run rail for submit AND Try-again: flip the panel to working, dispatch, and on outcome
  // either close (success — the placed blocks are the feedback) or flip the SAME panel to the
  // failed phase with the message + the retained prompt. The panel never silently vanishes.
  function runComposerPrompt(nodeId: string, prompt: string) {
    if (!composerShortcut) return;
    setActiveComposer({ nodeId, phase: 'working', prompt });
    const cancelToken = { cancelled: false };
    composerRunCancelledRef.current = cancelToken;
    void dispatchInputShortcut(composerShortcut, prompt, nodeId, {
      cancelToken,
      onOutcome: (failure) => {
        if (composerRunCancelledRef.current === cancelToken) composerRunCancelledRef.current = null;
        if (cancelToken.cancelled) return; // Stop already closed the panel
        // Touch only the working panel THIS run opened — a newer composer session
        // (user re-invoked while a stopped run was still settling) is left alone.
        setActiveComposer((current) => {
          if (!(current?.phase === 'working' && current.nodeId === nodeId)) return current;
          return failure ? { nodeId, phase: 'failed', prompt, failure } : null;
        });
      },
    }, composerLocalSelections);
  }
  // Stop = abandon THIS run (nothing will be placed) and return to writing immediately.
  function stopComposerRun() {
    const composer = activeComposer;
    if (composerRunCancelledRef.current) composerRunCancelledRef.current.cancelled = true;
    setActiveComposer(null);
    // Detach any live-output panel for this node (Stop/Escape bypasses settle).
    setStreamingRun((run) => (composer && run?.nodeId === composer.nodeId ? null : run));
    if (composer) {
      requestAnimationFrame(() => {
        const el = scopedNodeQuery(`.ca-text-node[data-node-id="${composer.nodeId}"]`);
        if (el) { el.focus(); placeCaretAtEnd(el); }
      });
    }
  }

  // The picker shortcut = the live registry's renderer:"picker" row (@-mention by default).
  const pickerShortcut = React.useMemo(
    () => (inputShortcutsFull ?? []).find((s) => s.presentation?.renderer === 'picker') ?? null,
    [inputShortcutsFull],
  );
  // Resolve the picker's options from its DATA-named live feeds (option_sources by kind, read across
  // the WHOLE published-records feed — the SAME by-kind read as the shortcut registry). Filtered by
  // the query typed after the prefix. The surface names no feed; a package points @ at its own kinds.
  const pickerOptions = React.useMemo(() => {
    if (!activePicker || !pickerShortcut) return [] as { value: string; label: string; kind: string; group: string; icon?: string }[];
    const sources = pickerShortcut.presentation?.option_sources ?? [];
    const q = activePicker.query.trim().toLowerCase();
    const rows: { value: string; label: string; kind: string; group: string; icon?: string }[] = [];
    const records = readPublishedRecords(placeableSurfaceRows);
    for (const src of sources) {
      if (!isRecord(src) || typeof src.kind !== 'string') continue;
      const kind = src.kind;
      const group = typeof src.group === 'string' ? src.group : kind;
      // Per-source DATA glyph (option_sources[].icon) → the chip + the menu row show the reference's
      // own icon. Absent → neutral fallback. Zero per-kind code (L090).
      const icon = typeof src.icon === 'string' && src.icon ? src.icon : undefined;
      // WHERE a source's label/value live is the source's OWN declaration (F4: the
      // try-chain of guessed field names — display_name/label/name/title — was the
      // surface deciding every kind's schema; a kind whose human name lives elsewhere
      // was unpickable without a code edit). label_path/value_path are dot-paths
      // (getPath — nested rows work); the pool cap is the source's `limit`. Absent
      // paths keep capable defaults (L083): value falls back id→value, label falls
      // back label→the value itself.
      const labelPath = typeof src.label_path === 'string' && src.label_path ? src.label_path : null;
      const valuePath = typeof src.value_path === 'string' && src.value_path ? src.value_path : null;
      const limit = typeof src.limit === 'number' && src.limit > 0 ? src.limit : 40;
      const asText = (raw: unknown): string | null =>
        typeof raw === 'string' && raw.trim() !== '' ? raw : null;
      const seen = new Set<string>();
      for (const rec of records) {
        const p = rec.payload as Record<string, unknown> | undefined;
        if (!p || p.kind !== kind) continue;
        const value = valuePath
          ? asText(getPath(p, valuePath))
          : (asText(p.id) ?? asText(p.value));
        const label = (labelPath ? asText(getPath(p, labelPath)) : asText(p.label)) ?? value;
        if (!value || !label || seen.has(value)) continue;
        if (q && !label.toLowerCase().includes(q)) continue;
        seen.add(value);
        rows.push({ value, label, kind, group, icon });
        if (seen.size >= limit) break;
      }
    }
    return rows;
  }, [activePicker, pickerShortcut, placeableSurfaceRows]);
  React.useEffect(() => { setPickerIndex(0); }, [activePicker?.query, activePicker?.nodeId]);

  // Insert the picked reference token into the invoking @-block (block-token model — the composition
  // engine is block-based, no inline spans). The token's TEXT is DATA (token_template.text_template
  // resolved against the chosen option); the block becomes that reference. Blind to what a "task" or
  // "skill" is — it only renders the resolved token string the DATA describes.
  function insertReferenceToken(nodeId: string, option: { value: string; label: string; kind: string; icon?: string }) {
    const token = pickerShortcut?.token_template;
    let text = `@${option.label}`;
    if (isRecord(token) && token.text_template) {
      const resolved = resolveBindingTemplate(token.text_template, { option } as unknown as AffordanceInvokeContext);
      if (typeof resolved === 'string' && resolved.trim()) text = resolved;
    }
    // The chip's stored IDENTITY (kind/value) is token_template-driven too (ref_kind/ref_id bindings),
    // not only its label — so a package can normalize what a chip POINTS at via DATA (e.g. map a source
    // record kind to a canonical target kind) without any code here. Falls back to the raw picked option
    // when the template omits a binding (Codex C5: don't hardcode option.kind/value past the DATA).
    const resolveRef = (node: unknown, fallback: string): string => {
      if (!isRecord(node)) return fallback;
      const r = resolveBindingTemplate(node, { option } as unknown as AffordanceInvokeContext);
      return typeof r === 'string' && r.trim() ? r : fallback;
    };
    const refKind = resolveRef(isRecord(token) ? token.ref_kind : undefined, option.kind);
    const refId = resolveRef(isRecord(token) ? token.ref_id : undefined, option.value);
    // Composer-scoped mention (typed inside the Ask-AI editable): the reference goes INTO THE PROMPT
    // as a chip token — replacing the trailing `@query` the user was typing — NOT into the block
    // behind the composer. Notion parity: @ inside the AI input adds context to the prompt as a chip.
    // The chip's LABEL is token_template-driven (DATA): `text` is the resolved token_template string
    // (or `@label` fallback); strip a leading @ since the chip already renders an @ icon.
    const chipLabel = text.replace(/^@/, '') || option.label;
    if (activePicker?.for === 'composer') {
      const refToken = encodeRefToken({ kind: refKind, value: refId, label: chipLabel, icon: option.icon });
      const range = activePicker.range;
      setActivePicker(null);
      const el = document.querySelector<HTMLElement>('.ca-composer-input');
      const base = el ? readBlockText(el, inlineMarksRef.current) : composerText;
      // Splice out EXACTLY the @-token the picker opened on (its flat range) — so a mid-prompt mention
      // ("summarize @ada| for me") replaces `@ada`, not the trailing word. The ONE shared splice primitive
      // falls back to trailing-@ replace when the range is stale/absent (caret moved). (Codex C3.)
      const nextText = insertRefTokenIntoText(base, refToken, range);
      setComposerText(nextText);
      if (el) {
        renderBlockRuns(el, nextText, inlineMarksRef.current); // materialize the chip now (the editable is focused → effect skips)
        el.focus();
        placeCaretAtEnd(el);
      }
      return;
    }
    setActivePicker(null);
    // INLINE CHIP (C5): the reference goes INLINE into the block at the caret — the trailing `@query`
    // the user was typing becomes a `⟦ref:…⟧` token (rendered as an icon+label chip), the rest of the
    // block's text is preserved. NOT the old "the block becomes the reference" model (that replaced
    // all text). The chip's DATA is the picked option (kind/value/label) — the surface names no
    // reference vocabulary; `text` remains the plain-text fallback stored inside no-token blocks.
    const refToken = encodeRefToken({ kind: refKind, value: refId, label: chipLabel, icon: option.icon });
    const el = scopedNodeQuery(`.ca-text-node[data-node-id="${nodeId}"]`);
    const current = el ? readBlockText(el, inlineMarksRef.current) : '';
    // The SAME shared splice primitive as the composer path (no range here → trailing-@ replace, the
    // block's existing behavior; a caret range can be threaded later for mid-block precision, zero new code).
    const finalText = insertRefTokenIntoText(current, refToken, activePicker?.range);
    // Optimistically materialize the chips in the focused contentEditable (the engine round-trip
    // can't overwrite a focused block), then persist through the same rAF-batched patch path as typing.
    if (el) {
      renderBlockRuns(el, finalText, inlineMarksRef.current);
      placeCaretAtEnd(el);
    }
    commitTextPatch(nodeId, finalText);
  }

  function applyAutoformat(nodeId: string, match: AutoformatMatch): string | null {
    const tree = snapshotRef.current.tree;
    if (!tree) return null;
    const loc = parentLocation(tree, nodeId);
    if (!loc) return null;
    // Cancel any rAF-queued text patch for THIS block before converting it. Live
    // typing defers each keystroke's text UPDATE_PROPS through a rAF (commitTextPatch);
    // if the pre-space "#" text flush is still pending when the user hits space, it
    // would land AFTER this autoformat patch and repaint the block unformatted (the
    // fast-type clobber — Codex root cause). Autoformat's own patch carries the final
    // text (the captured text, minus the marker), so the pending keystroke is stale.
    if (pendingText.current.nodeId === nodeId) pendingText.current.scheduled = false;
    const freshId = `node:${crypto.randomUUID()}`;
    const freshId2 = `node:${crypto.randomUUID()}`;
    const ctx: AutoformatContext = {
      captured: match.captured,
      block: { id: nodeId },
      parent: { id: loc.parentId, index: loc.index, next: loc.index + 1 },
      fresh: { id: freshId, id2: freshId2 },
    };
    const resolved = resolveBindingTemplate(match.rule.effect, ctx as unknown as AffordanceInvokeContext) as ScenePatch[];
    const patches = resolved.map((patch) => {
      if (patch.type === 'UPDATE_PROPS' && patch.node_id === nodeId) {
        const current = propsForNode(tree, nodeId) ?? {};
        const merged = mergeNodeProps({ id: nodeId, kind: 'Text', props: current }, patch.changes).props;
        return { ...patch, changes: { props: merged } } as ScenePatch;
      }
      return patch;
    });
    commitPatches(patches);
    // The FINAL text of the same block, if the effect kept it (headings, bullets, todos).
    const inPlace = resolved.find(
      (patch): patch is Extract<ScenePatch, { type: 'UPDATE_PROPS' }> =>
        patch.type === 'UPDATE_PROPS' && patch.node_id === nodeId,
    );
    const finalText = inPlace && isRecord(inPlace.changes.props) && typeof inPlace.changes.props.text === 'string'
      ? (inPlace.changes.props.text as string)
      : null;
    // A replace effect (e.g. divider) drops a fresh trailing text block — focus it so the
    // caret keeps flowing (detected generically: the effect inserted new nodes).
    if (finalText == null && resolved.some((patch) => patch.type === 'INSERT_NODE')) {
      setFocusedNodeId(freshId2);
    }
    return finalText;
  }

  // AI-output markdown expansion — reuses the SAME rules + effect templates as live typing
  // (one primitive, no second parser). Each produced Text artifact is split into lines; a
  // line that matches a rule is folded through its effect (foldAutoformatToNodes) into real
  // formatted block node(s); an unmatched single-line artifact keeps its original node (id +
  // reveal preserved). Non-Text / non-INSERT patches pass through. Indices are renumbered per
  // parent so expansion never collides with sibling inserts.
  function expandAutoformatInsertPatches(patches: ScenePatch[]): ScenePatch[] {
    const out: ScenePatch[] = [];
    const nextIndex = new Map<string, number>();
    // The live DATA rule set (read-by-kind from the feed) — same rules that fire on
    // typing, so AI/automation output and human typing share ONE parser + ONE source.
    const rules = inputShortcutsRef.current;
    const emit = (parentId: string, node: SceneNode) => {
      const i = nextIndex.get(parentId) ?? 0;
      out.push({ type: 'INSERT_NODE', parent_id: parentId, index: i, node });
      nextIndex.set(parentId, i + 1);
    };
    for (const patch of patches) {
      if (patch.type !== 'INSERT_NODE') { out.push(patch); continue; }
      const parentId = patch.parent_id;
      if (!nextIndex.has(parentId)) nextIndex.set(parentId, patch.index);
      const isText = patch.node?.kind === 'Text';
      const text = isText && typeof patch.node.props?.text === 'string' ? (patch.node.props.text as string) : null;
      if (text == null) { emit(parentId, patch.node); continue; }
      const lines = splitMarkdownLines(text);
      if (lines.length <= 1) {
        const only = lines[0] ?? '';
        const m = matchAutoformat(only, 'space', rules) ?? matchAutoformat(only, 'enter', rules);
        // An UNMATCHED single-line artifact keeps its ORIGINAL node (id + reveal
        // preserved). A MATCHED single line (`# Heading`, `---`) MUST fall through
        // to the fold loop below and become a real formatted block — the old
        // `|| only === text` guard was ALWAYS true for a one-line artifact (only ===
        // lines[0] === text), so it silently defeated every single-line conversion,
        // which is exactly how AI/automation blocks arrive (one paragraph per node).
        if (!m) { emit(parentId, patch.node); continue; }
      }
      for (const line of lines) {
        const m = matchAutoformat(line, 'space', rules) ?? matchAutoformat(line, 'enter', rules);
        if (!m) { emit(parentId, autoformatTextNode(line)); continue; }
        const baseId = `node:${crypto.randomUUID()}`;
        const ctx: AutoformatContext = {
          captured: m.captured,
          block: { id: baseId },
          parent: { id: parentId, index: 0, next: 1 },
          fresh: { id: `node:${crypto.randomUUID()}`, id2: `node:${crypto.randomUUID()}` },
        };
        const resolved = resolveBindingTemplate(m.rule.effect, ctx as unknown as AffordanceInvokeContext) as ScenePatch[];
        const folded = foldAutoformatToNodes(resolved, autoformatTextNode(m.captured.text, baseId));
        for (const node of folded) emit(parentId, node);
      }
    }
    return out;
  }

  // RETROACTIVE / UNIVERSAL: existing stored blocks that still hold literal markdown
  // (`# Heading`, `---`) — authored before the recognizer existed, produced by an older
  // AI run, or pasted — are normalized through the SAME recognizer at load, so the
  // primitive is genuinely source-agnostic (typing, AI, automation, paste, AND already-
  // saved content). It reuses expandAutoformatInsertPatches verbatim (one recognizer, no
  // second parser): each page's direct children become INSERT patches, get expanded, then
  // fold back into the page. Unmatched blocks keep their original node (id preserved), so a
  // reload is idempotent — a converted heading no longer starts with `#`, so it never
  // re-matches. Display-time only: it does not persist until the user next edits the page.
  function normalizeLoadedMarkdown(pages: SceneNode[]): SceneNode[] {
    return pages.map((page) => {
      const kids = page.children ?? [];
      if (kids.length === 0) return page;
      const asPatches: ScenePatch[] = kids.map((child, index) => ({
        type: 'INSERT_NODE', parent_id: page.id, index, node: child,
      }));
      const expanded = expandAutoformatInsertPatches(asPatches);
      const nextChildren = expanded
        .filter((patch): patch is Extract<ScenePatch, { type: 'INSERT_NODE' }> =>
          patch.type === 'INSERT_NODE' && patch.parent_id === page.id)
        .map((patch) => patch.node);
      return { ...page, children: nextChildren };
    });
  }

  // Node resize. The handles emit a candidate rect; we coalesce to one engine
  // transaction per animation frame (Pattern 58 — latest rect wins) so a drag
  // streams ~60 smooth reframes without flooding the engine. Size is node DATA
  // (props.style.width/height — the engine sizes from it, convergence F1/F2)
  // and is ALWAYS sent — the verified, model-independent path. Origin is the
  // engine's: inserted Component surfaces live in document FLOW (applyMaterial
  // INSERT_NODEs them into the tree — no explicit position), so the engine owns
  // their top-left. We send a layout_patch ONLY when (a) this drag's HANDLE moves
  // the top-left — handleMovesOrigin: a west/north grip — AND (b) the node's
  // parent positions children absolutely, so the origin is author-owned
  // (nodeAuthorsOrigin). Both are read STRUCTURALLY (from the handle + the tree),
  // never by diffing async snapshot coordinates — rounding + reply latency could
  // drop a real move or send a stray one (convergence 2026-06-20 Q1). Flow nodes
  // (every current mounted surface) get pure width/height; the future absolute
  // canvas gets correct origin patches with zero special-casing. The engine stays
  // the only layout truth — it reframes, the snapshot flows back via setSnapshot.
  const pendingFrame = React.useRef<{ nodeId: string; rect: SceneResizeRect; handle: SceneResizeHandleId; scheduled: boolean }>({
    nodeId: '',
    rect: { x: 0, y: 0, w: 0, h: 0 },
    handle: 'se',
    scheduled: false,
  });

  function commitFrame(nodeId: string, rect: SceneResizeRect, handle: SceneResizeHandleId) {
    const pending = pendingFrame.current;
    if (pending.scheduled && pending.nodeId !== nodeId) flushFramePatch();
    pending.nodeId = nodeId;
    pending.rect = rect;
    pending.handle = handle;
    if (pending.scheduled) return;
    pending.scheduled = true;
    requestAnimationFrame(flushFramePatch);
  }

  function flushFramePatch() {
    const pending = pendingFrame.current;
    if (!pending.scheduled) return;
    pending.scheduled = false;
    const { nodeId, rect, handle } = pending;
    // The resize→transaction decision is a pure, tested function (do-work):
    // ALWAYS width/height; a layout_patch only for a west/north handle on an
    // absolute-parented (author-owned-origin) node — structural, no async diff.
    const requestedRect = { ...rect };
    void runPersistingTransaction(() => {
      const tree = snapshotRef.current.tree;
      const node = tree ? findNodeById(tree, nodeId) : null;
      if (!node) return null;
      return buildResizeTransaction({ nodeId, rect: requestedRect, handle, tree, existingProps: node.props ?? {} });
    }).catch(recoverFromWriteError);
  }

  // AUTO-HEIGHT for text blocks. The engine cannot measure wrapped text (it is WASM
  // — no DOM/fonts), so a text block whose content wraps to more lines than the
  // engine assumes OVERFLOWS onto the absolutely-positioned block below it (the
  // "text covers the next block when the width shrinks" defect). The host is the only
  // thing that knows the real wrapped height, so each text block reports its measured
  // content height here and we feed it to the engine as a FIRST-CLASS ephemeral layout
  // input via `text_measurements` (KernelState.text_measurements) — NOT a persisted
  // `style.height` prop. The engine consumes it in the same layout pass as the
  // viewport width and repositions the siblings below, and KEEPS it in its side-map
  // across renders, so a concurrent viewport reflow can never discard it and leave
  // blocks overlapping (the old style.height + renderSequence race). Sent via the raw
  // sendTransaction (NOT trackedSend): never flips the save indicator, never persisted
  // — on reload the block re-measures and re-reports. No loop: the contentEditable's
  // scrollHeight depends on width+content, never on the frame height we set. The
  // last-applied height is cached AFTER the reply paints so a stable block never
  // re-sends AND a superseded reply is re-sent. rAF-coalesced so a burst of resizes
  // collapses to one transaction.
  const measuredTextHeights = React.useRef<Map<string, number>>(new Map());
  const pendingHeights = React.useRef<Map<string, number>>(new Map());
  const heightFlushScheduled = React.useRef(false);

  // STREAMING REVEAL: node ids whose text should type in progressively on mount rather
  // than appear all at once (AI output — "characters coming out"). The engine holds the
  // full persisted text; the reveal is a DOM-local typewriter in AutoSizeTextNode, so it
  // costs zero engine round-trips and the auto-height reflows as it grows. This is the
  // generic incremental-reveal primitive: today it reveals a completed result; when the
  // execution substrate streams partial output, the SAME primitive renders live chunks.
  const [revealTextNodeIds, setRevealTextNodeIds] = React.useState<ReadonlySet<string>>(() => new Set());

  function reportTextHeight(nodeId: string, height: number) {
    if (!(height > 0)) return;
    const last = measuredTextHeights.current.get(nodeId);
    if (last != null && Math.abs(last - height) < 2) return;
    // An ordinary keystroke may change a paragraph's height; keep its editor
    // visible. Only an opening or width-changing layout hides the whole plane.
    if (!visualLayoutSettledRef.current) markVisualLayoutDirty();
    pendingHeights.current.set(nodeId, height);
    if (heightFlushScheduled.current) return;
    heightFlushScheduled.current = true;
    requestAnimationFrame(flushTextHeights);
  }

  // INVARIANT (resize-flicker fix, L063): a NON-STRUCTURAL transaction — a viewport reflow
  // or a text-measurement, which carry ZERO scene_patches and therefore REMOVE nothing —
  // cannot legitimately empty the document. Under rapid resize the engine can answer such a
  // transaction with a partial/empty tree for a single frame; painting it flashes the "No
  // pages / create a page" empty state (the ~16ms flicker). So a reply that would drop a
  // currently-non-empty tree to empty/null is treated as a transient and DISCARDED (keep the
  // last good snapshot). Structural edits go through commitPatches and never use this guard,
  // so a real "delete the last page" still empties correctly.
  function nonStructuralSnapshot(next: CompositionSnapshot): CompositionSnapshot {
    const hadChildren = (snapshotRef.current.tree?.children?.length ?? 0) > 0;
    const nextHasChildren = (next.tree?.children?.length ?? 0) > 0;
    return hadChildren && !nextHasChildren ? snapshotRef.current : next;
  }

  function flushTextHeights() {
    heightFlushScheduled.current = false;
    const tree = snapshotRef.current.tree;
    const pending = pendingHeights.current;
    pendingHeights.current = new Map();
    if (!tree) return;
    const measurements: { node_id: string; height: number }[] = [];
    const applied: [string, number][] = [];
    for (const [nodeId, height] of pending) {
      const node = findNodeById(tree, nodeId);
      if (!node || node.kind !== 'Text') continue;
      const frameH = snapshotRef.current.frames[nodeId]?.rect?.h;
      if (frameH != null && Math.abs(frameH - height) < 1) {
        // The engine already lays this block out at the measured height — record it
        // so a stable block never re-sends.
        measuredTextHeights.current.set(nodeId, height);
        continue;
      }
      measurements.push({ node_id: nodeId, height });
      applied.push([nodeId, height]);
    }
    if (measurements.length === 0) {
      revealSettledVisualLayout();
      return;
    }
    const sequence = ++renderSequence.current;
    // Ephemeral layout INPUT, not a persisted `style.height` prop. The engine keeps
    // these heights in its own side-map across renders (KernelState.text_measurements),
    // so even if a concurrent viewport reflow supersedes THIS reply, the next render
    // still reflects the height — the persistent-overlap race is structurally gone.
    void sendTransaction({ text_measurements: measurements })
      .then(decodeCompositionSnapshotReply)
      .then((nextSnapshot) => {
        if (sequence === renderSequence.current) {
          const guarded = nonStructuralSnapshot(nextSnapshot);
          snapshotRef.current = guarded;
          setSnapshot(guarded);
          // Cache a height as "applied" ONLY if the RETURNED frame actually grew to it —
          // "transaction accepted" is NOT "frame height changed". A block can carry a stale
          // stored `style.height` that (before the engine `for_node` fix) pinned rect.h small
          // even though the engine stored our measurement; caching then would lie and the
          // dedup in reportTextHeight (|last-height|<2) would suppress every future resend,
          // freezing the overlap. So verify against nextSnapshot.frames and re-queue any
          // block whose frame did NOT reach the measured height (Codex-converged 2026-07-05).
          for (const [nodeId, height] of applied) {
            const frameH = nextSnapshot.frames[nodeId]?.rect?.h;
            if (frameH != null && Math.abs(frameH - height) < 1) {
              measuredTextHeights.current.set(nodeId, height);
            } else if (!pendingHeights.current.has(nodeId)) {
              pendingHeights.current.set(nodeId, height);
            }
          }
          if (pendingHeights.current.size > 0 && !heightFlushScheduled.current) {
            heightFlushScheduled.current = true;
            requestAnimationFrame(flushTextHeights);
          } else {
            revealSettledVisualLayout();
          }
        } else {
          // SUPERSEDED — a concurrent transaction bumped the shared renderSequence, so we
          // won't paint THIS reply. The engine ALREADY merged these heights into its
          // side-map (they're additive/idempotent), but the DISPLAYED snapshot is now stale
          // and would keep showing the pre-measure OVERLAP until some unrelated transaction
          // happens to repaint — and a stable block never re-measures on its own, so the
          // overlap sticks. Re-queue the measured heights so the measurement-input protocol
          // re-sends them against the latest sequence and the reflow reliably reaches the
          // screen. This is the real fix for the persistent multi-line-block overlap: host
          // measurement is the ONLY source of wrapped height (the engine has no DOM), so a
          // measured height must never be silently dropped (Codex-converged 2026-07-04).
          for (const [nodeId, height] of applied) {
            if (!pendingHeights.current.has(nodeId)) pendingHeights.current.set(nodeId, height);
          }
          if (!heightFlushScheduled.current) {
            heightFlushScheduled.current = true;
            requestAnimationFrame(flushTextHeights);
          }
        }
      })
      .catch(() => {
        if (!visualLayoutSettledRef.current) {
          setLoadErrorText('The page layout could not finish. Try again.');
          setLoadState('error');
        }
      });
  }

  // Floated-node reposition: rAF-coalesced like commitFrame (latest position
  // wins). The pure buildRepositionTransaction writes only layout.x/y.
  const pendingMove = React.useRef<{ nodeId: string; x: number; y: number; scheduled: boolean }>({
    nodeId: '', x: 0, y: 0, scheduled: false,
  });

  function commitMove(nodeId: string, x: number, y: number) {
    const pending = pendingMove.current;
    if (pending.scheduled && pending.nodeId !== nodeId) flushMovePatch();
    pending.nodeId = nodeId;
    pending.x = x;
    pending.y = y;
    if (pending.scheduled) return;
    pending.scheduled = true;
    requestAnimationFrame(flushMovePatch);
  }

  function flushMovePatch() {
    const pending = pendingMove.current;
    if (!pending.scheduled) return;
    pending.scheduled = false;
    const { nodeId, x, y } = pending;
    void runPersistingTransaction(() => {
      const tree = snapshotRef.current.tree;
      const node = tree ? findNodeById(tree, nodeId) : null;
      return node ? buildRepositionTransaction(node, x, y) : null;
    }).catch(recoverFromWriteError);
  }

  // Split-column divider drag. Like resize, we snapshot the START state at
  // pointerdown — the parts, the gap-aware available main size, and the node's
  // existing props — then apply the CUMULATIVE pixel delta to the START parts
  // each move (drift-free; an async snapshot landing mid-drag can't double-count).
  // applySplitDividerDrag keeps Σfraction constant, so only the two flanked
  // columns move; the engine reframes from the new parts and the snapshot flows
  // back. rAF-coalesced (Pattern 58 — latest delta wins) like commitFrame.
  // `tableNode` is set when the dragged split is a ROW of a table (its parent is a
  // table node): the divider then resizes that column in EVERY row at once
  // (buildTableColumnDragTransaction), not just this row — the behaviour that makes
  // a stack of splits read as a table. Captured at START (drift-free cumulative delta).
  const splitDragStart = React.useRef<{ nodeId: string; parts: SplitPart[]; available: number; existingProps: Record<string, unknown> | undefined; tableNode: SceneNode | null } | null>(null);
  const pendingSplit = React.useRef<{ nodeId: string; leftIndex: number; rightIndex: number; deltaPx: number; scheduled: boolean }>({
    nodeId: '', leftIndex: 0, rightIndex: 1, deltaPx: 0, scheduled: false,
  });

  function beginSplitDrag(nodeId: string) {
    const tree = snapshotRef.current.tree;
    const node = tree ? findNodeById(tree, nodeId) : null;
    const rect = snapshotRef.current.frames[nodeId]?.rect;
    if (!node || !rect) { splitDragStart.current = null; return; }
    const axis = readSplitAxis(node);
    const visibleColumns = (node.children ?? []).filter((child) => child.visible !== false).length;
    // Is this split a table ROW? (its parent is a table → sync the column across
    // all rows.) The table y-split itself has no table parent, so a divider drag on
    // it stays a single-node row-height resize — exactly right.
    const parentLoc = tree ? parentLocation(tree, nodeId) : null;
    const parentNode = parentLoc && tree ? findNodeById(tree, parentLoc.parentId) : null;
    const tableNode = parentNode && isTableNode(parentNode) ? parentNode : null;
    splitDragStart.current = {
      nodeId,
      parts: readSplitParts(node),
      available: splitAvailableMainPx(rect, axis, readSplitGap(node), visibleColumns),
      existingProps: propsForNode(tree, nodeId),
      tableNode,
    };
  }

  function commitSplitDrag(nodeId: string, leftIndex: number, rightIndex: number, deltaPx: number) {
    const pending = pendingSplit.current;
    pending.nodeId = nodeId;
    pending.leftIndex = leftIndex;
    pending.rightIndex = rightIndex;
    pending.deltaPx = deltaPx;
    if (pending.scheduled) return;
    pending.scheduled = true;
    requestAnimationFrame(flushSplitPatch);
  }

  function flushSplitPatch() {
    const pending = pendingSplit.current;
    if (!pending.scheduled) return;
    pending.scheduled = false;
    const start = splitDragStart.current;
    if (!start || start.nodeId !== pending.nodeId) return;
    // A table-row divider syncs the column across EVERY row (one transaction, many
    // patches); a plain split moves only this node. Both reuse the SAME converged
    // applySplitDividerDrag math — the table path just fans the result over rows.
    const transaction = start.tableNode
      ? buildTableColumnDragTransaction({
          table: start.tableNode,
          leftIndex: pending.leftIndex,
          rightIndex: pending.rightIndex,
          deltaPx: pending.deltaPx,
          availableMainPx: start.available,
        })
      : buildSplitDividerTransaction({
          nodeId: pending.nodeId,
          parts: applySplitDividerDrag({
            parts: start.parts,
            leftIndex: pending.leftIndex,
            rightIndex: pending.rightIndex,
            deltaPx: pending.deltaPx,
            availableMainPx: start.available,
          }),
          existingProps: start.existingProps,
        });
    void runPersistingTransaction(transaction).catch(recoverFromWriteError);
  }

  // B2: 4-sided insertion — pure scene patches; the engine owns all layout.
  // above/below = sibling INSERT_NODE. left/right = wrap the node and the new
  // node in a container whose layout axis is X (a "columns" feeling is just a
  // node arranging its children on X — no column concept exists).
  function insertBeside(
    nodeId: string,
    side: 'above' | 'below' | 'left' | 'right',
    // Props the fresh block should START with. The inserter never reads them; a caller that wants
    // the new block to continue something hands over the props and this stays blind (L090).
    startWith?: Record<string, unknown>,
  ) {
    const tree = snapshotRef.current.tree;
    if (!tree) return;
    const parent = parentLocation(tree, nodeId);
    if (!parent) return;
    const fresh = blankTextNode();
    if (startWith) fresh.props = { ...(fresh.props ?? {}), ...startWith };
    if (side === 'above' || side === 'below') {
      const index = side === 'above' ? parent.index : parent.index + 1;
      // L128-RACE-GUARD: Defer focus until AFTER keystroke event has fully settled from the event loop.
      // Keystroke handlers call insertBeside unawaited (line 5493). If focus moves synchronously,
      // the new block mounts and its keystroke handler can capture the lingering Return keystroke
      // event, creating duplicate blocks or spurious menus. Deferring focus to after the event
      // loop (via setTimeout 0 or requestIdleCallback) ensures the new block mounts AFTER the
      // keystroke event is fully processed and cleaned up.
      commitPatches([{ type: 'INSERT_NODE', parent_id: parent.parentId, index, node: fresh }]);
      const freshId = fresh.id;
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => setFocusedNodeId(freshId), { timeout: 16 });
      } else {
        setTimeout(() => setFocusedNodeId(freshId), 0);
      }
      return;
    }
    const existing = findNodeById(tree, nodeId);
    if (!existing) return;
    // A side-by-side wrap is a SPLIT layout node — the SAME engine shape the "Columns"
    // material uses (mode:split + axis:x + parts). `axis:'x'` ALONE was the B-42 regression:
    // without `mode:'split'` + `parts` the engine has no horizontal layout to honor and falls
    // back to vertical stacking, so "Insert left/right" landed the block BELOW. Equal parts
    // [1,1] give two even columns; SplitDividers then read these parts to place the drag edge.
    const row: SceneNode = {
      id: `node:${crypto.randomUUID()}`,
      kind: 'Container',
      props: { style: { layout: { mode: 'split', axis: 'x', gap: 12, parts: [{ fraction: 1 }, { fraction: 1 }] } } },
      visible: true,
      children: side === 'left' ? [fresh, cloneNode(existing)] : [cloneNode(existing), fresh],
    };
    // L128-RACE-GUARD: Apply same deferred focus as above case (line/right insert).
    commitPatches([
      { type: 'REMOVE_SUBTREE', node_id: nodeId },
      { type: 'INSERT_NODE', parent_id: parent.parentId, index: parent.index, node: row },
    ]);
    const freshId = fresh.id;
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => setFocusedNodeId(freshId), { timeout: 16 });
    } else {
      setTimeout(() => setFocusedNodeId(freshId), 0);
    }
  }

  // The gutter "+" (Notion): insert a blank block below this one AND open the
  // material picker on it — one click yields a new block ready to become anything.
  // Same INSERT_NODE primitive as every other insert; the picker is the slash menu.
  function addBlockBelow(nodeId: string) {
    const tree = snapshotRef.current.tree;
    if (!tree) return;
    const parent = parentLocation(tree, nodeId);
    if (!parent) return;
    const fresh = blankTextNode();
    setFocusedNodeId(fresh.id);
    setMenuIndex(0);
    setActiveMenu({ nodeId: fresh.id, query: '' });
    commitPatches([{ type: 'INSERT_NODE', parent_id: parent.parentId, index: parent.index + 1, node: fresh }]);
  }

  function removeBlock(nodeId: string) {
    // If the removed node IS the framed page (a top-level root child), reframe to
    // a sibling so the surface never points at a deleted page — auto-select the
    // adjacent page like reference editors (clear when none remain; the zero-page
    // empty state is already handled). Nested blocks never match framedNodeId, so
    // this stays a pure no-op for ordinary block delete (L116 page CRUD).
    if (framedNodeId === nodeId) {
      const sibling = (snapshotRef.current.tree?.children ?? []).find((page) => page.id !== nodeId) ?? null;
      setFramedNodeId(sibling?.id ?? null);
      setFocusedNodeId(sibling ? sibling.children?.[0]?.id ?? sibling.id : null);
    }
    commitPatches([{ type: 'REMOVE_SUBTREE', node_id: nodeId }]);
  }

  // MERGE-BACKWARD (N2): the cursor-command whose resolver is the SAME resolveInDirection up-ray as
  // arrow nav (N1) — it does NOT walk sibling indices. It finds the geometrically-previous text block
  // (the one directly above by rendered rects), appends this block's text to the END of it, deletes
  // this block, and drops the caret at the join. Empty block → plain delete + caret to the previous
  // block's end. No block above (first block) → no-op (returns false, Backspace does its default).
  function mergeBlockBackward(nodeId: string): boolean {
    const tree = snapshotRef.current.tree;
    if (!tree) return false;
    const node = findNodeById(tree, nodeId);
    if (!node || node.kind !== 'Text') return false;
    const fromEl = scopedNodeQuery(`.ca-text-node[data-node-id="${nodeId}"]`);
    if (!fromEl) return false;
    const toRect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const candidates = scopedNodeQueryAll('.ca-text-node[data-node-id]')
      .filter((el) => el.getAttribute('data-node-id') !== nodeId)
      .map((el) => ({ id: el.getAttribute('data-node-id') as string, rect: toRect(el) }));
    const targetId = resolveInDirection(toRect(fromEl), { dx: 0, dy: -1 }, candidates);
    if (!targetId) return false;
    const targetNode = findNodeById(tree, targetId);
    if (!targetNode || targetNode.kind !== 'Text') return false;
    const targetText = typeof targetNode.props?.text === 'string' ? targetNode.props.text : '';
    const currentText = typeof node.props?.text === 'string' ? node.props.text : '';
    const joinOffset = targetText.length;
    const mergedText = targetText + currentText;
    setFocusedNodeId(targetId);
    commitPatches([
      { type: 'UPDATE_PROPS', node_id: targetId, changes: { props: { ...targetNode.props, text: mergedText } } },
      { type: 'REMOVE_SUBTREE', node_id: nodeId },
    ]);
    // Optimistic caret placement at the join BEFORE the engine round-trip (a focused contentEditable
    // can't be overwritten by the re-render, same reason space-shortcut syncs the DOM optimistically).
    const targetEl = scopedNodeQuery(`.ca-text-node[data-node-id="${targetId}"]`);
    if (targetEl) {
      targetEl.focus();
      if ((targetEl.textContent ?? '') !== mergedText) targetEl.textContent = mergedText;
      placeCaretAtOffset(targetEl, joinOffset);
    }
    return true;
  }

  // ESCALATING SELECT-ALL (N3): Cmd/Ctrl+A widens the selection one rung up the CONTAINMENT tree per
  // press — content (browser text) → this block → its container → … → the page — using the pure
  // escalateScope walk (levels are the tree's real depth at the anchor, not a fixed 4-enum). Returns
  // true when it took a scope level (caller preventDefaults); false at level 0 so the BROWSER selects
  // the block's text (the natural first Cmd+A). Reset happens when the user re-focuses a block.
  function escalateSelectAll(): boolean {
    if (!framedPage) return false;
    const pageId = framedPage.id;
    let scope = selectionScopeRef.current;
    // Re-focusing/typing in a different block re-anchors the ladder to that block's content.
    if (focusedNodeId && (!scope || scope.anchorId !== focusedNodeId)) {
      scope = { anchorId: focusedNodeId, level: 0 };
      selectionScopeRef.current = scope;
    }
    if (!scope) {
      // Nothing focused and no prior scope → select the whole page at once.
      setSelectedNodeIds(new Set(subtreeIds(framedPage, pageId)));
      selectionScopeRef.current = { anchorId: pageId, level: 1 };
      return true;
    }
    // Level 0 over a non-empty block with text NOT yet fully selected → let the browser select it.
    if (scope.level === 0) {
      const el = scopedNodeQuery(`.ca-text-node[data-node-id="${scope.anchorId}"]`);
      if (el && (el.textContent ?? '').length > 0 && !isAllTextSelected(el)) {
        if (!textSelectAllRequestedRef.current) {
          textSelectAllRequestedRef.current = true;
          return false;
        }
      }
    }
    const next = escalateScope(framedPage, scope.anchorId, pageId, scope.level);
    scope.level = next.level;
    if (next.targetId) {
      setSelectedNodeIds(new Set(subtreeIds(framedPage, next.targetId)));
      setFocusedNodeId(null); // leave text editing so the block/container/page highlight shows
      textSelectAllRequestedRef.current = false;
      window.getSelection()?.removeAllRanges();
      // Move focus OFF the editable and ONTO THE STAGE — never blur to nothing. A bare blur()
      // drops the web content's key first-responder in the native WKWebView: the NEXT physical
      // keydown never reaches the page at all (live-proven: after blur, a window keylog captured
      // ZERO events for real Cmd+A AND plain character keys) — which killed "Cmd+A again" at
      // press 2. Focusing the stage keeps keys flowing (so the ladder escalates block→container→
      // page) while still leaving text editing, so a following Delete/Backspace hits the
      // block-selection handler (deletes the block) instead of the in-block text handler (N2).
      (document.activeElement as HTMLElement | null)?.blur();
      viewportRef.current?.focus();
    }
    return true;
  }

  // MARQUEE DRAG-SELECT (N4): a drag across empty background draws a box that selects the top-level
  // blocks it overlaps — resolved by candidatesInRect over the blocks' live SCREEN rects (the SAME
  // Rect primitive as arrow nav; marquee and nav share one spatial engine, L063). The selected SET
  // (selectedIds) is exactly the shape the group package's batch-actions/arrangeBy consume, so a
  // batch op over it (delete here; arrange/move next) never re-owns selection.
  function beginMarquee(event: React.PointerEvent) {
    const startX = event.clientX;
    const startY = event.clientY;
    const tree = snapshotRef.current.tree;
    const page = framedNodeId ? findNodeById(tree ?? null, framedNodeId) : (tree?.children?.[0] ?? null);
    const blockIds = (page?.children ?? []).map((child) => child.id);
    let moved = false;
    selectionScopeRef.current = null;
    const blockCandidates = () =>
      blockIds
        .map((id) => {
          const el = scopedNodeQuery(`[data-node-id="${id}"]`);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { id, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
        })
        .filter((c): c is { id: string; rect: { x: number; y: number; w: number; h: number } } => c != null);
    const onMove = (e: PointerEvent) => {
      if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return; // ignore micro-drift (a click)
      moved = true;
      setMarqueeBox({ x0: startX, y0: startY, x1: e.clientX, y1: e.clientY });
      const box = marqueeRect(startX, startY, e.clientX, e.clientY);
      setSelectedNodeIds(new Set(candidatesInRect(box, blockCandidates())));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      setMarqueeBox(null);
      if (!moved) setSelectedNodeIds(new Set()); // a bare click on background clears selection
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
  }

  // The SUBTREE ROOTS of the selection (ids not contained by another selected id) — so a set-fanned
  // patch never double-touches a node already covered by a selected ancestor (REMOVE_SUBTREE would
  // double-free; a style patch would apply twice). Pure containment over the live tree.
  function selectionSubtreeRoots(ids: readonly string[]): string[] {
    const tree = snapshotRef.current.tree;
    return ids.filter((id) => !ids.some((other) => {
      if (other === id || !tree) return false;
      const otherNode = findNodeById(tree, other);
      return !!otherNode && otherNode.id !== id && findNodeById(otherNode, id) != null;
    }));
  }

  // THE generic multi-op runner (N4) — every op is a DATA row (selectionOps registry, L030/L101: no
  // hardcoded op). It dispatches by effect SHAPE, never by a named op (L090):
  //   • scene-patch → fan the patch over the selected set (roots or each) through the SAME commitPatches
  //     rail as any edit — delete (REMOVE_SUBTREE), a style change (UPDATE_PROPS), or a patch invented
  //     tomorrow, all as ONE DATA row.
  //   • clear      → clear the selection (a control op, no engine mutation).
  //   • dispatch   → forward the opaque owner-local selection context plus selectedIds and DATA payload
  //     to a DATA-named target via the SAME
  //     runActionAffordance rail as an input-shortcut dispatch — the no-god-package reuse seam (e.g. the
  //     group package's batch primitive): the surface names no internals, it just forwards the set.
  function runSelectionOp(op: SelectionOp): boolean {
    const ids = [...selectedNodeIds];
    if (ids.length === 0) return false;
    const effect = op.effect;
    if ('clear' in effect) {
      setSelectedNodeIds(new Set());
      selectionScopeRef.current = null;
      return true;
    }
    if ('dispatch' in effect) {
      // Nothing to dispatch without a partition — report false so the caller does NOT swallow the key
      // (returning true here would preventDefault a keystroke that did nothing).
      if (!partitionLabel) return false;
      void runActionAffordance({
        target: effect.dispatch.target,
        // `selection` is the owner-local bridge: a target receives the addressed
        // scene and its live selected node IDs, never a caller-forged projection
        // ref. Targets that do not use selection remain fully generic.
        payload: {
          ...(effect.dispatch.payload ?? {}),
          selection: { scene_address: sceneAddress, node_ids: ids },
          selectedIds: ids,
        },
        statusAddresses: null,
        partitionLabel,
      }).catch((error) => {
        const raw = error instanceof Error ? error.message : String(error);
        console.error('[documents] action dispatch failed:', raw);
        showError('That action could not run.');
      });
      return true;
    }
    const roots = selectionSubtreeRoots(ids);
    const patches = selectionOpPatches(op, roots, ids) as unknown as ScenePatch[];
    if (patches.length === 0) return false;
    setSelectedNodeIds(new Set());
    selectionScopeRef.current = null;
    commitPatches(patches);
    return true;
  }

  // When blocks are multi-selected (marquee or escalated Cmd+A) and NO text input is focused, a key that
  // matches a selection-op DATA row runs it (Delete/Backspace→delete, Escape→clear, and any op a package
  // ships). A document listener (not the stage's) so it fires regardless of where focus landed after the
  // drag. The editable-focus guard keeps in-block editing (typing/merge) untouched.
  React.useEffect(() => {
    if (selectedNodeIds.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (keyboardEventClaimed(e)) return; // another surface already claimed this key
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      const op = matchSelectionOp(e.key, selectionOpsRef.current);
      if (!op) return;
      // Claim the key (shared keyboard-claim ownership contract): a Delete consumed here
      // must never ALSO reach another pane's global listener — with a board pane open
      // alongside, a bubbling claimed Delete would delete that board's cards too (same
      // class as the leaked-Cmd+A live incident).
      claimKeyboardEvent(e);
      runSelectionOp(op);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeIds]);

  // Apply a format descriptor to a node = merge the descriptor's computed style patch
  // into the node's style via the SAME UPDATE_PROPS path as any edit (so it persists
  // through the render/persist ordering like everything else). The engine renders the
  // resulting style (sceneStyleToCss). The transform is pure DATA (applyFormatToStyle);
  // this function never names a format — it applies whatever descriptor it's handed.
  function commitFormat(nodeId: string, descriptor: FormatDescriptor) {
    runPersistingTransaction(() => {
      const tree = snapshotRef.current.tree;
      const node = tree ? findNodeById(tree, nodeId) : null;
      if (!node) return null;
      const currentProps = node.props ?? {};
      const currentStyle = isRecord(currentProps.style) ? currentProps.style : {};
      return { scene_patches: [{
        type: 'UPDATE_PROPS',
        node_id: nodeId,
        changes: { props: { ...currentProps, style: applyFormatToStyle(currentStyle, descriptor) } },
      }] };
    }).catch(recoverFromWriteError);
  }

  // "Spacing …": open the box-spacing popover for a node. The editor reads the
  // node's CURRENT padding/gap and writes back engine-honored style numbers via
  // the SAME UPDATE_PROPS path as a format (so it persists identically). Only one
  // contextual surface shows at a time, so opening spacing closes the others.
  function openSpacingEditor(nodeId: string) {
    setActiveMenu(null);
    setConditionNodeId(null);
    setSpacingNodeId(nodeId);
  }

  // Write ONE numeric style field (by its machine-readable style path) onto the
  // spacing-target node. Generic: never names padding/gap — it folds whatever path
  // it is handed into the node's style via writeStyleNumber. Engine renders it.
  function commitSpacingField(path: string[], value: number) {
    writeSpacingStyle((style) => writeStyleNumber(style, path, value));
  }

  // Write EVERY field of a group to the same value in ONE patch (the link-sides
  // affordance — all 4 padding sides at once). Folds writeStyleNumber over each
  // group field's path so it stays a single atomic style write (one persist).
  function commitSpacingGroup(group: string, value: number) {
    const nodeId = spacingNodeId;
    const tree = snapshotRef.current.tree;
    const node = nodeId && tree ? findNodeById(tree, nodeId) : null;
    if (!node) return;
    const groupPaths = spacingFieldsForNode(node, spacingFields)
      .filter((field) => field.group === group)
      .map((field) => field.path);
    writeSpacingStyle((style) => groupPaths.reduce((acc, path) => writeStyleNumber(acc, path, value), style));
  }

  // Shared write path for spacing edits: read the target node's current style,
  // apply the transform, commit ONE UPDATE_PROPS (mirrors commitFormat exactly).
  function writeSpacingStyle(transform: (style: Record<string, unknown>) => Record<string, unknown>) {
    const nodeId = spacingNodeId;
    const tree = snapshotRef.current.tree;
    const node = nodeId && tree ? findNodeById(tree, nodeId) : null;
    if (!nodeId || !node) return;
    const currentProps = node.props ?? {};
    const currentStyle = isRecord(currentProps.style) ? currentProps.style : {};
    commitPatches([{
      type: 'UPDATE_PROPS',
      node_id: nodeId,
      changes: { props: { ...currentProps, style: transform(currentStyle) } },
    }]);
  }

  // "Show when …": open the condition editor for a node, pre-filled from its
  // current visibility binding (if any). Apply writes the node's `visible` as a
  // data-source binding the kernel resolves live (self-driving — no state-setter);
  // "Always show" clears it. Composes with split for free (a bound-hidden column
  // collapses via resolveVisibility, the engine's as_bool rule).
  function openConditionEditor(nodeId: string) {
    const tree = snapshotRef.current.tree;
    const existing = readNodeVisibilityCondition(tree ? findNodeById(tree, nodeId) : null);
    setConditionDraft(existing
      ? { path: existing.path, op: existing.op ?? 'op:core.equals', value: existing.value != null ? String(existing.value) : '' }
      : { path: '', op: 'op:core.equals', value: '' });
    setConditionNodeId(nodeId);
  }

  function applyCondition() {
    const nodeId = conditionNodeId;
    if (!nodeId) return;
    // A visibility BINDING is a top-level SceneNode field the UPDATE_PROPS delta cannot
    // carry, so the builder re-authors the FULL node — it needs the node + its parent slot.
    const tree = snapshotRef.current.tree;
    const node = tree ? findNodeById(tree, nodeId) : null;
    if (!node) { setConditionNodeId(null); return; }
    const parent = tree ? parentLocation(tree, nodeId) : null;
    const transaction = buildBindVisibilityTransaction({
      node,
      parent,
      condition: { from: 'dataSource', path: conditionDraft.path.trim(), op: conditionDraft.op, value: coerceConditionValue(conditionDraft.value), default: true },
    });
    setConditionNodeId(null);
    commitPatches(transaction.scene_patches ?? []);
  }

  function clearCondition() {
    const nodeId = conditionNodeId;
    if (!nodeId) return;
    const tree = snapshotRef.current.tree;
    const node = tree ? findNodeById(tree, nodeId) : null;
    setConditionNodeId(null);
    if (node) commitPatches(buildClearVisibilityTransaction(node).scene_patches ?? []);
  }

  // The authoring OUTPUT actions (Name this / Save as a file / Put on a board /
  // Attach to a task / anything added later) are DATA rows (`composition-projection-
  // action`), NOT a mode enum. `noteAction` holds only the chosen action id + the
  // node; the resolved row drives the modal + descriptor assembly generically.
  // The chosen action id + node; the resolved row's `ask.fields` are rendered by
  // the SHARED generic ActionForm (this surface owns no field widgets), and the
  // collected answers map into the projection descriptor via the row's DATA
  // bindings. Zero input-mode enum lives here.
  const [noteAction, setNoteAction] = React.useState<{ actionId: string; nodeId: string } | null>(null);

  // A slash ACTION awaiting its typed input (the record's ask.prompt). Reuses
  // the same one-field window pattern as noteAction; submit dispatches the run.
  const [affordanceAsk, setAffordanceAsk] = React.useState<{ row: AffordanceSlashRow; nodeId: string } | null>(null);
  const [affordanceAskText, setAffordanceAskText] = React.useState('');

  // A slash/toolbar ACTION awaiting a MULTI-FIELD form (the record's ask.fields).
  // The blind ActionForm renders it; submit binds the answers bag into the run.
  const [affordanceForm, setAffordanceForm] = React.useState<{
    row: AffordanceSlashRow;
    nodeId: string;
    sourceText: string;
    initialAnswers: Record<string, unknown>;
    ask: ActionAffordanceAsk;
  } | null>(null);
  // Completion rows remain owner data: an action reply supplies only result
  // refs; this surface re-resolves destination labels and state from the live
  // feed. Any destination-keyed action can use this one blind readback rail.
  const [actionResultRefs, setActionResultRefs] = React.useState<readonly string[]>([]);

  // L126 FIX (2026-07-23): allPublishedRows and titledPoolRows are now read ONCE
  // in mount-documents.tsx and passed here as props. This eliminates
  // per-keystroke re-reads of the full 34.7MB published-records aggregate that
  // were triggering multi-second typing stalls. The mount layer reads these once
  // and memoizes them; the surface consumes them as-is from props.
  // See mount-documents.tsx for the mount-layer data reading.
  const titledOptionSourceRecords = React.useMemo<OptionSourceRecord[]>(
    () => feedRowsToOptionSourceRecords(titledPoolRows),
    [titledPoolRows],
  );
  const lastUsedAffordanceAnswers = React.useMemo(
    () => readActionAffordanceConfigurations(readPublishedRecords(allPublishedRows)),
    [allPublishedRows],
  );

  // The authoring output actions, read as DATA from the same live feed. Adding an
  // output = one `composition-projection-action` row + one runner; the menu and
  // modal below render whatever rows are present — zero mode enum in this source.
  const projectionActions = React.useMemo<ProjectionActionRow[]>(
    () => foldProjectionActions(readPublishedRecords(allPublishedRows)),
    [allPublishedRows],
  );
  const activeAction = React.useMemo<ProjectionActionRow | null>(
    () => projectionActions.find((a) => a.id === noteAction?.actionId) ?? null,
    [projectionActions, noteAction],
  );

  // The live feed folded to the ONE shared options-source shape ({address, payload})
  // that resolveAskFieldOptions consumes — every field's option pool (a kind list,
  // a formats MAP unfolded from the file-output owner's rules record, the titled
  // task/entity feed) is the field's own `options_source` descriptor DATA. The
  // `__export-formats`/`'task'` sentinel branches this replaces were the surface
  // enumerating which pools exist (F7 / enum-dissolution) — a package shipping a
  // new pool needed a code edit here; now it ships a descriptor row.
  const optionSourceRecords = React.useMemo<OptionSourceRecord[]>(
    () => feedRowsToOptionSourceRecords(allPublishedRows),
    [allPublishedRows],
  );
  const actionResultReadback = React.useMemo<DestinationActionReadback[]>(
    () => resolveDestinationActionReadback(actionResultRefs, allPublishedRows),
    [actionResultRefs, allPublishedRows],
  );
  // Route each field to its matching candidate pool by the field's OWN descriptor
  // (`options_source.titled === true`), mirroring resolveAskFieldOptions's own internal
  // dispatch — never a surface-side kind/pool enumeration. A `{titled:true}` field (e.g.
  // "Attach to a task…") reads the scoped titled-pool feed; every other field keeps
  // reading the scoped content-pool feed, unchanged.
  const projectionFieldOptions = React.useCallback(
    (field: AskField): AskFieldOption[] =>
      resolveAskFieldOptions(
        field,
        field.options_source?.titled === true ? titledOptionSourceRecords : optionSourceRecords,
      ),
    [optionSourceRecords, titledOptionSourceRecords],
  );

  // Inject the resolved suggested note title as the default of the row's
  // `title_from` field (a dynamic default the static DATA can't carry), so
  // "Name this" / "Put on a board" open pre-filled — everything else unchanged.
  const projectionAskFields = React.useMemo<AskField[]>(() => {
    if (!activeAction || !noteAction) return [];
    const suggested = suggestedTitle(noteAction.nodeId);
    return activeAction.ask.fields.map((f) =>
      f.id === activeAction.title_from ? { ...f, default: suggested } : f,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAction, noteAction]);

  // Affordance form fields resolve through the SAME shared resolver — one options
  // grammar for slash actions AND projection actions (the previous near-duplicate
  // by-kind fold here was the third copy of this logic across the repo).
  const affordanceFieldOptions = projectionFieldOptions;

  // "New action" authoring: the shared editor emits a draft; this surface
  // publishes it live via write-batch. The saved record streams back through
  // published-records, so the new action appears in the "/" menu on its own.
  const [actionEditorOpen, setActionEditorOpen] = React.useState(false);
  const [actionEditorRunId, setActionEditorRunId] = React.useState('');
  // What an authored action can run + where it can show are OWNER-PUBLISHED
  // records folded from the live feed (F7's second half): a runnable definition
  // is an `affordance-definition-option` record the producing package ships with
  // ITS OWN result/error contract; a place is an `affordance-channel` record the
  // owning surface ships. The hardcoded producer block + the cross-named board
  // channel this replaces made every new producer/surface a code edit in every
  // editor host — now it's one record in the owner's DATA (L090/L093).
  const affordanceDefinitionOptions = React.useMemo<AffordanceDefinitionOption[]>(
    () => foldAffordanceDefinitionOptions(readPublishedRecords(allPublishedRows)),
    [allPublishedRows],
  );
  const affordanceChannelOptions = React.useMemo<AffordanceChannelOption[]>(
    () => foldAffordanceChannelOptions(readPublishedRecords(allPublishedRows)),
    [allPublishedRows],
  );

  function openActionEditor() {
    setActiveMenu(null);
    setActionEditorRunId(`ua-${crypto.randomUUID().slice(0, 8)}`);
    setActionEditorOpen(true);
  }

  async function saveAuthoredAction(draft: ActionAffordanceDraft) {
    if (!partitionLabel) return;
    try {
      await writeActionAffordanceLive(draft, partitionLabel);
      showSuccess(`"${draft.label}" is now in your actions.`);
    } catch (error) {
      showError(`Could not save the action: ${errorMessage(error)}`);
    }
  }

  // Save the current form configuration as a reusable PRESET: curry the base
  // action's raw record with the filled answers (deriveActionPresetRecord, via
  // buildActionPresetWriteItem) into a new, more-specialized action-affordance and
  // publish it through the SAME live user-actions write path. The published-records
  // feed re-reads and the preset appears in the slash menu — no cold boot.
  async function saveActionPreset(baseRecord: unknown, answers: Record<string, unknown>, name: string) {
    if (!partitionLabel) return;
    if (!baseRecord || typeof baseRecord !== 'object') {
      showError('This action cannot be saved as a preset.');
      return;
    }
    try {
      const item = buildActionPresetWriteItem(baseRecord as Record<string, unknown>, answers, {
        name,
        runId: `up-${crypto.randomUUID().slice(0, 8)}`,
      });
      await writeActionAffordanceItemLive(item, partitionLabel);
      showSuccess(`"${name}" is now in your actions.`);
    } catch (error) {
      showError(`Could not save the preset: ${errorMessage(error)}`);
    }
  }

  // Remove a user-authored action: soft-delete its record (is_active:false) at
  // its own log address, so it disappears from the toolbar/slash menu. The live
  // published-records feed re-reads and the row drops on the next projection.
  async function removeAffordance(row: AffordanceSlashRow) {
    if (!partitionLabel) return;
    try {
      await archiveActionAffordanceLive(row.affordance, partitionLabel);
      showSuccess(`Removed "${row.label}".`);
    } catch (error) {
      showError(`Could not remove "${row.label}": ${errorMessage(error)}`);
    }
  }

  // Removable iff we can resolve a writable identity-text address for the record
  // (user-authored OR a package-shipped record like Vision/Break down whose
  // source address is a real package:: address). Content-hash-only rows aren't.
  const isRemovableAffordance = (row: AffordanceSlashRow): boolean =>
    resolveActionAffordanceWriteAddress(row.affordance) !== null;

  // Choosing an action row from the "/" menu: clear the slash query from the
  // node, then take the fast path when DATA defaults/last-used answers are
  // valid. The explicit configure entry uses the exact same form with the
  // same initial answers; no action is named here.
  // The AI prompt for a run-on-content action = the target block's text (or the
  // page's combined text), NOT the "/"-command block (which only holds the slash
  // query). Empty ⇒ the producer would get an empty prompt (→ cloud API HTTP
  // 400), so content-transform actions operate on what the user wrote.
  function affordanceSourceText(slashNodeId: string): string {
    const tree = snapshotRef.current.tree;
    if (!tree) return '';
    const focusId = focusedNodeId && focusedNodeId !== slashNodeId ? focusedNodeId : '';
    const focusNode = focusId ? findNodeById(tree, focusId) : null;
    const focusText = focusNode ? textFromNode(focusNode).trim() : '';
    if (focusText) return focusText;
    const page = framedNodeId ? findNodeById(tree, framedNodeId) : tree;
    return collectPlainText(page, slashNodeId);
  }

  function startAffordance(row: AffordanceSlashRow, forceConfigure = false) {
    const nodeId = activeMenu?.nodeId ?? '';
    // Capture the source text BEFORE clearing the slash query below.
    const sourceText = affordanceSourceText(nodeId);
    setActiveMenu(null);
    if (nodeId) {
      commitPatches([{
        type: 'UPDATE_PROPS',
        node_id: nodeId,
        changes: { props: { ...propsForNode(snapshotRef.current.tree, nodeId), text: '' } },
      }]);
    }
    const ask = row.trigger.ask;
    const invokeContext: AffordanceInvokeContext = {
      run: {},
      surface: { channel: COMPOSITION_SLASH_CHANNEL, target_ref: nodeId, source_text: sourceText },
      selection: ownerSelectionContext(sceneAddress, selectedNodeIds, nodeId),
    };
    let initialAnswers = resolveActionAskInitialAnswers(
      ask,
      invokeContext,
      affordanceFieldOptions,
      lastUsedAffordanceAnswers[row.affordance.id],
    );
    let resolvedAsk = resolveActionAsk(ask, initialAnswers, affordanceFieldOptions);
    initialAnswers = resolveActionAskInitialAnswers(
      resolvedAsk,
      {
        ...invokeContext,
      },
      affordanceFieldOptions,
      lastUsedAffordanceAnswers[row.affordance.id],
    );
    resolvedAsk = resolveActionAsk(ask, initialAnswers, affordanceFieldOptions);
    // A multi-field form (ask.fields) opens the blind ActionForm only when the
    // current configuration is incomplete. Otherwise selecting the action sends
    // immediately, preserving the fast path for presets/defaults/last-used.
    if (resolvedAsk?.fields?.length) {
      if (!forceConfigure && actionAskHasRequiredAnswers(resolvedAsk, initialAnswers, affordanceFieldOptions)) {
        void runAffordanceRow(row, nodeId, sourceText, initialAnswers);
      } else {
        setAffordanceForm({ row, nodeId, sourceText, initialAnswers, ask: resolvedAsk });
      }
      return;
    }
    if (row.trigger.ask?.prompt) {
      setAffordanceAskText('');
      setAffordanceAsk({ row, nodeId });
      return;
    }
    void runAffordanceRow(row, nodeId, sourceText);
  }

  function chooseAffordance(row: AffordanceSlashRow) {
    startAffordance(row);
  }

  function configureAffordance(row: AffordanceSlashRow) {
    startAffordance(row, true);
  }

  // Dispatch → poll → place. Artifacts land as sibling Text nodes right after
  // the invoking node (the doc's own placement seam; the engine owns layout).
  // `answers` is the multi-field form's bag (bound via {from:'answers'}); typed
  // text is the one-line content — either or both may be present.
  async function runAffordanceRow(
    row: AffordanceSlashRow,
    nodeId: string,
    typedText: string,
    answers?: Record<string, unknown>,
  ) {
    if (!partitionLabel) return;
    const runId = `ca-${crypto.randomUUID()}`;
    const run = buildAffordanceRun(row, {
      run: { id: runId },
      actor: { ...LOCAL_DESKTOP_ACTOR },
      surface: { channel: COMPOSITION_SLASH_CHANNEL, target_ref: nodeId },
      selection: ownerSelectionContext(sceneAddress, selectedNodeIds, nodeId),
      ...(typedText ? { typed: { text: typedText } } : {}),
      ...(answers ? { answers } : {}),
    });
    if (answers && Object.keys(answers).length > 0 && partitionLabel) {
      void writeActionAffordanceConfigurationLive(row.affordance.id, answers, partitionLabel).catch((error) => {
        console.warn('[documents] could not persist last action configuration', error);
      });
    }
    showSuccess(`Running "${row.label}"…`);
    try {
      const outcome = await runActionAffordance({
        target: run.target,
        payload: run.payload,
        statusAddresses: run.statusAddresses,
        partitionLabel,
      });
      if (outcome.state === 'error') {
        showError(outcome.message || `"${row.label}" could not finish.`);
        return;
      }
      // The producer writes FAILURES into the RESULT payload (error_code + a
      // message) rather than the separate error address, so a run that "found a
      // result" can still be a failure with empty items. Surface the REAL error
      // instead of the cheerful "nothing to place" — a failed AI call must never
      // read as a benign empty success (L114/L116). The message is often a full
      // process traceback; show its last meaningful line.
      const failure = resultFailureMessage(outcome.resultPayload);
      if (failure) {
        showError(`"${row.label}" couldn't finish: ${failure}`);
        return;
      }
      if (outcome.state === 'timeout') {
        showError(`"${row.label}" is taking too long. It may still finish in the background.`);
        return;
      }
      const resultRefs = actionResultRefsFromPayload(outcome.resultPayload);
      if (resultRefs.length > 0) {
        setActionResultRefs(resultRefs);
        showSuccess(`"${row.label}" was accepted. Destination status is shown below.`);
        return;
      }
      const placed = insertResultArtifacts(
        outcome.resultPayload,
        row.affordance.output_contract?.artifacts_path ?? 'items',
        nodeId,
        runId,
      );
      if (placed === 0) {
        showSuccess(`"${row.label}" finished with nothing to place.`);
        return;
      }
      if (placed > 0) {
        showSuccess(`"${row.label}" added ${placed} ${placed === 1 ? 'block' : 'blocks'}.`);
      }
    } catch (error) {
      showError(`"${row.label}" failed: ${errorMessage(error)}`);
    }
  }

  // The ONE result-insertion rail (L063): a finished producer/workflow reply → real formatted
  // blocks placed on the current page. Shared by the slash-action rail (runAffordanceRow) AND
  // the command-composer dispatch rail (dispatchInputShortcut, e.g. space→AI), so BOTH entry
  // points place AI output identically. Returns the block count placed (0 = nothing, -1 = no tree).
  function insertResultArtifacts(
    resultPayload: unknown,
    artifactsPath: string,
    nodeId: string,
    runId: string,
  ): number {
    const tree = snapshotRef.current.tree;
    if (!tree) return -1;
    // Place produced blocks ON THE CURRENT PAGE — NEVER as new top-level pages.
    // A top-level node IS a page; inserting a sibling of the invoking node when that
    // node is a page (or defaulting to tree.id) wrongly spawns a page per artifact.
    // Resolve like insertBlockOnFramedPage: a real BLOCK invoked → insert after it in
    // its page; otherwise append into the framed page (falling back to the first page).
    const placeTargetId = nodeId || focusedNodeId || '';
    const targetLoc = placeTargetId ? parentLocation(tree, placeTargetId) : null;
    let parentId: string;
    let index: number;
    if (targetLoc && targetLoc.parentId !== tree.id) {
      parentId = targetLoc.parentId;
      index = targetLoc.index + 1;
    } else {
      let framedPage = framedNodeId ? findNodeById(tree, framedNodeId) : null;
      if (!framedPage || framedPage.id === tree.id) {
        framedPage = tree.children?.[0] ? findNodeById(tree, tree.children[0].id) : null;
      }
      parentId = framedPage ? framedPage.id : tree.id;
      index = framedPage ? (framedPage.children?.length ?? 0) : (tree.children?.length ?? 0);
    }
    const rawPatches = artifactsToInsertPatches(
      resultPayload,
      artifactsPath,
      parentId,
      index,
      () => `node:${crypto.randomUUID()}`,
    );
    // Recognize markdown the model produced (`# H1`, `- bullet`, `---` divider…) using the
    // SAME autoformat rules as live typing, so AI output lands as real formatted blocks.
    let patches = expandAutoformatInsertPatches(rawPatches);
    if (patches.length === 0) return 0;
    // REUSE THE INVOKING NODE'S IDENTITY for the first produced block when it is an empty
    // Text block (the composer's "write here" placeholder, or an empty slash-invoked block):
    // the first INSERT_NODE becomes an UPDATE_PROPS on nodeId itself instead of a fresh
    // sibling, so no stray empty block is left sitting next to the new content — the block
    // that was just showing the growing text (live override, cleared the instant this runs)
    // keeps showing it, now persisted. A non-empty invoking node (a slash affordance run from
    // inside typed text) is left untouched; its own content is never overwritten.
    const invokingNode = findNodeById(tree, nodeId);
    const invokingText = invokingNode ? textFromNode(invokingNode) : '';
    const invokingIsEmptyText = !!invokingNode
      && invokingNode.kind === 'Text'
      && !hasRefToken(invokingText)
      && invokingText.trim() === '';
    const [firstPatch, ...restPatches] = patches;
    if (invokingIsEmptyText && firstPatch.type === 'INSERT_NODE' && firstPatch.node.kind === 'Text') {
      patches = [
        { type: 'UPDATE_PROPS', node_id: nodeId, changes: { props: { text: firstPatch.node.props?.text ?? '' } } },
        ...restPatches,
      ];
    }
    console.log(`[documents] placed ${patches.length} artifacts for ${runId}`);
    commitPatches(patches);
    // Reveal freshly-placed AI text blocks progressively ("characters coming out").
    const revealIds = new Set<string>();
    for (const patch of patches) {
      if (patch.type !== 'INSERT_NODE') continue;
      const inserted = (patch as { node?: SceneNode }).node;
      if (inserted?.kind === 'Text' && typeof inserted.props?.text === 'string' && inserted.props.text.length > 0) {
        revealIds.add(inserted.id);
      }
    }
    if (revealIds.size > 0) {
      setRevealTextNodeIds(revealIds);
      window.setTimeout(() => setRevealTextNodeIds((s) => (s.size ? new Set() : s)), 8000);
    }
    return patches.length;
  }

  function currentContent(): CompositionContent {
    return {
      children: (snapshotRef.current.tree?.children ?? []) as SceneNode[],
      edges: authoredEdges.current,
      camera: snapshotRef.current.camera,
    };
  }

  function suggestedTitle(nodeId: string): string {
    const tree = snapshotRef.current.tree;
    const node = tree ? findNodeById(tree, nodeId) : null;
    return node ? visibleTextLines(node)[0] ?? 'Untitled' : 'Untitled';
  }

  function openNoteAction(actionId: string, nodeId: string) {
    if (!projectionActions.some((a) => a.id === actionId)) return;
    setNoteAction({ actionId, nodeId });
  }

  // ONE generic dispatch for EVERY authoring output. ActionForm collected the
  // answers from the row's `ask.fields`; the row's DATA (`projection_kind` +
  // `descriptor_bindings` + `title_from`) maps them into the materialize call.
  // This function names ZERO projection — a new output is a new DATA row + runner.
  async function submitProjectionAnswers(answers: Record<string, unknown>) {
    const action = activeAction;
    if (!action || !noteAction || !partitionLabel) return;
    const { nodeId } = noteAction;
    setNoteAction(null);
    try {
      const { title, projection } = buildProjectionDispatch(action, answers, {
        suggestedTitle: suggestedTitle(nodeId),
      });
      const result = await materializeAuthoredCompositionIntent({
        partitionLabel,
        content: currentContent(),
        nodeId,
        title,
        projection: projection as ProjectionDescriptor,
        runners: projectionRunners,
      });
      showSuccess(fillSuccessTemplate(action.success_template, {
        value: title,
        title: (result.thing as { title?: string } | undefined)?.title ?? title,
        path: typeof (result as { path?: unknown }).path === 'string' ? (result as { path: string }).path : '',
      }));
    } catch (error) {
      showError(errorMessage(error));
    }
  }

  function completeConnection(targetId: string) {
    const sourceId = connectFromId;
    setConnectFromId(null);
    if (!sourceId || sourceId === targetId) return;
    // A new connection gets the default (first) MEANING; the label pill cycles it (#37).
    const defaultKind = connectionKindsRef.current[0];
    const edge: EdgeConnection = {
      edge_id: `edge:${crypto.randomUUID()}`,
      source_id: sourceId,
      target_id: targetId,
      source_anchor: 'right',
      target_anchor: 'left',
      ...(defaultKind ? { kind: defaultKind.id, label: defaultKind.label } : {}),
    };
    authoredEdges.current = [...authoredEdges.current, edge];
    void runPersistingTransaction({
      edge_mutations: [{ type: 'add', ...edge }],
    })
      .catch(recoverFromWriteError);
  }

  // Cycle a connection's MEANING to the next kind (data-driven) — the label pill's click.
  // One edge_mutations 'update'; the kernel re-routes, the EdgeLayer re-colours + re-labels.
  function cycleEdgeKind(edgeId: string) {
    const existing = authoredEdges.current.find((e) => e.edge_id === edgeId);
    if (!existing) return;
    const kind = nextConnectionKind(existing.kind, connectionKindsRef.current);
    const edge: EdgeConnection = { ...existing, kind: kind.id, label: kind.label };
    authoredEdges.current = authoredEdges.current.map((e) => (e.edge_id === edgeId ? edge : e));
    void runPersistingTransaction({ edge_mutations: [{ type: 'update', ...edge }] })
      .catch(recoverFromWriteError);
  }

  // B2 remainder: pointer-drag reparenting. The drop target is found by
  // hit-testing the ENGINE's frame rects from the snapshot (reading engine
  // truth, never computing layout — plan §4.5 boundary note). Drop commits
  // one MOVE_NODE patch; the engine recomputes everything.
  const [dragNodeId, setDragNodeId] = React.useState<string | null>(null);
  // B6: edge drawing. "Connect to…" arms connect-from; the next frame click
  // completes one edge_mutations add. The kernel routes it; we render
  // visible_edge_routes. Edge meaning = a data label on the edge.
  const [connectFromId, setConnectFromId] = React.useState<string | null>(null);
  // Authored edges are content data (the snapshot carries derived ROUTES,
  // not the authored connections) — tracked here for the one content record.
  const authoredEdges = React.useRef<EdgeConnection[]>([]);
  const [dropTarget, setDropTarget] = React.useState<DropPlacement | null>(null);
  // Floating drag ghost — a chip that follows the cursor while a block is being dragged, so
  // the user SEES the block picked up (The owner: "i cannot drag something and see it getting
  // picked up"). Pure pointer chrome (screen coords), never scene state.
  const [dragGhost, setDragGhost] = React.useState<{ x: number; y: number; label: string } | null>(null);
  // Minimap visibility (B-46) — pure chrome state, off by default (a clean canvas).
  // The HUD's Map button toggles it; it shows only in canvas mode.
  const [minimapOn, setMinimapOn] = React.useState(false);
  const stageRef = React.useRef<HTMLDivElement>(null);
  // The FIXED stage viewport (`.ca-stage`) — does NOT transform. stageRef lives on
  // the content plane INSIDE it (which the camera scales). Cursor-anchored zoom and
  // the wheel listener measure the pointer against THIS fixed origin (B-45).
  const viewportRef = React.useRef<HTMLDivElement | null>(null);

  // Re-layout to a new stage size: a viewport-only transaction (camera kept, no
  // patches) → the engine reflows the SAME tree into the new area and the reply
  // snapshot renders. Raw send (NOT runPersistingTransaction, and it bumps ONLY
  // renderSequence): a reflow is navigation, not a save, so it stays outside the
  // durable mutation queue. Stable identity (empty deps, reads refs)
  // so attachStage's ResizeObserver never thrashes.
  const reflowToViewport = React.useCallback((viewport: Viewport, attempt = 0) => {
    if (!snapshotRef.current.tree) return;
    const sequence = ++renderSequence.current;
    void sendTransactionRef.current({ viewport, camera: snapshotRef.current.camera ?? EMPTY_CAMERA })
      .then(decodeCompositionSnapshotReply)
      .then((nextSnapshot) => {
        if (sequence !== renderSequence.current) return;
        const guarded = nonStructuralSnapshot(nextSnapshot);
        snapshotRef.current = guarded;
        setSnapshot(guarded);
        revealSettledVisualLayout();
      })
      .catch(() => {
        // The reflow is the ONLY carrier of the new viewport — edit transactions send
        // none — so a dropped reflow leaves the kernel laying out at the OLD size until
        // the next navigation (Codex Q8). Retry (bounded, rAF-spaced) so the kernel
        // converges to the measured size on its own, but ONLY while this is still the
        // latest measurement (a newer resize supersedes it), and capped so a down
        // engine can't spin. A persistent outage is still repaired by the next nav/resize.
        if (attempt >= REFLOW_MAX_RETRIES) {
          setLoadErrorText('The page layout could not finish. Try again.');
          setLoadState('error');
          return;
        }
        requestAnimationFrame(() => {
          const current = stageViewportRef.current;
          if (current.w === viewport.w && current.h === viewport.h) {
            reflowToViewport(viewport, attempt + 1);
          }
        });
      });
  }, [revealSettledVisualLayout]);

  // Callback ref for the stage: its REAL pixel size IS the engine viewport. A
  // ResizeObserver tracks it across initial mount, resize, and device rotation, so
  // content reflows to fit EVERY width (phone → ultrawide) — the L063 category fix
  // for "content overflows the available area" (engine stays the only layout truth;
  // we only report the size). rAF-coalesced + 2px change-gated so a scrollbar's
  // sub-pixel flutter can't loop. Guards the no-ResizeObserver env (jsdom/SSR): the
  // ref still sets stageRef.current for the pointer/float handlers that read it.
  const attachStage = React.useCallback((node: HTMLDivElement | null) => {
    stageRef.current = node;
    stageObserverRef.current?.disconnect();
    stageObserverRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const measure = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next = resolveStageViewport(node.clientWidth, node.clientHeight);
        const prev = stageViewportRef.current;
        if (Math.abs(next.w - prev.w) < 2 && Math.abs(next.h - prev.h) < 2) {
          revealSettledVisualLayout();
          return;
        }
        markVisualLayoutDirty();
        stageViewportRef.current = next;
        reflowToViewport(next);
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    stageObserverRef.current = observer;
    measure();
  }, [markVisualLayoutDirty, reflowToViewport, revealSettledVisualLayout]);

  // Canvas wheel → camera (B-45). The logic lives in a ref refreshed EVERY render
  // (latest camera, commitCamera, canvas-ness — never stale) and is invoked through
  // a STABLE trampoline, so the native listener is attached exactly once per stage
  // mount and survives re-renders. It MUST be non-passive (attached in attachViewport
  // with { passive: false }) so ctrl/⌘+wheel — the browser's pinch-zoom gesture —
  // can be preventDefault'd and redirected to the camera instead of zooming the page.
  const wheelHandlerRef = React.useRef<(event: WheelEvent) => void>(() => {});
  const handleCanvasWheel = React.useCallback((event: WheelEvent) => {
    wheelHandlerRef.current(event);
  }, []);
  // The stage-level keyboard contract (diagnostic dump, escalating Cmd+A select, menu/picker
  // arrow+Enter+Escape nav) runs on a NATIVE capture-phase keydown listener for the SAME reason
  // the block contract does: React 19's delegated synthetic key events don't fire on this
  // engine-hosted subtree in the WKWebView presenter. Capture phase on the viewport (an ancestor
  // of the blocks) runs BEFORE the block's native bubble listener, so a menu/picker that consumes
  // an arrow preventDefaults it and the block handler then reads defaultPrevented and stands down —
  // preserving the exact ownership the old onKeyDownCapture→onKeyDown ordering gave. Ref-held so
  // the once-bound listener always sees the latest menu/picker state without re-binding.
  const stageKeyDownRef = React.useRef<(event: KeyboardEvent) => void>(() => {});
  const handleStageKeyDown = React.useCallback((event: KeyboardEvent) => {
    stageKeyDownRef.current(event);
  }, []);
  // The stage keyboard contract listens on the WINDOW (capture), not the viewport element:
  // (1) Cmd+A escalation BLURS the editable (so a Delete hits block-selection, not text) —
  //     after the blur the next keydown targets <body>, OUTSIDE the viewport subtree, so a
  //     viewport-bound listener goes deaf and "Cmd+A again" dies (the user-reported bug).
  // (2) The menu/picker/composer overlays PORTAL to <body> (AnchoredOverlay) — their keydowns
  //     never bubble through the viewport either.
  // The handler itself guards per command (see stageKeyDownRef assignment) so this global
  // listener never hijacks other surfaces' keys.
  React.useEffect(() => {
    window.addEventListener('keydown', handleStageKeyDown, true);
    return () => window.removeEventListener('keydown', handleStageKeyDown, true);
  }, [handleStageKeyDown]);
  // Ref-callback on the FIXED stage viewport: (re)binds the non-passive wheel listener when the
  // stage element mounts/unmounts (it only exists once a page exists, so a one-shot effect would
  // miss it).
  const attachViewport = React.useCallback((node: HTMLDivElement | null) => {
    if (viewportRef.current) {
      viewportRef.current.removeEventListener('wheel', handleCanvasWheel);
    }
    viewportRef.current = node;
    if (node) {
      node.addEventListener('wheel', handleCanvasWheel, { passive: false });
    }
  }, [handleCanvasWheel]);

  // Free-pan the canvas: grab-drag the BACKGROUND of an Absolute canvas root to
  // move the camera (camera-only, zero tree mutation; Codex-converged). rAF-
  // coalesced like the other commits; the engine returns the re-offset snapshot.
  const pendingCamera = React.useRef<{ pan_x: number; pan_y: number; zoom: number; scheduled: boolean }>({
    pan_x: 0, pan_y: 0, zoom: 1, scheduled: false,
  });

  function commitCamera(pan_x: number, pan_y: number, zoom: number) {
    const pending = pendingCamera.current;
    pending.pan_x = pan_x;
    pending.pan_y = pan_y;
    pending.zoom = zoom;
    if (pending.scheduled) return;
    pending.scheduled = true;
    requestAnimationFrame(flushCameraPatch);
  }

  function flushCameraPatch() {
    const pending = pendingCamera.current;
    if (!pending.scheduled) return;
    pending.scheduled = false;
    void runPersistingTransaction({ camera: { pan_x: pending.pan_x, pan_y: pending.pan_y, zoom: pending.zoom }, viewport: stageViewportRef.current })
      .catch(recoverFromWriteError);
  }

  // Grab-pan: capture the start camera + pointer ONCE (Codex Q3), pointer-capture
  // so the gesture never reclassifies mid-drag (Q7), unbounded zoom-aware delta.
  function beginCanvasPan(event: React.PointerEvent) {
    const stage = stageRef.current;
    if (!stage) return;
    const cam = snapshotRef.current.camera ?? EMPTY_CAMERA;
    const startPanX = cam.pan_x;
    const startPanY = cam.pan_y;
    const startZoom = cam.zoom || 1;
    const bounds = stage.getBoundingClientRect();
    const pointerStartX = event.clientX - bounds.left;
    const pointerStartY = event.clientY - bounds.top;
    try { stage.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
    const move = (e: PointerEvent) => {
      const next = panFromDrag({
        startPanX, startPanY, startZoom,
        pointerStartX, pointerStartY,
        pointerX: e.clientX - bounds.left,
        pointerY: e.clientY - bounds.top,
      });
      commitCamera(next.pan_x, next.pan_y, startZoom);
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { stage.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // A floated node (its parent is the Absolute canvas root — nodeAuthorsOrigin)
  // is moved by a body-drag: track the pointer delta from the captured frame
  // origin and rAF-commit new layout.x/y. Flow nodes keep the reorder drag below.
  function beginRepositionDrag(nodeId: string) {
    const rect = snapshotRef.current.frames[nodeId]?.rect;
    if (!rect) return;
    const originX = rect.x;
    const originY = rect.y;
    const nodeWidth = rect.w;
    const nodeHeight = rect.h;
    let pointerStart: { x: number; y: number } | null = null;
    setDragNodeId(nodeId);
    const move = (event: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      const bounds = stage.getBoundingClientRect();
      const px = event.clientX - bounds.left;
      const py = event.clientY - bounds.top;
      if (!pointerStart) pointerStart = { x: px, y: py };
      // Under canvas zoom the plane is scaled, so a screen delta is delta/zoom world
      // px (repositionFromDrag divides) and the reachable WORLD bounds are the
      // unscaled plane size / zoom. zoom = 1 (flow / unzoomed) leaves this unchanged.
      const zoom = snapshotRef.current.camera?.zoom || 1;
      const next = repositionFromDrag({
        originX, originY, nodeWidth, nodeHeight,
        canvasWidth: stage.clientWidth / zoom, canvasHeight: stage.clientHeight / zoom,
        pointerStartX: pointerStart.x, pointerStartY: pointerStart.y,
        pointerX: px, pointerY: py,
        zoom,
      });
      commitMove(nodeId, next.x, next.y);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragNodeId(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function beginDrag(nodeId: string) {
    const dragTree = snapshotRef.current.tree;
    if (dragTree && nodeAuthorsOrigin(dragTree, nodeId)) {
      beginRepositionDrag(nodeId);
      return;
    }
    setDragNodeId(nodeId);
    const draggedLabel = (() => {
      const node = findNodeById(snapshotRef.current.tree, nodeId);
      return (node && firstNonEmptyTextValue(node)) || 'Block';
    })();
    const move = (event: PointerEvent) => {
      setDragGhost({ x: event.clientX, y: event.clientY, label: draggedLabel });
      const stage = stageRef.current;
      if (!stage) return;
      // dropPlacementAt compares against snapshot.frames WORLD rects, so the pointer must cross
      // the full screen→world seam: bounds already include the camera translate; divide by zoom
      // (a screen px is 1/zoom world px on the scaled plane), then ADD the framed page's world
      // origin (the plane is localized against it — see pageOrigin). zoom=1 + first page keeps
      // the original arithmetic exactly.
      const bounds = stage.getBoundingClientRect();
      const zoom = snapshotRef.current.camera?.zoom || 1;
      const origin = pageOriginRef.current;
      const point = {
        x: (event.clientX - bounds.left) / zoom + origin.x,
        y: (event.clientY - bounds.top) / zoom + origin.y,
      };
      setDropTarget(dropPlacementAt(snapshotRef.current, nodeId, point));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragNodeId(null);
      setDragGhost(null);
      setDropTarget((placement) => {
        if (placement?.kind === 'sibling') {
          commitPatches([{
            type: 'MOVE_NODE',
            node_id: nodeId,
            new_parent_id: placement.parentId,
            new_index: placement.index,
          }]);
        } else if (placement?.kind === 'split') {
          // Drop on a block's LEFT/RIGHT edge → wrap that target in a horizontal split with the
          // dragged block beside it (Notion/Craft columns). Same proven split shape as the
          // Columns material + insertBeside. The dragged block MOVES here, so the wrap rebuilds
          // both subtrees: REMOVE dragged, REMOVE target, INSERT a split holding clones of both.
          // Index bookkeeping: removing the dragged node first shifts the target's index down by
          // one ONLY when they share a parent and the dragged node sat before it.
          const tree = snapshotRef.current.tree;
          const dragged = tree ? findNodeById(tree, nodeId) : null;
          const target = tree ? findNodeById(tree, placement.targetId) : null;
          const targetParent = tree ? parentLocation(tree, placement.targetId) : null;
          const draggedParent = tree ? parentLocation(tree, nodeId) : null;
          // Guards (Codex-converged): a wrap is valid only for DISJOINT subtrees. (1) never drop a
          // block onto itself; (2) never wrap a target that CONTAINS the dragged node — cloning the
          // pre-edit target would re-include the dragged id alongside the separate dragged clone =
          // duplicate id/content; (3) never wrap a target that LIVES INSIDE the dragged node (the
          // descent already excludes the dragged subtree, so this is belt-and-suspenders).
          const targetContainsDragged = !!target && !!findNodeById(target, nodeId) && target.id !== nodeId;
          const draggedContainsTarget = !!dragged && !!findNodeById(dragged, placement.targetId) && dragged.id !== placement.targetId;
          if (dragged && target && targetParent && nodeId !== target.id && !targetContainsDragged && !draggedContainsTarget) {
            const adjustedIndex = draggedParent && draggedParent.parentId === targetParent.parentId && draggedParent.index < targetParent.index
              ? targetParent.index - 1
              : targetParent.index;
            const row: SceneNode = {
              id: `node:${crypto.randomUUID()}`,
              kind: 'Container',
              props: { style: { layout: { mode: 'split', axis: 'x', gap: 12, parts: [{ fraction: 1 }, { fraction: 1 }] } } },
              visible: true,
              children: placement.side === 'left' ? [cloneNode(dragged), cloneNode(target)] : [cloneNode(target), cloneNode(dragged)],
            };
            commitPatches([
              { type: 'REMOVE_SUBTREE', node_id: nodeId },
              { type: 'REMOVE_SUBTREE', node_id: placement.targetId },
              { type: 'INSERT_NODE', parent_id: targetParent.parentId, index: adjustedIndex, node: row },
            ]);
          }
        }
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  async function insertMaterialAndPersist(material: MaterialDescriptor, deliveryRef?: string): Promise<boolean> {
    const initialTree = snapshotRef.current.tree;
    if (!initialTree) return false;
    const page = framedNodeId ? findNodeById(initialTree, framedNodeId) : initialTree;
    const editableNodeId = activeMenu?.nodeId ?? focusedNodeId ?? (page ? firstTextNode(page)?.id : null);
    if (!editableNodeId) return false;
    const nextNode = deliveryRef ? stampComponentDeliveryRef(materialNode(material), deliveryRef) : materialNode(material);
    setActiveMenu(null);
    flushTextPatch();
    let inserted = false;
    try {
      await runPersistingTransaction(() => {
        const tree = snapshotRef.current.tree;
        const parent = tree ? parentLocation(tree, editableNodeId) : null;
        // Keep the exact selected identity. A removed target cannot redirect the
        // insertion to another block or to the workspace root.
        if (!tree || !parent) return null;
        // A component material inserts a linked INSTANCE: register its root so collapse
        // (at persist) folds it back to a ref, and hand the engine the RESOLVED subtree
        // (the engine lays out concrete nodes, never the ref placeholder).
        const defId = instanceDefinitionId(nextNode);
        let engineNode = nextNode;
        if (defId) {
          instanceRootsRef.current.set(nextNode.id, defId);
          engineNode = resolveComponentInstances(nextNode, definitionsByIdRef.current) ?? nextNode;
        }
        setFocusedNodeId(firstTextNode(engineNode)?.id ?? engineNode.id);
        inserted = true;
        return { scene_patches: [
          { type: 'REMOVE_SUBTREE', node_id: editableNodeId },
          { type: 'INSERT_NODE', parent_id: parent.parentId, index: parent.index, node: engineNode },
        ] };
      });
      return inserted;
    } catch (error) { recoverFromWriteError(error); return false; }
  }
  function applyMaterial(material: MaterialDescriptor) {
    void insertMaterialAndPersist(material);
  }
  async function placeReceiptSurface(payload: Parameters<typeof placeableSurfaceMaterial>[0], deliveryRef?: string): Promise<boolean> {
    const material = placeableSurfaceMaterial(payload);
    if (!material) return false;
    const disposition = deliveryRef
      ? resolveComponentDeliveryDisposition(lastKnownDurableContentRef.current, snapshotRef.current.tree, deliveryRef)
      : 'insert';
    if (disposition === 'already-durable') return true;
    if (disposition === 'retry-current') {
      try {
        await retryPersistingSnapshot();
        return true;
      } catch (error) {
        recoverFromWriteError(error);
        return false;
      }
    }
    return insertMaterialAndPersist(material, deliveryRef);
  }
  const surfaceIntentCatalog = React.useMemo(
    () => placeableSurfaceCatalogForViewer(findPlaceableSurfaces(readPublishedRecords(placeableSurfaceRows)), viewerAccessRefs),
    [placeableSurfaceRows, viewerAccessRefs],
  );

  // Create a reusable component from a selected node (Framer "Create Component").
  // Serializes the subtree into a document-local definition + replaces the
  // selection with a linked instance. The engine renders the RESOLVED instance;
  // collapse (at persist) folds it back to a ref. The definition joins the slash
  // menu so the user can insert more instances.
  function createComponent(nodeId: string) {
    const current = snapshotRef.current;
    if (!current.tree) return;
    const result = buildCreateComponentTransaction({
      tree: current.tree,
      selectedNodeId: nodeId,
      name: `Component ${componentDefinitionsRef.current.length + 1}`,
      makeDefinitionId: () => `def:${crypto.randomUUID()}`,
    });
    const insertPatch = result?.patches.find((patch) => patch.type === 'INSERT_NODE');
    if (!result || !insertPatch || insertPatch.type !== 'INSERT_NODE') return;
    setComponentDefinitions((defs) => [...defs, result.descriptor]);
    componentDefinitionsRef.current = [...componentDefinitionsRef.current, result.descriptor];
    definitionsByIdRef.current = new Map(definitionsByIdRef.current).set(result.definitionId, result.descriptor.node);
    instanceRootsRef.current.set(result.instanceId, result.definitionId);
    const resolvedInstance = resolveComponentInstances(
      { id: result.instanceId, kind: result.descriptor.node.kind, props: { [DEFINITION_REF_PROP]: result.definitionId, [PROP_OVERRIDES_PROP]: {} }, visible: true, children: [] },
      definitionsByIdRef.current,
    );
    if (!resolvedInstance) return;
    setSelectedNodeId(null);
    commitPatches([
      { type: 'REMOVE_SUBTREE', node_id: nodeId },
      { type: 'INSERT_NODE', parent_id: insertPatch.parent_id, index: insertPatch.index, node: resolvedInstance },
    ]);
  }

  // New page = the same INSERT_NODE primitive as any block (plan §4.5);
  // then frame it with the camera. Honest creation: starts blank (L117).
  function createPage() {
    const fresh = freshFlowNode();
    setFramedNodeId(fresh.id);
    setFocusedNodeId(fresh.children?.[0]?.id ?? fresh.id);
    const tree = snapshotRef.current.tree;
    if (!tree) {
      // Empty composition: there is no root yet, so INSERT_NODE has no parent to
      // attach to. Bootstrap the root container (pages are its children) with
      // SET_ROOT so the very first "New page" creates a real page.
      const root: SceneNode = {
        id: 'root',
        kind: 'Container',
        props: { style: { layout: { mode: 'flex', axis: 'y', gap: DEFAULT_BLOCK_GAP } } },
        visible: true,
        children: [fresh],
      };
      commitPatches([{ type: 'SET_ROOT', node: root }]);
      return;
    }
    commitPatches([{ type: 'INSERT_NODE', parent_id: tree.id, index: 0, node: fresh }]);
  }

  const [importPageOpen, setImportPageOpen] = React.useState(false);
  const [importReplacement, setImportReplacement] = React.useState<SceneNode | null>(null);
  async function replaceImportedPage(reviewed: SceneNode, incoming: SceneNode): Promise<boolean> {
    try {
      // Include the current input even if its coalescing microtask has not run.
      flushTextPatch();
      await runPersistingTransaction(() => {
        const tree = snapshotRef.current.tree;
        const current = tree && findNodeById(tree, reviewed.id);
        if (!current) throw new Error('This page is no longer available.');
        // An engine update can succeed before its durable save fails. Retry
        // only the identical incoming page, without removing/inserting again.
        if (sameImportedPage(current, incoming)) return null;
        const plan = planImportedPageReplacement(reviewed, current, incoming);
        if (!plan.ok) throw new Error(plan.reason);
        const location = parentLocation(tree!, reviewed.id);
        if (!location) throw new Error('This page cannot be replaced.');
        return { scene_patches: [
          { type: 'REMOVE_SUBTREE', node_id: reviewed.id },
          { type: 'INSERT_NODE', parent_id: location.parentId, index: location.index, node: plan.page },
        ] };
      });
      setFramedNodeId(incoming.id);
      setFocusedNodeId(incoming.children?.[0]?.id ?? incoming.id);
      return true;
    } catch (error) { recoverFromWriteError(error); return false; }
  }
  async function importPage(page: SceneNode): Promise<boolean> {
    const tree = snapshotRef.current.tree;
    const existing = tree && findNodeById(tree, page.id);
    if (existing) {
      // A failed durable write may leave the inserted page in the engine.
      // Never insert its IDs again or replace edits made since that attempt.
      if (!sameImportedPage(existing, page)) {
        showError('This page has changed. Close the import window and review the page before saving again.');
        return false;
      }
      try {
        await retryPersistingSnapshot();
        setFramedNodeId(page.id);
        setFocusedNodeId(page.children?.[0]?.id ?? page.id);
        return true;
      } catch (error) { recoverFromWriteError(error); return false; }
    }
    const patches: ScenePatch[] = tree
      ? [{ type: 'INSERT_NODE', parent_id: tree.id, index: 0, node: page }]
      : [{ type: 'SET_ROOT', node: { id: 'root', kind: 'Container', visible: true,
        props: { style: { layout: { mode: 'flex', axis: 'y', gap: DEFAULT_BLOCK_GAP } } }, children: [page] } }];
    const saved = await commitPatchesAndPersist(patches);
    if (saved) { setFramedNodeId(page.id); setFocusedNodeId(page.children?.[0]?.id ?? page.id); }
    return saved;
  }

  // The VISIBLE "Insert" toolbar action (L083): append a fresh block to the
  // framed page (or the first page) and open the SAME "/" menu on it. This is
  // the discoverable default — hovering a block's grip or typing "/" are the
  // power shortcuts to the identical menu. One insert mechanism, three entry
  // points; nothing important is keyboard-only.
  function insertBlockOnFramedPage() {
    const tree = snapshotRef.current.tree;
    if (!tree) return;
    const pages = tree.children ?? [];
    const page = (framedNodeId ? findNodeById(tree, framedNodeId) : null)
      ?? (pages[0] ? findNodeById(tree, pages[0].id) : null);
    if (!page) return;
    const children = page.children ?? [];
    const last = children[children.length - 1];
    if (last) { addBlockBelow(last.id); return; }
    const fresh = blankTextNode();
    setFramedNodeId(page.id);
    setFocusedNodeId(fresh.id);
    setMenuIndex(0);
    setActiveMenu({ nodeId: fresh.id, query: '' });
    commitPatches([{ type: 'INSERT_NODE', parent_id: page.id, index: 0, node: fresh }]);
  }

  // Per-page row actions (the ⋮ popover). Each is the SAME scene primitive any
  // block uses — a page is just a top-level node, so rename = frame + focus its
  // heading text, duplicate = clone with fresh ids beside it, delete = remove the
  // subtree. No page/document backend type; nothing here the grip menu can't also do.
  function onPageAction(pageId: string, action: string) {
    const tree = snapshotRef.current.tree;
    if (!tree) return;
    if (action === 'retry-save') {
      if (loadState === 'ready' && pageSaveStates[pageId] === 'error'
          && (tree.children ?? []).some(page => page.id === pageId)) {
        flushTextPatch();
        void retryPersistingSnapshot().catch(recoverFromWriteError);
      }
      return;
    }
    if (action === 'check-references') {
      if ((tree.children ?? []).some(page => page.id === pageId)) {
        setReferenceCheckRequest(previous => ({ pageId, revision: previous.revision + 1 }));
      }
      return;
    }
    if (action === 'rename') {
      frameNode(pageId);
      const firstText = firstTextNode(findNodeById(tree, pageId) ?? tree);
      setFocusedNodeId(firstText?.id ?? pageId);
      return;
    }
    if (action === 'move-to-top') {
      const location = parentLocation(tree, pageId);
      if (location && location.index > 0) {
        commitPatches([{ type: 'MOVE_NODE', node_id: pageId, new_parent_id: location.parentId, new_index: 0 }]);
      }
      return;
    }
    if (action === 'spacing') {
      // Frame the page first so its blocks are on-stage and the popover anchors under
      // it; editing the page's gap moves the space between every block (the global lever).
      frameNode(pageId);
      openSpacingEditor(pageId);
      return;
    }
    if (action === 'duplicate') {
      const page = findNodeById(tree, pageId);
      if (!page) return;
      const loc = parentLocation(tree, pageId);
      const copy = freshIds(cloneNode(page));
      setFramedNodeId(copy.id);
      commitPatches([{ type: 'INSERT_NODE', parent_id: loc?.parentId ?? tree.id, index: (loc?.index ?? 0) + 1, node: copy }]);
      return;
    }
    if (action === 'delete') {
      const nextFramed = (tree.children ?? []).find((node) => node.id !== pageId)?.id ?? null;
      if (framedNodeId === pageId) setFramedNodeId(nextFramed);
      commitPatches([{ type: 'REMOVE_SUBTREE', node_id: pageId }]);
    }
  }

  // Float a block onto the canvas: the engine snapshot's frame is the ONLY
  // layout truth (we read the node's current rect + the stage size, never
  // compute), then the pure primitive emits one atomic batch that lazily
  // migrates the flow root to an Absolute canvas (first float only) and pins the
  // node at its captured frame. The blind SceneFrame then renders it at its new
  // absolute position — no float/canvas backend type anywhere.
  function floatNode(nodeId: string) {
    const current = snapshotRef.current;
    if (!current.tree) return;
    // SCOPE = THE FRAMED PAGE, never the workspace root (live incident 2026-07-11,
    // image #73: passing the WHOLE tree migrated the workspace root — every PAGE got
    // wrapped into one FlowColumn and the floated node became a root sibling, so the
    // pages sidebar collapsed to 2 rows and all pages rendered stacked/overlapping).
    // "Float on canvas" means THIS page becomes a canvas: the page's own blocks wrap
    // into the FlowColumn INSIDE the page, and the floated node pins at page-local
    // coordinates. The page's absolute mode persists in its own props (pages are
    // persisted children), so a floated page reloads as a canvas with zero root
    // reconstruction. The sidebar (root children) is structurally untouched.
    const page = (framedNodeId ? findNodeById(current.tree, framedNodeId) : null) ?? current.tree.children?.[0] ?? null;
    if (!page || page.id === nodeId) return; // floating the page itself is the workspace overview's job
    const rect = current.frames[nodeId]?.rect;
    const pageRect = current.frames[page.id]?.rect;
    if (!rect || !pageRect) return;
    const tx = buildFloatTransaction(
      page,
      nodeId,
      // World → page-local: the page's content plane originates at ITS world origin.
      { x: rect.x - pageRect.x, y: rect.y - pageRect.y, w: rect.w, h: rect.h },
      { width: pageRect.w, height: pageRect.h },
      () => `node:${crypto.randomUUID()}`,
    );
    if (tx.scene_patches.length === 0) return;
    setSelectedNodeId(null);
    commitPatches(tx.scene_patches);
  }

  // Frame the WORKSPACE ROOT — the "Fit all pages" overview where every page is a positioned
  // card on one plane (Mobbin: Fibery / ClickUp "Fit to screen"). This is NAVIGATION (framing
  // a node), NOT a view mode: the canvas is emergent from the root's own Absolute layout. It
  // arranges any not-yet-placed page so the overview is spatial, then frames the root. To go
  // back into a page, click it in the rail (`frameNode`) — symmetric navigation, no mode flag.
  // Idempotent: an already-arranged workspace emits no patches and just frames the root.
  function frameWorkspaceOverview() {
    const tree = snapshotRef.current.tree;
    if (!tree || (tree.children ?? []).length === 0) return;
    const stage = stageRef.current;
    const canvasSize = stage
      ? { width: stage.clientWidth, height: stage.clientHeight }
      : { width: 1200, height: 800 };
    const tx = buildWorkspaceCanvasArrangement(tree, canvasSize);
    if (tx.scene_patches.length > 0) commitPatches(tx.scene_patches);
    setSelectedNodeId(null);
    setFramedNodeId(tree.id);
  }

  // Collapse a panel to a fixed-width spine — and the inverse. A panel group is a
  // Flex row; the engine renders a style.flex>0 child to fill and a {flex:0,
  // width:36} child as a fixed spine, so collapse/expand are pure style writes the
  // engine lays out (Codex-converged 2026-06-21; no new backend type, no engine
  // change). The spine's own chevron calls expandPanel; the grip menu calls
  // collapsePanel. Restore is exact — collapse stashes the prior flex.
  function collapsePanel(nodeId: string) {
    const tree = snapshotRef.current.tree;
    if (!tree) return;
    const tx = collapsePanelTransaction(findNodeById(tree, nodeId));
    if (tx.scene_patches.length === 0) return;
    commitPatches(tx.scene_patches);
  }
  function expandPanel(nodeId: string) {
    const tree = snapshotRef.current.tree;
    if (!tree) return;
    const tx = expandPanelTransaction(findNodeById(tree, nodeId));
    if (tx.scene_patches.length === 0) return;
    commitPatches(tx.scene_patches);
  }

  // Table structural edits — insert/remove a row or column, keyed off the cell's live
  // (rowIndex, colIndex) computed during render (tableCtx). Each builder emits one
  // granular, shared-fraction-preserving transaction (Codex-converged); the guard
  // no-ops below 1×1. The table node is found by id from the live snapshot.
  function commitTableTx(tx: { scene_patches: ScenePatch[] }) {
    if (tx.scene_patches.length === 0) return;
    commitPatches(tx.scene_patches);
  }
  function insertTableRow(tableId: string, index: number) {
    const table = snapshotRef.current.tree ? findNodeById(snapshotRef.current.tree, tableId) : null;
    if (table) commitTableTx(buildInsertTableRowTransaction({ table, index, makeId: () => `node:${crypto.randomUUID()}`, makeCell: freshFlowNode }));
  }
  function removeTableRow(tableId: string, index: number) {
    const table = snapshotRef.current.tree ? findNodeById(snapshotRef.current.tree, tableId) : null;
    if (table) commitTableTx(buildRemoveTableRowTransaction({ table, index }));
  }
  function insertTableColumn(tableId: string, index: number) {
    const table = snapshotRef.current.tree ? findNodeById(snapshotRef.current.tree, tableId) : null;
    if (table) commitTableTx(buildInsertTableColumnTransaction({ table, index, makeCell: freshFlowNode }));
  }
  function removeTableColumn(tableId: string, index: number) {
    const table = snapshotRef.current.tree ? findNodeById(snapshotRef.current.tree, tableId) : null;
    if (table) commitTableTx(buildRemoveTableColumnTransaction({ table, index }));
  }

  // Rail selection = framing navigation. ZERO scene patches (grep-gated). Framing
  // anchors the chosen node at the stage origin via the framed-ROOT origin-zeroing in
  // SceneNodeView (isRoot ⇒ rect {x:0,y:0}) — NOT via the camera. So framing RESETS the
  // camera to identity: the camera is purely for INTERACTIVE pan/zoom WITHIN the framed
  // view (grab-pan + pinch-zoom, B-45). Sending a pan here too would DOUBLE-apply with
  // the origin-zeroing now that the camera is a live host transform (it shifted the
  // framed page off-screen — the latent-gap era hid this because the camera was inert).
  function frameNode(nodeId: string) {
    setFramedNodeId(nodeId);
    const sequence = ++renderSequence.current;
    void sendTransaction({
      camera: EMPTY_CAMERA,
      viewport: stageViewportRef.current,
    })
      .then(decodeCompositionSnapshotReply)
      .then((nextSnapshot) => {
        if (sequence !== renderSequence.current) return;
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
      })
      .catch((error) => showError(`Could not open the page.${appendDetail(error)}`));
  }

  // The rail IS a rendering of the engine root's children — same snapshot,
  // no second data source (plan §4.5). The pages search box filters the same
  // rows by their authored text (no extra index, no second list). Reuse the
  // content-action text reader so nested page bodies participate in search.
  const railNodes = snapshot.tree?.children ?? [];
  const pagesNeedle = pagesSearch.trim().toLowerCase();
  const filteredPages = React.useMemo(() => {
    const pages = snapshot.tree?.children ?? [];
    return pagesNeedle
      ? pages.filter((node) => readableInlineText(collectPlainText(node, '')).toLowerCase().includes(pagesNeedle)
        || railLabel(node).toLowerCase().includes(pagesNeedle))
      : pages;
  }, [snapshot.tree, pagesNeedle]);
  // A PURE projection of the same rows into the shape the owned sidebar already
  // reads. Nothing is written: page scene nodes stay the only identity and order
  // authority, so there is no second membership record to drift (L030). The
  // projection preserves each page id as `viewId`, because sidebar membership
  // namespaces the rendered row id and click/active routing must still address
  // the real node.
  // Keyed on the page CONTENT, never on the array identity. `railNodes` comes from
  // `snapshot.tree?.children ?? []`, which is a fresh array on every render, so a
  // memo keyed on it would rebuild the graph every time. The owned sidebar reacts
  // to graph identity, so that rebuild feeds its effects and the surface spins
  // forever. Two mount tests caught exactly that. The signature changes only when
  // a page is added, removed, renamed or reordered.
  const [referenceCheckRequest, setReferenceCheckRequest] = React.useState({pageId:'',revision:0});
  const referencePages = snapshot.tree?.children ?? [];
  // A deliberate page check goes first in the bounded batch, including pages
  // beyond the automatic batch's limit. Scene order and content are untouched.
  const orderedReferencePages = [...referencePages.filter(page => page.id === referenceCheckRequest.pageId),
    ...referencePages.filter(page => page.id !== referenceCheckRequest.pageId)];
  const referenceInputs = orderedReferencePages.flatMap(node =>
    pageReferencesToCheck(node, () => 'unchecked').map(row => row.reference));
  const referenceCheckKey = JSON.stringify([sceneAddress, partitionLabel, referenceCheckRequest,
    referenceInputs.map(reference => [reference.kind, reference.value]),
    pickerShortcut?.presentation?.option_sources ?? []]);
  const referenceCheckInputs = React.useRef({ references: referenceInputs,
    sources: pickerShortcut?.presentation?.option_sources ?? [] });
  referenceCheckInputs.current = { references: referenceInputs,
    sources: pickerShortcut?.presentation?.option_sources ?? [] };
  const [referenceChecks, setReferenceChecks] = React.useState<{
    key: string; values: Awaited<ReturnType<typeof checkPageReferences>>;
  } | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const input = referenceCheckInputs.current;
    void checkPageReferences(input.references, input.sources, checkReferenceOwner, controller.signal, (key, resolution) => {
      if (controller.signal.aborted) return;
      setReferenceChecks(previous => {
        const values = new Map(previous?.key === referenceCheckKey ? previous.values : []);
        values.set(key, resolution);
        return {key: referenceCheckKey, values};
      });
    })
      .then(values => {
        if (!controller.signal.aborted) setReferenceChecks({key: referenceCheckKey, values});
      }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [referenceCheckKey, checkReferenceOwner]);
  const sidebarPages = filteredPages.map((node) => {
    const selected = node.id === framedNodeId && focusedNodeId && focusedNodeId !== node.id
      ? findNodeById(node, focusedNodeId) : null;
    return { id: node.id, label: railLabel(node), headings: documentHeadings(node),
      saveLabel: pageSaveStates[node.id] === 'saved' ? 'Saved'
        : pageSaveStates[node.id] ? SAVE_VIEW[pageSaveStates[node.id]].label : undefined,
      canRetrySave: loadState === 'ready' && pageSaveStates[node.id] === 'error',
      referencesToCheck: pageReferencesToCheck(node, reference => {
        const checked = referenceChecks?.key === referenceCheckKey
          ? referenceChecks.values.get(referenceKey(reference)) : undefined;
        // Picker feeds may be partial or stale. Only the current owner check
        // can resolve a reference; pending, unsupported and failed reads remain visible.
        return checked ?? 'unchecked';
      }),
      selectedBlock: selected ? {id: selected.id, label: typeof selected.props?.text === 'string'
        ? parseInlineRuns(selected.props.text).map(run => run.type === 'text' ? run.text : `@${run.label}`).join('').trim().slice(0, 120) || 'Empty block' : 'Selected content'} : undefined };
  });
  const pagesSignature = JSON.stringify(sidebarPages);
  const sidebarPagesRef = React.useRef(sidebarPages);
  sidebarPagesRef.current = sidebarPages;
  const pagesSidebar = React.useMemo(
    () => buildDocumentsPageSidebarProjection(sidebarPagesRef.current),
    [pagesSignature],
  );
  const indexedDocuments = React.useMemo(() => readDocumentIndex(documentIndexRows), [documentIndexRows]);
  const matchingIndexedDocuments = React.useMemo(() => pagesNeedle
    ? indexedDocuments.filter(entry => [entry.title, entry.summary, ...entry.content_labels]
      .some(text => text.toLowerCase().includes(pagesNeedle))) : indexedDocuments,
  [indexedDocuments, pagesNeedle]);
  const documentLibrarySections = React.useMemo(() => matchingIndexedDocuments.length ? [
    ...(pagesSidebar.sections ?? [{id:'documents-pages', title:'Pages', items:pagesSidebar.catalogItems}]),
    {id:'documents-library',title:'Saved documents',items:matchingIndexedDocuments.map(entry => ({
      id:`indexed-document:${entry.doc_id}`,viewId:`indexed-document:${entry.doc_id}`,label:entry.title,icon:'FileText',
    }))},
  ] : pagesSidebar.sections, [matchingIndexedDocuments, pagesSidebar]);

  // The stage shows ONLY the framed page — the framed engine-root child — like a
  // Notion document, never all pages stacked. A "page" is just a top-level node;
  // framing picks which one renders (default: the first). The page's OWN layout
  // mode drives the stage chrome, so a fresh flow page is a clean document even
  // when the root was migrated to a canvas elsewhere. New pages are inserted at
  // the top (engine origin) so creating one shows it alone, not added to a canvas.
  // Framing targets ANY node: a page (rail click) OR the workspace root (Overview). The
  // canvas is emergent — framing the root, whose LayoutMode is Absolute, shows every page as
  // a positioned card; framing a page shows that page. No "view mode": framedPage is purely
  // which node is framed (root included), and the chrome follows the framed node's layout.
  const framedPage =
    (framedNodeId === snapshot.tree?.id ? snapshot.tree : railNodes.find((node) => node.id === framedNodeId))
    ?? railNodes[0] ?? snapshot.tree;
  const framedPageIsCanvas = framedPage ? isCanvasRoot(framedPage) : false;
  // THE WORLD↔PLANE SEAM (L063 category fix). SceneNodeView renders the framed root at {0,0}
  // and localizes every child against its parent, so PLANE DOM coords = engine WORLD − the
  // framed page's world origin. Every plane-level chrome consumer of snapshot.frames must
  // cross this ONE seam: world→plane SUBTRACTS it (drop indicator, edge routes, in-plane
  // popover anchors), pointer→world ADDS it (drop placement). The first page's origin is
  // (0,0), which is exactly why the whole misanchored-overlay class of bugs only appeared on
  // later pages (probe-proven: block at plane top 39 vs its menu at world top 560, page
  // origin 521). Ref-mirrored so pointer handlers bound once read the live value.
  const pageOrigin = (framedPage ? snapshot.frames[framedPage.id]?.rect : undefined) ?? { x: 0, y: 0 };
  const pageOriginRef = React.useRef<{ x: number; y: number }>(pageOrigin);
  pageOriginRef.current = pageOrigin;

  // EMPTY-STATE RE-SEED (#29). The generic multi-delete made "a page with ZERO blocks" a valid
  // state (The owner hit it live: select-all + Backspace → nothing left to type into, editor dead).
  // The empty state is DATA: a `kind:"composition-empty-state"` record declares the node set an
  // empty page re-materializes (readEmptyStateSeed — N blank blocks, prefilled blocks, a whole
  // template); absent → ONE blank block (the capable L083 default). An EFFECT, not a delete-path
  // patch, so EVERY route to emptiness heals — selection delete, grip Delete of the last block,
  // an AI action, a patch invented tomorrow (the L063 category fix; patching each delete path
  // would be whack-a-mole). Fresh ids per seed (materializeEmptyStateSeed), focus lands on the
  // first seeded block so typing resumes immediately. Only fires on a real framed PAGE (never
  // the workspace-root overview, whose emptiness is "no pages yet" — a different, honest state).
  const emptyStateSeed = React.useMemo(() => readEmptyStateSeed(placeableSurfaceRows), [placeableSurfaceRows]);
  const emptyPageId = framedPage && framedPage.id !== snapshot.tree?.id && (framedPage.children ?? []).length === 0
    ? framedPage.id : null;
  React.useEffect(() => {
    if (!emptyPageId) return;
    const templates = emptyStateSeed ?? [{ kind: 'Text', props: { text: '' } }];
    const seeded = materializeEmptyStateSeed(templates, () => `node:${crypto.randomUUID()}`);
    if (seeded.length === 0) return;
    setFocusedNodeId(seeded[0].id);
    commitPatches(seeded.map((node, index) => ({ type: 'INSERT_NODE' as const, parent_id: emptyPageId, index, node })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emptyPageId]);

  // DIAGNOSTIC DUMP (Alt+Shift+D, or window.__caCursorDiagnostics()): prints the BLIND geometry model
  // the cursor navigates over — every block's live rect + the along/off score for each direction from
  // the anchor, the containment escalation ladder, and the current selection/scope. Proves nav is
  // geometry + DATA, not sibling-index or hidden state (the loop's "generic universal diagnostic dump").
  // Declared AFTER framedPage so the deps array reads an initialized binding (not a TDZ const).
  const dumpCursorDiagnostics = React.useCallback(() => {
    const anchor = focusedNodeId ?? selectedNodeId;
    const rectOf = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const blocks = scopedNodeQueryAll('.ca-text-node[data-node-id]')
      .map((el) => ({ id: el.getAttribute('data-node-id') as string, rect: rectOf(el) }));
    const model: Record<string, unknown> = { blockCount: blocks.length, anchor };
    if (anchor) {
      const fromEl = scopedNodeQuery(`.ca-text-node[data-node-id="${anchor}"]`);
      if (fromEl) {
        const from = rectOf(fromEl);
        const cands = blocks.filter((b) => b.id !== anchor);
        const gx = from.x + from.w / 2;
        const gy = from.y + from.h / 2;
        // Derived from the LIVE cursor-command DATA rows — NOT a hardcoded down/up/left/right list, so a
        // new DATA direction (e.g. a diagonal {dx:1,dy:1}) appears here with zero code, and this dump
        // shows the ACTUAL shipped vectors (reading-flow left/right), not an idealized spatial guess. The
        // goal point preserves the perpendicular axis: a vertical-dominant move keeps x (the goal column),
        // a horizontal-dominant one keeps y (matching navigateFromBlock's own goal handling).
        model.nav = Object.fromEntries(
          cursorCommandsRef.current.map((c) => {
            const goal = Math.abs(c.direction.dy) >= Math.abs(c.direction.dx) ? { x: gx } : { y: gy };
            return [c.key, navDiagnostics(from, c.direction, cands, goal)];
          }),
        );
      }
      if (framedPage) model.escalationLadder = ancestorChainToCeiling(framedPage, anchor, framedPage.id);
    }
    model.selection = [...selectedNodeIds];
    model.scope = selectionScopeRef.current;
    // The four DATA-row families the blind engine navigates over — dumped LIVE so you can see there is
    // NO enum in code: directions emerge from nav geometry above; gestures = the cursor-command rows;
    // scopes = the containment ladder above; ops = the selection-op registry. A new row here (zero code)
    // appears in this dump immediately (enum-dissolution proof).
    model.gestures = cursorCommandsRef.current.map((c) => ({ key: c.key, requires: c.requires, direction: c.direction, landEdge: c.landEdge }));
    model.ops = selectionOpsRef.current.map((o) => ({
      id: o.id,
      keys: o.keys,
      effect: 'patch' in o.effect ? `patch:${o.effect.patch}` : 'clear' in o.effect ? 'clear' : `dispatch:${o.effect.dispatch.target}`,
    }));
    // eslint-disable-next-line no-console
    console.log('[documents] cursor diagnostics', model);
    return model;
  }, [focusedNodeId, selectedNodeId, selectedNodeIds, framedPage]);

  React.useEffect(() => {
    (window as unknown as { __caCursorDiagnostics?: () => unknown }).__caCursorDiagnostics = dumpCursorDiagnostics;
    return () => { delete (window as unknown as { __caCursorDiagnostics?: () => unknown }).__caCursorDiagnostics; };
  }, [dumpCursorDiagnostics]);

  // Refresh the canvas-wheel logic each render so the stable native listener always
  // sees the latest camera + canvas-ness (B-45). ctrl/⌘+wheel = cursor-anchored
  // pinch-zoom; plain two-finger scroll = pan (content moves opposite the scroll,
  // Figma/Miro convention). Both are pure camera writes — no tree mutation.
  wheelHandlerRef.current = (event: WheelEvent) => {
    if (!framedPageIsCanvas) return; // flow pages keep native scroll
    const viewport = viewportRef.current;
    if (!viewport) return;
    const cam = snapshotRef.current.camera ?? EMPTY_CAMERA;
    const rect = viewport.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = Math.exp(-event.deltaY * 0.0125); // smooth; scroll up = zoom in
      const next = zoomAtPoint(cam, pointer, factor, CANVAS_ZOOM_LIMITS);
      commitCamera(next.pan_x, next.pan_y, next.zoom);
    } else {
      event.preventDefault();
      commitCamera(cam.pan_x - event.deltaX, cam.pan_y - event.deltaY, cam.zoom || 1);
    }
  };

  // ---- Canvas HUD (B-46) -------------------------------------------------
  // All derived from the live camera + the engine's world-coord frames (the only
  // layout truth) via the pure do-work fns. The HUD/minimap are blind ui chrome;
  // every camera computation happens here and lands through commitCamera (the same
  // camera-only write the wheel/pan use). Nothing here names a node kind.
  const hudCamera = snapshot.camera ?? EMPTY_CAMERA;
  const hudViewport = stageViewportRef.current;
  const hudZoom = hudCamera.zoom > 0 ? hudCamera.zoom : 1;
  // Every framed child = a "page" silhouette on the canvas. Its world rect feeds both
  // fit-to-content (a bbox) and the shared CanvasMinimap (id'd frames; it does its own
  // world↔map scaling and highlights the selected one).
  const canvasChildren = framedPageIsCanvas && framedPage ? (framedPage.children ?? []) : [];
  const canvasFrameRects: WorldRect[] = canvasChildren
    .map((child) => snapshot.frames[child.id]?.rect)
    .filter((rect): rect is WorldRect => !!rect);
  const minimapFrames: CanvasMinimapFrame[] = canvasChildren.flatMap((child) => {
    const rect = snapshot.frames[child.id]?.rect;
    return rect ? [{ id: child.id, x: rect.x, y: rect.y, width: rect.w, height: rect.h }] : [];
  });
  const commitCameraResult = (next: { pan_x: number; pan_y: number; zoom: number }) =>
    commitCamera(next.pan_x, next.pan_y, next.zoom);
  const handleZoomIn = () => commitCameraResult(zoomByFactor(hudCamera, hudViewport, 1.2));
  const handleZoomOut = () => commitCameraResult(zoomByFactor(hudCamera, hudViewport, 1 / 1.2));
  const handleResetZoom = () => commitCameraResult(zoomToActualSize(hudCamera, hudViewport));
  const handleFit = () => commitCameraResult(fitCamera(framesBoundingBox(canvasFrameRects), hudViewport));
  // The shared minimap emits the WORLD point to centre on; we turn it into a pan.
  const handleMinimapJump = (worldX: number, worldY: number) =>
    commitCameraResult(cameraCenteredOnWorld(worldX, worldY, hudCamera, hudViewport));

  // Stage-level keyboard contract on a NATIVE WINDOW capture listener (React 19 synthetic key
  // events don't fire on this engine-hosted subtree in the WKWebView; element-bound capture went
  // deaf after Cmd+A's blur; portaled overlays never bubble through the viewport). Assigned each
  // render so it closes over the latest menu/picker state. Because the listener is GLOBAL, each
  // command carries its OWN ownership guard — this surface only ever consumes a key it owns:
  //   • diagnostics + Cmd+A: the key targets this editor (viewport subtree) OR a selection
  //     session this editor owns is active (escalation blurred focus to <body>). Never inside
  //     the composer input — its own select-all must stay the browser's.
  //   • menu/picker nav: the overlay is OPEN (this editor owns it, wherever it portals).
  stageKeyDownRef.current = (event: KeyboardEvent) => {
    // A CLAIMED key must be dead to every other surface (the shared keyboard-claim ownership
    // contract in tools/ui; live incident 2026-07-10: the editor's claimed Cmd+A —
    // preventDefault only — bubbled on to the group board pane's window listener, which selected
    // every board card and docked its tools rail over the neighbouring pane). Stand down when
    // another surface already claimed the key; claim = preventDefault + stopPropagation (this
    // listener runs in the WINDOW CAPTURE phase, so a stopped event never reaches any other
    // surface's bubble listener) — while unclaimed keys flow through completely untouched.
    if (keyboardEventClaimed(event)) return;
    const claimKey = () => claimKeyboardEvent(event);
    const target = event.target as Element | null;
    const inViewport = !!(viewportRef.current && target && viewportRef.current.contains(target));
    const inComposer = !!(target && target.closest && target.closest('.ca-composer-input'));
    const sessionActive = (selectionScopeRef.current?.level ?? 0) > 0 || selectedNodeIds.size > 0;
    const ownsEditorKeys = (inViewport || sessionActive || target === document.body) && !inComposer;
    if (ownsEditorKeys && event.altKey && event.shiftKey && (event.key === 'd' || event.key === 'D' || event.key === 'Δ')) {
      claimKey();
      dumpCursorDiagnostics();
      return;
    }
    if (ownsEditorKeys && (event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'a' || event.key === 'A') && !activePicker && !activeMenu) {
      // Only claim body-targeted Cmd+A when OUR escalation session is live — a bare body target
      // with no session belongs to whatever surface the user is actually in.
      if (!inViewport && !sessionActive) return;
      if (escalateSelectAll()) claimKey();
      return;
    }
    if (activePicker) {
      if (pickerOptions.length === 0) {
        if (event.key === 'Escape') { claimKey(); setActivePicker(null); }
        return;
      }
      if (event.key === 'ArrowDown') {
        claimKey();
        setPickerIndex((index) => nextMenuIndex(index, 1, pickerOptions.length));
      } else if (event.key === 'ArrowUp') {
        claimKey();
        setPickerIndex((index) => nextMenuIndex(index, -1, pickerOptions.length));
      } else if (event.key === 'Enter') {
        claimKey();
        const chosen = pickerOptions[((pickerIndex % pickerOptions.length) + pickerOptions.length) % pickerOptions.length];
        if (chosen) insertReferenceToken(activePicker.nodeId, chosen);
      } else if (event.key === 'Escape') {
        claimKey();
        setActivePicker(null);
      }
      return;
    }
    if (!activeMenu || menuRowCount === 0) return;
    if (event.key === 'ArrowDown') {
      claimKey();
      setMenuIndex((index) => nextMenuIndex(index, 1, menuRowCount));
    } else if (event.key === 'ArrowUp') {
      claimKey();
      setMenuIndex((index) => nextMenuIndex(index, -1, menuRowCount));
    } else if (event.key === 'Enter') {
      claimKey();
      if (menuActiveIndex < matchingMaterials.length) {
        applyMaterial(matchingMaterials[menuActiveIndex]);
      } else {
        chooseAffordance(matchingAffordances[menuActiveIndex - matchingMaterials.length]);
      }
    }
  };

  return (
    <>
    {surfaceIntentReader && <AddressedSurfaceIntentReader {...surfaceIntentReader} allowList={[]} permit={(payload) => surfaceIntentMatchesCatalogPayload(payload, surfaceIntentCatalog)} emit={placeReceiptSurface} />}
    {surfaceIntentDestinationRef && <AddressedSurfaceIntentRecipient destinationRef={surfaceIntentDestinationRef} allowList={[]} permit={(payload) => surfaceIntentMatchesCatalogPayload(payload, surfaceIntentCatalog)} emit={placeReceiptSurface} />}
    <div ref={surfaceRootRef} className="ca-root" data-dragging={dragNodeId ? 'true' : undefined}>
      <style>{DOCUMENTS_SURFACE_CSS}</style>
      {dragGhost ? (
        // The lifted block, following the cursor (viewport-fixed, so it floats above the camera
        // transform). pointer-events:none so it never blocks the drop hit-test underneath.
        <div className="ca-drag-ghost" aria-hidden="true" style={{ left: dragGhost.x + 12, top: dragGhost.y + 10 }}>
          {dragGhost.label}
        </div>
      ) : null}
      {/* The OWNED sidebar, driven by a projection of the same page rows. Row
          anatomy, hover reveal, the actions menu, docking, floating, resizing,
          hiding and the mobile modal all belong to `packages/sidebar` now, so
          Documents ships zero rail markup and zero rail CSS. Everything the old
          rail did still works, and moving or floating the rail is new. */}
      {loadState !== 'revision-warning' && <AppSidebar
        instanceId={`documents:${persistentSidebarId ?? localSidebarId}:pages`}
        persistPlacement={Boolean(persistentSidebarId)}
        containerRef={surfaceRootRef}
        capabilities={sidebarCapabilities}
        scope={DOCUMENTS_PAGE_SIDEBAR_SCOPE}
        presentation="embedded"
        surfaceCollectionsGraph={pagesSidebar.graph}
        sections={documentLibrarySections}
        catalogItems={pagesSidebar.catalogItems}
        currentSelectionId={sidebarPages.find(page => page.id === framedPage?.id)?.headings.some(heading => heading.id === focusedNodeId)
          ? focusedNodeId! : framedPage?.id ?? ''}
        onNavigate={(id) => {
          const indexed = indexedDocuments.find(entry => `indexed-document:${entry.doc_id}` === id);
          if (indexed) {
            const accepted = emitPlaceableSurfaceIntent({
              title:indexed.title,packageEntry:{packageName:'documents',entryName:'documents'},
              surfaceInput:{scene_address:indexed.doc_address,scene_address_mode:indexed.doc_address_mode ?? 'identity_text',expected_document_revision:indexed.document_revision_hash},
            });
            if (!accepted) showError('Could not open this document. Try again.');
            return;
          }
          if (id === 'documents:new-page') createPage();
          else if (id === 'documents:import-page') {
            const page = snapshotRef.current.tree?.children?.find(node => node.id === framedPage?.id);
            setImportReplacement(page ? JSON.parse(JSON.stringify(page)) : null);
            setImportPageOpen(true);
          }
          else if (id === 'documents:all-pages') frameWorkspaceOverview();
          else {
            const referencePage = sidebarPages.find(page => page.referencesToCheck.some(reference => reference.id === id));
            const reference = referencePage?.referencesToCheck.find(reference => reference.id === id);
            if (referencePage && reference) {
              if (framedPage?.id !== referencePage.id) frameNode(referencePage.id);
              setFocusedNodeId(reference.blockId);
              setSelectedNodeIds(new Set([reference.blockId]));
              return;
            }
            const page = sidebarPages.find(page => page.headings.some(heading => heading.id === id) || page.selectedBlock?.id === id);
            if (page) {
              if (framedPage?.id !== page.id) frameNode(page.id);
              setFocusedNodeId(id);
              setSelectedNodeIds(new Set([id]));
            } else frameNode(id);
          }
        }}
        showCollectionManager={false}
        searchValue={pagesSearch}
        onSearchChange={setPagesSearch}
        searchPlaceholder="Search pages..."
        searchAriaLabel="Search pages"
        headerItems={DOCUMENTS_SIDEBAR_ACTIONS.filter((item) => railNodes.length > 0 || item.id === 'documents:new-page' || item.id === 'documents:import-page')}
        emptyContent={<Text variant="body" color="muted">{pagesNeedle && (railNodes.length > 0 || indexedDocuments.length > 0)
          ? indexedDocuments.length > 0 ? 'No matching pages or documents' : 'No matching pages'
          : 'No pages yet'}</Text>}
        onItemAction={(item, actionId) => onPageAction(item.viewId ?? item.id, actionId)}
      />}
      <div className="ca-main">
        {/* VISIBLE page toolbar (L083): the discoverable home for Insert + custom
            actions. Before this the editor had NO visible control — every insert
            and every action was hidden behind hovering a block's grip or typing
            "/", so the surface read as a dead blank page. Each custom action is a
            record-backed row (zero source per action); "New action" opens the
            shared authoring editor. Only shown once a page exists. */}
        {railNodes.length > 0 && loadState === 'ready' ? (
          <div className="ca-toolbar" role="toolbar" aria-label="Page tools">
            <Button variant="secondary" size="sm" onClick={insertBlockOnFramedPage} aria-label="Insert a block" data-reach-action="add-element">
              <Icon icon={Plus} size="sm" /> Insert
            </Button>
            {/* The user's OWN actions stay pinned inline with a hover × to remove
                (the reveal-on-hover row-action idiom). The shared action LIBRARY
                (content + package actions) collapses into ONE "Actions" menu so a
                large, growing library never floods the toolbar (L118) — the same
                actions are also reachable by typing "/". Both are pure DATA rows;
                zero source per action. */}
            {affordanceRows
              .filter((row) => row.id.startsWith('affordance:action-affordance:user:'))
              .map((row) => (
                <HoverRevealGroup key={row.id} layout="horizontal" gap="none" alignItems="center">
                  <Button variant="secondary" size="sm" onClick={() => chooseAffordance(row)}>
                    <Icon icon={Sparkles} size="sm" /> {row.label}
                  </Button>
                  {isRemovableAffordance(row) ? (
                    <HoverRevealItem>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${row.label}`}
                        onClick={() => removeAffordance(row)}
                        className="h-6 w-6 min-w-0 text-[var(--text-ghost)]"
                      >
                        <Icon icon={X} size="xs" />
                      </Button>
                    </HoverRevealItem>
                  ) : null}
                </HoverRevealGroup>
              ))}
            {(() => {
              const library = affordanceRows.filter(
                (row) => !row.id.startsWith('affordance:action-affordance:user:'),
              );
              if (library.length === 0) return null;
              return (
                <Dropdown
                  items={library.map((row) => ({
                    value: row.id,
                    label: row.label,
                    icon: 'Sparkles',
                    section: (row.affordance.section as string | undefined) ?? 'Actions',
                  }))}
                  value=""
                  onValueChange={(id: string) => {
                    const row = library.find((r) => r.id === id);
                    if (row) chooseAffordance(row);
                  }}
                  align="start"
                  scrollable="60vh"
                  aria-label="Actions"
                  customTrigger={(
                    <Button variant="secondary" size="sm" aria-label="Actions">
                      <Icon icon={Sparkles} size="sm" /> Actions
                    </Button>
                  )}
                />
              );
            })()}
            {partitionLabel ? (
              <Button variant="secondary" size="sm" onClick={openActionEditor} aria-label="Create a new action">
                <Icon icon={Sparkles} size="sm" /> New action
              </Button>
            ) : null}
          </div>
        ) : null}
        {loadState === 'revision-warning' ? (
          <Container layout="vertical" padding="lg" gap="md">
            <Text role="alert">This document has changed since its library entry was saved.</Text>
            <Text>Open the current document to review it before editing.</Text>
            <Button onClick={() => {
              acknowledgedRevision.current = revisionWarning;
              setReloadToken(token => token + 1);
            }}>Open current document</Button>
          </Container>
        ) : loadState === 'loading' && (!snapshot.tree || expectedDocumentRevision) ? (
          <Container layout="vertical" alignItems="center" justifyContent="center" padding="lg" gap="md">
            <Spinner />
            <Text variant="body-xs" color="faint">Loading pages...</Text>
          </Container>
        ) : loadState === 'error' ? (
          <Container layout="vertical" padding="lg">
            <SafeErrorCard
              title="Pages could not load"
              message={loadErrorText}
              onRetry={() => setReloadToken((token) => token + 1)}
            />
          </Container>
        ) : railNodes.length === 0 ? (
          <Container layout="vertical" alignItems="center" justifyContent="center" padding="lg" gap="md">
            <EmptyPlaceholder icon={FileText} message="No pages yet. Create a page to start writing." />
            <Button variant="primary" size="sm" onClick={createPage}>New page</Button>
          </Container>
        ) : (
          <div
            ref={attachViewport}
            className={framedPageIsCanvas ? 'ca-stage ca-stage-canvas' : 'ca-stage'}
            aria-label="Page content"
            data-reach-role="canvas"
            // Programmatically focusable (NOT tabbable): escalateSelectAll moves focus here after
            // leaving the editable — in the native WKWebView a bare blur() drops the page's key
            // first-responder and the NEXT physical keydown never reaches the DOM (killed Cmd+A
            // press 2). A div without an explicit tabIndex silently ignores .focus().
            tabIndex={-1}
            // Canvas mode only: paint the dot grid in the SAME camera convention the
            // content plane uses (engine: screen = world*zoom + pan). backgroundPosition
            // = +pan and backgroundSize = base*zoom, so the grid pans AND scales in
            // lockstep with the `translate(pan) scale(zoom)` plane below — one rigid
            // infinite world plane. Flow mode renders no grid (transparent), no style.
            style={framedPageIsCanvas ? { backgroundPosition: canvasGridPosition(snapshot.camera), backgroundSize: canvasGridSize(snapshot.camera) } : undefined}
            onPointerDown={(event) => {
              // A node pointerdown falls through to the node's own select/grip/reposition handlers.
              if ((event.target as Element).closest('[data-node-id]')) return;
              // Canvas mode: background drag = free-pan (Codex Q7). Flow mode: background drag =
              // MARQUEE select (N4) — draw a box that selects the blocks it overlaps.
              if (framedPageIsCanvas) { beginCanvasPan(event); return; }
              beginMarquee(event);
            }}
          >
            {marqueeBox ? (
              // The live drag-select box (N4). Positioned in viewport (fixed) coords — the same
              // client coords the drag reports and candidatesInRect scores against — so the box the
              // user sees IS the box that selects. Pointer-transparent so the drag keeps flowing.
              <div
                className="ca-marquee"
                style={{
                  position: 'fixed',
                  left: Math.min(marqueeBox.x0, marqueeBox.x1),
                  top: Math.min(marqueeBox.y0, marqueeBox.y1),
                  width: Math.abs(marqueeBox.x1 - marqueeBox.x0),
                  height: Math.abs(marqueeBox.y1 - marqueeBox.y0),
                  border: '1px solid var(--accent-blue, #4f8cff)',
                  background: 'color-mix(in srgb, var(--accent-blue, #4f8cff) 12%, transparent)',
                  borderRadius: 3,
                  pointerEvents: 'none',
                  zIndex: 40,
                }}
              />
            ) : null}
            {/* The content plane: the single engine-coordinate origin. In FLOW mode it is
                inset from the stage's left by a host GUTTER (--ca-gutter) so the per-block
                grip renders in that gutter for EVERY node type (B-44c, generic — no per-kind
                branch), and the engine viewport is the plane's width so flow content never
                overflows into the gutter (Codex-converged). In CANVAS mode the gutter is 0
                (identity wrapper). `attachStage` lives here so stageRef == the plane: every
                pointer→engine conversion (flow drag hit-test) and the viewport measure read
                this one origin, which also fixes a latent scroll offset (Codex A).

                CANVAS CAMERA (B-45, Codex-converged 2026-06-23): the engine stores the
                camera and ONLY culls visibility — it never projects frames (mod.rs:2240).
                So the host applies the camera as a VIEW TRANSFORM right here, on the single
                coordinate origin: `translate(pan) scale(zoom)` in the engine convention
                (screen = world*zoom + pan). One transform on one element pans AND zooms
                every frame, edge, grip, and popover together (they all live in this plane),
                and it is the exact inverse of the pointer→world `/zoom` math below — so the
                cursor stays pinned. transform-origin 0 0 = the world origin. This both fixes
                the latent free-pan gap (frames now move with the grid) and enables pinch-zoom.
                Flow mode = no transform (identity) so authored documents are never scaled. */}
            <div
              className={framedPageIsCanvas ? 'ca-content-plane ca-content-plane-canvas' : 'ca-content-plane'}
              ref={attachStage}
              data-reach-action="edit-element"
              style={framedPageIsCanvas ? {
                transform: `translate(${snapshot.camera?.pan_x ?? 0}px, ${snapshot.camera?.pan_y ?? 0}px) scale(${snapshot.camera?.zoom ?? 1})`,
                transformOrigin: '0 0',
                visibility: visualLayoutSettled ? 'visible' : 'hidden',
              } : { visibility: visualLayoutSettled ? 'visible' : 'hidden' }}
            >
            {framedPage ? (
              <SceneNodeView
                node={framedPage}
                snapshot={snapshot}
                focusedNodeId={focusedNodeId}
                selectedNodeId={selectedNodeId}
                selectedNodeIds={selectedNodeIds}
                onSelect={(nodeId) => {
                  if (connectFromId && nodeId) {
                    completeConnection(nodeId);
                    return;
                  }
                  setSelectedNodeId(nodeId);
                  // Clicking a block seeds the Cmd+A ladder at that block (level 1) so the next
                  // Cmd+A escalates to its container; clearing selection resets the ladder.
                  selectionScopeRef.current = nodeId ? { anchorId: nodeId, level: 1 } : null;
                }}
                onTextChange={applyTextChange}
                onAutoformat={applyAutoformat}
                matchShortcut={matchShortcut}
                dispatchShortcut={tryDispatchShortcut}
                openComposer={openComposer}
                getCursorCommands={() => cursorCommandsRef.current}
                getInlineMarks={getInlineMarks}
                onTextFocus={(nodeId) => {
                  setFocusedNodeId(nodeId);
                  // Re-anchor the Cmd+A ladder to the block being edited (starts at content level).
                  selectionScopeRef.current = { anchorId: nodeId, level: 0 };
                  textSelectAllRequestedRef.current = false;
                }}
                onEscape={() => {
                  setActiveMenu(null);
                  setSelectedNodeId(null);
                  selectionScopeRef.current = null; // reset the Cmd+A ladder
                  // Escape exits text editing: drop the focused node so the contextual
                  // format bar hides (Notion/Craft idiom — the toolbar belongs to an
                  // actively edited block, not a defocused one).
                  setFocusedNodeId(null);
                }}
                rootId={framedPage.id}
                editorPlaceholder={editorPlaceholder}
                onMeasureTextHeight={reportTextHeight}
                revealTextNodeIds={revealTextNodeIds}
                streamingTextNodeId={streamingRun?.nodeId ?? null}
                streamingText={liveOutput.text}
                onInsertBeside={insertBeside}
                getInputShortcutRules={() => inputShortcutsFullRef.current}
                onMergeBackward={mergeBlockBackward}
                onCreateComponent={createComponent}
                onAddBlockBelow={addBlockBelow}
                onRemoveBlock={removeBlock}
                onBeginDrag={beginDrag}
                dragNodeId={dragNodeId}
                onStartConnect={setConnectFromId}
                onNoteAction={partitionLabel ? openNoteAction : undefined}
                noteActions={projectionActions}
                onResizeFrame={commitFrame}
                onSplitDragStart={beginSplitDrag}
                onSplitDrag={commitSplitDrag}
                onEditVisibility={openConditionEditor}
                onEditSpacing={openSpacingEditor}
                onFloatNode={floatNode}
                onCollapsePanel={collapsePanel}
                onExpandPanel={expandPanel}
                onInsertTableRow={insertTableRow}
                onRemoveTableRow={removeTableRow}
                onInsertTableColumn={insertTableColumn}
                onRemoveTableColumn={removeTableColumn}
              />
            ) : null}
            {snapshot.visible_edge_routes.length > 0 ? (
              // WORLD-LAYER wrapper: EdgeLayer draws engine WORLD coords, but the plane's DOM is
              // LOCALIZED against the framed page — one translate(−pageOrigin) crosses the seam
              // for every route/label at once (the L063 one-seam fix, not per-point math).
              <div style={{ position: 'absolute', left: -pageOrigin.x, top: -pageOrigin.y, pointerEvents: 'none' }}>
                <EdgeLayer
                  routes={snapshot.visible_edge_routes}
                  edges={authoredEdges.current}
                  kinds={connectionKinds}
                  onCycleKind={cycleEdgeKind}
                />
              </div>
            ) : null}
            {dropTarget ? (
              // Same world-layer seam as EdgeLayer: DropIndicator positions from world frames.
              <div style={{ position: 'absolute', left: -pageOrigin.x, top: -pageOrigin.y, pointerEvents: 'none' }}>
                <DropIndicator snapshot={snapshot} target={dropTarget} />
              </div>
            ) : null}
            {activeMenu ? (
              // The / menu floats via the shared AnchoredOverlay (portal-to-body, fixed coords
              // from the LIVE anchor element's DOM rect) — block-scoped it anchors below the
              // block, composer-scoped below the composer panel. DOM-rect anchoring is the
              // category fix for "menu opened at world coords on a localized plane".
              <AnchoredOverlay open anchorRef={menuAnchorRef} placement="below" gap={8} measureKey={snapshot} surface={false}>
                <MaterialMenu
                  query={activeMenu.query}
                materials={matchingMaterials}
                affordances={matchingAffordances}
                activeIndex={menuActiveIndex}
                onSelect={applyMaterial}
                onRunAffordance={chooseAffordance}
                onConfigureAffordance={configureAffordance}
                onNewAction={partitionLabel ? openActionEditor : undefined}
                  onClose={() => setActiveMenu(null)}
                  closeKeyLabel={MENU_DISMISS_KEY_LABEL}
                />
              </AnchoredOverlay>
            ) : null}
            {activeComposer?.phase === 'working' ? (
              // WORKING phase (Notion): the SAME anchored panel where the prompt was typed now
              // shows the run happening — spinner + a quiet label + Stop — right where the
              // writing will land. No status toast anywhere else; the produced blocks appearing
              // is the completion feedback. Escape = Stop (abandon placement, back to writing).
              //
              // CHROME ONLY — never the answer body (2026-07-20 self-overlap fix). The growing
              // answer text is rendered by the invoking block itself (see the `streamingTextNodeId`/
              // `streamingText` props threaded into SceneNodeView below), through the SAME
              // measure + mark-render path every other block uses — ONE layout authority. This
              // panel used to ALSO paint the streaming text on top of that same block (a portaled,
              // position-anchored overlay whose own size only re-measures on `snapshot` changes,
              // which streaming tokens never trigger) — two owners drawing the same growing text
              // is exactly what produced the reported self-overlap ("looks like double vision"
              // until a window resize forced the overlay to re-measure and self-correct).
              <AnchoredOverlay open anchorRef={composerAnchorRef} placement="over" measureKey={snapshot} matchAnchorWidth>
                <div
                  ref={composerBoxRef}
                  className="ca-composer"
                  role="status"
                  aria-label="Writing"
                  onKeyDownCapture={(e) => { if (e.key === 'Escape') { e.preventDefault(); stopComposerRun(); } }}
                >
                  <Spinner size="sm" />
                  <Text variant="body-sm" color="dim" className="flex-1 truncate">
                    {activeComposer.prompt ? `Writing: ${activeComposer.prompt}` : 'Writing…'}
                  </Text>
                  <Button variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={stopComposerRun}>
                    Stop
                  </Button>
                </div>
              </AnchoredOverlay>
            ) : null}
            {activeComposer?.phase === 'failed' ? (
              // FAILED phase: the run errored / timed out / produced nothing — the SAME panel says
              // so where the writing was going to land and offers Try again (re-runs the retained
              // prompt) or Escape to dismiss. The panel never silently vanishes on failure (the
              // silent-vanish incident: a timed-out ask closed with nothing placed, zero feedback).
              <AnchoredOverlay open anchorRef={composerAnchorRef} placement="over" measureKey={snapshot} matchAnchorWidth>
                <div
                  ref={composerBoxRef}
                  className="ca-composer"
                  role="alert"
                  aria-label="AI run failed"
                  onKeyDownCapture={(e) => { if (e.key === 'Escape') { e.preventDefault(); stopComposerRun(); } }}
                >
                  <Text variant="body-sm" color="dim" className="flex-1">{activeComposer.failure ?? "That didn't finish."}</Text>
                  {activeComposer.prompt ? (
                    <Button
                      variant="primary"
                      size="sm"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runComposerPrompt(activeComposer.nodeId, activeComposer.prompt ?? '')}
                    >
                      Try again
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={stopComposerRun}>
                    Dismiss
                  </Button>
                </div>
              </AnchoredOverlay>
            ) : null}
            {activeComposer?.phase === 'input' ? (
              // The Ask-AI composer floats OVER the block that invoked it (Notion "press space for
              // AI" replaces the block in place) via the shared AnchoredOverlay placement="over" —
              // anchored to the block's LIVE DOM rect (portal + fixed coords), never to raw world
              // frames, and surfaced by the shared primitive (no package-local popover chrome).
              <AnchoredOverlay open anchorRef={composerAnchorRef} placement="over" measureKey={snapshot} matchAnchorWidth>
                <div ref={composerBoxRef} className="ca-composer" role="dialog" aria-label={composerCopy.label}>
                <ComposerEditable
                  value={composerText}
                  marks={inlineMarks ?? EMPTY_INLINE_MARKS}
                  label={composerCopy.label}
                  placeholder={composerCopy.placeholder}
                  overlayOpen={
                    (activePicker?.for === 'composer') ||
                    (activeMenu != null && activeMenu.nodeId === activeComposer.nodeId)
                  }
                  onInput={(value, caretOffset) => {
                    setComposerText(value);
                    // The composer is a FULL input-shortcut surface (Notion parity): it runs the SAME
                    // DATA registry AND the SAME matcher call as a block — never a hardcoded "@" (L090 /
                    // enum-dissolution). Passing (value, caretOffset) lets the matcher's `at:"caret-token"`
                    // scope key on the run ENDING at the caret ("write about @ada| please" → "@ada", not
                    // the trailing "please") and hand back the exact splice `range` — so the composer no
                    // longer re-implements activeTokenAt + range math (ONE machinery, C3). renderer:"picker"
                    // (@ + any future picker) lands a chip in the prompt; renderer:"menu" (/) opens the
                    // command menu. A new trigger — or a new scope — is ONE DATA row, zero code here.
                    const open = matchInputShortcut(value, 'inline', inputShortcutsFullRef.current, caretOffset);
                    if (open && open.renderer === 'picker') {
                      setActivePicker({ nodeId: activeComposer.nodeId, query: open.query, for: 'composer', range: open.range });
                      setActiveMenu(null);
                    } else if (open && open.renderer === 'menu') {
                      setActiveMenu({ nodeId: activeComposer.nodeId, query: open.query.trim().toLowerCase() });
                      setActivePicker(null);
                    } else {
                      if (activePicker?.for === 'composer') setActivePicker(null);
                      if (activeMenu != null && activeMenu.nodeId === activeComposer.nodeId) setActiveMenu(null);
                    }
                  }}
                  onSubmit={submitComposer}
                  onDismiss={() => {
                    // Dismiss the empty composer (Backspace on empty OR Escape) and RETURN focus+caret to
                    // the block. Clearing state unmounts the composer, but the block's focus effect keys on
                    // `focused` (unchanged here), so it will NOT re-run — focus would be orphaned on the
                    // unmounting composer and the next keystroke would go nowhere (Codex C2 defect). So we
                    // imperatively re-focus the block after the unmount flush (rAF), placing the caret at end.
                    const returnTo = activeComposer.nodeId;
                    setActiveComposer(null);
                    setComposerText('');
                    setActiveMenu(null);
                    setActivePicker(null);
                    requestAnimationFrame(() => {
                      const el = scopedNodeQuery(`.ca-text-node[data-node-id="${returnTo}"]`);
                      if (el) { el.focus(); placeCaretAtEnd(el); }
                    });
                  }}
                />
                <Button variant="primary" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={submitComposer}>
                  {composerCopy.label}
                </Button>
                {composerConfigViewData ? (
                  // Disclosure chevron (L115): the default row stays minimal; the full
                  // configurability opens behind this. Chevron only exists when the row
                  // ships a config bag (DATA opt-in).
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${composerConfigViewData.title} options`}
                    aria-expanded={composerConfigOpen}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setComposerConfigOpen((open) => !open)}
                  >
                    <Icon icon={ChevronDown} size="sm" />
                  </Button>
                ) : null}
                </div>
              </AnchoredOverlay>
            ) : null}
            {activeComposer?.phase === 'input' && composerConfigOpen && composerConfigViewData ? (
              // The config DISCLOSURE panel — same shared AnchoredOverlay + the same menu
              // list idiom as / and @ (one popover anatomy everywhere). Every row is a
              // DATA option in HUMAN language (label + description + what it runs on — all
              // resolved from records; machine-id-only rows never render, L114/L118); the
              // checkmark is the honestly-read current choice. Below the options: the
              // writing-instructions preamble that rides along with every ask — visible,
              // and editable in place (saves to the LIVE registry record, no redeploy).
              <AnchoredOverlay open anchorRef={composerAnchorRef} placement="below" gap={8} measureKey={snapshot} surface={false} onDismiss={() => setComposerConfigOpen(false)}>
                <div className="ca-menu ca-config" role="listbox" aria-label={composerConfigViewData.title}>
                  <div className="ca-menu-scroll">
                    <div className="ca-menu-group">
                      <div className="ca-menu-section">{composerConfigViewData.title}</div>
                      {composerConfigViewData.defaultOption ? (
                        <button
                          type="button"
                          className={!composerConfigCurrent ? 'ca-menu-row ca-menu-row-active' : 'ca-menu-row'}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => void chooseComposerConfigOption(composerConfigViewData.defaultOption!)}
                        >
                          <span className="ca-menu-label">{composerConfigViewData.defaultOption.label}</span>
                          {!composerConfigCurrent ? <span aria-hidden>✓</span> : null}
                        </button>
                      ) : null}
                      {composerConfigViewData.options.length === 0 && !composerConfigViewData.defaultOption ? (
                        <div className="ca-menu-empty">Nothing to choose yet</div>
                      ) : null}
                      {composerConfigViewData.options.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={composerConfigCurrent === option.value ? 'ca-menu-row ca-menu-row-active' : 'ca-menu-row'}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => void chooseComposerConfigOption(option)}
                        >
                          <span className="ca-config-option">
                            <span className="ca-config-option-head">
                              <span className="ca-menu-label">{option.label}</span>
                              {option.annotation ? <span className="ca-config-annotation">{option.annotation}</span> : null}
                            </span>
                            {option.description ? <span className="ca-config-description">{option.description}</span> : null}
                          </span>
                          {composerConfigCurrent === option.value ? <span aria-hidden>✓</span> : null}
                        </button>
                      ))}
                    </div>
                    {/* PER-ASK groups (select-less config bags — e.g. Model): the SAME row
                        anatomy; choosing writes ONLY this session's config_selection bag,
                        never a global record. The marked row = the explicit local pick,
                        else the default_from-derived value (the agent's own model), else
                        the group's default row. A new group = one DATA key (L090). */}
                    {composerConfigGroupsData.filter((g) => g.key && !g.hasSelect).map((group) => {
                      const selected = composerLocalSelections[group.key] ?? '';
                      const derived = composerGroupDefaults[group.key] ?? '';
                      const markedValue = selected !== '' ? selected : derived;
                      return (
                        <div className="ca-menu-group" key={group.key}>
                          <div className="ca-menu-section">{group.view.title}</div>
                          {group.view.defaultOption ? (
                            <button
                              type="button"
                              className={selected === '' ? 'ca-menu-row ca-menu-row-active' : 'ca-menu-row'}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => chooseComposerLocalOption(group.key, '')}
                            >
                              <span className="ca-config-option">
                                <span className="ca-config-option-head">
                                  <span className="ca-menu-label">{group.view.defaultOption.label}</span>
                                  {derived ? (
                                    <span className="ca-config-annotation">
                                      {group.view.options.find((o) => o.value === derived)?.label ?? derived}
                                    </span>
                                  ) : null}
                                </span>
                              </span>
                              {selected === '' ? <span aria-hidden>✓</span> : null}
                            </button>
                          ) : null}
                          {group.view.options.length === 0 && !group.view.defaultOption ? (
                            <div className="ca-menu-empty">Nothing to choose yet</div>
                          ) : null}
                          {group.view.options.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className={selected !== '' && markedValue === option.value ? 'ca-menu-row ca-menu-row-active' : 'ca-menu-row'}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => chooseComposerLocalOption(group.key, option.value)}
                            >
                              <span className="ca-config-option">
                                <span className="ca-config-option-head">
                                  <span className="ca-menu-label">{option.label}</span>
                                  {option.annotation ? <span className="ca-config-annotation">{option.annotation}</span> : null}
                                </span>
                                {option.description ? <span className="ca-config-description">{option.description}</span> : null}
                              </span>
                              {selected !== '' && markedValue === option.value ? <span aria-hidden>✓</span> : null}
                            </button>
                          ))}
                        </div>
                      );
                    })}
                    {composerConfigViewData.preamble !== null || composerPreambleDraft !== null ? (
                      <div className="ca-menu-group">
                        <div className="ca-menu-section">Writing instructions</div>
                        {composerPreambleDraft === null ? (
                          <button
                            type="button"
                            className="ca-menu-row"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setComposerPreambleDraft(composerConfigViewData.preamble ?? '')}
                          >
                            <span className="ca-config-preamble">{composerConfigViewData.preamble}</span>
                            <span className="ca-config-annotation">Edit</span>
                          </button>
                        ) : (
                          <div className="ca-config-preamble-edit">
                            <Textarea
                              value={composerPreambleDraft}
                              autoFocus
                              rows={4}
                              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setComposerPreambleDraft(e.target.value)}
                            />
                            <div className="ca-config-preamble-actions">
                              <Button variant="primary" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => void saveComposerPreamble()}>
                                Save
                              </Button>
                              <Button variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => setComposerPreambleDraft(null)}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
              </AnchoredOverlay>
            ) : null}
            {activePicker ? (
              // The @ picker floats via the same shared AnchoredOverlay — below the block
              // (block scope) or below the composer panel (composer scope). Same DOM-rect
              // anchoring category fix as the / menu.
              <AnchoredOverlay open anchorRef={pickerAnchorRef} placement="below" gap={8} measureKey={snapshot} surface={false}>
              <div className="ca-menu ca-picker" role="listbox" aria-label="Insert reference">
                <div className="ca-menu-scroll">
                  {pickerOptions.length === 0 ? (
                    <div className="ca-menu-empty">No matches</div>
                  ) : (() => {
                    // Group by the option's DATA `group` label (Tasks / Skills / …); the renderer
                    // never names a group — it shows whatever the option_sources DATA carries.
                    const groups: { name: string; rows: { opt: typeof pickerOptions[number]; flat: number }[] }[] = [];
                    pickerOptions.forEach((opt, flat) => {
                      let bucket = groups.find((g) => g.name === opt.group);
                      if (!bucket) { bucket = { name: opt.group, rows: [] }; groups.push(bucket); }
                      bucket.rows.push({ opt, flat });
                    });
                    const active = ((pickerIndex % pickerOptions.length) + pickerOptions.length) % pickerOptions.length;
                    return groups.map((group) => (
                      <div className="ca-menu-group" key={group.name}>
                        <div className="ca-menu-section">{group.name}</div>
                        {group.rows.map(({ opt, flat }) => (
                          <button
                            key={`${opt.kind}:${opt.value}`}
                            type="button"
                            role="option"
                            aria-selected={flat === active}
                            className={flat === active ? 'ca-menu-row ca-menu-row-active' : 'ca-menu-row'}
                            onMouseDown={(event) => { event.preventDefault(); insertReferenceToken(activePicker.nodeId, opt); }}
                          >
                            <span className="ca-menu-ico" aria-hidden="true">{opt.icon || '@'}</span>
                            <span className="ca-menu-label">{opt.label}</span>
                          </button>
                        ))}
                      </div>
                    ));
                  })()}
                </div>
              </div>
              </AnchoredOverlay>
            ) : null}
            {conditionNodeId ? (
              // Same shared AnchoredOverlay anatomy as the / menu (live DOM rect, portal,
              // fixed coords) — the world-frame anchoring painted the editor over other
              // pages'/off-screen pixels (the image #71/#74 "click did nothing" incident).
              <AnchoredOverlay open anchorRef={conditionAnchorRef} placement="below" gap={8} measureKey={snapshot} surface={false} onDismiss={() => setConditionNodeId(null)}>
                <ConditionEditor
                  draft={conditionDraft}
                  operators={VISIBILITY_OPERATORS}
                  onChange={setConditionDraft}
                  onApply={applyCondition}
                  onClear={clearCondition}
                  onClose={() => setConditionNodeId(null)}
                />
              </AnchoredOverlay>
            ) : null}
            {(() => {
              // Spacing popover: padding (4 sides) + the flow gap, anchored under the node.
              // The fields are DATA (spacingFields), filtered to what applies to THIS node
              // (gap only for a ≥2-child container); each field's CURRENT value is read from
              // the live snapshot style. Edits write engine-honored style numbers.
              if (!spacingNodeId) return null;
              const node = findNodeById(snapshot.tree, spacingNodeId);
              if (!node) return null;
              const style = isRecord(node.props?.style) ? node.props.style : undefined;
              const views: SpacingFieldView[] = spacingFieldsForNode(node, spacingFields).map((field) => ({
                id: field.id,
                label: field.label,
                group: field.group,
                value: readStyleNumber(style, field.path),
                min: field.min,
                max: field.max,
                step: field.step,
              }));
              const fieldById = new Map(spacingFieldsForNode(node, spacingFields).map((field) => [field.id, field]));
              return (
                // Shared AnchoredOverlay (live DOM rect) — same category fix as the / menu;
                // the old world-frame style put the popover on another page's pixels (#71/#74).
                <AnchoredOverlay open anchorRef={spacingAnchorRef} placement="below" gap={8} measureKey={snapshot} surface={false} onDismiss={() => setSpacingNodeId(null)}>
                  <SpacingEditor
                    fields={views}
                    onChange={(id, value) => {
                      const field = fieldById.get(id);
                      if (field) commitSpacingField(field.path, value);
                    }}
                    onChangeGroup={commitSpacingGroup}
                    onClose={() => setSpacingNodeId(null)}
                  />
                </AnchoredOverlay>
              );
            })()}
            {(() => {
              // Contextual format bar: floats above the focused TEXT node ONLY while text is
              // SELECTED (Mobbin: Notion/Craft selection toolbar — never a persistent bar).
              // Hidden while the slash menu / condition / spacing editor is open so only one
              // contextual surface shows at a time (the "-1000 IQ, one thing" rule).
              if (activeMenu || conditionNodeId || spacingNodeId || !focusedNodeId || !hasTextSelection) return null;
              const focusedNode = findNodeById(snapshot.tree, focusedNodeId);
              if (!focusedNode || focusedNode.kind !== 'Text') return null;
              return (
                <FormatBar
                  node={focusedNode}
                  snapshot={snapshot}
                  descriptors={formatDescriptors}
                  onFormat={(descriptor) => commitFormat(focusedNodeId, descriptor)}
                />
              );
            })()}
            </div>
            {/* Canvas HUD + minimap (B-46): screen-fixed chrome OUTSIDE the transformed
                content plane (a sibling, so it never pans/zooms with the world). Canvas
                mode only. The components are blind — they receive a number + map-pixel
                rects and emit callbacks; every camera computation is the pure do-work
                math above, landing through the same commitCamera the wheel/pan use. */}
            {framedPageIsCanvas ? (
              <>
                {minimapOn ? (
                  // stopPropagation: the chrome owns its pointer — without it a press here
                  // would fall through to the stage's background-pan (which pointer-captures
                  // and would swallow the click/jump).
                  <div className="ca-canvas-minimap-slot" onPointerDown={(event) => event.stopPropagation()}>
                    <CanvasMinimap
                      frames={minimapFrames}
                      panX={hudCamera.pan_x}
                      panY={hudCamera.pan_y}
                      zoom={hudZoom}
                      viewportWidth={hudViewport.w}
                      viewportHeight={hudViewport.h}
                      selectedId={selectedNodeId}
                      onJump={handleMinimapJump}
                    />
                  </div>
                ) : null}
                <div className="ca-canvas-hud-slot" onPointerDown={(event) => event.stopPropagation()}>
                  <CanvasHud
                    zoomPercent={Math.round(hudZoom * 100)}
                    onZoomIn={handleZoomIn}
                    onZoomOut={handleZoomOut}
                    onResetZoom={handleResetZoom}
                    onFit={handleFit}
                    minimapOn={minimapOn}
                    onToggleMinimap={() => setMinimapOn((on) => !on)}
                    canZoomIn={hudZoom < CANVAS_ZOOM_LIMITS.max - 1e-3}
                    canZoomOut={hudZoom > CANVAS_ZOOM_LIMITS.min + 1e-3}
                  />
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
      <ActionAffordanceEditor
        open={actionEditorOpen}
        onClose={() => setActionEditorOpen(false)}
        runId={actionEditorRunId}
        definitionOptions={affordanceDefinitionOptions}
        channelOptions={affordanceChannelOptions}
        onSave={saveAuthoredAction}
      />
      {importPageOpen && <DocumentImportDialog onClose={() => setImportPageOpen(false)} onImport={importPage}
        replacementPage={importReplacement} onReplace={replaceImportedPage} />}
      {conflictComparison && conflictComparison.scope === conflictScope && <DocumentConflictComparison
        local={conflictComparison.local} current={conflictComparison.current} onClose={() => setConflictComparison(null)} />}
      <FloatingPanel
        open={affordanceAsk !== null}
        onClose={() => setAffordanceAsk(null)}
        title={affordanceAsk?.row.label ?? ''}
        description={affordanceAsk?.row.trigger.ask?.prompt}
      >
        <Container layout="vertical" gap="md" padding="md">
          <Textarea
            autoFocus
            value={affordanceAskText}
            onChange={(event) => setAffordanceAskText(event.target.value)}
            placeholder={affordanceAsk?.row.trigger.ask?.prompt ?? ''}
            rows={2}
          />
          <Container layout="horizontal" gap="sm" justifyContent="end">
            <Button variant="ghost" size="sm" onClick={() => setAffordanceAsk(null)}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const ask = affordanceAsk;
                const text = affordanceAskText.trim();
                if (!ask || !text) return;
                setAffordanceAsk(null);
                void runAffordanceRow(ask.row, ask.nodeId, text);
              }}
            >
              Run
            </Button>
          </Container>
        </Container>
      </FloatingPanel>
      {affordanceForm ? (
        <ActionForm
          open
          title={affordanceForm.ask.title ?? affordanceForm.row.label}
          fields={affordanceForm.ask.fields ?? []}
          schema={affordanceForm.ask.configuration}
          initialValues={affordanceForm.initialAnswers}
          optionsFor={affordanceFieldOptions}
          submitLabel={affordanceForm.ask.submit_label ?? 'Run'}
          onCancel={() => setAffordanceForm(null)}
          onSubmit={(answers) => {
            const form = affordanceForm;
            setAffordanceForm(null);
            if (form) void runAffordanceRow(form.row, form.nodeId, form.sourceText, answers);
          }}
          onSavePreset={(name, answers) => {
            void saveActionPreset(affordanceForm?.row.affordance.payload, answers, name);
          }}
          onMaterialize={materializeActionFormFile}
        />
      ) : null}
      {actionResultReadback.length > 0 ? (
        <aside aria-label="Action destination status">
          <Text variant="overline">Destination status</Text>
          {actionResultReadback.map((row) => (
            <Container key={row.destinationRef} layout="horizontal" justifyContent="between" gap="sm">
              <Text variant="caption">{row.label}</Text>
              <Text variant="caption" tone="subtle">{row.state}</Text>
            </Container>
          ))}
        </aside>
      ) : null}
      {activeAction ? (
        <ActionForm
          open
          title={activeAction.ask.title}
          fields={projectionAskFields}
          optionsFor={projectionFieldOptions}
          submitLabel={activeAction.ask.submit_label}
          onCancel={() => setNoteAction(null)}
          onSubmit={(answers) => { void submitProjectionAnswers(answers); }}
          onMaterialize={materializeActionFormFile}
        />
      ) : null}
    </div>
    </>
  );
}

// Anchor the condition popover just below a node's engine frame (stage coords,
// zoom = 1); falls back to the top-left when the node is unplaced.
// Anchor an IN-PLANE editor (Condition/Spacing — absolute inside .ca-content-plane) below a node.
// snapshot.frames rects are engine WORLD coords, but the plane's DOM is LOCALIZED against the framed
// page (SceneNodeView renders the framed root at {0,0}), so the world rect must cross the seam:
// plane coords = world − pageOrigin. (The floating popovers — composer, / menu, @ picker — use the
// shared AnchoredOverlay on the block's live DOM rect instead; this helper exists only for chrome
// that intentionally stays inside the plane.)
export type SceneNodeViewProps = {
  node: SceneNode;
  snapshot: CompositionSnapshot;
  focusedNodeId: string | null;
  selectedNodeId: string | null;
  // The full selection set (multi-select from escalating Cmd+A / marquee) — a node is highlighted
  // when its id is in here, so container/page escalation and marquee both light up their members.
  selectedNodeIds: ReadonlySet<string>;
  onSelect: (nodeId: string | null) => void;
  onTextChange: (nodeId: string, value: string, caretOffset?: number) => void;
  onAutoformat: (nodeId: string, match: AutoformatMatch) => string | null;
  // Blind shortcut matcher: the text node asks "does this text match a shortcut for
  // this trigger?" and gets back a match (or null). The RULE TABLE stays in the
  // parent (closes over the live DATA ref) — the child never sees the rules (L098).
  matchShortcut: (before: string, trigger: 'space' | 'enter') => AutoformatMatch | null;
  // Fire a renderer:none dispatch shortcut (!! -> workflow, etc.) on this key; returns true if one
  // matched + fired so the keydown consumes the gesture. The block stays blind to the target.
  dispatchShortcut: (before: string, trigger: 'space' | 'enter', nodeId: string) => boolean;
  openComposer: (nodeId: string, key: string, isEmpty: boolean) => boolean;
  // Blind accessor for the LIVE spatial-nav gesture table (same L098 shape as matchShortcut:
  // the parent owns the DATA ref; children ask per keydown, never hold the table).
  getCursorCommands: () => readonly CursorCommand[];
  // Blind accessor for the LIVE inline-mark table (marker pair → element) — render/serialize
  // compile against the latest rows per call; the child never holds the vocabulary.
  getInlineMarks: () => readonly InlineMark[];
  onTextFocus: (nodeId: string) => void;
  onEscape: () => void;
  rootId: string;
  onInsertBeside: (
    nodeId: string,
    side: 'above' | 'below' | 'left' | 'right',
    startWith?: Record<string, unknown>,
  ) => void;
  getInputShortcutRules: () => readonly InputShortcut[];
  // Merge this block into the geometrically-previous one (Backspace at block start, N2).
  onMergeBackward: (nodeId: string) => boolean;
  onCreateComponent: (nodeId: string) => void;
  onAddBlockBelow: (nodeId: string) => void;
  // Empty-block placeholder copy (threaded to every text node; flows via {...props}).
  editorPlaceholder: string;
  // A text block reports its measured wrapped height so the engine can size it.
  onMeasureTextHeight: (nodeId: string, height: number) => void;
  revealTextNodeIds: ReadonlySet<string>;
  // The node currently receiving a streaming AI run's output, and its live accumulated text
  // (or null when nothing is streaming). ONE node — the invoking block itself — owns the
  // growing answer; everything else is null. Passed straight through to AutoSizeTextNode so
  // it renders the override through the SAME measure + mark-render path as stored text (single
  // layout authority — 2026-07-20 self-overlap fix; see the 'working'-phase AnchoredOverlay,
  // now chrome-only, above).
  streamingTextNodeId: string | null;
  streamingText: string;
  onRemoveBlock: (nodeId: string) => void;
  onBeginDrag: (nodeId: string) => void;
  dragNodeId: string | null;
  onStartConnect: (nodeId: string) => void;
  onNoteAction?: (actionId: string, nodeId: string) => void;
  // The authoring output actions (DATA), rendered as menu items. Each triggers
  // onNoteAction with its id — no output verb is named in this component.
  noteActions?: readonly { readonly id: string; readonly menu_label: string }[];
  onResizeFrame: (nodeId: string, rect: SceneResizeRect, handle: SceneResizeHandleId) => void;
  onSplitDragStart: (nodeId: string) => void;
  onSplitDrag: (nodeId: string, leftIndex: number, rightIndex: number, deltaPx: number) => void;
  onEditVisibility: (nodeId: string) => void;
  onEditSpacing: (nodeId: string) => void;
  onFloatNode: (nodeId: string) => void;
  onCollapsePanel: (nodeId: string) => void;
  onExpandPanel: (nodeId: string) => void;
  tableCtx?: TableCtx;
  // True when this node is a DIRECT child of a split node (a column / cell position).
  // A split sizes its children by fraction (the engine ignores their style.width), so a
  // surface here resizes via the parent's DIVIDER, not its own handles — the Component
  // branch suppresses its resize chrome when this is set.
  parentIsSplit?: boolean;
  // The PARENT node's WORLD frame rect. The engine emits WORLD/absolute frames
  // (layout.rs places every node at its accumulated absolute origin — Codex-converged
  // 2026-06-23), but SceneFrame nests children as `position:absolute`, so a child fed
  // a raw world rect double-offsets by the sum of its ancestors' origins. The render
  // localizes each child against this parent rect (childWorld − parentWorld) so nested
  // abspos composes back to world. Absent ⇒ root (rendered at the zeroed origin).
  parentRect?: { x: number; y: number; w: number; h: number };
  // Whether the PARENT rendered a grip. A leaf at a gripped parent's corner is inline content
  // and suppresses its own (redundant) grip; a row renders no grip, so its cells stay gripped.
  parentHasGrip?: boolean;
  onInsertTableRow: (tableId: string, index: number) => void;
  onRemoveTableRow: (tableId: string, index: number) => void;
  onInsertTableColumn: (tableId: string, index: number) => void;
  onRemoveTableColumn: (tableId: string, index: number) => void;
};

// Table membership flows DOWN the render (no per-node tree walk): a table node tags its
// children role:'row'; a row tags its children role:'cell' with the live indices. This
// drives the grip menu so table cells get table-SAFE row/column actions and table
// rows/cells never expose the generic Add/Delete that would corrupt the shared split
// parts. Structure is semantics — no Society marker (Codex-converged 2026-06-21).
type TableCtx =
  | { role: 'row'; tableId: string; rowIndex: number }
  | { role: 'cell'; tableId: string; rowIndex: number; colIndex: number };

function childTableContext(parent: SceneNode, parentCtx: TableCtx | undefined, index: number): TableCtx | undefined {
  if (isTableNode(parent)) return { role: 'row', tableId: parent.id, rowIndex: index };
  if (parentCtx?.role === 'row') return { role: 'cell', tableId: parentCtx.tableId, rowIndex: parentCtx.rowIndex, colIndex: index };
  return undefined;
}

function capturedWebElement(node: SceneNode): CapturedSceneElementData | null {
  const custom = node.props?.custom;
  return isRecord(custom) && isRecord(custom.web_element)
    ? custom.web_element as CapturedSceneElementData
    : null;
}

function CapturedWebElementSurface({ node, data }: { node: SceneNode; data: CapturedSceneElementData }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const element = createCapturedSceneElement(data, 'div');
    element.dataset.nodeId = node.id;
    if (data.capability) element.dataset.sceneCapability = data.capability.editability;
    applySceneStyleToElement(element, {
      ...(isRecord(data.computed_css) ? data.computed_css : {}),
      ...(isRecord(node.style) ? node.style : {}),
      ...(isRecord(node.props?.style) ? node.props.style : {}),
    });
    element.style.position = 'absolute';
    element.style.inset = '0';
    element.style.width = '100%';
    element.style.height = '100%';
    if (typeof node.props?.text === 'string') element.appendChild(document.createTextNode(node.props.text));
    appendCapturedRasterFallback(element, data.capability ?? null);
    host.replaceChildren(element);
    return () => host.replaceChildren();
  }, [data, node]);
  return <div ref={hostRef} data-captured-web-element-host={node.id} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} />;
}

// A grip lives in the left gutter — the strip just left of its frame (right:calc(100%+2px)).
// That strip is free for a document block (a vertical stack leaves the page margin clear) but
// OCCUPIED whenever another grip already sits there: an ancestor sharing this node's exact
// top-left corner (correct localization places a table cell / first column at the same origin
// as its container — the container's grip is right there), or a left-neighbour whose right
// edge reaches into this strip (a flex panel beside another, a later table column). The lane
// counts how many such frames pile up, and the grip insets that many notches into its OWN
// frame so it never lands on another grip — at ANY nesting depth, across parent boundaries,
// for ANY layout. This is the one place the rule lives: pure frame geometry over the engine
// snapshot, zero layout-mode/Society branching (L069). The page root is excluded (it contains
// every node but its grip is the document gutter itself); a wide container whose corner is
// elsewhere is excluded by construction (its right edge is past this node, its corner is far);
// and this node's OWN descendants are excluded — they sit inside it (a table's first cell is
// at the table's corner) but they never occupy the table's gutter, so they must not push the
// table's grip inward. A corner-sharing ANCESTOR is NOT inside this node (it contains it), so
// it is still counted — exactly the grip the cell must step past.
const GRIP_GUTTER_PX = 44; // width of the gutter strip a grip occupies (the + button + ⋮ menu)
function gripLaneFor(
  nodeId: string,
  me: { x: number; y: number; w: number; h: number } | null | undefined,
  frames: Record<string, { rect?: { x: number; y: number; w: number; h: number } } | undefined>,
  rootId: string,
): number {
  if (!me) return 0;
  // `frames` is the WHOLE snapshot — every page, the document root, every node,
  // rendered or not. Only nodes co-rendered INSIDE the framed page can ever share
  // my gutter, so scope the lane count to the framed root's subtree (rootId's
  // rect). Without this, the framed page's own frame AND the document-root frame
  // (both ANCESTORS that start at my top-left corner when I am a first child)
  // count as corner-sharers → the FIRST block of every page gets lane ≥1 and its
  // grip is shoved INSIDE the frame, on top of its own text ("drag handle above
  // the text"). Ancestors contain me but aren't descendants, so the insideMe
  // guard alone never caught them. Bounding to rootId's rect is the category fix:
  // ancestors (bigger than root) and sibling pages (outside root) are both excluded.
  const root = frames[rootId]?.rect;
  let pile = 0;
  for (const id in frames) {
    if (id === nodeId || id === rootId) continue;
    const r = frames[id]?.rect;
    if (!r) continue;
    if (
      root &&
      !(r.x >= root.x - 4 && r.y >= root.y - 4 &&
        r.x + r.w <= root.x + root.w + 4 && r.y + r.h <= root.y + root.h + 4)
    ) {
      continue; // outside the framed page — not rendered here, never in my gutter
    }
    const insideMe =
      r.x >= me.x - 4 && r.y >= me.y - 4 &&
      r.x + r.w <= me.x + me.w + 4 && r.y + r.h <= me.y + me.h + 4;
    if (insideMe) continue; // a descendant — inside my frame, never in my gutter
    const overlapsMyTopBand = r.y < me.y + 12 && r.y + r.h > me.y;
    if (!overlapsMyTopBand) continue;
    const sharesMyCorner = Math.abs(r.x - me.x) < 8 && Math.abs(r.y - me.y) < 8;
    const isLeftNeighbour = r.x < me.x && r.x + r.w > me.x - GRIP_GUTTER_PX && r.x + r.w <= me.x + 4;
    if (sharesMyCorner || isLeftNeighbour) pile += 1;
  }
  return pile;
}


// Blind renderer of engine snapshot frames. SceneFrame applies the engine's
// rect verbatim (never computes layout); DragHandleMenu is the hover-only
// A collapsed panel's SPINE: a fixed-width rail (the engine frame is SPINE_PX wide
// via {flex:0,width:36}) showing the panel's title vertically + an expand chevron.
// Pure host chrome over a self-describing collapsed node — no Society type, no engine
// knowledge; the chevron commits the expand transaction.
function PanelSpine({ title, onExpand }: { title: string; onExpand: () => void }) {
  return (
    <div className="ca-panel-spine" role="group" aria-label={`Collapsed panel: ${title}`}>
      <button
        type="button"
        className="ca-panel-spine-expand"
        aria-label={`Expand ${title}`}
        title={`Expand ${title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onExpand();
        }}
      >
        <ChevronRight size={14} />
      </button>
      <span className="ca-panel-spine-title" aria-hidden>{title}</span>
    </div>
  );
}

// grip block-actions chrome (TRUE-VISION design bar).
export function SceneNodeView(props: SceneNodeViewProps) {
  const { node, snapshot, focusedNodeId, selectedNodeIds, onSelect, onTextChange, onTextFocus, onEscape, rootId } = props;
  // Same rule as the engine (resolveVisibility = Visibility::as_bool): a literal
  // false OR a binding resolving to its default-false hides the node. The kernel
  // overlays the live-resolved bool in the computed snapshot; this is the host
  // fallback so render + dividers never disagree with the engine.
  if (!resolveVisibility(node.visible)) return null;
  const isRoot = node.id === rootId;
  // Canvas zoom: the content plane is scaled by scale(zoom), so any handle/divider
  // SCREEN delta is delta/zoom world px. Threaded into the resize handles and split
  // dividers below. 1 when unzoomed (flow) → existing behaviour unchanged.
  const cameraZoom = snapshot.camera?.zoom || 1;
  const rawRect = snapshot.frames[node.id]?.rect;
  // COORDINATE LOCALIZATION (Codex-converged 2026-06-23, the deepest root of nested
  // rendering). The engine emits WORLD/absolute frames (layout.rs places every node at
  // its accumulated absolute origin; there is NO localization anywhere in the engine→
  // host path). But SceneFrame renders each child `position:absolute` INSIDE its parent's
  // SceneFrame, so feeding a child its raw world rect double-offsets it by the sum of its
  // ancestors' origins (empirically: a panel text at world x=32 inside a panel at world
  // x=24 rendered at DOM x=56). The fix is to localize at the DOM nesting boundary:
  //   • root        → the zeroed origin (the framed page anchors at the stage top; its
  //                    own world offset among siblings is removed, the void with it).
  //   • every child → childWorld − parentWorld, so the abspos nesting composes back to
  //                    the exact world position. Backward-compatible: root-direct content
  //                    localizes against the root's own world rect → unchanged where it
  //                    already rendered right; deeper-nested content (columns, table cells,
  //                    canvas children) is CORRECTED (an L063 category fix for the whole
  //                    nested-content class, not just the canvas). Content-plane-level chrome
  //                    (edges, drop indicator, popovers) stays WORLD — the plane IS the world
  //                    origin and the localized tree composes back to world, so they align.
  const rect = !rawRect
    ? rawRect
    : isRoot
      ? { ...rawRect, x: 0, y: 0 }
      : props.parentRect
        ? { x: rawRect.x - props.parentRect.x, y: rawRect.y - props.parentRect.y, w: rawRect.w, h: rawRect.h }
        : rawRect;
  // GRIP LANE — how many other grips already occupy this node's left-gutter strip (see
  // gripLaneFor). 0 ⇒ the free document gutter; ≥1 ⇒ inset that many notches into this frame
  // so the grip never stacks on an ancestor's or a left-neighbour's. The root needs none.
  const gripLane = isRoot ? 0 : gripLaneFor(node.id, rawRect, snapshot.frames, rootId);
  // Block-selection chrome NEVER shows on the block the caret is INSIDE (Notion: typing
  // in a block paints nothing; the wash belongs to unit-selection — Cmd+A escalation,
  // marquee, grip click). Clicking into a block also single-selects it (onFocus →
  // onSelect), so without this exclusion the focused block would wear the selection
  // wash the moment you click in. Cmd+A escalation clears focusedNodeId, so the wash
  // appears exactly when the block becomes a selected UNIT.
  const selected = selectedNodeIds.has(node.id) && focusedNodeId !== node.id;
  const dragging = props.dragNodeId === node.id;
  // Table membership (threaded down render via childTableContext) decides the grip:
  //  • a CELL (X-split child of a table row) gets table-SAFE row/column actions — the
  //    generic Add/Float/Delete would inject a lone sibling into one row and break the
  //    shared column-fraction alignment, so they are replaced wholesale. Insert/Delete
  //    here fan across EVERY row (buildInsert/RemoveTable*Transaction).
  //  • a ROW (direct child of the table y-split) gets NO grip; it is pure table
  //    structure, edited only through its cells. Its column dividers stay live —
  //    those are already table-aware, syncing every row (see beginSplitDrag).
  const tableCtx = props.tableCtx;
  // A leaf node at a gripped ancestor's top-left corner is inline content of that ancestor (a
  // table cell's text label sits at the cell's corner; a panel's title sits at the panel's
  // corner). The cell/panel is the unit the user manipulates, so the content node renders no
  // separate grip — one grip per region, and the click lands on the cell's. Keyed on "the
  // PARENT renders a grip" (a ROW renders none, so its cells stay gripped with the table
  // actions) plus pure corner geometry, never node-kind vocabulary (L069).
  const coincidesWithGrippedParent =
    !!props.parentHasGrip && !!rawRect && !!props.parentRect &&
    !(node.children && node.children.length > 0) &&
    Math.abs(rawRect.x - props.parentRect.x) < 24 &&
    Math.abs(rawRect.y - props.parentRect.y) < 24;
  const hasGrip = !(isRoot || tableCtx?.role === 'row' || coincidesWithGrippedParent);
  // Grip vertical centering is DERIVED from the block's own first-line height (font_size ×
  // the .ca-text-node 1.7 line-height), never a fixed top — a fixed 2px centers on a 16px
  // paragraph but floats 11px high beside a 30px H1 (any DATA-styled size misaligns; this is
  // the L063 fix for every size a shortcut row ships, not an H1 special case). 24 = the
  // grip's own chrome height; 16px text resolves back to ~2px so paragraphs are unchanged.
  const gripFontSize = node.kind === 'Text' && isRecord(node.props?.style) && typeof node.props.style.font_size === 'number'
    ? node.props.style.font_size : 16;
  const gripTop = Math.max(2, Math.round((gripFontSize * 1.7 - 24) / 2));
  const handle = !hasGrip ? null : (
    <Container layout="horizontal" gap="none" alignItems="center"
      // Lane ≥1 sits OVER the block's own content (a split child has no free gutter), so it
      // carries the opaque inset pill — transparent dots mixed into glyphs read as broken
      // paint (image #70). Lane 0 lives in the free gutter, no surface needed.
      className={gripLane > 0 ? 'ca-grip ca-grip-inset' : 'ca-grip'}
      // lane 0 keeps the CSS gutter (right:calc(100%+2px), outside the frame's left edge);
      // lane ≥1 re-anchors just inside this frame's top-left, stepping right per lane so a
      // corner-sharing child's grip clears its parent's. z rises with depth so the inner
      // grip is the topmost hit target where frames still overlap.
      style={{ top: `${gripTop}px`, ...(gripLane > 0 ? { right: 'auto', left: `${(gripLane - 1) * 18 + 2}px`, zIndex: 10 + gripLane } : {}) }}>
      <HoverRevealItem className="flex items-center gap-0">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Add block below"
          onClick={() => props.onAddBlockBelow(node.id)}
          className="h-5 w-5 min-w-0 text-[var(--text-ghost)]"
        >
          <Icon icon={Plus} size="xs" />
        </Button>
      {/* Both the + and the drag handle live inside ONE hover-reveal span so they
          fade in TOGETHER only while this block's frame is hovered (SceneFrame sets
          group/hover-reveal). Before, the drag handle sat OUTSIDE the reveal and was
          shown on every block at rest — the "why are the handles always there" bug. */}
      <DragHandleMenu
        aria-label="Block actions"
        onDragStart={() => props.onBeginDrag(node.id)}
      actions={
        tableCtx?.role === 'cell'
          ? [
              { label: 'Insert row above', onSelect: () => props.onInsertTableRow(tableCtx.tableId, tableCtx.rowIndex) },
              { label: 'Insert row below', onSelect: () => props.onInsertTableRow(tableCtx.tableId, tableCtx.rowIndex + 1) },
              { label: 'Insert column left', onSelect: () => props.onInsertTableColumn(tableCtx.tableId, tableCtx.colIndex) },
              { label: 'Insert column right', onSelect: () => props.onInsertTableColumn(tableCtx.tableId, tableCtx.colIndex + 1) },
              { label: 'Connect to…', onSelect: () => props.onStartConnect(node.id) },
              { label: 'Show when…', onSelect: () => props.onEditVisibility(node.id) },
              { label: 'Delete row', danger: true, onSelect: () => props.onRemoveTableRow(tableCtx.tableId, tableCtx.rowIndex) },
              { label: 'Delete column', danger: true, onSelect: () => props.onRemoveTableColumn(tableCtx.tableId, tableCtx.colIndex) },
            ]
          : [
              { label: 'Add above', onSelect: () => props.onInsertBeside(node.id, 'above') },
              { label: 'Add below', onSelect: () => props.onInsertBeside(node.id, 'below') },
              { label: 'Add left', onSelect: () => props.onInsertBeside(node.id, 'left') },
              { label: 'Add right', onSelect: () => props.onInsertBeside(node.id, 'right') },
              { label: 'Spacing…', onSelect: () => props.onEditSpacing(node.id) },
              { label: 'Create component', onSelect: () => props.onCreateComponent(node.id) },
              { label: 'Connect to…', onSelect: () => props.onStartConnect(node.id) },
              { label: 'Show when…', onSelect: () => props.onEditVisibility(node.id) },
              { label: 'Float on canvas', onSelect: () => props.onFloatNode(node.id) },
              ...(isPanelNode(node) && !isCollapsedPanel(node)
                ? [{ label: 'Collapse panel', onSelect: () => props.onCollapsePanel(node.id) }]
                : []),
              ...(isCollapsedPanel(node)
                ? [{ label: 'Expand panel', onSelect: () => props.onExpandPanel(node.id) }]
                : []),
              ...(props.onNoteAction
                ? (props.noteActions ?? []).map((a) => ({
                    label: a.menu_label,
                    onSelect: () => props.onNoteAction!(a.id, node.id),
                  }))
                : []),
              { label: 'Delete', danger: true, onSelect: () => props.onRemoveBlock(node.id) },
            ]
      }
      />
      </HoverRevealItem>
    </Container>
  );
  // A COLLAPSED panel renders as a fixed-width SPINE: its engine frame is SPINE_PX
  // wide (the engine honours {flex:0,width:36}), and we paint the spine chrome —
  // the panel's title + an expand chevron — instead of its content. The spine OWNS
  // its affordances: the chevron is the always-visible expand control, exactly like a
  // reference collapsed rail (VS Code activity bar, Slack huddle rail). It deliberately
  // does NOT carry the generic block grip — on a 36px rail the grip's "add block below"
  // is meaningless and (as a split child) its lane-inset would land on the chevron; the
  // grip's secondary actions (Delete, Connect, Show-when) are reached after expanding.
  // Generic: keyed on the self-describing collapsed state, never a Society type
  // (§C #7, Codex-converged; grip suppression added with the grip-lane fix 2026-06-23).
  if (isCollapsedPanel(node)) {
    return (
      <SceneFrame key={node.id} rect={rect} fit="fill" hoverReveal selected={selected} nodeId={node.id} onActivate={() => onSelect(node.id)}>
        <PanelSpine title={firstNonEmptyTextValue(node) ?? 'Panel'} onExpand={() => props.onExpandPanel(node.id)} />
      </SceneFrame>
    );
  }
  const webElement = capturedWebElement(node);
  if (webElement) {
    const opaqueWithFallback = webElement.capability?.editability === 'opaque'
      && typeof webElement.capability.raster_fallback_src === 'string';
    return (
      <SceneFrame key={node.id} rect={rect} fit="fill" hoverReveal selected={selected} nodeId={node.id} onActivate={() => onSelect(node.id)}>
        {handle}
        <CapturedWebElementSurface node={node} data={webElement} />
        {!opaqueWithFallback ? (node.children ?? []).map((child, index) => (
          <SceneNodeView key={child.id} {...props} node={child} parentRect={rawRect} parentHasGrip={hasGrip} tableCtx={childTableContext(node, tableCtx, index)} parentIsSplit={false} />
        )) : null}
      </SceneFrame>
    );
  }
  if (node.kind === 'Text') {
    return (
      <SceneFrame key={node.id} rect={rect} hoverReveal selected={selected} nodeId={node.id} className={dragging ? 'opacity-40' : undefined}>
        {handle}
        <AutoSizeTextNode
          node={node}
          focused={focusedNodeId === node.id}
          placeholder={props.editorPlaceholder}
          // The live streamed-into node renders the growing answer HERE, through this same
          // measure + mark-render path (single layout authority) — null for every other node.
          liveText={props.streamingTextNodeId === node.id ? props.streamingText : null}
          revealOnMount={props.revealTextNodeIds.has(node.id)}
          onMeasureHeight={props.onMeasureTextHeight}
          onFocus={() => {
            onSelect(node.id);
            onTextFocus(node.id);
          }}
          onChange={(value, caretOffset) => onTextChange(node.id, value, caretOffset)}
          onAutoformat={(match) => props.onAutoformat(node.id, match)}
          matchShortcut={props.matchShortcut}
          dispatchShortcut={props.dispatchShortcut}
          openComposer={props.openComposer}
          getCursorCommands={props.getCursorCommands}
          getInlineMarks={props.getInlineMarks}
          onEscape={onEscape}
          onEnterNewBlock={(startWith) => props.onInsertBeside(node.id, 'below', startWith)}
          getInputShortcutRules={props.getInputShortcutRules}
          onBackspaceAtStart={() => props.onMergeBackward(node.id)}
        />
      </SceneFrame>
    );
  }
  if (node.kind === 'Component') {
    // fit="fill": the engine rect becomes a DEFINITE box height so the mounted
    // live surface (height:100% all the way down) fills it, resizes with it, and
    // has real area to receive pointer events. Under the default 'hug' the
    // surface's percentage height resolves against a minHeight-only parent and
    // collapses to ~0 — the "frames don't resize / don't interact" defect.
    return (
      <SceneFrame key={node.id} rect={rect} fit="fill" hoverReveal outlined selected={selected} nodeId={node.id} onActivate={() => onSelect(node.id)}>
        {handle}
        <ComponentNodeSurface node={node} />
        {rect && !props.parentIsSplit ? (
          // Chrome plane: eight resize handles + live W×H badge over the mounted
          // surface, never clipped (the frame dropped overflow-hidden, F3/F4).
          // The container is pointer-transparent so the surface stays
          // interactive between the handles. Each drag streams the new rect to
          // the engine via commitFrame (resize AND interact, not either/or).
          //
          // SUPPRESSED when this surface is a DIRECT child of a split (a column /
          // cell position): the engine's place_split_children sizes split children
          // by fraction and IGNORES their style.width/height (layout.rs:789), so the
          // handles (which set style.width) would be a DEAD CONTROL. The parent split's
          // DIVIDER is the correct resize affordance there — it edits the fraction, which
          // IS what sizes the surface. Structure decides the affordance (like the table
          // grip suppression on rows). Codex-converged 2026-06-21.
          <SceneResizeHandles
            rect={rect}
            revealed={selected}
            zoom={cameraZoom}
            onResize={(next, handle) => props.onResizeFrame(node.id, next, handle)}
          />
        ) : null}
      </SceneFrame>
    );
  }
  // Default: a Container — incl. a split LAYOUT node (mode:split). It renders its
  // column children (each its own SceneFrame at its engine rect); when it is a
  // split node we overlay draggable dividers at the boundaries between adjacent
  // VISIBLE columns. The dividers' positions are a pure function of the engine
  // frames; dragging one edits this node's layout.parts (engine reframes).
  const splitAxis = isSplitNode(node) ? readSplitAxis(node) : null;
  // A Container's authored DATA style (background / border / radius) paints as a
  // passive underlay INSIDE the frame. SceneFrame itself stays a blind positioner
  // (zero styling by contract); without this layer every styled card authored as
  // DATA renders invisible — Text nodes applied sceneStyleToCss but Containers
  // dropped it entirely.
  const containerCss = sceneStyleToCss(isRecord(node.props?.style) ? node.props.style : undefined);
  const hasContainerPaint = containerCss.background != null || containerCss.borderColor != null;
  return (
    <SceneFrame key={node.id} rect={rect} hoverReveal={!isRoot} nodeId={node.id}>
      {hasContainerPaint ? (
        <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
          background: containerCss.background,
          borderColor: containerCss.borderColor,
          borderWidth: containerCss.borderWidth,
          borderStyle: containerCss.borderColor != null ? 'solid' : undefined,
          borderRadius: containerCss.borderRadius }} />
      ) : null}
      {handle}
      {(node.children ?? []).map((child, index) => (
        // parentRect = this node's WORLD rect, so each child localizes against it; parentHasGrip
        // lets a leaf at my corner suppress its redundant grip. The grip lane is each node's own
        // job (gripLaneFor reads the global frame geometry), so it is not threaded here.
        <SceneNodeView key={child.id} {...props} node={child} parentRect={rawRect} parentHasGrip={hasGrip} tableCtx={childTableContext(node, tableCtx, index)} parentIsSplit={isSplitNode(node)} />
      ))}
      {splitAxis && rect ? (
        <SplitDividers
          axis={splitAxis}
          revealed={selected}
          // splitDividerScreenRects works in WORLD coords (it subtracts the WORLD splitRect
          // from the WORLD child boundary to get the split-LOCAL divider position the overlay
          // renders at). Both inputs MUST be world — rawRect, not the localized `rect`.
          dividers={splitDividerScreenRects({
            splitRect: rawRect ?? { x: 0, y: 0, w: 0, h: 0 },
            childRects: (node.children ?? []).map((child) => snapshot.frames[child.id]?.rect ?? null),
            pairs: visibleDividerPairs(node.children ?? []),
            axis: splitAxis,
          })}
          onResizeStart={() => props.onSplitDragStart(node.id)}
          // deltaPx is a SCREEN delta; ÷ zoom = world delta the engine fraction edit expects.
          onResize={(leftIndex, rightIndex, deltaPx) => props.onSplitDrag(node.id, leftIndex, rightIndex, deltaPx / cameraZoom)}
        />
      ) : null}
    </SceneFrame>
  );
}

// Component nodes whose data carries a package_entry mount the REAL live
// surface (the same entry-bytes path every arranged screen uses). Without a
// package_entry the node renders its label — still pure data, no registry.
// The reference is read DIALECT-TOLERANTLY: node DATA exists in two vintages —
// snake_case {package_name, entry_name} (canonical, what inserts now write and
// what every sibling renderer reads) and camelCase {packageName, entryName}
// (what this surface's own insert path wrote between 2026-06-21 and 2026-08-22
// via the ui reader's normalization). Reading only one dialect rendered every
// camelCase block as its label — the "inserted block shows just a name" defect.
// Same tolerant convention as screen-arrangement WorkspaceShell.
function ComponentNodeSurface({ node }: { node: SceneNode }) {
  const customRaw = node.props?.custom;
  const custom = isRecord(customRaw) ? customRaw : undefined;
  const packageEntryRaw = custom && isRecord(custom.package_entry)
    ? custom.package_entry as Record<string, unknown>
    : null;
  const packageName = typeof packageEntryRaw?.package_name === 'string'
    ? packageEntryRaw.package_name
    : typeof packageEntryRaw?.packageName === 'string' ? packageEntryRaw.packageName : undefined;
  const entryName = typeof packageEntryRaw?.entry_name === 'string'
    ? packageEntryRaw.entry_name
    : typeof packageEntryRaw?.entryName === 'string' ? packageEntryRaw.entryName : undefined;
  if (packageName && entryName) {
    // The live mount depends on a Bitfield read scope; outside one (tests,
    // detached previews) it throws. The boundary degrades to the label
    // placeholder instead of unmounting the whole authoring surface.
    return (
      <ErrorBoundary
        zoneName="composition live surface"
        fallback={() => <Text variant="body-xs" color="secondary">{componentLabel(node)}</Text>}
      >
        <LiveEntrySurface
          packageName={packageName}
          entryName={entryName}
          label={componentLabel(node)}
          frameFit={typeof custom?.frame_fit === 'string' ? custom.frame_fit : undefined}
          surfaceInput={isRecord(custom?.surface_input) ? custom.surface_input : undefined}
          materialTarget={typeof custom?.material_target === 'string' ? custom.material_target : undefined}
          target={typeof custom?.target === 'string' ? custom.target : undefined}
        />
      </ErrorBoundary>
    );
  }
  return <Text variant="body-xs" color="secondary">{componentLabel(node)}</Text>;
}

function LiveEntrySurface({
  packageName,
  entryName,
  label,
  frameFit,
  surfaceInput,
  materialTarget,
  target,
}: {
  packageName: string;
  entryName: string;
  label: string;
  frameFit?: string;
  surfaceInput?: Record<string, unknown>;
  materialTarget?: string;
  target?: string;
}) {
  const addressLabel = `package::${packageName}::entry-bytes::${entryName}`;
  // Pass a live-source POINTER (address_label), NOT inline bytes: SourceBytesScreenMount
  // rejects inline payloads >1MB (they block the transfer), and real entry bundles are
  // multi-MB. The painter resolves + subscribes the pointer by content identity from CAS
  // regardless of size — so ANY entry (not just tiny ones) can be Component-mounted.
  const sourcePointer = React.useMemo(() => ({ address_label: addressLabel }), [addressLabel]);
  // Honor the surface's OWN declared mount contract (convergence F5/F8): a
  // declared fit wins, else default to 'fill' — composition mounts full live
  // panels, not content-height cards (L083 maximally-capable default). The
  // node's SceneFrame supplies the definite height (fit="fill") this percentage
  // fill resolves against. surfaceInput / materialTarget / target hand any mounted
  // slot its real invocation context so it COMPOSES, not merely loads its bytes.
  const mountProps = React.useMemo(
    () => ({
      // Carry the descriptor's frame_fit VERBATIM (L090) — default to 'fill' ONLY when
      // absent, never coerce an unrecognized value. A new fit mode is a data concern the
      // renderer passes through, not a closed set the host narrows.
      floating_frame: { mode: typeof frameFit === 'string' && frameFit ? frameFit : 'fill' },
      ...(surfaceInput ? { surfaceInput } : {}),
      ...(materialTarget ? { materialTarget } : {}),
      ...(target ? { target } : {}),
    }),
    [frameFit, surfaceInput, materialTarget, target],
  );
  return (
    <SourceBytesScreenMount
      sourceBytes={sourcePointer}
      sourceKey={addressLabel}
      mountProps={mountProps}
      fill
      unavailableText={`${label} is not available yet`}
      runtimeUnavailableText={`${label} could not load`}
    />
  );
}

// Text block keymap — DATA (L090), not hardcoded branches: the key handler matches an
// event against these bindings (specific modifiers first) and dispatches the action.
// Rebinding or adding a key is a data row. Enter yields the 'new-block' ACTION, and what that
// action actually does is then asked of the DATA: a block produced by an input-shortcut row that
// declares `what_enter_does` continues that kind (the next bullet, the next numbered item) or
// leaves it when empty; everything else falls through to a plain new block. See
// read-data/what-enter-does-in-this-block.ts. Cmd/Ctrl+Enter
// and Shift+Enter add a soft line break INSIDE the block; the dismiss key closes the
// slash menu / exits editing (Notion/Craft reference). The dismiss key is NOT hardcoded
// in the handler — it lives here as data, and the menu footer label reads from the same
// row so the displayed shortcut can never drift from the bound key.
type TextKeyAction = 'new-block' | 'new-line' | 'dismiss';
const TEXT_KEYMAP: Array<{ key: string; meta?: boolean; shift?: boolean; action: TextKeyAction }> = [
  { key: 'Enter', meta: true, action: 'new-line' },
  { key: 'Enter', shift: true, action: 'new-line' },
  { key: 'Enter', action: 'new-block' },
  { key: 'Escape', action: 'dismiss' },
];
// Human label for the dismiss shortcut, derived from the keymap (single source). 'Escape'
// prints as the familiar 'Esc'; any other bound key prints verbatim.
const MENU_DISMISS_KEY_LABEL = (() => {
  const binding = TEXT_KEYMAP.find((entry) => entry.action === 'dismiss');
  if (!binding) return '';
  return binding.key === 'Escape' ? 'Esc' : binding.key;
})();
function resolveTextKeyAction(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>): TextKeyAction | null {
  const meta = event.metaKey || event.ctrlKey;
  for (const binding of TEXT_KEYMAP) {
    if (binding.key !== event.key) continue;
    if (binding.meta !== undefined ? binding.meta !== meta : meta) continue;
    if (binding.shift !== undefined ? binding.shift !== event.shiftKey : event.shiftKey) continue;
    return binding.action;
  }
  return null;
}

function AutoSizeTextNode({
  node,
  focused,
  placeholder,
  revealOnMount,
  onFocus,
  onChange,
  onAutoformat,
  matchShortcut,
  dispatchShortcut,
  openComposer,
  onEscape,
  onEnterNewBlock,
  getInputShortcutRules,
  onBackspaceAtStart,
  onMeasureHeight,
  getCursorCommands,
  getInlineMarks,
  liveText,
}: {
  node: SceneNode;
  focused: boolean;
  placeholder: string;
  revealOnMount: boolean;
  onFocus: () => void;
  onChange: (value: string, caretOffset?: number) => void;
  onAutoformat: (match: AutoformatMatch) => string | null;
  matchShortcut: (before: string, trigger: 'space' | 'enter') => AutoformatMatch | null;
  // Fire a renderer:none dispatch shortcut (!! -> workflow, etc.) on this key; returns true if one
  // matched + fired so the keydown consumes the gesture. The block stays blind to the target.
  dispatchShortcut: (before: string, trigger: 'space' | 'enter', nodeId: string) => boolean;
  openComposer: (nodeId: string, key: string, isEmpty: boolean) => boolean;
  onEscape: () => void;
  onEnterNewBlock: (startWith?: Record<string, unknown>) => void;
  // Blind accessor for the LIVE input-shortcut DATA rows (mirror of getCursorCommands): the block
  // asks "what do the rules say right now?" and never holds a rule of its own.
  getInputShortcutRules: () => readonly InputShortcut[];
  // Backspace with a COLLAPSED caret at the block's text start: merge this block into the
  // geometrically-previous block (N2). Returns true if it merged so keydown consumes the gesture.
  onBackspaceAtStart: () => boolean;
  onMeasureHeight: (nodeId: string, height: number) => void;
  // The LIVE spatial-nav gesture table, as a blind accessor (L098): the PARENT owns the DATA ref
  // (cursorCommandsRef, fed by the live cursor-command feed); this child only asks "what are the
  // gestures right now?" per keydown. Root-cause note: the handler previously referenced the
  // parent's cursorCommandsRef as a FREE VARIABLE from this top-level component — a scope bug that
  // threw ReferenceError on EVERY keydown (killing nav/merge/composer/autoformat) and shipped
  // because esbuild transpiles without name resolution. The accessor prop makes the dependency
  // explicit and structurally un-shippable-wrong (the prop is required, so a missing table is a
  // compile-visible hole, not a runtime bomb).
  getCursorCommands: () => readonly CursorCommand[];
  // Blind accessor for the LIVE inline-mark table — the block renders/serializes marks
  // per the latest DATA rows, holding no vocabulary of its own (mirror of getCursorCommands).
  getInlineMarks: () => readonly InlineMark[];
  // LIVE streaming override: when THIS block is the active AI-composer target, the growing
  // answer text (else null). Non-null makes this node the SINGLE visible owner of the live
  // output — it renders the stream IN PLACE through the same renderBlockRuns mark path as
  // finalized text (so `**bold**` is bold live, not literal) and measures it as its own
  // height. This replaces the old portaled overlay that painted the text a SECOND time over
  // the node (two layout authorities → self-overlap until resize; 2026-07-20 fix).
  liveText: string | null;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  // The stream, while active, IS the node's text — one authority, rendered + measured through
  // the exact same path as persisted text below. null ⇒ the persisted node text (unchanged).
  const value = liveText ?? textFromNode(node);
  const nodeId = node.id;
  const marks = getInlineMarks();

  // Report the block's real wrapped content height to the engine whenever it (or
  // its width) changes — the auto-height bridge (see reportTextHeight). scrollHeight
  // is the natural content height incl. wrapped lines + padding.
  //
  // CRITICAL: measure on the NEXT animation frame, never synchronously. A typed
  // block re-measures on every keystroke (layout already settled) so it grows
  // correctly — but an AI-INSERTED block has its text set once, and a synchronous
  // read in that same commit returns the PRE-WRAP height (one line). The engine
  // then never grows the frame and the block below overlaps it. A rAF read happens
  // after contentEditable has wrapped its lines, so inserted, pasted, and reloaded
  // blocks all report their true multi-line height. Double-rAF guards the first
  // paint after mount. The parent throttles + de-dups, so measuring freely is cheap.
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let raf1 = 0;
    let raf2 = 0;
    const measure = () => {
      cancelAnimationFrame(raf1);
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          const el = ref.current;
          if (el) onMeasureHeight(nodeId, el.scrollHeight);
        });
      });
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    measure();
    return () => { observer?.disconnect(); cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [nodeId, onMeasureHeight, value]);

  // STREAMING REVEAL (typewriter) — the shared ui primitive (useTypewriterReveal, SSOT
  // with the board note). When this block is a freshly-produced AI result (flagged in
  // revealTextNodeIds → revealOnMount), it types the text in progressively instead of
  // dumping it — the "characters coming out" the user asked for. DOM-local: the engine
  // holds the full PERSISTED text, so this is zero round-trips and a reload shows it
  // whole. `onProgress` re-measures the wrapped height each frame so the auto-height
  // reflows as the text grows. `revealingRef` (owned by the hook) makes the text-sync
  // effect below defer while the typewriter owns textContent.
  const revealHeight = React.useCallback(
    (el: HTMLElement) => onMeasureHeight(nodeId, el.scrollHeight),
    [nodeId, onMeasureHeight],
  );
  const { revealingRef } = useTypewriterReveal({
    ref,
    text: value,
    // No typewriter WHILE streaming: the live stream is already progressive, so a second
    // reveal animation over it would fight the incoming text. The typewriter is only for a
    // freshly-FINALIZED block (liveText == null, revealOnMount from revealTextNodeIds).
    active: revealOnMount && liveText == null,
    onProgress: revealHeight,
    // When the typewriter releases the element, re-apply the STRUCTURED render the
    // text-sync effect skipped while the reveal owned textContent — a fresh AI block
    // with `**bold**` / chips would otherwise show literal markers until reload (the
    // sync keys on `value`, which never changes after placement).
    onSettled: (el) => {
      const m = getInlineMarks();
      if (hasRefToken(value) || hasEmphasisMarker(value, m)) renderBlockRuns(el, value, m);
    },
  });

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (revealingRef.current) return; // the typewriter owns textContent while animating
    if (document.activeElement === element) return;
    // FAIL-SAFE (C5): a block carrying a reference token OR an inline emphasis span renders its
    // runs (chips + <strong>/<em>); a block with neither uses the exact plain-text fast path as
    // before (zero change to existing content). The stored text keeps the literal `**`/`*`
    // markers — the styled DOM is a render projection serializeBlockElement inverts losslessly
    // (user incident 2026-07-10: AI output showed literal asterisks). The runs path re-renders
    // only when the serialized DOM diverges from the stored text.
    if (hasRefToken(value) || hasEmphasisMarker(value, marks)) {
      if (serializeBlockElement(element, marks) !== value) renderBlockRuns(element, value, marks);
    } else if (element.textContent !== value) {
      element.textContent = value;
    }
  }, [value, node.props?.style, marks]);

  React.useEffect(() => {
    if (!focused || !ref.current) return;
    const element = ref.current;
    if (document.activeElement === element) return;
    element.focus();
    placeCaretAtEnd(element);
  }, [focused]);

  // NATIVE keydown contract (not React onKeyDown). React 19's delegated synthetic onKeyDown does
  // NOT fire on these engine-hosted contentEditable blocks inside the macOS WKWebView presenter —
  // only onInput does (verified live + Codex-converged: a window/element-native keydown reaches
  // the DOM as trusted while React's block-level onKeyDown never runs). So the block's whole
  // keyboard contract (spatial nav, backspace-merge, composer-open, autoformat, dispatch, enter,
  // escape, soft-break) is attached as a NATIVE 'keydown' listener on the element, which fires
  // reliably. Held in a ref so the once-registered listener always runs the LATEST closures
  // (openComposer/matchShortcut/etc.) without re-binding on every render.
  const onKeyDownRef = React.useRef<(event: KeyboardEvent) => void>(() => {});
  onKeyDownRef.current = (event: KeyboardEvent) => {
    const el = event.currentTarget as HTMLDivElement;
    // SPATIAL-CURSOR NAV (N1): at a block edge, an arrow crosses into the geometrically-nearest
    // block; not at the edge → the browser moves the caret within the block. An open menu/picker
    // consumes arrows in the stage's NATIVE capture handler (runs first) via preventDefault, so
    // defaultPrevented means "the menu took it".
    const cursorCommands = getCursorCommands();
    if (cursorCommands.some((c) => c.key === event.key)) {
      if (!event.defaultPrevented) {
        const g = readCaretGeometry(el);
        const cmd = g ? resolveCursorCommand(event.key, g, cursorCommands) : null;
        if (g && cmd && navigateFromBlock(el.closest('.ca-root'), node.id, cmd.direction, g.goalX, g.goalY, cmd.landEdge)) {
          event.preventDefault();
          return;
        }
      }
    }
    // MERGE-BACKWARD (N2): Backspace with a collapsed caret at the block's very start merges into
    // the geometrically-previous block; not-at-start → the browser deletes a char.
    if (event.key === 'Backspace' && !event.defaultPrevented) {
      const g = readCaretGeometry(el);
      if (g && g.atStart && onBackspaceAtStart()) {
        event.preventDefault();
        return;
      }
    }
    // COMPOSER OPEN (DATA-keyed): the renderer:composer shortcut opens on ITS OWN key + block-state
    // from DATA (default: space on an empty block). Space on a NON-empty block falls to autoformat.
    if (!event.defaultPrevented && openComposer(node.id, event.key, (el.textContent ?? '').trim() === '')) {
      event.preventDefault();
      return;
    }
    // SHORTHAND (space-trigger): a rule's prefix + SPACE transforms the block (# → H1, - → bullet).
    if (event.key === ' ') {
      const before = el.textContent ?? '';
      const match = matchShortcut(`${before} `, 'space');
      if (match) {
        event.preventDefault();
        const finalText = onAutoformat(match);
        if (finalText != null) {
          el.textContent = finalText;
          placeCaretAtEnd(el);
        }
        return;
      }
      // DISPATCH shortcut (renderer:none, e.g. `!! ` -> a deterministic workflow): space completes it.
      if (dispatchShortcut(`${before} `, 'space', node.id)) {
        event.preventDefault();
        el.textContent = '';
        onChange('');
        return;
      }
    }
    const action = resolveTextKeyAction(event);
    if (action === 'dismiss') {
      event.preventDefault();
      el.blur();
      onEscape();
      return;
    }
    if (action === 'new-block') {
      const before = el.textContent ?? '';
      const match = matchShortcut(before, 'enter');
      if (match) {
        event.preventDefault();
        onAutoformat(match);
        return;
      }
      if (dispatchShortcut(before, 'enter', node.id)) {
        event.preventDefault();
        el.textContent = '';
        onChange('');
        return;
      }
      // Ask the DATA what Enter does in THIS block before falling back to a plain one. The block
      // that a rule produced carries that rule's id, so the rule decides; this handler never learns
      // what kind of thing the rule makes (L063/L090). A rule that declares nothing lands on
      // 'make_a_plain_block', which is exactly the old behaviour.
      const enterDecision = whatEnterDoesInThisBlock({
        madeByShortcut: (node.props as { made_by_shortcut?: string } | undefined)?.made_by_shortcut ?? null,
        text: before,
        rules: getInputShortcutRules() as ContinuableShortcutRule[],
      });
      if (enterDecision.does === 'make_another_one_like_this') {
        event.preventDefault();
        onEnterNewBlock({
          text: markerToStartTheNextOneWith(before, enterDecision.nextMarker),
          made_by_shortcut: enterDecision.rule.id,
        });
        return;
      }
      if (enterDecision.does === 'leave_this_kind') {
        // How a list ends: the empty item drops its marker and becomes an ordinary block in place.
        event.preventDefault();
        el.textContent = '';
        onChange('');
        return;
      }
      // Enter splits to a NEW block below, not a newline inside this one.
      event.preventDefault();
      onEnterNewBlock();
    } else if (action === 'new-line') {
      // Cmd/Ctrl+Enter or Shift+Enter = a soft line break INSIDE the block.
      event.preventDefault();
      document.execCommand('insertLineBreak');
      onChange(el.innerText ?? '');
    }
  };
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listener = (event: KeyboardEvent) => onKeyDownRef.current(event);
    el.addEventListener('keydown', listener);
    return () => el.removeEventListener('keydown', listener);
  }, []);

  return (
    <div
      ref={ref}
      role="textbox"
      aria-multiline="true"
      aria-label={Number.isInteger(node.props?.custom?.heading_level)
        && Number(node.props?.custom?.heading_level) >= 1 && Number(node.props?.custom?.heading_level) <= 6
        ? `Heading level ${node.props?.custom?.heading_level}` : 'Text block'}
      className="ca-text-node"
      data-node-id={node.id}
      data-placeholder={placeholder}
      // data-empty drives the :focus placeholder (see CSS): text-emptiness per readBlockText,
      // NOT the `:empty` pseudo (a focused CE keeps a stray <br> after type+backspace → `:empty`
      // false → hint lost). Stamped from `value` on render and re-stamped live on focus/input.
      data-empty={!hasRefToken(value) && (value ?? '').trim() === '' ? 'true' : 'false'}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      style={sceneStyleToCss(node.props?.style)}
      onFocus={(event) => { event.currentTarget.setAttribute('data-empty', readBlockText(event.currentTarget, marks).trim() === '' ? 'true' : 'false'); onFocus(); }}
      onInput={(event) => { const el = event.currentTarget; el.setAttribute('data-empty', readBlockText(el, marks).trim() === '' ? 'true' : 'false'); onChange(readBlockText(el, marks), caretFlatOffset(el, marks)); }}
    />
  );
}

function placeCaretAtEnd(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

// ── Inline reference CHIPS (C5) ─────────────────────────────────────────────────────────────────────
// The chip DOM inverse-pair (makeRefChip / renderBlockRuns / serializeBlockElement / readBlockText) now
// lives in the pure, jsdom-tested read-data/inline-chip-dom.ts module (imported above) — extracted out
// of this surface so the C5 chip DOM is verifiable in isolation, engine-free.

// The caret's offset in the FLATTENED text of `el` (the same flattening readBlockText produces, chips
// included). Clones the start-to-caret range into a holder and measures its flat length — so the offset
// lines up with the string activeTokenAt slices, even across ref-chips. Returns -1 when there is no live
// caret inside `el` (the caller then falls back to end-of-text). Standard Range API (WebKit-safe).
function caretFlatOffset(el: HTMLElement, marks: readonly InlineMark[]): number {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0) return -1;
  const caret = sel.getRangeAt(0);
  if (!el.contains(caret.endContainer)) return -1;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(caret.endContainer, caret.endOffset);
  const holder = document.createElement('div');
  holder.appendChild(pre.cloneContents());
  return readBlockText(holder, marks).length;
}

// The Ask-AI composer editable (C3): a RICH contentEditable that reuses the SAME chip render/read
// primitive as a block (renderBlockRuns / readBlockText), so a picked @-reference shows as a chip in
// the prompt (not plain text) and the composer behaves like an editable surface. FAIL-SAFE: text with
// no chip token is plain text; the parent owns @-detection + submit/dismiss, this only owns the DOM.
function ComposerEditable({
  value,
  label,
  placeholder,
  overlayOpen,
  marks,
  onInput,
  onSubmit,
  onDismiss,
}: {
  value: string;
  // The accessible name — the row's own ask-field label (composerAskCopy), never a literal.
  label: string;
  placeholder: string;
  overlayOpen: boolean;
  // The live inline-mark table — same DATA the blocks compile (chips + marks render identically).
  marks: readonly InlineMark[];
  onInput: (text: string, caretOffset: number) => void;
  onSubmit: () => void;
  onDismiss: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  // Focus + seed empty on mount (the composer always opens empty).
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    renderBlockRuns(el, '', marks);
    el.focus();
    // Mount-only: seeding EMPTY text touches no mark row, so the live table isn't a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Sync external value changes (e.g. a chip insert while blurred) — never while focused, so typing
  // is never clobbered (same rule as a block).
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement === el) return;
    if (serializeBlockElement(el, marks) !== value) renderBlockRuns(el, value, marks);
  }, [value, marks]);
  // NATIVE keydown (not React onKeyDown) — the composer editable lives in the same engine-hosted
  // subtree where React 19's synthetic key events don't fire in the WKWebView presenter, so its
  // submit/dismiss contract (Enter → submit, Escape / Backspace-on-empty → dismiss) is attached
  // natively. The decision stays the pure, unit-tested composerKeyAction; only the intent runs here.
  const onKeyDownRef = React.useRef<(event: KeyboardEvent) => void>(() => {});
  onKeyDownRef.current = (event: KeyboardEvent) => {
    const el = event.currentTarget as HTMLDivElement;
    const intent = composerKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      isEmpty: readBlockText(el, marks).length === 0,
      overlayOpen,
    });
    if (intent === 'submit') {
      event.preventDefault();
      onSubmit();
    } else if (intent === 'dismiss') {
      event.preventDefault();
      onDismiss();
    }
  };
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const listener = (event: KeyboardEvent) => onKeyDownRef.current(event);
    el.addEventListener('keydown', listener);
    return () => el.removeEventListener('keydown', listener);
  }, []);
  return (
    <div
      ref={ref}
      className="ca-composer-input"
      role="textbox"
      aria-label={label}
      data-placeholder={placeholder}
      contentEditable
      suppressContentEditableWarning
      onInput={(event) => onInput(readBlockText(event.currentTarget, marks), caretFlatOffset(event.currentTarget, marks))}
    />
  );
}

// ── Spatial-cursor nav (N1 wiring) — the surface side of the resolveInDirection primitive ──────────
// Everything is in SCREEN coordinates (getBoundingClientRect), the TRUE rendered geometry the user
// sees — so it works through the engine's pan/zoom transform and text wrapping with no coordinate
// conversion. Candidate rects come from the live .ca-text-node DOM elements (every editable block).

type CaretGeom = { goalX: number; goalY: number; atTop: boolean; atBottom: boolean; atStart: boolean; atEnd: boolean };

// Read the caret's screen position + whether it sits on the block's first/last visual line and at the
// block's text start/end — the four edges from which an arrow crosses into a neighbor block.
function readCaretGeometry(el: HTMLElement): CaretGeom | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const rects = range.getClientRects();
  const caret = rects.length ? rects[0] : el.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const lineH = caret.height || parseFloat(getComputedStyle(el).lineHeight || '20') || 20;
  const before = range.cloneRange();
  before.selectNodeContents(el);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(el);
  after.setStart(range.endContainer, range.endOffset);
  return {
    goalX: caret.left,
    goalY: caret.top,
    atTop: caret.top - box.top < lineH * 0.6,
    atBottom: box.bottom - caret.bottom < lineH * 0.6,
    atStart: before.toString().length === 0,
    atEnd: after.toString().length === 0,
  };
}

// Place the caret at screen x=goalX on the target block's `edge` line (goal-column preservation),
// via the browser's own point→caret hit-test (reused from the proven customer focusLineAtX approach).
function placeCaretAtPoint(el: HTMLElement, goalX: number, edge: 'top' | 'bottom' | 'start' | 'end'): void {
  el.focus();
  if (edge === 'end') { placeCaretAtEnd(el); return; }
  if (edge === 'start') {
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(r);
    return;
  }
  const box = el.getBoundingClientRect();
  const lineH = parseFloat(getComputedStyle(el).lineHeight || '20') || 20;
  const clampX = Math.max(box.left + 2, Math.min(goalX, box.right - 2));
  const y = edge === 'top' ? box.top + Math.min(lineH / 2, box.height / 2) : box.bottom - Math.min(lineH / 2, box.height / 2);
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const sel = window.getSelection();
  const pos = doc.caretPositionFromPoint?.(clampX, y);
  if (pos && sel) {
    const r = document.createRange();
    r.setStart(pos.offsetNode, pos.offset);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    return;
  }
  const r2 = doc.caretRangeFromPoint?.(clampX, y);
  if (r2 && sel) { sel.removeAllRanges(); sel.addRange(r2); return; }
  edge === 'top' ? placeCaretAtStartOf(el) : placeCaretAtEnd(el);
}

function placeCaretAtStartOf(el: HTMLElement): void {
  const sel = window.getSelection();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(r);
}

// True when the current selection covers the whole of `el`'s text — the signal that Cmd+A should
// escalate PAST content (browser text selection) to the block level (N3).
function isAllTextSelected(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  if (!el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return false;
  const full = (el.textContent ?? '').trim();
  if (full.length === 0) return true;
  return sel.toString().trim().length >= full.length;
}

// Drop a collapsed caret at character `offset` within el's text (walking its text nodes) — the join
// point after a merge (N2). Offset past the end clamps to the end.
function placeCaretAtOffset(el: HTMLElement, offset: number): void {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  let remaining = offset;
  const walk = (n: Node): Range | null => {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = n.textContent?.length ?? 0;
      if (remaining <= len) {
        const r = document.createRange();
        r.setStart(n, remaining);
        r.collapse(true);
        return r;
      }
      remaining -= len;
      return null;
    }
    for (const child of Array.from(n.childNodes)) {
      const r = walk(child);
      if (r) return r;
    }
    return null;
  };
  const range = walk(el);
  if (range) {
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    placeCaretAtEnd(el);
  }
}

// Resolve + move: from the current block, find the nearest block in `dir` (over live DOM rects) and
// drop the caret there at the goal column. Returns true when it navigated (caller preventDefaults).
// Sticky goal column (N1): the visual x the caret aims for across CONSECUTIVE vertical block crossings.
// Preserved so that landing in a NARROWER block (whose placeCaretAtPoint clamps the caret x) does not
// drift the column on the next ArrowDown/Up — the classic goal-column bug. SELF-INVALIDATING: each
// vertical move records where the caret actually landed; if the next move's incoming caret x is no
// longer there (the user typed, clicked, or moved horizontally), we start a fresh column from the
// current x. No external reset wiring needed — a horizontal move (edge start/end) also clears it.
let stickyGoalColumn: { column: number; landedX: number } | null = null;

function navigateFromBlock(root: ParentNode | null, nodeId: string, dir: Direction, goalX: number, goalY: number, edge: 'top' | 'bottom' | 'start' | 'end'): boolean {
  const fromEl = (root ?? document).querySelector<HTMLElement>(`.ca-text-node[data-node-id="${nodeId}"]`);
  if (!fromEl) return false;
  const toRect = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const from = toRect(fromEl);
  const candidates = Array.from((root ?? document).querySelectorAll<HTMLElement>('.ca-text-node[data-node-id]'))
    .filter((el) => el.getAttribute('data-node-id') !== nodeId)
    .map((el) => ({ id: el.getAttribute('data-node-id') as string, rect: toRect(el) }));
  const vertical = edge === 'top' || edge === 'bottom';
  // The goal column (drift-prevention decision) is the pure resolveGoalColumn — continues the sticky
  // column when the caret is still where the last vertical move left it, else starts fresh.
  const columnX = vertical ? resolveGoalColumn(stickyGoalColumn, goalX) : goalX;
  const target = resolveInDirection(from, dir, candidates, { x: columnX, y: goalY });
  if (!target) return false;
  const targetEl = (root ?? document).querySelector<HTMLElement>(`.ca-text-node[data-node-id="${target}"]`);
  if (!targetEl) return false;
  placeCaretAtPoint(targetEl, columnX, edge);
  if (vertical) {
    const landedX = readCaretGeometry(targetEl)?.goalX ?? columnX;
    stickyGoalColumn = { column: columnX, landedX };
  } else {
    stickyGoalColumn = null; // a horizontal wrap starts a fresh column at the new position
  }
  return true;
}

// Floating format bar over the focused text node (Mobbin: Notion/Craft/Slack inline
// format toolbar). It renders whatever descriptors it is handed, grouped by the DATA
// `group` — the renderer NEVER names a format — and highlights the ones whose effect
// is currently applied (isFormatActive vs the node's style). Glassmorphic pill (the
// .ca-menu aesthetic); anchored above the node's engine frame, flipping below when
// there's no room above. Click applies the descriptor's style transform via the
// engine (commitFormat → UPDATE_PROPS); preventDefault keeps the text focused.
function FormatBar({
  node,
  snapshot,
  descriptors,
  onFormat,
}: {
  node: SceneNode;
  snapshot: CompositionSnapshot;
  descriptors: FormatDescriptor[];
  onFormat: (descriptor: FormatDescriptor) => void;
}) {
  const barRef = React.useRef<HTMLDivElement>(null);
  const rect = snapshot.frames[node.id]?.rect;
  const style = isRecord(node.props?.style) ? node.props.style : {};
  const BAR_H = 40;
  const above = rect ? rect.y - BAR_H - 6 : 8;
  const rawLeft = rect ? rect.x : 16;
  const top = rect ? (above >= 4 ? above : rect.y + rect.h + 8) : 8;
  // Keep the toolbar inside the visible stage at ANY button count / viewport width: a
  // node near the right edge OR a bar wider than a narrow phone must never overflow. We
  // measure the bar's NATURAL content width (scrollWidth, stable regardless of the cap)
  // and its positioned stage ancestor, then (1) cap max-width to the stage minus margins
  // so a too-wide bar SCROLLS horizontally instead of overflowing (the L063 fix — any
  // future format additions just scroll), and (2) clamp left so it stays on-screen. One
  // useLayoutEffect pass, before paint (no visible jump). Viewport-discipline = Finding B.
  const MARGIN = 8;
  const [box, setBox] = React.useState<{ left: number; maxWidth: number | undefined }>({ left: rawLeft, maxWidth: undefined });
  React.useLayoutEffect(() => {
    const el = barRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) { setBox({ left: rawLeft, maxWidth: undefined }); return; }
    const available = parent.clientWidth - MARGIN * 2;
    const natural = el.scrollWidth;
    const width = Math.min(natural, available);
    const maxLeft = Math.max(MARGIN, parent.clientWidth - width - MARGIN);
    setBox({ left: Math.max(MARGIN, Math.min(rawLeft, maxLeft)), maxWidth: natural > available ? available : undefined });
  }, [rawLeft, node.id]);
  // A group whose descriptors carry `swatch` (colours) collapses to ONE chip trigger that
  // opens a swatch popover; plain groups render inline. The presentation is chosen by the
  // `swatch` DATA, never by group name — adding a colour is a descriptor row, zero bar code.
  const [openGroup, setOpenGroup] = React.useState<string | null>(null);
  const groups: { name: string; rows: FormatDescriptor[] }[] = [];
  for (const descriptor of descriptors) {
    const name = descriptor.group ?? 'Format';
    let bucket = groups.find((g) => g.name === name);
    if (!bucket) {
      bucket = { name, rows: [] };
      groups.push(bucket);
    }
    bucket.rows.push(descriptor);
  }
  const openRows = openGroup ? (groups.find((g) => g.name === openGroup)?.rows ?? null) : null;
  return (
    <>
      <div ref={barRef} className="ca-format-bar" style={{ left: box.left, top, maxWidth: box.maxWidth }} role="toolbar" aria-label="Format text">
        {groups.map((group, index) => {
          // A group renders as a swatch popover only when EVERY row carries a swatch
          // (homogeneous — Codex Q1); a mixed group stays inline rather than half-rendering.
          const isSwatchGroup = group.rows.every((r) => r.swatch);
          return (
            <React.Fragment key={group.name}>
              {index > 0 ? <span className="ca-format-sep" aria-hidden="true" /> : null}
              {isSwatchGroup ? (
                <button
                  type="button"
                  className={openGroup === group.name ? 'ca-format-btn ca-format-btn-active' : 'ca-format-btn'}
                  aria-haspopup="listbox"
                  aria-expanded={openGroup === group.name}
                  aria-label={group.name}
                  title={group.name}
                  onMouseDown={(event) => { event.preventDefault(); setOpenGroup(openGroup === group.name ? null : group.name); }}
                >
                  <span
                    className="ca-format-swatch-indicator"
                    style={{ background: group.rows.find((r) => isFormatActive(style, r))?.swatch
                      ?? 'conic-gradient(from 90deg, #e03e3e, #d9730d, #dfab01, #0f9960, #0b6bcb, #6940a5, #e03e3e)' }}
                  />
                </button>
              ) : (
                group.rows.map((descriptor) => {
                  const active = isFormatActive(style, descriptor);
                  return (
                    <button
                      key={descriptor.id}
                      type="button"
                      className={active ? 'ca-format-btn ca-format-btn-active' : 'ca-format-btn'}
                      aria-pressed={active}
                      aria-label={descriptor.label}
                      title={descriptor.label}
                      onMouseDown={(event) => { event.preventDefault(); onFormat(descriptor); }}
                    >
                      {descriptor.icon ?? descriptor.label}
                    </button>
                  );
                })
              )}
            </React.Fragment>
          );
        })}
      </div>
      {openRows ? (
        <SwatchPopover
          rows={openRows}
          style={style}
          left={box.left}
          top={top + BAR_H + 6}
          onPick={(descriptor) => { onFormat(descriptor); setOpenGroup(null); }}
        />
      ) : null}
    </>
  );
}

// The swatch popover renders OUTSIDE the bar (the bar has overflow-x:auto for the mobile
// scroll, which would clip a child popover) — a sibling, self-clamped into the stage like
// the bar. Renders whatever swatch DATA it is handed; the active swatch gets a ring.
function SwatchPopover({
  rows,
  style,
  left,
  top,
  onPick,
}: {
  rows: FormatDescriptor[];
  style: Record<string, unknown>;
  left: number;
  top: number;
  onPick: (descriptor: FormatDescriptor) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [clampedLeft, setClampedLeft] = React.useState(left);
  React.useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) { setClampedLeft(left); return; }
    const maxLeft = Math.max(8, parent.clientWidth - el.offsetWidth - 8);
    setClampedLeft(Math.max(8, Math.min(left, maxLeft)));
  }, [left, rows]);
  return (
    <div ref={ref} className="ca-format-swatches" style={{ left: clampedLeft, top }} role="listbox" aria-label="Colours">
      {rows.map((descriptor) => {
        const active = isFormatActive(style, descriptor);
        return (
          <button
            key={descriptor.id}
            type="button"
            role="option"
            aria-selected={active}
            className={active ? 'ca-format-swatch ca-format-swatch-active' : 'ca-format-swatch'}
            aria-label={descriptor.label}
            title={descriptor.label}
            onMouseDown={(event) => { event.preventDefault(); onPick(descriptor); }}
          >
            <span className="ca-format-swatch-chip" style={{ background: descriptor.swatch }} />
          </button>
        );
      })}
    </div>
  );
}

// Pure listbox content: positioning is OWNED by the caller's AnchoredOverlay (anchored to the
// live block/composer DOM element) — this component renders rows only, no coordinates.
function MaterialMenu({
  query,
  materials,
  affordances,
  activeIndex,
  onSelect,
  onRunAffordance,
  onConfigureAffordance,
  onNewAction,
  onClose,
  closeKeyLabel,
}: {
  query: string;
  materials: MaterialDescriptor[];
  affordances: AffordanceSlashRow[];
  activeIndex: number;
  onSelect: (material: MaterialDescriptor) => void;
  onRunAffordance: (row: AffordanceSlashRow) => void;
  onConfigureAffordance: (row: AffordanceSlashRow) => void;
  onNewAction?: () => void;
  onClose: () => void;
  closeKeyLabel: string;
}) {
  // Group rows by the DATA `group` field, preserving first-appearance order. The
  // renderer never names a group — it shows whatever groups the data carries (one
  // fallback). `flat` keeps a running flat index so the highlighted row and the
  // keyboard commit index agree across group boundaries.
  void query;
  const groups: { name: string; rows: { material: MaterialDescriptor; flat: number }[] }[] = [];
  materials.forEach((material, flat) => {
    const name = material.group ?? 'Insert';
    let bucket = groups.find((group) => group.name === name);
    if (!bucket) {
      bucket = { name, rows: [] };
      groups.push(bucket);
    }
    bucket.rows.push({ material, flat });
  });
  return (
    <div className="ca-menu" role="listbox" aria-label="Insert">
      {/* Scroll region: the long catalog scrolls INSIDE a bounded height so the popover
          never grows taller than the reference (Notion caps ~min(60vh)). The top/bottom
          opacity fade is a CSS mask on this element (same idiom as the audio/video review
          list The owner referenced) — content dissolves into the chrome instead of a hard cut. */}
      <div className="ca-menu-scroll">
        {materials.length === 0 && affordances.length === 0 ? (
          <div className="ca-menu-empty">Nothing matches</div>
        ) : groups.map((group) => (
          <div className="ca-menu-group" key={group.name}>
            <div className="ca-menu-section">{group.name}</div>
            {group.rows.map(({ material, flat }) => (
              <button
                key={material.id}
                type="button"
                role="option"
                aria-selected={flat === activeIndex}
                className={flat === activeIndex ? 'ca-menu-row ca-menu-row-active' : 'ca-menu-row'}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(material);
                }}
              >
                {/* The descriptor carries an icon NAME (data, L090). The shared resolver maps it
                    to a real lucide glyph and falls back to a generic block icon — it must never
                    render the raw name string as text. */}
                <span className="ca-menu-ico" aria-hidden="true">
                  <NamedIcon name={material.icon ?? null} fallback="SquareDashed" size="sm" />
                </span>
                <span className="ca-menu-label">{material.label}</span>
              </button>
            ))}
          </div>
        ))}
        {/* Action rows — one row per published action-affordance record on this
            surface's slash channel. Rendered after insertables; each row is
            opaque DATA (never named in source). "New action…" opens the shared
            authoring editor when the surface can write records. */}
        {affordances.length > 0 || onNewAction ? (
          <div className="ca-menu-group">
            <div className="ca-menu-section">Actions</div>
            {affordances.map((row, i) => {
              // Action rows continue the ONE keyboard index after the materials: flat index is
              // materials.length + i, so ArrowUp/Down + Enter reach them exactly like insert rows.
              const flat = materials.length + i;
              return (
              <div
                key={row.id}
                role="option"
                aria-selected={flat === activeIndex}
                className={flat === activeIndex ? 'ca-menu-row ca-menu-row-active' : 'ca-menu-row'}
              >
                <button
                  type="button"
                  className="ca-menu-row-main"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onRunAffordance(row);
                  }}
                >
                  <span className="ca-menu-ico" aria-hidden="true">
                    <NamedIcon name={row.affordance.icon ?? null} fallback="Sparkles" size="sm" />
                  </span>
                  <span className="ca-menu-label">{row.label}</span>
                </button>
                <button
                  type="button"
                  className="ca-menu-row-configure"
                  aria-label={`Configure ${row.label}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onConfigureAffordance(row);
                  }}
                >
                  Configure
                </button>
              </div>
              );
            })}
            {onNewAction ? (
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="ca-menu-row"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onNewAction();
                }}
              >
                <span className="ca-menu-ico" aria-hidden="true">
                  <NamedIcon name="Sparkles" fallback="Sparkles" size="sm" />
                </span>
                <span className="ca-menu-label">New action…</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="ca-menu-foot">
        <span className="ca-menu-hint"><kbd>↑</kbd><kbd>↓</kbd> Navigate · <kbd>↵</kbd> Insert</span>
        <button
          type="button"
          className="ca-menu-close"
          onMouseDown={(event) => {
            event.preventDefault();
            onClose();
          }}
        >
          Close <kbd>{closeKeyLabel}</kbd>
        </button>
      </div>
    </div>
  );
}

// A 2px insertion line at the drop location — every coordinate read from the
// engine snapshot's frames (parent rect + sibling rect), never computed.
function DropIndicator({
  snapshot,
  target,
}: {
  snapshot: CompositionSnapshot;
  target: DropPlacement;
}) {
  // SPLIT (left/right): a VERTICAL bar on the target block's chosen edge — signals the dragged
  // block will land as a COLUMN beside it (The owner: "i should see a visual indicator of which
  // side i am dropping it to ... because u can insert left right top bottom").
  if (target.kind === 'split') {
    const rect = snapshot.frames[target.targetId]?.rect;
    if (!rect) return null;
    const left = target.side === 'left' ? rect.x : rect.x + rect.w;
    return (
      <div
        aria-hidden="true"
        data-drop-indicator="split"
        data-drop-side={target.side}
        className="pointer-events-none absolute w-0.5 rounded bg-[var(--border-focus,var(--border-primary))]"
        style={{ left: left - 1, top: rect.y, height: rect.h }}
      />
    );
  }
  // SIBLING (top/bottom): a HORIZONTAL bar at the insertion boundary, spanning the parent.
  const parentRect = snapshot.frames[target.parentId]?.rect;
  if (!parentRect) return null;
  const parent = findNodeById(snapshot.tree, target.parentId);
  const sibling = (parent?.children ?? [])[target.index];
  const siblingRect = sibling ? snapshot.frames[sibling.id]?.rect : undefined;
  const top = siblingRect ? siblingRect.y : parentRect.y + parentRect.h;
  return (
    <div
      aria-hidden="true"
      data-drop-indicator="sibling"
      className="pointer-events-none absolute h-0.5 rounded bg-[var(--border-focus,var(--border-primary))]"
      style={{ left: parentRect.x, top, width: parentRect.w }}
    />
  );
}

// The edge layer renders the kernel-routed connection lines, coloured + labelled by their
// MEANING (#37). It NEVER names a kind: it joins each route to its authored edge by edge_id,
// asks connectionKindFor for the descriptor, and paints {tone, label} — so a new kind is a
// DATA row, zero code here (L090). The label is an in-SVG pill (same coord space as the path
// → camera-transform-safe, no overlay) that is clickable to cycle the meaning (Runway-grounded).
function EdgeLayer({ routes, edges, kinds, onCycleKind }: {
  routes: CompositionSnapshot['visible_edge_routes'];
  edges: EdgeConnection[];
  kinds: ConnectionKind[];
  onCycleKind: (edgeId: string) => void;
}) {
  const edgeById = new Map(edges.map((edge) => [edge.edge_id, edge] as const));
  return (
    <svg className="ca-edge-layer">
      {routes.map((route) => {
        const kind = connectionKindFor(edgeById.get(route.edge_id)?.kind, kinds);
        const d = route.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
        const mid = route.points[Math.floor(route.points.length / 2)] ?? route.points[0];
        const pillW = Math.round(kind.label.length * 6.6 + 18);
        return (
          <g key={route.edge_id} data-edge-id={route.edge_id} data-edge-kind={kind.id}>
            <path className="ca-edge-path" d={d} style={{ stroke: kind.tone }} />
            {mid ? (
              <g
                className="ca-edge-label"
                transform={`translate(${mid.x - pillW / 2}, ${mid.y - 10})`}
                role="button"
                aria-label={`Connection: ${kind.label}. Click to change the meaning.`}
                onClick={() => onCycleKind(route.edge_id)}
              >
                <rect className="ca-edge-label-bg" width={pillW} height={20} rx={10} />
                <text className="ca-edge-label-text" x={pillW / 2} y={14} textAnchor="middle" style={{ fill: kind.tone }}>
                  {kind.label}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

// The local scene/layout helper family was deleted here (plan §2 / Phase A1).
// It formed a second scene/layout engine inside the show layer — the exact
// documented 5x failure. The composition engine's snapshot reply is the only
// scene/layout truth. Do not reintroduce local scene math here; the package
// test suite greps this file and fails on the old symbol names.

// Duplicate-id / invalid-id / dangling-edge repair moved to the ONE pure load
// boundary normalizer (read-data/normalize-authored-document.ts) — the load path
// runs it before AND after component-instance resolution so no stored document
// can brick the engine handoff.

function cloneNode(node: SceneNode): SceneNode {
  return {
    ...node,
    props: node.props ? { ...node.props, style: cloneRecord(node.props.style) } : node.props,
    style: cloneRecord(node.style),
    children: (node.children ?? []).map(cloneNode),
  };
}

function cloneRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : undefined;
}

// L114: product UI must NEVER show internal runtime plumbing in error copy. A raw
// transport/engine error ("...SendRequestToBitfieldTarget(...) failed: slot invocation
// failed: status=3...") is meaningless and alarming to a writer. errorMessage is the
// SINGLE display gate: it returns the underlying text ONLY when that text is already
// humane (no technical signature); anything carrying engine/slot/transport internals,
// a stack frame, or a JS type error yields '' so the caller's own humane sentence (or
// HUMANE_LOAD_FALLBACK on the error card) stands alone. Every user-facing error string
// in this surface flows through here, so one gate sanitizes them all (L063).
const TECHNICAL_ERROR_SIGNATURE =
  /SendRequestToBitfieldTarget|slot invocation|\bstatus=\d|correlation|context=\{|envelope|\bpartition\b|dispatch|\bwasm\b|panic|\bEEAF\b|undefined is not|cannot read prop|TypeError|\bat .+:\d+:\d+/i;
const HUMANE_LOAD_FALLBACK = 'Something went wrong. Nothing was changed. Try again.';
function errorMessage(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).trim();
  return !raw || TECHNICAL_ERROR_SIGNATURE.test(raw) ? '' : sanitizeErrorText(raw, '');
}
// Append humane detail to a toast that already carries its own humane sentence — a
// single leading space when there is humane detail, nothing when the error was gated
// (so the toast never ends in a dangling " " or ": ").
function appendDetail(error: unknown): string {
  const detail = errorMessage(error);
  return detail ? ` ${detail}` : '';
}

// A producer run reports failure INSIDE its result payload (`error_code` set,
// `items` empty) — not via the separate error address. Return a human message
// when the payload is a failure, else null. The producer's `error_message` is
// often a full multi-line process traceback; the LAST non-empty line is the
// actual error (e.g. "urllib.error.HTTPError: HTTP Error 400: Bad Request"), so
// show that rather than the stack. Generic: reads only the two standard fields.
function resultFailureMessage(resultPayload: unknown): string | null {
  if (!isRecord(resultPayload)) return null;
  const code = resultPayload.error_code;
  if (code == null || code === '' || code === false) return null;
  const raw = typeof resultPayload.error_message === 'string' ? resultPayload.error_message.trim() : '';
  const lastLine = raw.split('\n').map((line) => line.trim()).filter(Boolean).pop();
  return sanitizeErrorText(
    lastLine || (typeof code === 'string' ? code : ''),
    'This could not be completed.',
  );
}

// The action rail is domain-blind. Workflow transport may retain a producer's
// result inside `reply`, while owner result records may expose the same generic
// references at their top level. Normalize only that stable opaque field; the
// destination owner remains the source for labels and state.
function actionResultRefsFromPayload(resultPayload: unknown): string[] {
  if (!isRecord(resultPayload)) return [];
  const candidates = [resultPayload.result_refs, isRecord(resultPayload.reply) ? resultPayload.reply.result_refs : undefined];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const ref of candidate) {
      if (typeof ref === 'string' && ref.length > 0) seen.add(ref);
    }
  }
  return [...seen];
}

// The condition value is typed as text but compared against real data — coerce
// to the natural type so `count > 0` (number) and `mode == "edit"` (string) both
// work: numeric strings → number, true/false → boolean, else the raw string.
function coerceConditionValue(raw: string): unknown {
  const text = raw.trim();
  if (text === '') return '';
  if (text === 'true') return true;
  if (text === 'false') return false;
  const asNumber = Number(text);
  return Number.isFinite(asNumber) && String(asNumber) === text ? asNumber : text;
}

// Honest creation only: a new page-feeling node starts blank (L117).
// It is a plain flow Container with one empty Text child — the same node
// shape as anything else in the tree; nothing page-specific exists.
// Default block spacing (B-44a). A new page's root flow carries a default `layout.gap` so
// stacked blocks breathe — the engine reads `gap` for flow placement (layout.rs), so this is the
// "default space between blocks" The owner found "too little" (a page with no gap stacks them flush).
// It is plain DATA: the gap is editable per-page via the block Spacing editor (the global default
// is just this value), and a future template could ship a different default with zero code change.
const DEFAULT_BLOCK_GAP = 10;
// Capable default for the empty-block placeholder (overridable via
// CompositionRuntimeConfig.block_placeholder — DATA). Names the real affordance
// ("/" opens the insert/command menu) rather than a bare "Write".
const DEFAULT_BLOCK_PLACEHOLDER = "Write, or press '/' for commands";
function freshFlowNode(): SceneNode {
  const id = `node:${crypto.randomUUID()}`;
  return {
    id,
    kind: 'Container',
    props: { style: { layout: { mode: 'flex', axis: 'y', gap: DEFAULT_BLOCK_GAP } } },
    visible: true,
    children: [
      { id: `node:${crypto.randomUUID()}`, kind: 'Text', props: { text: '' }, visible: true, children: [] },
    ],
  };
}

// Structural slash-menu blocks (Columns / Table / Panels) now live as FROZEN DATA in
// read-data/default-structural-materials.ts (#27) — spread into `materials` above and
// read through the SAME generic path as live material rows + components. A "Columns"
// block is just a scene node whose layout is mode:split; materialNode() regenerates ids
// on insert, so the records are templates, not instances. To offer a new built-in block
// (e.g. 3 columns), add a record THERE — zero surface code, OUTSIDE this consumer.

// Rail label = first non-empty text inside the subtree — a DISPLAY fallback
// only, never written anywhere. The heading text node IS the name.
function railLabel(node: SceneNode): string {
  const text = firstNonEmptyTextValue(node);
  return text ? readableInlineText(text) : 'Untitled page';
}

function readableInlineText(text: string): string {
  return parseInlineRuns(text).map(run => run.type === 'text' ? run.text : `@${run.label}`).join('');
}

function firstNonEmptyTextValue(node: SceneNode): string | null {
  const own = typeof node.props?.text === 'string' ? node.props.text.trim() : '';
  if (node.kind === 'Text' && own) return own;
  for (const child of node.children ?? []) {
    const found = firstNonEmptyTextValue(child);
    if (found) return found;
  }
  return null;
}

function firstTextNode(node: SceneNode): SceneNode | null {
  if (node.kind === 'Text') return node;
  for (const child of node.children ?? []) {
    const found = firstTextNode(child);
    if (found) return found;
  }
  return null;
}

function textFromNode(node: SceneNode | null): string {
  const value = node?.props?.text;
  return typeof value === 'string' ? value : '';
}

// Every Text node's text under `root`, in document order, blank-line joined —
// the page's content as a single prompt for a run-on-content action. `excludeId`
// drops the "/"-command block so its query never leaks into the prompt.
function collectPlainText(root: SceneNode | null, excludeId: string): string {
  if (!root) return '';
  const parts: string[] = [];
  const walk = (node: SceneNode) => {
    if (node.id === excludeId) return;
    if (node.kind === 'Text') {
      const text = textFromNode(node).trim();
      if (text) parts.push(text);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return parts.join('\n\n');
}

function propsForNode(node: SceneNode | null | undefined, nodeId: string): Record<string, unknown> {
  if (!node) return {};
  if (node.id === nodeId) return node.props ?? {};
  for (const child of node.children ?? []) {
    const props = propsForNode(child, nodeId);
    if (Object.keys(props).length > 0) return props;
  }
  return {};
}

// Hit-test the engine's frame rects for a drop location: the deepest
// container frame containing the point becomes the parent; the index is the
// position among its children whose engine rects sit above the point. Pure
// reads of snapshot truth — zero layout computation.
// Where a dragged block will land — self-describing DATA (L090): a `kind` discriminant the
// indicator and the drop handler both dispatch on. `sibling` = vertical placement among a
// parent's children (top/bottom); `split` = wrap a target block in a horizontal split so the
// dragged block sits beside it (left/right columns). Adding a placement mode = a new variant +
// its geometry, never scattered branches.
type DropPlacement =
  | { kind: 'sibling'; parentId: string; index: number }
  | { kind: 'split'; targetId: string; side: 'left' | 'right' };

function dropPlacementAt(
  snapshot: CompositionSnapshot,
  draggedId: string,
  point: { x: number; y: number },
): DropPlacement | null {
  const tree = snapshot.tree;
  if (!tree) return null;
  const within = (id: string) => {
    const rect = snapshot.frames[id]?.rect;
    return !!rect && point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h;
  };
  // Deepest container under the pointer, excluding the dragged subtree (skipping the dragged
  // node also means we never descend INTO it — the target is always outside the dragged subtree).
  let parent: SceneNode = tree;
  let descended = true;
  while (descended) {
    descended = false;
    for (const child of parent.children ?? []) {
      if (child.id === draggedId) continue;
      if (child.kind !== 'Text' && child.kind !== 'Component' && within(child.id)) {
        parent = child;
        descended = true;
        break;
      }
    }
  }
  const siblings = (parent.children ?? []).filter((child) => child.id !== draggedId);
  // The block the pointer's row is over. Its LEFT/RIGHT edge band is the side-drop zone:
  // aiming near a block's side edge wraps it in a split (Notion/Craft columns). The band is a
  // capped fraction of the block width, so left/right is an intentional side-aim — the broad
  // middle stays vertical placement.
  const hovered = siblings.find((child) => {
    const rect = snapshot.frames[child.id]?.rect;
    return !!rect && point.y >= rect.y && point.y <= rect.y + rect.h;
  });
  if (hovered) {
    const rect = snapshot.frames[hovered.id]?.rect;
    if (rect) {
      const band = Math.min(rect.w * 0.25, 72);
      if (point.x < rect.x + band) return { kind: 'split', targetId: hovered.id, side: 'left' };
      if (point.x > rect.x + rect.w - band) return { kind: 'split', targetId: hovered.id, side: 'right' };
    }
  }
  // Vertical placement: insert as a sibling before/after by the row midpoint.
  let index = siblings.length;
  for (const [position, child] of siblings.entries()) {
    const rect = snapshot.frames[child.id]?.rect;
    if (rect && point.y < rect.y + rect.h / 2) {
      index = position;
      break;
    }
  }
  return { kind: 'sibling', parentId: parent.id, index };
}

// A blank text node — the unit every insertion verb starts from (L117:
// honest empty, no fake content).
function blankTextNode(): SceneNode {
  return { id: `node:${crypto.randomUUID()}`, kind: 'Text', props: { text: '' }, visible: true, children: [] };
}

// A text node carrying content (used by the AI-markdown autoformat expansion).
function autoformatTextNode(text: string, id?: string): SceneNode {
  return { id: id ?? `node:${crypto.randomUUID()}`, kind: 'Text', props: { text }, visible: true, children: [] };
}

function findNodeById(root: SceneNode | null, nodeId: string): SceneNode | null {
  if (!root) return null;
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const found = findNodeById(child, nodeId);
    if (found) return found;
  }
  return null;
}

function parentLocation(root: SceneNode, nodeId: string): { parentId: string; index: number } | null {
  for (const [index, child] of (root.children ?? []).entries()) {
    if (child.id === nodeId) return { parentId: root.id, index };
    const found = parentLocation(child, nodeId);
    if (found) return found;
  }
  return null;
}

// A split-rooted block (Columns, and Table whose root is a Y-split) FILLS its parent in
// the engine (LayoutMode::Split => parent_constraints.max, kernel/layout.rs), so dropped
// into an UNSIZED document-flow page it grabs the whole viewport height — the "really
// large gap below the block" defect. A placeable Component already carries an explicit
// height, and a flex panel-group hugs; only a split needs help. Stamp ONE default card
// height on a split-rooted block that lacks an explicit height so it lands as a card in
// flow. In a SIZED parent (split column / panel) the engine IGNORES this height and the
// parent fraction sizes the child (place_split_children), so this never regresses sized
// layouts. (Default lives here for now; task #27 moves the structural catalog — and this
// default — to DATA descriptor rows.)
const FLOW_CARD_HEIGHT = 320;
function withFlowCardHeight(node: SceneNode): SceneNode {
  const style = (node.props?.style ?? {}) as Record<string, unknown>;
  if (!isSplitNode(node) || style.height != null) return node;
  return { ...node, props: { ...node.props, style: { ...style, height: FLOW_CARD_HEIGHT } } };
}

function materialNode(material: MaterialDescriptor): SceneNode {
  return withFlowCardHeight(freshIds(cloneNode(material.node)));
}

// The self-reference sentinel a MATERIAL template puts in a descendant's
// `visible` binding path to mean "the nearest FSM-owning ancestor's id". The
// read side (engine `SelectSource::Fsm`) is an ABSOLUTE key = the owner node's
// id, but a template's owner id is minted at insert — so the sentinel is
// resolved here, in `freshIds`, to the freshly-minted owner id. This is the
// authoring half of the interactive-block primitive (to-do / toggle / accordion):
// the WRITE side needs no id (click dispatches to the clicked node's own id),
// only the READ side needs the owner id, resolved once at insert (never at eval).
const SELF_FSM_TOKEN = '$selfFsm';

// Rewrite a node's `visible` binding whose fsm path is the self-sentinel to the
// concrete owner id in scope. Leaves every other visibility (bool / non-fsm /
// concrete-path binding) untouched. Pure, allocation-free when nothing matches.
function resolveSelfFsm(visible: SceneNode['visible'], selfFsmId: string | undefined): SceneNode['visible'] {
  if (!selfFsmId || !visible || typeof visible === 'boolean' || visible.$kind !== 'binding') return visible;
  const select = visible.select as { from?: string; path?: string } | undefined;
  if (!select || select.from !== 'fsm' || select.path !== SELF_FSM_TOKEN) return visible;
  return { ...visible, select: { ...select, path: selfFsmId } };
}

// Each insertion gets fresh node ids so the same material can be inserted
// any number of times (template, not instance). While re-minting, thread the
// current FSM owner's NEW id down the subtree so descendant `$selfFsm` bindings
// resolve to their own instance's owner (interactive-block primitive).
function freshIds(node: SceneNode, selfFsmId?: string): SceneNode {
  const newId = `node:${crypto.randomUUID()}`;
  // If THIS node owns an inline FSM, it becomes the self-fsm anchor for its subtree.
  const ownFsmId = node.fsm ? newId : selfFsmId;
  return {
    ...node,
    id: newId,
    visible: resolveSelfFsm(node.visible, ownFsmId),
    children: (node.children ?? []).map((child) => freshIds(child, ownFsmId)),
  };
}

function componentLabel(node: SceneNode): string {
  const custom = isRecord(node.props?.custom) ? node.props.custom : {};
  return stringValue(custom.label)
    ?? stringValue(node.props?.component_id)
    ?? 'Untitled';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function sceneNodeIdSet(root: SceneNode | null): ReadonlySet<string> {
  const ids = new Set<string>();
  const stack = root ? [root] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || ids.has(node.id)) continue;
    ids.add(node.id);
    for (const child of node.children ?? []) stack.push(child);
  }
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Flattens a normalized feed's rows (see normalize-feed-rows.ts) into the shared
// {address, payload} shape resolveAskFieldOptions consumes. Shared by every feed this
// surface reads (the scoped content pool AND the scoped titled pool) so a new feed never
// needs its own bespoke parsing — one flatten function, N feed sources (L043).
function feedRowsToOptionSourceRecords(rows: unknown): OptionSourceRecord[] {
  const out: OptionSourceRecord[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue;
    const nestedRecord = isRecord(row.record) ? row.record : null;
    const address = typeof row.address === 'string' ? row.address
      : (nestedRecord && typeof nestedRecord.address === 'string' ? nestedRecord.address : undefined);
    const payload = isRecord(row.payload) ? row.payload
      : typeof row.payload === 'string' && row.payload.trim().startsWith('{')
        ? (() => { try { const p = JSON.parse(row.payload as string); return isRecord(p) ? p : null; } catch { return null; } })()
        : null;
    if (!payload) continue;
    out.push({ address, payload });
  }
  return out;
}

export const DOCUMENTS_SURFACE_CSS = `
/* Drag pickup chrome (The owner: "see it getting picked up and dragged"). While a block drags,
   the whole surface shows a grabbing cursor and a floating ghost chip follows the pointer
   (the dragged block itself is dimmed via opacity-40 on its frame). */
.ca-root[data-dragging] {
  cursor: grabbing;
}
.ca-root[data-dragging] * {
  cursor: grabbing !important;
}
.ca-drag-ghost {
  position: fixed;
  z-index: 50;
  pointer-events: none;
  max-width: 220px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  padding: 5px 10px;
  border-radius: 8px;
  background: var(--black-rich, #17171b);
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.14));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  color: var(--text-primary, #f4f4f4);
  font-size: 12.5px;
  opacity: 0.92;
}

.ca-root {
  --stage-inset-left: 0px;
  --stage-inset-right: 0px;
  --stage-inset-top: 0px;
  --stage-inset-bottom: 0px;
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  color: var(--text-primary, #f4f4f4);
  background: transparent;
  overflow: hidden;
  /* DragHandleMenu (shared ui) paints its open menu with bg-[var(--glass-bg-strong)],
     a token the screen-look theme does not define -> the menu was transparent. Supply
     it in our scope (CSS custom props inherit to the menu rendered inside the stage):
     prefer the real popover glass token, fall back to a near-solid dark. (Proper fix =
     define --glass-bg-strong in screen-look OR point DragHandleMenu at --glass-bg-popover;
     both are hook-blocked ui/screen-look edits — flagged.) */
  --glass-bg-strong: var(--glass-bg-popover, rgba(18, 18, 20, 0.96));
  /* The block-grip gutter (B-44c): the host reserves this much space to the LEFT of the
     content plane so every block's [+]/drag grip sits beside the block, never inside its
     box — for text AND containers alike. The flow content plane is inset by this and the
     engine viewport shrinks to match (no overflow). Narrows on phones where the grip is
     hover-only (touch has no hover) so it doesn't eat a touch layout. */
  --ca-gutter: 44px;
}

/* The .ca-rail rules are gone. Rail chrome, row anatomy, hover highlight and the
   active-row treatment now belong to the owned sidebar in packages/sidebar, so
   Documents no longer paints a second sidebar look that can drift from the real
   one. The Amie row anatomy The owner asked for (the ROW is the single hovered
   container, the label paints no second background, the actions reveal inside
   that container) is the owned sidebar's row behaviour, applied everywhere at
   once instead of only here. */

.ca-main {
  position: relative;
  margin-left: var(--stage-inset-left, 0px);
  margin-right: var(--stage-inset-right, 0px);
  margin-top: var(--stage-inset-top, 0px);
  margin-bottom: var(--stage-inset-bottom, 0px);
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.ca-title {
  padding: 16px 22px 0;
}

.ca-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 22px 0;
}

.ca-stage {
  position: relative;
  flex: 1;
  margin: 14px 22px 22px;
  overflow: auto;
  /* The stage is programmatically focusable (tabIndex=-1: Cmd+A escalation moves
     focus here so the NEXT keydown still reaches the page — WKWebView drops the
     key first-responder on a bare blur). That focus is an implementation seam,
     not a user-facing selection: the browser's default focus ring drew a blue
     border around the ENTIRE page, reading as "everything is an input". The
     selection WASH on the chosen blocks is the visible state; the stage shows
     no chrome of its own. */
  outline: none;
  /* Reserve the scrollbar gutter ALWAYS so a vertical scrollbar appearing can't
     shrink clientWidth — that would change the measured viewport and re-fire the
     reflow ResizeObserver (Codex Q3). With the gutter stable, the engine viewport
     is a pure function of the stage's layout box, not its scroll state. */
  scrollbar-gutter: stable;
  background: transparent;
}

/* Canvas mode: the camera is the ONLY navigation (Codex free-pan Q2) — native
   scroll would fight the camera-pan, so hide it; grab cursor signals pannability. */
.ca-stage-canvas {
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  /* Infinite-canvas dot grid (Mobbin: ClickUp / Dovetail / Stitch / Figma all
     paint one). Longhands -- NOT the background shorthand -- so the inline
     world-anchored background-position (offset by -pan, set per-render on the
     stage) composes; the grid then scrolls WITH the engine-offset frames and
     reads as one continuous infinite plane rather than a fixed screen texture. */
  background-image: radial-gradient(circle, var(--canvas-grid-dot, rgba(255, 255, 255, 0.10)) 1.2px, transparent 1.4px);
  background-size: 24px 24px;
}
.ca-stage-canvas:active {
  cursor: grabbing;
}

/* Canvas HUD + minimap slots (B-46): screen-fixed chrome anchored to the stage's
   bottom corners. They are siblings of the transformed .ca-content-plane, so they
   never pan/zoom with the world. The stage clips them with overflow:hidden; in
   canvas mode the stage never scrolls, so bottom-anchored = always in view. */
.ca-canvas-hud-slot {
  position: absolute;
  left: 16px;
  bottom: 16px;
  z-index: 30;
}
.ca-canvas-minimap-slot {
  position: absolute;
  right: 16px;
  bottom: 16px;
  z-index: 30;
}

/* The content plane (B-44c): the engine-coordinate origin, inset from the stage's
   left by the grip gutter in FLOW mode. width = 100% - gutter so the engine viewport
   (measured on THIS element via attachStage) shrinks to match and flow content never
   spills into the gutter. height:100% so the vertical viewport equals the stage. It is
   position:relative = the positioned ancestor for every abspos SceneFrame, so the grip
   (right: calc(100% + 2px)) lands in the gutter to its left. */
.ca-content-plane {
  position: relative;
  height: 100%;
  margin-left: var(--ca-gutter);
  width: calc(100% - var(--ca-gutter));
}
/* Canvas mode: gutter = 0 (identity wrapper) — free-positioned nodes pan on the
   infinite plane, no document gutter; the plane is a transparent passthrough. */
.ca-content-plane-canvas {
  margin-left: 0;
  width: 100%;
}

/* The per-block grip ([+] + drag handle), reveal-on-hover. Positioned in the LEFT
   GUTTER beside the block (Mobbin: Notion / Craft / Threads block grips live in a left
   gutter, never inside the block). right:calc(100% + 2px) puts its right edge 2px
   left of the frame, so it sits beside ANY node — text or container — with zero per-kind
   logic. The --ca-gutter reserves enough room that it never clips the stage. */
.ca-grip {
  position: absolute;
  right: calc(100% + 2px);
  top: 2px;
  z-index: 10;
}
/* Lane-inset grip (a split/column child whose gutter is occupied): it floats OVER the
   block's own first line, so it needs its OWN surface — transparent dots mixed into
   glyphs read as broken paint (image #70). Every reference floating control (Notion's
   column handle) carries an opaque pill when it can sit over content. Hover-only
   reveal is unchanged; at rest nothing covers the text. */
.ca-grip-inset {
  background: var(--glass-bg-strong, rgba(28, 28, 34, 0.92));
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  padding: 0 1px;
  backdrop-filter: blur(8px);
  /* The pill surface must follow the same hover-reveal as its buttons: the
     background lives on the grip CONTAINER (outside HoverRevealItem), so without
     this it paints an opaque box over the block's first line at rest. */
  opacity: 0;
  transition: opacity 150ms;
}
[class~="group/hover-reveal"]:hover .ca-grip-inset,
[class~="group/hover-reveal"]:focus-within .ca-grip-inset {
  opacity: 1;
}

/* Canvas page-cards (#38): a top-level node positioned on the canvas reads as a CARD
   (ClickUp / Fibery / Figma frames). SceneFrame is a BLIND positioner (zero visual
   styling by contract), so the card surface is host chrome here — scoped to canvas
   view AND to the framed root's DIRECT children (the pages), so document view and
   nested blocks are untouched. Pure CSS over the engine frame: the card surface IS
   the frame, so it tracks position under pan/zoom for free — no overlay, no coordinate
   math, no node-style pollution (which SceneFrame would ignore anyway). The
   .ca-content-plane segment is REQUIRED: B-44c nests the scene one level inside the
   plane (the camera-transform / grip-gutter origin), so the framed root is the plane's
   child, and the page-cards are its grandchildren. */
.ca-stage-canvas > .ca-content-plane > [data-node-id] > [data-node-id] {
  background: var(--black-rich, #141414);
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
}

@media (max-width: 720px) {
  .ca-root {
    flex-direction: column;
    /* Touch has no hover, so the grip never reveals on a phone — reclaim the gutter
       width for content (the grip gutter is a pointer/desktop affordance). */
    --ca-gutter: 16px;
  }
  /* The phone rail rules are gone with the rest of the rail. Turning it into a
     scrolling horizontal strip was the best a CSS-only fallback could do. The
     owned sidebar ships a real mobile presentation with a focus trap, a scroll
     lock and a close control, so Documents no longer needs a phone rule here. */
}

.ca-node {
  position: absolute;
  box-sizing: border-box;
}

.ca-container-node {
  pointer-events: none;
}

.ca-text-node {
  display: block;
  pointer-events: auto;
  overflow: visible;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary, #f4f4f4);
  font: inherit;
  min-width: 160px;
  /* One line tall, not a hardcoded 34px slab. min-height = exactly one line-height so
     an EMPTY block stays clickable but a one-line block carries ZERO dead space below
     its text (the "why is there this much space below a block" defect). Extra space is
     the user's to add per block via margin (engine-honored DATA), never forced here. */
  line-height: 1.7;
  min-height: 1.7em;
  /* No left gutter padding here anymore: the grip gutter is now a UNIVERSAL host
     gutter (the content plane is inset, the grip sits in it for every node type), so
     text aligns with container content instead of carrying its own per-type inset (B-44c). */
  padding: 1px 0;
  caret-color: var(--text-primary, #f4f4f4);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Placeholder shows ONLY on the block you are actively editing while it is empty
   (Notion/Craft: the caret's block, not every empty block). :focus = the caret is
   in this contenteditable; [data-empty=true] = text-empty per the editor's own
   readBlockText, NOT the CSS :empty pseudo — a focused contentEditable keeps a stray
   br after you type+backspace, so :empty goes false and the hint vanishes forever.
   The surface stamps data-empty from readBlockText on focus/input, so the hint
   tracks real text-emptiness. A resting/unfocused empty block shows nothing. */
.ca-text-node:focus[data-empty="true"] {
  /* Anchor for the OUT-OF-FLOW hint below. relative with no offsets = zero layout change. */
  position: relative;
}
.ca-text-node:focus[data-empty="true"]::before {
  content: attr(data-placeholder);
  color: var(--text-tertiary, rgba(244, 244, 244, 0.42));
  pointer-events: none;
  /* The hint is overlay CHROME, so it lives OUT OF THE LAYOUT FLOW — this one property is
     the category fix for every hint-vs-content interaction: an in-flow ::before either
     wraps (spills over the block below) or, as display:block, TAKES the first line box and
     pushes the caret's empty line BELOW the hint (the "caret is on the line below the
     placeholder" defect). Absolutely positioned, the hint paints over the block's own
     first line while the caret owns that same line at offset 0 — hint and caret coexist,
     and the hint is invisible to layout (scrollHeight, engine frames, siblings) forever. */
  position: absolute;
  top: 1px; /* = the block's own vertical padding, so the hint sits exactly on the text line */
  left: 0;
  right: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ca-text-node:focus {
  outline: none;
}

.ca-component-node {
  display: grid;
  place-items: center;
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.12));
  border-radius: 16px;
  background: var(--glass-bg-secondary, rgba(255, 255, 255, 0.06));
  color: var(--text-secondary, rgba(244, 244, 244, 0.72));
}

.ca-edge-layer {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
  color: var(--text-tertiary, rgba(244, 244, 244, 0.36));
}

.ca-edge-layer path {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
}

/* Connection MEANING pill (#37): an in-SVG label that is clickable (the layer is
   pointer-events:none, the pill opts back IN) to cycle the connection's kind. */
.ca-edge-label {
  pointer-events: auto;
  cursor: pointer;
}
.ca-edge-label-bg {
  fill: rgba(20, 20, 22, 0.92);
  stroke: rgba(255, 255, 255, 0.10);
  stroke-width: 1;
}
.ca-edge-label:hover .ca-edge-label-bg {
  fill: rgba(34, 34, 38, 0.96);
}
.ca-edge-label-text {
  font-size: var(--font-size-caption);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.ca-format-bar {
  position: absolute;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  background: color-mix(in srgb, var(--black-rich, #141414) 78%, transparent);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(28px) saturate(1.4);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
  /* When the bar is capped to a narrow viewport (max-width set in JS), the buttons
     scroll horizontally instead of overflowing — single-row scrollable format bar
     (Apple Notes / Universe mobile). Scrollbar hidden for the clean floating look. */
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.ca-format-bar::-webkit-scrollbar { display: none; }
.ca-format-btn { flex: 0 0 auto; }

.ca-format-sep {
  width: 1px;
  align-self: stretch;
  margin: 3px;
  background: var(--border-primary, rgba(255, 255, 255, 0.10));
}

.ca-format-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  padding: 0 7px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, rgba(244, 244, 244, 0.78));
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
}

.ca-format-btn:hover {
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.08));
  color: var(--text-primary, #f4f4f4);
}

.ca-format-btn-active {
  background: var(--glass-bg-active, rgba(255, 255, 255, 0.16));
  color: var(--text-primary, #f4f4f4);
}

/* Swatch trigger indicator — a small round chip showing the active colour (or a
   rainbow conic-gradient when none is set = "pick a colour"). */
.ca-format-swatch-indicator {
  display: inline-block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
}

/* Swatch popover — a sibling of the bar (escapes its overflow), glassmorphic like the
   bar, a wrapping grid of colour chips. */
.ca-format-swatches {
  position: absolute;
  z-index: 7;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: min(296px, calc(100% - 16px));
  padding: 10px;
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  background: color-mix(in srgb, var(--black-rich, #141414) 82%, transparent);
  box-shadow: 0 16px 44px rgba(0, 0, 0, 0.46), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(28px) saturate(1.4);
  -webkit-backdrop-filter: blur(28px) saturate(1.4);
}
.ca-format-swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
}
.ca-format-swatch-chip {
  display: inline-block;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.22);
}
.ca-format-swatch-active {
  box-shadow: inset 0 0 0 2px var(--text-primary, #f4f4f4);
}

.ca-ref-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px 1px 4px;
  margin: 0 1px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent-blue, #4f8cff) 16%, transparent);
  color: var(--accent-blue, #4f8cff);
  font-weight: 500;
  line-height: 1.35;
  white-space: nowrap;
  vertical-align: baseline;
  cursor: default;
  user-select: none;
}
.ca-ref-chip-ico { font-size: 0.85em; opacity: 0.8; }
.ca-ref-chip-label { color: inherit; }

/* Composer CONTENT layout only. The floating shell (portal, position, opaque surface,
   radius, shadow) is the shared AnchoredOverlay primitive — no package-local popover
   chrome (Package UI Reference Lock / no custom styling where a ui primitive owns it).
   The ACCENT WASH is layered over the overlay's opaque surface: the same translucent
   accent fill as block selection (SceneFrame's wash — user: the Ask-AI area should be
   that color, not plain black). Same color-mix recipe, same live token. */
.ca-composer {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 320px;
  max-width: min(560px, 80vw);
  padding: 8px 10px;
  border-radius: var(--radius-lg, 12px);
  background: color-mix(in srgb, var(--accent-blue, #4c8dff) 17%, transparent);
}
.ca-composer-input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 20px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary, #f2f2f5);
  font-size: 14px;
  line-height: 20px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Placeholder for the empty contentEditable composer (an input's ::placeholder doesn't apply). */
.ca-composer-input:empty::before {
  content: attr(data-placeholder);
  color: var(--text-ghost, rgba(255, 255, 255, 0.4));
  pointer-events: none;
}
/* The Ask-AI run control is the shared ui Button (variant=primary) — no bespoke button CSS. */
/* Menu/picker CONTENT: the floating shell (portal, fixed position, layer) is the shared
   AnchoredOverlay; this styles only the listbox surface itself. */
.ca-menu {
  display: flex;
  flex-direction: column;
  width: min(300px, 80vw);
  /* Bounded height (The owner: "way too tall compared to notion") — the catalog scrolls inside
     instead of growing the popover. Notion caps near min(60vh). */
  max-height: min(58vh, 408px);
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.14));
  border-radius: 14px;
  /* OPAQUE (The owner: "the popover for the slash menu is still transparent") — a solid surface,
     no color-mix transparency, no backdrop blur to see through. */
  background: var(--black-rich, #17171b);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  padding: 6px;
  overflow: hidden;
}

/* The scrolling catalog region. Footer (Close) lives OUTSIDE this and stays pinned. */
.ca-menu-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* Top/bottom opacity fade as you scroll (The owner referenced the record-audio/video review
     list) — the first/last rows dissolve into the chrome rather than a hard clipped edge. */
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  scrollbar-width: thin;
}

.ca-menu-group + .ca-menu-group {
  margin-top: 2px;
}

.ca-menu-section {
  padding: 8px 10px 4px;
  color: var(--text-tertiary, rgba(244, 244, 244, 0.42));
  font-size: var(--font-size-caption);
  font-weight: 600;
  letter-spacing: 0.10em;
  text-transform: uppercase;
}

.ca-menu-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-primary, #f4f4f4);
  padding: 7px 10px;
  text-align: left;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
}

.ca-menu-row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  text-align: left;
  font: inherit;
}

.ca-menu-row-configure {
  flex: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary, rgba(244, 244, 244, 0.58));
  padding: 3px 5px;
  font: inherit;
  font-size: var(--font-size-caption);
}

.ca-menu-row-configure:hover,
.ca-menu-row-configure:focus-visible {
  background: var(--glass-bg-active, rgba(255, 255, 255, 0.14));
  color: var(--text-primary, #f4f4f4);
}

.ca-menu-ico {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--text-secondary, rgba(244, 244, 244, 0.78));
  font-size: 12px;
  flex: none;
}

.ca-menu-label {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ca-menu-row-active,
.ca-menu-row:hover {
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.09));
}

.ca-menu-row-active .ca-menu-ico,
.ca-menu-row:hover .ca-menu-ico {
  background: var(--glass-bg-active, rgba(255, 255, 255, 0.14));
  color: var(--text-primary, #f4f4f4);
}

/* Config disclosure panel content: human option rows (label + what it runs on +
   description) and the writing-instructions preamble (visible + editable). Same
   ca-menu shell as / and @ — these style only the row INTERNALS. */
.ca-config {
  width: min(400px, 86vw);
}
.ca-config-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
.ca-config-option-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.ca-config-annotation {
  margin-left: auto;
  flex: none;
  color: var(--text-ghost, rgba(255, 255, 255, 0.4));
  font-size: var(--font-size-caption);
  font-weight: 500;
}
.ca-config-description {
  color: var(--text-dim, rgba(244, 244, 244, 0.55));
  font-size: 12px;
  font-weight: 400;
  line-height: 1.35;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.ca-config-preamble {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-dim, rgba(244, 244, 244, 0.55));
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  white-space: normal;
}
.ca-config-preamble-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 10px 10px;
}
.ca-config-preamble-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.ca-menu-empty {
  padding: 12px;
  color: var(--text-tertiary, rgba(244, 244, 244, 0.48));
  font-size: 13px;
}

.ca-menu-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  margin-top: 4px;
  padding: 7px 8px 4px 10px;
  border-top: 1px solid var(--border-primary, rgba(255, 255, 255, 0.08));
  color: var(--text-tertiary, rgba(244, 244, 244, 0.42));
  font-size: var(--font-size-caption);
}

.ca-menu-hint {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* Clickable Close affordance (The owner: "they also have a fixed closed text button"). The
   shortcut label inside is sourced from the dismiss keymap row, never hardcoded twice. */
.ca-menu-close {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  border: 0;
  border-radius: 7px;
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--text-secondary, rgba(244, 244, 244, 0.74));
  padding: 4px 8px;
  font: inherit;
  font-size: var(--font-size-caption);
  font-weight: 500;
  cursor: pointer;
}

.ca-menu-close:hover {
  background: var(--glass-bg-active, rgba(255, 255, 255, 0.13));
  color: var(--text-primary, #f4f4f4);
}

.ca-menu-foot kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  margin-right: 2px;
  border-radius: 4px;
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.08));
  font-family: inherit;
  font-size: var(--font-size-caption);
}

/* A collapsed panel's spine — a thin vertical rail filling the 36px engine frame.
   Fills via width/height:100% (frame-relative) rather than absolute inset so it
   stays confined to the frame regardless of the frame's positioning context. */
.ca-panel-spine {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.04));
  border-radius: 8px;
  overflow: hidden;
}
.ca-panel-spine-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: var(--black-rich, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, inherit);
  cursor: pointer;
}
.ca-panel-spine-expand:hover {
  background: var(--glass-bg-hover, rgba(255, 255, 255, 0.12));
}
.ca-panel-spine-title {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  font-size: var(--font-size-caption);
  line-height: 1;
  color: var(--text-ghost, rgba(255, 255, 255, 0.6));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-height: calc(100% - 40px);
  letter-spacing: 0.02em;
}
`;
