import React from 'react';
import { Container, ErrorBoundary, FloatingMaterialFrame, mountReactSurface, Spinner, Text } from '../../../../ui';
import { ToastProvider } from '../../../../ui/show/toast';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { bitfieldGeneratedLiveReadScopeDescriptor } from 'tools/documents/.bitfield-entry-scope/documents/runtime-kit-react';
import { readSurfaceIntentReaderConfig } from '../../../../ui/show/placeable-surface-intent';
import { ViewerAccessRefsProvider } from '../../../../ui/show/placeable-surface-intent';
import { DocumentsSurface } from './DocumentsSurface';
import { defaultProjectionRunners } from '../do-work/projection-runners-pack';
import { sendCompositionTransaction } from '../do-work/send-composition-transaction';
import type { CompositionTransaction } from '../read-data/documents';
import {
  createCompositionDocumentsLogStore,
  readServingCompositionRuntimeConfig,
  DOCUMENTS_ADDRESS,
  type CompositionDocumentsLogStore,
} from '../do-work/write-composition-documents';
import { createApplyScenePatchOperation, type ApplyScenePatchRequest } from '../do-work/apply-scene-patch';
import {
  readCompositionContent,
  readCompositionRuntimeConfig,
  readInlineMarks,
  readInputShortcuts,
  readInputShortcutsFull,
  type CompositionContent,
  type SceneNode,
} from '../read-data/documents';
import { readSelectionOps } from '../../../../documents/read-data/selection-ops';
import { readCursorCommands } from '../../../../documents/read-data/cursor-commands';
import { normalizeFeedRows } from '../../../read-data/feed-rows';

export function createMountedDocumentsScenePatch(
  store: CompositionDocumentsLogStore,
  partitionLabel: string,
  documentRef: string,
  addressMode: 'label-hash' | 'identity-text',
) {
  const apply = createApplyScenePatchOperation({
    partitionLabel, documentRef, readClockMs: Date.now,
    // This is the editor's existing CAS store, including its save timestamp.
    createStore: () => store,
  });
  return (input: ApplyScenePatchRequest) => {
    const mode = addressMode === 'identity-text' ? 'identity_text' : 'label_hash';
    if (input.scene_address_mode !== undefined && input.scene_address_mode !== mode) {
      throw new Error('scene_address_mode must match the mounted document');
    }
    return apply({ ...input, scene_address_mode: mode });
  };
}

// Filter the generic published-record rows to one address's payload rows.
function rowsAt(raw: unknown, address: string): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((row) => {
    if (typeof row !== 'object' || row === null) return false;
    return (row as Record<string, unknown>).address === address;
  });
}

// Address-NAMESPACE gather: every row at `base` OR under `base.<namespace>`.
// The insert-menu material catalog is a MERGE POINT — the base structural
// materials (this package) and any other package's contributed materials
// (e.g. request-intake's form-field blocks) must coexist. A single shared
// address collides in the one-current-per-address fold (last writer wins,
// the SSOT bug that hid the form-field palette), so each contributor owns its
// OWN sub-address `documents.material-descriptors.<ns>` and the
// menu reads the whole namespace here. Adding a material family = one DATA
// record at a new sub-address, ZERO code here (L063 category fix / L090).
function rowsAtNamespace(raw: unknown, base: string): unknown[] {
  if (!Array.isArray(raw)) return [];
  const prefix = `${base}.`;
  return raw.filter((row) => {
    if (typeof row !== 'object' || row === null) return false;
    const address = (row as Record<string, unknown>).address;
    return typeof address === 'string' && (address === base || address.startsWith(prefix));
  });
}


type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

export function readDocumentsMountInput(props: Record<string, unknown>): Record<string, unknown> {
  return props.surfaceInput && typeof props.surfaceInput === 'object' && !Array.isArray(props.surfaceInput)
    ? props.surfaceInput as Record<string, unknown>
    : props;
}

