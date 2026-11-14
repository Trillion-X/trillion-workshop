import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import permissionLeaseContract from '../../record-voice-and-meetings/things-to-store-and-run.json';
import {
  decodeConfiguredPermissionActions,
  type PermissionLeaseAction,
} from '../read-data/permission-lease-surface.ts';
import {
  ONLY_ONE_CONTROLS_RULE,
  DEFAULT_ACTUATOR_HOLDER,
  type Holder,
  type GrantControlInput,
} from './exclusive-control-lease-core.ts';

/*
 * The one-controller takeover as a saved control-note state.
 *
 * The pure cores (checkControl, assertNobodyElseIsInControl, decodeControlNotes,
 * buildControlHandBack, effectiveNow, isCurrentlyInControl, the WithDeps
 * orchestrators, the types and constants) are defined ONCE in the
 * dependency-free leaf exclusive-control-lease-core.ts (SSOT) and re-exported
 * from here. This module adds only the default Envelope wiring that reaches the
 * package's read-data surface + contract, so a node-platform target handler
 * imports the cores from the core leaf and never bundles this package's UI
 * read-data or its full contract JSON.
 *
 * The file name stays exclusive-control-lease.ts, a separate decision from the
 * identifier rename above it, tracked in the plan
 * rename-the-lease-jargon-to-plain-words: the manifest's `source_path` names this
 * exact path, so a file rename is a manifest change plus a rebuild, sequenced
 * with the rest of the wire layer, not skipped.
 */
export * from './exclusive-control-lease-core.ts';

/* =============================================================================
 * Default Envelope wiring. The one-controller record/check flow through the SAME
 * owner operations the package already declares (record-lease / check-lease,
 * target slot::workflow), carrying the control-note DATA. No new target, no new
 * operation: one note variant, one gate predicate, inside the charter. Not
 * unit-tested here (they need a live engine); the pure cores carry the contract.
 * ========================================================================== */
function recordAction(actions: PermissionLeaseAction[]): PermissionLeaseAction {
  const action = actions.find((candidate) => candidate.operation === 'record-lease');
  if (!action) throw new Error('permission-lease record action is not configured');
  return action;
}

function checkAction(actions: PermissionLeaseAction[]): PermissionLeaseAction {
  const action = actions.find((candidate) => candidate.operation === 'check-lease');
  if (!action) throw new Error('permission-lease check action is not configured');
  return action;
}

export interface GrantControlRequest extends GrantControlInput {
  idempotencyKey: string;
  evidenceRefs?: string[];
}

export function buildGrantControlRequest(
  input: GrantControlRequest,
  actions: PermissionLeaseAction[] = decodeConfiguredPermissionActions(permissionLeaseContract),
) {
  const action = recordAction(actions);
  return {
    target: action.target,
    payload: {
      definition_id: action.definitionId,
      input: {
        lease_ref: input.leaseRef,
        lease_class: ONLY_ONE_CONTROLS_RULE,
        scope_ref: input.scopeRef,
        holder: input.holder,
        subject_ref: input.holderSubjectRef ?? input.holder,
        allowed_actions: ['computer.actuate'],
        idempotency_key: input.idempotencyKey,
        ...(input.holderSubjectRef ? { holder_subject_ref: input.holderSubjectRef } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {}),
        ...(input.evidenceRefs ? { evidence_refs: input.evidenceRefs } : {}),
      },
    },
  };
}

export function recordControlNote(input: GrantControlRequest) {
  return sendRequestToBitfieldTarget(buildGrantControlRequest(input));
}

export interface ControlCheckRequest {
  scopeRef: string;
  actuatorHolder?: Holder;
  idempotencyKey: string;
  leaseRef?: string;
  evidenceRefs?: string[];
}

export function buildControlCheckRequest(
  input: ControlCheckRequest,
  actions: PermissionLeaseAction[] = decodeConfiguredPermissionActions(permissionLeaseContract),
) {
  const action = checkAction(actions);
  return {
    target: action.target,
    payload: {
      definition_id: action.definitionId,
      input: {
        operation_ref: `control:${input.scopeRef}`,
        requested_action_ref: 'computer.actuate',
        scope_ref: input.scopeRef,
        lease_class: ONLY_ONE_CONTROLS_RULE,
        actuator_holder: input.actuatorHolder ?? DEFAULT_ACTUATOR_HOLDER,
        idempotency_key: input.idempotencyKey,
        ...(input.leaseRef ? { lease_ref: input.leaseRef } : {}),
        ...(input.evidenceRefs ? { evidence_refs: input.evidenceRefs } : {}),
      },
    },
  };
}

export function requestControlCheck(input: ControlCheckRequest) {
  return sendRequestToBitfieldTarget(buildControlCheckRequest(input));
}
