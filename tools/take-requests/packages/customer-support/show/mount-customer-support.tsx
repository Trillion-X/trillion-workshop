// package-set://bitfield-studio/packages/customer-support/show/mount-customer-support.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The mount boundary for the Support Workbench. It reads the live `record-work`
// value, turns it into a CustomerSupportWorkspace, and renders the generic
// CustomerSupportSurface into a host element wrapped in the shared floating
// material frame + error boundary. This file is the ONLY place transport lives:
// the surface stays a blind, pure, iOS-JSCore-safe renderer; here the user's
// action intent becomes a real invocation through `invokeCustomerSupportAction`
// and is sent with `sendRequestToBitfieldTarget`.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The data boundary is `readCustomerSupportWorkspace` — the mount never
//    invents records, descriptors, or copy; it only maps the live value's shape.
// 2. The action boundary is `invokeCustomerSupportAction` (the declared package
//    target). The renderer never imports transport — it calls back `onAction`.
// 3. Honest live data (L117): when the live value is empty, the workspace is
//    empty and the surface shows its honest empty state — never fabricated rows.
//
// =============================================================================

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  readCustomerSupportWorkspace,
  type CustomerSupportWorkspace,
} from '../read-data/read-customer-support-workspace';
import type { RecordWorkGraphInput, WorkDescriptor } from '../read-data/record-work-graph';
import {
  invokeCustomerSupportAction,
} from '../do-work/invoke-customer-support-action';
import type { ActionDescriptor } from '../do-work/invoke-record-work-action';
import { CustomerSupportSurface, type SupportActionHandler } from './CustomerSupportSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Map whatever shape the live `record-work` value carries into the reader's
 * input. Accepts either a flat array of published record rows or an object that
 * carries explicit descriptor arrays — so the seed can evolve without touching
 * this boundary.
 */
export function inputFromLiveValue(value: unknown): RecordWorkGraphInput & { status?: string } {
  if (Array.isArray(value)) {
    return { records: value.filter(isObject) };
  }
  if (!isObject(value)) {
    return {};
  }
  return {
    records: list(value.records),
    workRecords: list(value.work_records ?? value.workRecords ?? value.items ?? value.records_data),
    fieldDescriptors: list(value.field_descriptors ?? value.fieldDescriptors ?? value.fields),
    relationDescriptors: list(value.relation_descriptors ?? value.relationDescriptors ?? value.relations),
    viewDescriptors: list(value.view_descriptors ?? value.viewDescriptors ?? value.views),
    actionDescriptors: list(value.action_descriptors ?? value.actionDescriptors ?? value.actions),
    ruleDescriptors: list(value.rule_descriptors ?? value.ruleDescriptors ?? value.rules),
    projectionDescriptors: list(value.projection_descriptors ?? value.projectionDescriptors ?? value.projections),
    ownerEvidence: list(value.owner_evidence ?? value.ownerEvidence ?? value.evidence),
    copyDescriptors: list(value.copy_descriptors ?? value.copyDescriptors ?? value.copy),
    status: firstString(value.status),
  };
}

/** A renderer action carries an optional target; only a targeted action can be invoked. */
function toActionDescriptor(action: WorkDescriptor): ActionDescriptor | undefined {
  if (!action.target) return undefined;
  return {
    id: action.id,
    target: action.target,
    operation: action.operation,
    definitionId: action.definitionId,
    ownerRef: action.ownerRef,
    permissionRef: action.permissionRef,
    idempotencyKey: action.idempotencyKey,
    input: action.input,
    copy: action.copy,
  };
}

export function CustomerSupportPanel(): React.ReactElement {
  const liveValue = useBitfieldData('record-work');
  const workspace: CustomerSupportWorkspace = React.useMemo(
    () => readCustomerSupportWorkspace(inputFromLiveValue(liveValue)),
    [liveValue],
  );

  const handleAction = React.useCallback<SupportActionHandler>((action, record, answers) => {
    const descriptor = toActionDescriptor(action);
    if (!descriptor) {
      console.info(`[customer-support] action ${action.id} has no target — nothing to send`);
      return;
    }
    const invocation = invokeCustomerSupportAction(descriptor, {
      workRecordId: record?.id ?? '',
      answers,
    });
    void sendRequestToBitfieldTarget(invocation);
  }, []);

  return <CustomerSupportSurface workspace={workspace} onAction={handleAction} />;
}

function CustomerSupportMaterial({ props }: { props: Record<string, unknown> }): React.ReactElement {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="customer-support material">
        <CustomerSupportPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <CustomerSupportMaterial props={props} />);
}
