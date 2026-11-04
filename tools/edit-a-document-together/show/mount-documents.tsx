import React from 'react';
import { Container, ErrorBoundary, FloatingMaterialFrame, mountReactSurface, Spinner, Text } from '../../ui';
import { ToastProvider } from '../../ui/show/toast';
import { isSavedRecordPending, placeOf, readRecordAt, subscribeRecordChanges, subscribeSavedRecordAcceptance, subscribeSavedRecordRefusal, useBitfieldData } from '#workspace-records';
import { quietWritesKept } from '#workspace/quiet-writes.ts';
import { documentOperationsTransport } from '#workspace/document-operations-transport.ts';
import { onStoreChange } from '#workspace/store-changes.ts';
import { openPageOperations, pageOperationsAddress } from '../do-work/page-operation-writes.mjs';
import { bitfieldGeneratedLiveReadScopeDescriptor } from '#workspace-records';
import { readSurfaceIntentReaderConfig } from '../../ui/show/placeable-surface-intent';
import { ViewerAccessRefsProvider } from '../../ui/show/placeable-surface-intent';
import { DocumentsSurface } from './DocumentsSurface';
import { defaultProjectionRunners } from '../do-work/projection-runners-pack';
import { sendCompositionTransaction } from '../do-work/send-composition-transaction';
import type { CompositionTransaction } from '../read-data/documents';
import {
  createCompositionDocumentsLogStore,
  readServingCompositionRuntimeConfig,
  DOCUMENTS_ADDRESS,
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
import { readSelectionOps } from '../read-data/selection-ops';
import { readCursorCommands } from '../read-data/cursor-commands';
import { normalizeFeedRows } from '../read-data/feed-rows';
import { readSidebarSettings } from '../../sidebar/read-data/sidebar-settings';
import { documentCollaborationView } from '../read-data/collaboration-view';
import type { FileFieldSource } from '../../ui/show/file-field';

export function createMountedDocumentsScenePatch(
  partitionLabel: string,
  documentRef: string,
  addressMode: 'label-hash' | 'identity-text',
) {
  const apply = createApplyScenePatchOperation({
    partitionLabel, documentRef, readClockMs: Date.now,
    // Each patch owns its observed basis. A rejected AI patch cannot silently
    // grant the human editor permission to overwrite a newer remote document.
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
            <DocumentsData surfaceInput={surfaceInput}
              fileSource={props.fileSource as FileFieldSource | undefined}
              readFileText={props.readFileText as ((identity: string, signal?: AbortSignal) => Promise<string>) | undefined}
              savePortableFile={props.savePortableFile as ((input: { name: string; folder: string; text: string }) => Promise<string>) | undefined} />
          </ViewerAccessRefsProvider>
        </ErrorBoundary>
      </ToastProvider>
    </FloatingMaterialFrame>
  );
}

function DocumentsData({ surfaceInput, fileSource, readFileText, savePortableFile }: {
  surfaceInput?: Record<string, unknown>;
  fileSource?: FileFieldSource;
  readFileText?: (identity: string, signal?: AbortSignal) => Promise<string>;
  savePortableFile?: (input: { name: string; folder: string; text: string }) => Promise<string>;
}) {
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
  const hasPublishedRuntimeConfig = runtimeConfigRows.length > 0;
  React.useEffect(() => {
    if (hasPublishedRuntimeConfig) return;
    let cancelled = false;
    readServingCompositionRuntimeConfig()
      .then((value) => { if (!cancelled) { setDirectRuntimeConfig(value); setDirectRuntimeConfigResolved(true); } })
      .catch(() => { if (!cancelled) { setRuntimeConfigError(true); setDirectRuntimeConfigResolved(true); } });
    return () => { cancelled = true; };
  }, [hasPublishedRuntimeConfig]);
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
  const partitionLabel = runtimeConfig?.partition_label;
  // The documents log store owns guarded (CAS) read/write of the scene content
  // at the sceneAddress, throwing CompositionWriteConflictError on
  // a superseded basis (the surface maps that one type -> 'conflict').
  // The feed may arrive after first render; build only with a known partition.
  const documentStore = React.useMemo(
    // The target ABI retains its clock argument; current saves use only the
    // document's observed identity and do not publish version-note records.
    () => partitionLabel ? createCompositionDocumentsLogStore(partitionLabel, () => Date.now(), sceneAddress, undefined, sceneAddressMode) : null,
    [partitionLabel, sceneAddress, sceneAddressMode],
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
      if (!documentStore || !partitionLabel) return null;
      const apply = createMountedDocumentsScenePatch(partitionLabel, sceneAddress, sceneAddressMode);
      return (request: unknown) => apply(request as ApplyScenePatchRequest);
    },
    [documentStore, partitionLabel, sceneAddress, sceneAddressMode],
  );
  // The document changed by anyone else (another member in a shared room, another device, another screen on this
  // page showing it) is read again; a change that is what this screen last wrote is its own and reads nothing.
  const lastWritten = React.useRef<string | null>(null);
  const currentStore = React.useRef(documentStore);
  currentStore.current = documentStore;
  const [confirmedDocument, setConfirmedDocument] = React.useState<{ store: object; hash: string } | null>(null);
  const [refusedDocument, setRefusedDocument] = React.useState<{ store: object; hash: string; generation: number } | null>(null);
  const [changedElsewhere, setChangedElsewhere] = React.useState(0);
  React.useEffect(() => subscribeRecordChanges(labels => {
    if (!labels.includes(sceneAddress)) return;
    if (JSON.stringify(readRecordAt(sceneAddress)) === lastWritten.current) return;
    setChangedElsewhere(count => count + 1);
  }), [sceneAddress]);
  React.useEffect(() => subscribeSavedRecordAcceptance(sceneAddress, ({ identity, payload }) => {
    if (documentStore && JSON.stringify(payload) === lastWritten.current) {
      documentStore.confirmWrite(identity);
      setConfirmedDocument({ store: documentStore, hash: identity });
    }
  }), [documentStore, sceneAddress]);
  React.useEffect(() => subscribeSavedRecordRefusal(sceneAddress, ({ identity, payload, generation, expectedIdentity }) => {
    if (!documentStore || JSON.stringify(payload) !== lastWritten.current) return;
    const refused = { store: documentStore, hash: identity, generation };
    // The record owner filters this to the current outbox generation. Rebase its
    // matching local CAS frame before showing Retry as available; this never
    // adopts a different remote snapshot over the active editor.
    void documentStore.recoverRefusedWrite(identity, expectedIdentity).catch(() => false).then(() => {
      if (currentStore.current === documentStore && lastWritten.current === JSON.stringify(payload)) setRefusedDocument(refused);
    });
  }), [documentStore, sceneAddress]);
  // Configuration/feed refreshes keep the same store and callbacks. A real
  // document update is a separate signal, never a replacement editor session.
  const loadDocuments = React.useCallback(() => documentStore!.read(), [documentStore]);
  const readDocumentSnapshot = React.useCallback(() => documentStore!.readSnapshot(), [documentStore]);
  const peekDocumentSnapshot = React.useCallback(() => documentStore!.readSnapshot({ adopt: false }), [documentStore]);
  const adoptDocumentSnapshot = React.useCallback((snapshot: Parameters<NonNullable<typeof documentStore>['adoptSnapshot']>[0]) => documentStore!.adoptSnapshot(snapshot), [documentStore]);
  // The page is also kept as operations in the person's store (page-operation-writes.mjs): a save is merged with what other
  // editors kept meanwhile, and a change only they made is written and read again here.
  const pageOperations = React.useRef<Awaited<ReturnType<typeof openPageOperations>> | null>(null);
  React.useEffect(() => {
    if (!documentStore) return undefined;
    let stopped = false, stopListening = () => {};
    pageOperations.current = null;
    void documentStore.read().then(async seed => {
      if (stopped || !seed) return;
      const opened = await openPageOperations({
        address: pageOperationsAddress(sceneAddress), seed, transport: documentOperationsTransport,
        write: content => documentStore.write(content), onRemote: () => setChangedElsewhere(count => count + 1),
      });
      if (stopped || !opened) return;
      pageOperations.current = opened;
      stopListening = onStoreChange(() => opened.arrive().then(() => undefined), ['/work/api/records']);
    }).catch(() => {});
    return () => { stopped = true; stopListening(); void pageOperations.current?.close(); pageOperations.current = null; };
  }, [documentStore, sceneAddress]);
  const writeDocuments = React.useCallback(async (typed: Parameters<NonNullable<typeof documentStore>['write']>[0]) => {
    const operations = pageOperations.current;
    const { content, merged } = operations ? await operations.merge(typed).catch(() => ({ content: typed, merged: false })) : { content: typed, merged: false };
    const written = JSON.stringify(content);
    lastWritten.current = written;
    return documentStore!.write(content).then(receipt => {
      if (merged) setChangedElsewhere(count => count + 1);
      // Disk and network acknowledgements update status independently. A slow
      // disk must not hold the engine's input queue behind each keystroke.
      void quietWritesKept().then(kept => {
        if (kept && documentStore && currentStore.current === documentStore && lastWritten.current === written
            && isSavedRecordPending(sceneAddress, receipt.documentHash)) {
          setConfirmedDocument({ store: documentStore, hash: receipt.documentHash });
        }
      });
      return { ...receipt, savedOnDevice: false };
    });
  }, [documentStore, sceneAddress]);
  if (!runtimeConfig || !documentStore || !applyMountedScenePatch) {
    return <Container layout="vertical" alignItems="center" justifyContent="center" padding="lg" gap="md">{runtimeConfigError ? <Text variant="body-xs" color="muted">Pages could not load right now. Reload to try again.</Text> : <><Spinner /><Text variant="body-xs" color="faint">Loading pages...</Text></>}</Container>;
  }
  // The generated descriptor can lack a partition, so wait for the live row.
  // A placed document belongs to its live room. The private document library
  // is not a list of that room's pages and must not appear inside it.
  return (
    <div className="relative h-full min-h-0">
    <DocumentsSurface
      key={JSON.stringify([partitionLabel, sceneAddress, sceneAddressMode])}
      sidebarInstanceId={typeof surfaceInput?.surface_instance_ref === 'string' ? surfaceInput.surface_instance_ref : undefined}
      sidebarCapabilities={surfaceInput?.sidebar_capabilities && typeof surfaceInput.sidebar_capabilities === 'object' ? surfaceInput.sidebar_capabilities : undefined}
      sidebarSettings={readSidebarSettings(surfaceInput?.sidebar_settings)}
      onePage={surfaceInput?.one_page === true}
      sceneAddress={sceneAddress}
      sceneAddressMode={sceneAddressMode === 'identity-text' ? 'identity_text' : 'label_hash'}
      spaceId={typeof surfaceInput?.space_id === 'string' ? surfaceInput.space_id : undefined}
      initialPageId={typeof surfaceInput?.initial_page_id === 'string' ? surfaceInput.initial_page_id : undefined}
      collaborationRoom={placeOf(sceneAddress)?.room ?? null}
      collaborationView={documentCollaborationView(sceneAddress)}
      expectedDocumentRevision={typeof surfaceInput?.expected_document_revision === 'string' ? surfaceInput.expected_document_revision : undefined}
      mountedViewRef={typeof surfaceInput?.view_context_ref === 'string' ? surfaceInput.view_context_ref : null}
      documentRows={documentRows}
      documentIndexRows={placeOf(sceneAddress) ? [] : documentIndexRows}
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
      projectionRunners={defaultProjectionRunners({
        savePortableFile,
      })}
      blockPlaceholder={runtimeConfig.block_placeholder}
      sendTransaction={sendDocumentTransaction}
      loadDocuments={loadDocuments}
      readDocumentSnapshot={readDocumentSnapshot}
      peekDocumentSnapshot={peekDocumentSnapshot}
      adoptDocumentSnapshot={adoptDocumentSnapshot}
      documentChangeRevision={changedElsewhere}
      confirmedDocumentHash={confirmedDocument?.store === documentStore ? confirmedDocument.hash : null}
      refusedDocumentHash={refusedDocument?.store === documentStore ? refusedDocument.hash : null}
      refusedDocumentGeneration={refusedDocument?.store === documentStore ? refusedDocument.generation : 0}
      writeDocuments={writeDocuments}
      applyMountedScenePatch={applyMountedScenePatch}
      allPublishedRows={allPublishedRows}
      titledPoolRows={titledPoolRows}
      formatRows={formatRows}
      connectionKindRows={connectionKindRows}
      surfaceIntentReader={readSurfaceIntentReaderConfig(surfaceInput?.surface_intent_reader)}
      surfaceIntentDestinationRef={typeof surfaceInput?.surface_intent_destination_ref === 'string' ? surfaceInput.surface_intent_destination_ref : null}
      fileSource={fileSource}
      readFileText={readFileText}
      pageHistoryAvailable={!placeOf(sceneAddress)}
    />
    </div>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <DocumentsMaterial props={props} />);
}
