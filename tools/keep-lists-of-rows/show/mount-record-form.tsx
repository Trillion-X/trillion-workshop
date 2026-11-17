//
// Live mount for RecordFormSurface — the visual-database FORM as an openable surface.
// Mirrors mount-visual-database.tsx exactly (same package data scope, same model
// decode, same writer + action invoker), but renders the FORM instead of the board
// and selects an optional edit-target record from a DATA `record_id`.
//
// COMPOSE (no record_id): a new-record form over the surface's field descriptors.
// EDIT (record_id matches a live record): that record's fields seed the draft and
// submit writes back to its own address. record_id present but absent from the live
// feed → an honest "not found" message, never a silent edit of the wrong record.
//
// The form is a pure configuration of the visual-database primitive: fields come from
// decodeVisualDatabaseModel (explicit DATA descriptors + auto-discovered payload keys),
// so a "full-record edit form" needs ZERO per-record-type code — this file names no
// field, no kind, no domain.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, ToastProvider, Container, Text, mountReactSurface, useToastContext } from '../../ui';
import { bitfieldGeneratedPackageEntryScopeBinding, useBitfieldData,
  bitfieldGeneratedLiveReadScopeDescriptor,
} from '@/packages/visual-database/.bitfield-entry-scope/visual-database/runtime-kit-react';
import { invokeVisualDatabaseAction } from '../do-work/visual-database-actions';
import { registerMutationNotifier } from './field-editors';
import { createRecordWriter } from '../do-work/record-writes';
import { decodeVisualDatabaseModel } from '../read-data/visual-database';
import { selectVisualDatabaseInput } from './select-visual-database-input';
import { RecordFormSurface } from './RecordFormSurface';
import { isEditTargetMissing, selectFormRecord, readFormSubmitLabel } from './select-form-record';

const recordWriter = createRecordWriter(bitfieldGeneratedLiveReadScopeDescriptor.partitionLabel);

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function RecordFormDataSurface({ surfaceInput }: { surfaceInput?: unknown }) {
  const { showSuccess, showError } = useToastContext();
  React.useEffect(() => {
    registerMutationNotifier({ success: showSuccess, error: showError });
    return () => registerMutationNotifier(null);
  }, [showSuccess, showError]);
  // Same per-surface board DATA seam as the board mount: a surface may supply its
  // OWN records/fields/views/actions via surfaceInput, each key overriding the
  // global read. A form surface typically supplies its own `fields` (the form's
  // field set) and reads the global `records` feed for an edit target.
  const records = selectVisualDatabaseInput(surfaceInput, 'records', useBitfieldData<unknown>('records'));
  const fields = selectVisualDatabaseInput(surfaceInput, 'fields', useBitfieldData<unknown>('fields'));
  const views = selectVisualDatabaseInput(surfaceInput, 'views', useBitfieldData<unknown>('views'));
  const actions = selectVisualDatabaseInput(surfaceInput, 'actions', useBitfieldData<unknown>('actions'));
  const model = decodeVisualDatabaseModel({ records, fields, views, actions });

  const record = selectFormRecord(model, surfaceInput);
  const submitLabel = readFormSubmitLabel(surfaceInput) ?? undefined;

  // Asked to edit a record that isn't in the live feed — honest, never edit another.
  if (isEditTargetMissing(model, surfaceInput)) {
    return (
      <Container layout="vertical" gap="sm" padding="lg">
        <Text variant="body-sm" color="faint">That record isn’t available right now.</Text>
      </Container>
    );
  }

  return (
    <RecordFormSurface
      model={model}
      record={record}
      writeRecord={recordWriter}
      submitLabel={submitLabel}
      onInvokeAction={(action, context) => {
        invokeVisualDatabaseAction(action, context).catch((error) => {
          console.error('[RecordForm] action failed', error);
        });
      }}
    />
  );
}

function RecordFormMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="record form material">
        <ToastProvider>
          <RecordFormDataSurface surfaceInput={props.surfaceInput} />
        </ToastProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <RecordFormMaterial props={props} />);
}
