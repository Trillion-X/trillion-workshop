// bitfield/packages/ai-action-guard/show/mount-openbot-operator.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Package entry for the Union Operator Console. It reads the three live DATA
// feeds the autonomous-operator primitives publish, folds them through the pure
// reader, and renders the console. It also wires the two write affordances:
//
//   - take/hand-back the wheel  -> permission-lease record-lease / revoke-lease
//   - give the operator a secret -> credentials-vault scoped store (SP7)
//
// Reads come in as opaque published records over the Envelope by feed address
// (useBitfieldData), never by importing permission-lease or ai-agent-profile.
// Writes go out as one blind Envelope request each. Composition-by-DATA only
// (L166, no god package).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This file names no live record content; it only binds feed keys + targets.
// 2. The secret value handed to the credential write is never logged and never
//    returned to the model; it flows straight from the ui Input to the target.
// 3. Missing targets/feeds degrade to a read-only console, never a crash.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { readPublishedRecords } from '@/packages/ui/show/placeable-surface-intent/placeable-surface-record';
import { readOperatorConsole, type ControlState } from '../read-data/read-openbot-operator';
import { OpenbotOperatorConsole } from './OpenbotOperatorConsole';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

/** Fire-and-forget Envelope request; the console never blocks on the write. */
async function dispatch(target: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await sendRequestToBitfieldTarget({
      target,
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    });
  } catch {
    // A missing target degrades to read-only; the feed reflects the real state
    // on the next fold. Never crash the surface on a write.
  }
}

function OpenbotOperatorMaterial({ props }: { props: Record<string, unknown> }) {
  const governedActions = useBitfieldData('governed-actions');
  const controlLeases = useBitfieldData('control-leases');
  const agentProfiles = useBitfieldData('agent-profiles');

  const data = React.useMemo(
    () =>
      readOperatorConsole(
        readPublishedRecords(governedActions),
        readPublishedRecords(controlLeases),
        readPublishedRecords(agentProfiles),
      ),
    [governedActions, controlLeases, agentProfiles],
  );

  // A pending scoped-secret request is DATA the operator publishes when a login
  // wall is hit; the surface renders the masked entry only when one is open.
  const secretRequest = React.useMemo(() => {
    const field = props.secret_field_label;
    return typeof field === 'string' && field.trim()
      ? { fieldLabel: field.trim(), ...(typeof props.secret_note === 'string' ? { note: props.secret_note } : {}) }
      : null;
  }, [props.secret_field_label, props.secret_note]);

  const scopeRef = typeof props.computer_scope_ref === 'string' ? props.computer_scope_ref : 'computer:default';

  const onToggleControl = React.useCallback(
    (next: ControlState['action']) => {
      if (next === 'take-the-wheel') {
        void dispatch('slot::permission-lease.record-lease', {
          operation: 'record-lease',
          lease_class: 'exclusive-control',
          scope_ref: scopeRef,
          holder: 'human',
          reason: 'took the wheel from the operator console',
        });
      } else {
        void dispatch('slot::permission-lease.revoke-lease', {
          operation: 'revoke-lease',
          lease_class: 'exclusive-control',
          scope_ref: scopeRef,
          reason: 'handed the wheel back from the operator console',
        });
      }
    },
    [scopeRef],
  );

  const onSubmitSecret = React.useCallback(
    (value: string) => {
      const field = secretRequest?.fieldLabel;
      if (!field) return;
      // The value goes straight to the scoped store; it is never placed on any
      // model-readable path and is not returned here (SP7).
      void dispatch('slot::credentials-vault.store-scoped-secret', {
        operation: 'store-scoped-secret',
        scope_ref: scopeRef,
        field_label: field,
        secret_value: value,
      });
    },
    [scopeRef, secretRequest],
  );

  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Trillion autonomous operator">
        <OpenbotOperatorConsole
          data={data}
          secretRequest={secretRequest}
          onToggleControl={onToggleControl}
          onSubmitSecret={onSubmitSecret}
        />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <OpenbotOperatorMaterial props={props} />);
}