export function resolveMountedDocumentsRuntimeConfig(
  publishedRows: unknown[],
  directValue: unknown,
  directReadResolved: boolean,
  directReadFailed: boolean,
  generatedPartitionLabel: string | undefined,
) {
  if (publishedRows.length > 0) return readCompositionRuntimeConfig(publishedRows, undefined);
  if (!directReadResolved || directReadFailed) return null;
  return readCompositionRuntimeConfig(directValue, generatedPartitionLabel);
}

function DocumentsMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceInput = readDocumentsMountInput(props);
  return (
    <FloatingMaterialFrame frame={props.floating_frame} className="h-full min-h-0 overflow-hidden">
      <ToastProvider>
        <ErrorBoundary zoneName="documents material">
          <ViewerAccessRefsProvider>
            <DocumentsData surfaceInput={surfaceInput} />
          </ViewerAccessRefsProvider>
        </ErrorBoundary>
      </ToastProvider>
    </FloatingMaterialFrame>
  );
}

function DocumentsData({ surfaceInput }: { surfaceInput?: Record<string, unknown> }) {
  // Derive the scene address from surfaceInput; default to the standalone documents address.
  const sceneAddress = (surfaceInput?.scene_address as string) ?? DOCUMENTS_ADDRESS;
  const sceneAddressMode = surfaceInput?.scene_address_mode === 'identity_text' ? 'identity-text' : 'label-hash';

  // Two SCOPED sink feeds replace the whole multi-MB published-records
  // aggregate here (the aggregate stays the fold's truth; these are
  // engine-maintained kind/address-scoped derivations of the SAME fold —
  // record_from_matching_records DATA rows, zero code):
  //  - ca-owned-feed: every row whose address names this package
  //    (runtime-config, documents, material-descriptors, spacing-fields, …)
  //  - ca-registry-feed: the cross-package registry kinds this surface folds
  //    (input-shortcut/-set, inline-mark/-set, selection-op/-set,
  //    cursor-command/-set, placeable-surface, composition-empty-state,
  //    composition-material-defaults)
  // A new registry rule from ANY package still lands with zero code — the
  // sink's kind list is DATA in things-to-store-and-run.json.
  const ownedRows = useBitfieldData('ca-owned-feed');
  const documentIndexRows = useBitfieldData('ca-document-index-feed');
  const registryRowsRaw = useBitfieldData('ca-registry-feed');
  const publishedRows = React.useMemo(() => normalizeFeedRows(ownedRows), [ownedRows]);
  const registryRows = React.useMemo(() => normalizeFeedRows(registryRowsRaw), [registryRowsRaw]);
  const runtimeConfigRows = React.useMemo(
    () => rowsAt(publishedRows, 'package::documents::runtime-config'), [publishedRows]);
  const [directRuntimeConfig, setDirectRuntimeConfig] = React.useState<unknown>(null);
  const [directRuntimeConfigResolved, setDirectRuntimeConfigResolved] = React.useState(false);
  const [runtimeConfigError, setRuntimeConfigError] = React.useState(false);
  React.useEffect(() => {
    if (runtimeConfigRows.length > 0) return;
    let cancelled = false;
    readServingCompositionRuntimeConfig()
      .then((value) => { if (!cancelled) { setDirectRuntimeConfig(value); setDirectRuntimeConfigResolved(true); } })
      .catch(() => { if (!cancelled) { setRuntimeConfigError(true); setDirectRuntimeConfigResolved(true); } });
    return () => { cancelled = true; };
  }, [runtimeConfigRows]);
  // Documents are the authoritative scene content (the surface ALSO loads them
  // live via loadDocuments=store.read with basis tracking; these rows are the
  // first-paint seed). Address moved authored-scene-content -> documents.
  const documentRows = React.useMemo(
    () => rowsAt(publishedRows, sceneAddress), [publishedRows, sceneAddress]);
  const materialRows = React.useMemo(
    () => rowsAtNamespace(publishedRows, 'documents.material-descriptors'), [publishedRows]);
  // Numeric box-spacing fields a package may publish as DATA (e.g. add a border-radius
  // stepper). Absent → the surface falls back to the built-in SPACING_FIELDS seed.
  const spacingFieldRows = React.useMemo(
    () => rowsAt(publishedRows, 'documents.spacing-fields'), [publishedRows]);
  const placeableSurfaceRows = registryRows;
  // Input-shortcut registry (# -> H1, ~> -> spark, and any user/package rule) read BY KIND
  // across the registry feed — so a rule shipped by ANY package (or written live via write-batch)
  // is picked up with zero code, no redeploy. This is the ONLY rule source (no code constant).
  const inputShortcuts = React.useMemo(() => readInputShortcuts(registryRows), [registryRows]);
  // The FULL registry (every row: menu/picker/composer/dispatch, not only effect) — drives the
  // command-composer opening + dispatch. Same by-kind read across the registry feed, so a package's
  // slash/mention/ask-AI/workflow shortcut surfaces live with zero code (W4).
  const inputShortcutsFull = React.useMemo(() => readInputShortcutsFull(registryRows), [registryRows]);
  // Inline-mark table (the text-decoration vocabulary: `**` -> strong, `~~` -> s, any pair a
  // package ships) read BY KIND across the registry feed — the render/serialize pair compiles
  // whatever rows are present; no rows = plain text. Same DATA-first pattern as input-shortcuts.
  const inlineMarks = React.useMemo(() => readInlineMarks(registryRows), [registryRows]);
  // Selection-op registry (N4): every multi-selection op (delete/clear/group/…) read BY KIND across the
  // registry feed, same as input-shortcuts — so a new op is ONE DATA row any package ships, zero surface code.
  const selectionOps = React.useMemo(() => readSelectionOps(registryRows), [registryRows]);
  // Cursor-command registry (N1): the spatial-nav gesture table (gesture→direction/land-edge) read BY
  // KIND across the registry feed — seed const + any live `cursor-command` rows. Same DATA-first pattern as
  // selection-ops; a package rebinds/extends nav (PageDown, a diagonal) with ONE row, zero surface code.
  const cursorCommands = React.useMemo(() => readCursorCommands(registryRows), [registryRows]);

  // L126 FIX (2026-07-23): affordance/projection data moved here from surface to eliminate
  // per-keystroke re-reads of the full published-records aggregate (34.7MB re-materialization
  // per keystroke caused 2-5s typing stalls). Now read ONCE in mount via ca-content-pool-feed,
  // then passed to surface as props. Reduces per-keystroke data load from 34.7MB to ~780KB.
  const allPublishedRowsRaw = useBitfieldData('published-records');
  const allPublishedRows = React.useMemo(
    () => normalizeFeedRows(allPublishedRowsRaw),
    [allPublishedRowsRaw],
  );
  const titledPoolRowsRaw = useBitfieldData('ca-titled-pool-feed');
  const titledPoolRows = React.useMemo(
    () => normalizeFeedRows(titledPoolRowsRaw),
    [titledPoolRowsRaw],
  );
  const formatRows = React.useMemo(
    () => rowsAt(allPublishedRows, 'content-production.style-descriptor'),
    [allPublishedRows],
  );
  const connectionKindRows = React.useMemo(
    () => rowsAt(allPublishedRows, 'composition-connection-kind'),
    [allPublishedRows],
  );

  // The generated descriptor can belong to the package set that built this entry,
  // rather than the app currently serving it. Resolve the serving app's config
  // before using that descriptor as an absence fallback; otherwise a first-render
  // document read can name a different app and fail with FE_CODEC_ERROR.
  const runtimeConfig = React.useMemo(
    () => resolveMountedDocumentsRuntimeConfig(runtimeConfigRows, directRuntimeConfig,
      directRuntimeConfigResolved, runtimeConfigError, bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel),
    [runtimeConfigRows, directRuntimeConfig, directRuntimeConfigResolved, runtimeConfigError],
  );
  // The documents log store owns guarded (CAS) read/write of the scene content
  // at the sceneAddress, throwing CompositionWriteConflictError on
  // a superseded basis (the surface maps that one type -> 'conflict').
  // The feed may arrive after first render; build only with a known partition.
  const documentStore = React.useMemo(
    // The surface's own clock stamps each save's version note. A browser clock is
    // an INPUT the log records, exactly like a date the user typed; only a
    // derivation replayed against the log has to take its clock from the runtime.
    () => runtimeConfig ? createCompositionDocumentsLogStore(runtimeConfig.partition_label, () => Date.now(), sceneAddress, undefined, sceneAddressMode) : null,
    [runtimeConfig, sceneAddress, sceneAddressMode],
  );
  // Every engine call from THIS surface addresses the DOCUMENT's own scene session
  // (the engine keys one kernel per session): the shell's subscribed scene and other
  // surfaces can never replace this editor's scene out from under it (the
  // NodeNotFound save-storm / "Pages could not load" collision class).
  // Keep hooks before the loading return as the feed arrives after first render.
  const sendDocumentTransaction = React.useCallback(
    (transaction: CompositionTransaction) =>
      sendCompositionTransaction({ ...transaction, session: sceneAddress }),
    [sceneAddress],
  );
  const applyMountedScenePatch = React.useMemo(
    () => {
      if (!documentStore || !runtimeConfig) return null;
      const apply = createMountedDocumentsScenePatch(documentStore, runtimeConfig.partition_label, sceneAddress, sceneAddressMode);
      return (request: unknown) => apply(request as ApplyScenePatchRequest);
    },
    [documentStore, runtimeConfig, sceneAddress, sceneAddressMode],
  );
  if (!runtimeConfig || !documentStore || !applyMountedScenePatch) {
    return <Container layout="vertical" alignItems="center" justifyContent="center" padding="lg" gap="md">{runtimeConfigError ? <Text variant="body-xs" color="muted">Pages could not load right now. Reload to try again.</Text> : <><Spinner /><Text variant="body-xs" color="faint">Loading pages...</Text></>}</Container>;
  }
  // The generated descriptor can lack a partition, so wait for the live row.
  return (
    <DocumentsSurface
      sidebarInstanceId={typeof surfaceInput?.surface_instance_ref === 'string' ? surfaceInput.surface_instance_ref : undefined}
      sidebarCapabilities={surfaceInput?.sidebar_capabilities && typeof surfaceInput.sidebar_capabilities === 'object' ? surfaceInput.sidebar_capabilities : undefined}
      sceneAddress={sceneAddress}
      expectedDocumentRevision={typeof surfaceInput?.expected_document_revision === 'string' ? surfaceInput.expected_document_revision : undefined}
      mountedViewRef={typeof surfaceInput?.view_context_ref === 'string' ? surfaceInput.view_context_ref : null}
      documentRows={documentRows}
      documentIndexRows={documentIndexRows}
      materialRows={materialRows}
      placeableSurfaceRows={placeableSurfaceRows}
      spacingFieldRows={spacingFieldRows}
      inputShortcuts={inputShortcuts}
      inputShortcutsFull={inputShortcutsFull}
      inlineMarks={inlineMarks}
      selectionOps={selectionOps}
      cursorCommands={cursorCommands}
      sidebarPanelRows={[]}
      partitionLabel={runtimeConfig.partition_label}
      projectionRunners={defaultProjectionRunners()}
      blockPlaceholder={runtimeConfig.block_placeholder}
      sendTransaction={sendDocumentTransaction}
      loadDocuments={documentStore.read}
      readDocumentSnapshot={documentStore.readSnapshot}
      writeDocuments={documentStore.write}
      applyMountedScenePatch={applyMountedScenePatch}
      allPublishedRows={allPublishedRows}
      titledPoolRows={titledPoolRows}
      formatRows={formatRows}
      connectionKindRows={connectionKindRows}
      surfaceIntentReader={readSurfaceIntentReaderConfig(surfaceInput?.surface_intent_reader)}
      surfaceIntentDestinationRef={typeof surfaceInput?.surface_intent_destination_ref === 'string' ? surfaceInput.surface_intent_destination_ref : null}
    />
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <DocumentsMaterial props={props} />);
}
