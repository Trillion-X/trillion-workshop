//
// Public consumer boundary for packages that configure Visual Database with
// their own records and descriptors. Consumers supply owner DATA; Visual
// Database retains its private mutation, action, expression, authority, and
// descriptor-reference mechanisms behind this already-public show root.

import React from 'react';
import { useToastContext } from '../../ui';
import { selectDescriptorAuthority } from '../do-work/migrate-descriptor-aggregates';
import { createRecordWriter } from '../do-work/record-writes';
import { invokeVisualDatabaseAction } from '../do-work/visual-database-actions';
import {
  foldAddressedDescriptorFactsFromPublishedFeed,
  type DescriptorOwnerTarget,
} from '../read-data/addressed-descriptors';
import { visualDatabaseInputsFromAddressedDescriptors } from '../read-data/descriptor-projection';
import {
  decodeVisualDatabaseModel,
} from '../read-data/visual-database';
import descriptorReferenceRules from '../source-data/descriptor-reference-rules.json';
import { registerMutationNotifier } from './field-editors';
import {
  VisualDatabaseSurface,
  type VisualDatabaseRecordTarget,
} from './VisualDatabaseSurface';
import { useAddressedCellExpressionOwner } from './use-addressed-cell-expression-owner';

export interface VisualDatabaseConsumerDescriptorTarget {
  addressPrefix: string;
  pathLabels: readonly string[];
  payloadDefaults?: Readonly<Record<string, unknown>>;
}

export interface OwnerBoundVisualDatabaseSurfaceProps {
  partitionLabel: string;
  descriptorTarget: VisualDatabaseConsumerDescriptorTarget;
  recordTarget: VisualDatabaseRecordTarget;
  descriptorAuthorityErrorLabel: string;
  actionErrorLabel: string;
  initialViewId?: string;
  records: unknown;
  cellExpressionRecords: unknown;
  fields: unknown;
  views: unknown;
  actions: unknown;
  evaluatorDescriptors: unknown;
  mutationSettlementPolicy: unknown;
  descriptorRecords: unknown;
  descriptorAuthority: unknown;
  /** Open one persisted row in the consumer's matching detail surface. */
  onOpenRecord?: (recordId: string) => void;
}

/**
 * One owner-controlled public capability/render boundary. The consumer never
 * imports Visual Database's private do-work or source-data implementation.
 */
export function OwnerBoundVisualDatabaseSurface({
  partitionLabel,
  descriptorTarget,
  recordTarget,
  descriptorAuthorityErrorLabel,
  actionErrorLabel,
  initialViewId,
  records,
  cellExpressionRecords,
  fields,
  views,
  actions,
  evaluatorDescriptors,
  mutationSettlementPolicy,
  descriptorRecords,
  descriptorAuthority: descriptorAuthorityInput,
  onOpenRecord,
}: OwnerBoundVisualDatabaseSurfaceProps) {
  const { showSuccess, showError } = useToastContext();
  React.useEffect(() => {
    registerMutationNotifier({ success: showSuccess, error: showError });
    return () => registerMutationNotifier(null);
  }, [showSuccess, showError]);

  const recordWriter = React.useMemo(
    () => createRecordWriter(partitionLabel),
    [partitionLabel],
  );
  const descriptorOwner = React.useMemo<DescriptorOwnerTarget>(() => ({
    ...descriptorTarget,
    referenceRules: descriptorReferenceRules,
  }), [descriptorTarget]);
  const descriptorFold = React.useMemo(
    () => foldAddressedDescriptorFactsFromPublishedFeed(descriptorOwner, descriptorRecords),
    [descriptorOwner, descriptorRecords],
  );
  const descriptorAuthority = React.useMemo(
    () => selectDescriptorAuthority({
      activation: descriptorAuthorityInput,
      target: descriptorOwner,
      fold: descriptorFold,
    }),
    [descriptorAuthorityInput, descriptorFold, descriptorOwner],
  );
  const addressedDescriptorInputs = React.useMemo(
    () => descriptorAuthority.state === 'addressed'
      ? visualDatabaseInputsFromAddressedDescriptors(descriptorAuthority.snapshots)
      : null,
    [descriptorAuthority],
  );
  const descriptorAuthorityInvalid = descriptorAuthority.state === 'invalid';
  const model = React.useMemo(
    () => decodeVisualDatabaseModel({
      records: descriptorAuthorityInvalid ? { rows: [] } : records,
      fields: addressedDescriptorInputs?.fields
        ?? (descriptorAuthorityInvalid ? { descriptors: [] } : fields),
      views: addressedDescriptorInputs?.views
        ?? (descriptorAuthorityInvalid ? { views: [], palette: [] } : views),
      actions: descriptorAuthorityInvalid ? { actions: [] } : actions,
      gridProperties: addressedDescriptorInputs?.gridProperties
        ?? (descriptorAuthorityInvalid ? [] : undefined),
    }),
    [records, fields, views, actions, addressedDescriptorInputs, descriptorAuthorityInvalid],
  );
  const expressionOwner = useAddressedCellExpressionOwner(cellExpressionRecords, evaluatorDescriptors, model);

  return (
    <VisualDatabaseSurface
      model={model}
      initialViewId={initialViewId}
      writeRecord={recordWriter}
      recordTarget={recordTarget}
      descriptorOwner={descriptorAuthority.state === 'addressed' ? descriptorOwner : undefined}
      descriptorSnapshots={descriptorAuthority.state === 'addressed'
        ? descriptorAuthority.snapshots
        : undefined}
      descriptorAuthorityError={descriptorAuthorityInvalid
        ? `${descriptorAuthorityErrorLabel} (${descriptorAuthority.reason}).`
        : undefined}
      cellExpressionInputs={expressionOwner.cellExpressionInputs}
      evaluatorDescriptors={expressionOwner.evaluatorDescriptors}
      dispatchDerived={expressionOwner.dispatchDerived}
      mutationSettlementPolicy={mutationSettlementPolicy}
      onOpenRecord={onOpenRecord ? (record) => onOpenRecord(record.id) : undefined}
      onInvokeAction={(action, context) => {
        return invokeVisualDatabaseAction(action, context).catch((error) => {
          console.error(`[${actionErrorLabel}] action failed`, error);
          throw error;
        });
      }}
    />
  );
}

