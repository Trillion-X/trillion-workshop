
import React from 'react';
import {
  ErrorBoundary,
  FloatingMaterialFrame,
  ToastProvider,
  mountReactSurface,
  useToastContext,
} from '@/packages/ui';
import {
  ActionForm,
  materializeActionFormFile,
} from '@/packages/ui/show/action-affordance';
import { bitfieldGeneratedPackageEntryScopeBinding, useBitfieldData,
  bitfieldGeneratedLiveReadScopeDescriptor,
} from '@/packages/visual-database/.bitfield-entry-scope/visual-database/runtime-kit-react';
import { sendRequestToBitfieldTarget } from '@/packages/visual-database/.bitfield-entry-scope/visual-database/runtime-kit';
import { invokeVisualDatabaseAction } from '@/packages/visual-database/do-work/visual-database-actions';
import {
  FieldEditorOwnerCapabilitiesProvider,
  registerMutationNotifier,
} from '@/packages/visual-database/show/field-editors';
import type {
  AttachmentReadRequest,
  AttachmentReadResult,
  AttachmentRevealRequest,
  FieldEditorOwnerCapabilities,
  FieldEditorOwnerTarget,
} from '@/packages/visual-database/show/field-editor-kit';
import { createRecordWriter } from '@/packages/visual-database/do-work/record-writes';
import {
  decodeVisualDatabaseEvaluatorDescriptors,
  decodeVisualDatabaseModel,
  decodeVisualDatabaseSurfaceState,
  decodeVisualDatabaseViewWorkspace,
  visualDatabaseViewsWithSelection,
  recordsForVisualDatabaseDataset,
  selectVisualDatabaseViewWorkspace,
} from '@/packages/visual-database/read-data/visual-database';
import { selectVisualDatabaseInput } from '@/packages/visual-database/show/select-visual-database-input';
import { hasVisualDatabaseBoardInputOverride } from '@/packages/visual-database/show/board-input-precedence';
import { VisualDatabaseSurface } from '@/packages/visual-database/show/VisualDatabaseSurface';
import {
  initialViewIdFromSurfaceInput,
  latestRecordRefsFromSurfaceInput,
  scopedVisualDatabaseModel,
  visualDatabaseRecordScopeFromSurfaceInput,
  visualDatabaseInstanceIsWritable,
} from '@/packages/visual-database/show/surface-input-record-scope';
import { setSelectedAgent } from '@/packages/selected-agent/do-work/set-selected-agent';
import { addressedCellInputsFromPublishedRecords } from '@/packages/visual-database/do-work/cell-expression';
import {
  foldAddressedDescriptorFactsFromPublishedFeed,
  type DescriptorOwnerTarget,
} from '@/packages/visual-database/read-data/addressed-descriptors';
import { visualDatabaseInputsFromAddressedDescriptors } from '@/packages/visual-database/read-data/descriptor-projection';
import { selectDescriptorAuthority } from '@/packages/visual-database/do-work/migrate-descriptor-aggregates';
import descriptorReferenceRules from '@/packages/visual-database/source-data/descriptor-reference-rules.json';
import {
  dispatchVisualDatabaseSelectionAffordance,
  visualDatabaseSelectionActionApplies,
  visualDatabaseSelectionAffordances,
  visualDatabaseSelectionAskFields,
  type VisualDatabaseSelectionAffordance,
} from '@/packages/visual-database/show/selection-action-affordances';

const recordWriter = createRecordWriter(bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel);
const RECORD_BOARD_DESCRIPTOR_OWNER: DescriptorOwnerTarget = {
  addressPrefix: 'visual-database.descriptors::visual-database',
  pathLabels: ['current-item', 'visual-database-descriptor', 'owner', 'visual-database'],
  referenceRules: descriptorReferenceRules,
};

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function ownerTarget<Request, Result>(
  value: unknown,
): FieldEditorOwnerTarget<Request, Result> | undefined {
  const candidate = record(value);
  return typeof candidate?.target === 'string' && candidate.target.length > 0
    && typeof candidate.invoke === 'function'
    ? {
        target: candidate.target,
        invoke: candidate.invoke as FieldEditorOwnerTarget<Request, Result>['invoke'],
      }
    : undefined;
}

function fieldEditorCapabilitiesFromUnknown(value: unknown): FieldEditorOwnerCapabilities | undefined {
  const root = record(value);
  const attachment = record(root?.attachment);
  if (!attachment) return undefined;
  const readCapability = ownerTarget<AttachmentReadRequest, AttachmentReadResult>(attachment.read);
  const revealCapability = ownerTarget<AttachmentRevealRequest, void>(attachment.reveal);
  const editor = record(attachment.editor);
  const editorCapability = typeof editor?.target === 'string' && editor.target.length > 0
    && typeof editor.Component === 'function'
    ? { target: editor.target, Component: editor.Component as NonNullable<NonNullable<FieldEditorOwnerCapabilities['attachment']>['editor']>['Component'] }
    : undefined;
  if (!readCapability && !revealCapability && !editorCapability) return undefined;
  return { attachment: {
    ...(readCapability ? { read: readCapability } : {}),
    ...(revealCapability ? { reveal: revealCapability } : {}),
    ...(editorCapability ? { editor: editorCapability } : {}),
  } };
}

export function VisualDatabaseDataSurface({
  surfaceInput,
  initialViewId,
  fieldEditorOwnerCapabilities,
}: {
  surfaceInput?: unknown;
  initialViewId?: string;
  fieldEditorOwnerCapabilities?: FieldEditorOwnerCapabilities;
}) {
  const { showSuccess, showError } = useToastContext();
  React.useEffect(() => {
    registerMutationNotifier({ success: showSuccess, error: showError });
    return () => registerMutationNotifier(null);
  }, [showSuccess, showError]);
  const globalRecords = useBitfieldData<unknown>('records');
  const globalFields = useBitfieldData<unknown>('fields');
  const globalViews = useBitfieldData<unknown>('views');
  const globalActions = useBitfieldData<unknown>('actions');
  const globalGridProperties = useBitfieldData<unknown>('gridProperties');
  const globalEvaluatorDescriptors = useBitfieldData<unknown>('evaluatorDescriptors');
  const globalMutationSettlementPolicy = useBitfieldData<unknown>('mutationSettlementPolicy');
  const globalDescriptorRecords = useBitfieldData<unknown>('descriptorRecords');
  const globalDescriptorAuthority = useBitfieldData<unknown>('descriptorAuthority');
  const globalDirectViewWorkspace = useBitfieldData<unknown>('directViewWorkspace');
  const actionAffordanceFeed = useBitfieldData<unknown>('action-affordance-feed');
  // Per-surface board DATA may supply its own workspace and ordinary model
  // inputs. An exact direct-link id resolves only from that already-loaded
  // workspace; its bound dataset then becomes the normal decoder input.
  const directViewWorkspaceInput = selectVisualDatabaseInput(
    surfaceInput,
    'directViewWorkspace',
    globalDirectViewWorkspace,
  );
  const directViewWorkspace = React.useMemo(
    () => decodeVisualDatabaseViewWorkspace(directViewWorkspaceInput),
    [directViewWorkspaceInput],
  );
  const directSelection = React.useMemo(
    () => selectVisualDatabaseViewWorkspace(directViewWorkspace, initialViewId),
    [directViewWorkspace, initialViewId],
  );
  const boardRecords = selectVisualDatabaseInput(surfaceInput, 'records', globalRecords);
  const boardFields = selectVisualDatabaseInput(surfaceInput, 'fields', globalFields);
  const boardViews = selectVisualDatabaseInput(surfaceInput, 'views', globalViews);
  const boardActions = selectVisualDatabaseInput(surfaceInput, 'actions', globalActions);
  const boardGridProperties = selectVisualDatabaseInput(surfaceInput, 'gridProperties', globalGridProperties);
  const boardEvaluatorDescriptors = selectVisualDatabaseInput(
    surfaceInput,
    'evaluatorDescriptors',
    globalEvaluatorDescriptors,
  );
  const datasetInput = directSelection?.dataset.payload;
  const records = directSelection
    ? recordsForVisualDatabaseDataset(directSelection.dataset, boardRecords)
    : boardRecords;
  const fields = selectVisualDatabaseInput(datasetInput, 'fields', boardFields);
  const views = visualDatabaseViewsWithSelection(boardViews, directSelection?.view);
  const actions = selectVisualDatabaseInput(datasetInput, 'actions', boardActions);
  // Adjustable grid-element aspects as DATA. Absent → DEFAULT_GRID_PROPERTIES (FALLBACK_VIEW pattern).
  const gridProperties = selectVisualDatabaseInput(datasetInput, 'gridProperties', boardGridProperties);
  const evaluatorDescriptors = selectVisualDatabaseInput(
    datasetInput,
    'evaluatorDescriptors',
    boardEvaluatorDescriptors,
  );
  const mutationSettlementPolicyInput = selectVisualDatabaseInput(
    surfaceInput,
    'mutationSettlementPolicy',
    globalMutationSettlementPolicy,
  );
  const descriptorRecordsInput = selectVisualDatabaseInput(
    surfaceInput,
    'descriptorRecords',
    globalDescriptorRecords,
  );
  const descriptorAuthorityInput = selectVisualDatabaseInput(
    surfaceInput,
    'descriptorAuthority',
    globalDescriptorAuthority,
  );
  const descriptorFold = React.useMemo(
    () => foldAddressedDescriptorFactsFromPublishedFeed(
      RECORD_BOARD_DESCRIPTOR_OWNER,
      descriptorRecordsInput,
    ),
    [descriptorRecordsInput],
  );
  const descriptorAuthority = React.useMemo(
    () => selectDescriptorAuthority({
      activation: descriptorAuthorityInput,
      target: RECORD_BOARD_DESCRIPTOR_OWNER,
      fold: descriptorFold,
    }),
    [descriptorAuthorityInput, descriptorFold],
  );
  const boardInputOverridesAddressedDescriptors = hasVisualDatabaseBoardInputOverride(surfaceInput);
  const addressedDescriptorInputs = React.useMemo(
    () => !boardInputOverridesAddressedDescriptors && descriptorAuthority.state === 'addressed'
      ? visualDatabaseInputsFromAddressedDescriptors(descriptorAuthority.snapshots)
      : null,
    [boardInputOverridesAddressedDescriptors, descriptorAuthority],
  );
  const descriptorAuthorityInvalid = !boardInputOverridesAddressedDescriptors && descriptorAuthority.state === 'invalid';
  const writable = visualDatabaseInstanceIsWritable(directSelection?.dataset.payload.writable, surfaceInput);
  const authoritativeRecords = descriptorAuthorityInvalid ? { rows: [] } : records;
  globalThis.performance?.mark(records == null ? 'database:open:records-pending' : 'database:open:records-present');
  globalThis.performance?.mark(mutationSettlementPolicyInput == null ? 'database:open:policy-pending' : 'database:open:policy-present');
  globalThis.performance?.mark('database:open:decode-start');
  const addressedCells = addressedCellInputsFromPublishedRecords(authoritativeRecords);
  const model = decodeVisualDatabaseModel({
    records: authoritativeRecords,
    fields: addressedDescriptorInputs?.fields
      ?? (descriptorAuthorityInvalid ? { descriptors: [] } : fields),
    views: addressedDescriptorInputs?.views
      ?? (descriptorAuthorityInvalid ? { views: [], palette: [] } : views),
    actions: descriptorAuthorityInvalid ? { actions: [] } : actions,
    gridProperties: addressedDescriptorInputs?.gridProperties
      ?? (descriptorAuthorityInvalid ? [] : gridProperties),
  });
  // Scope is caller DATA over this instance's already-owned feed. It narrows
  // the rendered projection only and never substitutes a parallel record read.
  const scopedModel = scopedVisualDatabaseModel(
    model,
    visualDatabaseRecordScopeFromSurfaceInput(surfaceInput),
  );
  globalThis.performance?.mark('database:open:decode-complete');
  const latestRecordRefs = latestRecordRefsFromSurfaceInput(surfaceInput);
  const selectionAffordances = React.useMemo(
    () => visualDatabaseSelectionAffordances(actionAffordanceFeed),
    [actionAffordanceFeed],
  );
  const [pendingAffordance, setPendingAffordance] = React.useState<{
    action: VisualDatabaseSelectionAffordance;
    selectedRecords: readonly import('@/packages/visual-database/read-data/visual-database').VisualDatabaseRecord[];
  } | null>(null);

  const runSelectionAffordance = React.useCallback(async (
    action: VisualDatabaseSelectionAffordance,
    selectedRecords: readonly import('@/packages/visual-database/read-data/visual-database').VisualDatabaseRecord[],
    answers: Record<string, unknown> = {},
  ) => {
    try {
      await dispatchVisualDatabaseSelectionAffordance({
        action,
        selectedRecords,
        runId: crypto.randomUUID(),
        answers,
        sender: sendRequestToBitfieldTarget,
      });
      showSuccess(`${action.label} started`);
    } catch (error) {
      showError(error instanceof Error ? error.message : `${action.label} failed`);
    }
  }, [showError, showSuccess]);

  // Current records can paint before write policy arrives. Keep the same live
  // surface and subscriptions; only expose its writer once policy is present.
  // Absence of records remains pending, never an invented empty board.
  const writesReady = writable && mutationSettlementPolicyInput != null;
  if (records == null) {
    return <div role="status">Loading records…</div>;
  }

  return (
    <FieldEditorOwnerCapabilitiesProvider value={fieldEditorOwnerCapabilities}>
      <VisualDatabaseSurface
        model={scopedModel}
        presentation={surfaceInput && typeof surfaceInput === 'object' && (surfaceInput as Record<string, unknown>).presentation === 'section' ? 'section' : 'surface'}
        surfaceState={surfaceInput && typeof surfaceInput === 'object' && Object.prototype.hasOwnProperty.call(surfaceInput, 'surfaceState')
          ? decodeVisualDatabaseSurfaceState((surfaceInput as Record<string, unknown>).surfaceState)
          : undefined}
        initialViewId={initialViewId}
        latestRecordRefs={latestRecordRefs}
        viewIdentity={directSelection?.identity}
        writeRecord={writesReady ? recordWriter : undefined}
        mutationSettlementPolicy={writesReady ? mutationSettlementPolicyInput : undefined}
        recordTarget={!writesReady || directSelection ? undefined : {
          addressPrefix: 'package::visual-database::record',
          payloadDefaults: { owner_package: 'visual-database' },
        }}
        descriptorOwner={!directSelection && descriptorAuthority.state === 'addressed'
          ? RECORD_BOARD_DESCRIPTOR_OWNER
          : undefined}
        descriptorSnapshots={descriptorAuthority.state === 'addressed'
          ? descriptorAuthority.snapshots
          : undefined}
        descriptorAuthorityError={descriptorAuthorityInvalid
          ? `Saved board setup failed verification (${descriptorAuthority.reason}).`
          : undefined}
        cellExpressionInputs={addressedCells}
        evaluatorDescriptors={decodeVisualDatabaseEvaluatorDescriptors(evaluatorDescriptors)}
        onSelectNode={(nodeRef) => {
          void setSelectedAgent(nodeRef);
        }}
        selectionActions={selectionAffordances.map((action) => ({
          id: action.id,
          label: action.label,
          appliesToSelection: (records) => visualDatabaseSelectionActionApplies(action, records),
        }))}
        onInvokeSelectionAction={(row, selectedRecords) => {
          const action = selectionAffordances.find((candidate) => candidate.id === row.id);
          if (!action) return;
          if (visualDatabaseSelectionAskFields(action).length > 0) {
            setPendingAffordance({ action, selectedRecords });
          } else {
            void runSelectionAffordance(action, selectedRecords);
          }
        }}
        onInvokeAction={(action, context) => {
          invokeVisualDatabaseAction(action, context).catch((error) => {
            console.error('[VisualDatabase] action failed', error);
          });
        }}
      />
      {pendingAffordance ? (
        <ActionForm
          open
          title={pendingAffordance.action.trigger.ask?.title ?? pendingAffordance.action.label}
          fields={visualDatabaseSelectionAskFields(pendingAffordance.action)}
          schema={pendingAffordance.action.trigger.ask?.configuration}
          initialValues={{}}
          submitLabel={pendingAffordance.action.trigger.ask?.submit_label ?? 'Run'}
          onMaterialize={materializeActionFormFile}
          onCancel={() => setPendingAffordance(null)}
          onSubmit={(answers) => {
            const pending = pendingAffordance;
            setPendingAffordance(null);
            void runSelectionAffordance(pending.action, pending.selectedRecords, answers);
          }}
        />
      ) : null}
    </FieldEditorOwnerCapabilitiesProvider>
  );
}

function VisualDatabaseMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceInitialViewId = initialViewIdFromSurfaceInput(props.surfaceInput);
  const initialViewId = typeof window === 'undefined'
    ? surfaceInitialViewId
    : new URL(window.location.href).searchParams.get('visualDatabaseViewId')
      ?? surfaceInitialViewId;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="visual database material">
        {/* ONE toast container, bottom-center (provider default — the Look
            button owns bottom-right). The previous explicit <ToastContainer/>
            next to the provider's built-in one doubled every toast. */}
        <ToastProvider>
          <VisualDatabaseDataSurface
            surfaceInput={props.surfaceInput}
            initialViewId={initialViewId}
            fieldEditorOwnerCapabilities={fieldEditorCapabilitiesFromUnknown(props.fieldEditorOwnerCapabilities)}
          />
        </ToastProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <VisualDatabaseMaterial props={props} />);
}
