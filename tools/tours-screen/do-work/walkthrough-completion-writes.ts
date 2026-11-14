import type { HostEvent } from '../engine/trigger-intake.ts';
import type { WalkthroughDefinition, WalkthroughWrite } from '../read-data/walkthrough-eeaf.ts';

type ExitDisposition = 'completed' | 'skipped';

export interface ScopedRunIdentity {
  readonly scope_ref: string;
  readonly definition_id: string;
  readonly definition_revision: number;
  readonly run_id: string;
}

export interface SuccessorTriggerRefs {
  readonly destination_operation_ref: string | null;
  readonly destination_readback_ref: string | null;
  readonly successor_trigger_ref: string | null;
}

export interface SuccessorTriggerDispatch {
  readonly event: { readonly event_kind: string; readonly [field: string]: unknown };
  readonly refs: Required<SuccessorTriggerRefs>;
}

export interface WalkthroughOutcomeRefs extends SuccessorTriggerRefs {
  readonly successor_dispatch: SuccessorTriggerDispatch | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function scalar(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

export function outcomeRefsAfterExit(
  definition: WalkthroughDefinition,
  sourceEvent?: HostEvent,
): WalkthroughOutcomeRefs {
  const descriptor = object(definition.completion);
  const ref = (key: string) => typeof descriptor?.[key] === 'string' && String(descriptor[key]).trim()
    ? String(descriptor[key]).trim()
    : null;
  const refs = {
    destination_operation_ref: ref('destination_operation_ref'),
    destination_readback_ref: ref('destination_readback_ref'),
    successor_trigger_ref: ref('successor_trigger_ref'),
  };
  const eventKind = typeof descriptor?.successor_event_kind === 'string' && descriptor.successor_event_kind.trim()
    ? descriptor.successor_event_kind.trim()
    : typeof descriptor?.event_kind === 'string' && descriptor.event_kind.trim()
      ? descriptor.event_kind.trim()
      : typeof sourceEvent?.event_kind === 'string' && sourceEvent.event_kind.trim()
        ? sourceEvent.event_kind.trim()
        : null;
  const complete = Object.values(refs).every((value) => value !== null) && eventKind !== null;
  return {
    ...refs,
    successor_dispatch: complete
      ? {
          event: { event_kind: eventKind },
          refs: refs as Required<SuccessorTriggerRefs>,
        }
      : null,
  };
}

export function completionWriteAfterExit(
  definition: WalkthroughDefinition,
  sourceEvent: HostEvent,
  disposition: ExitDisposition,
  run?: ScopedRunIdentity,
): WalkthroughWrite | null {
  const descriptor = object(definition.completion);
  const eventKind = typeof descriptor?.event_kind === 'string' ? descriptor.event_kind : null;
  if (!eventKind || !run) return null;
  if (run.definition_id !== definition.id
    || !Number.isSafeInteger(run.definition_revision)
    || run.definition_revision < 1
    || !run.scope_ref.trim()
    || !run.run_id.trim()) return null;

  return completionWriteForRun(eventKind, sourceEvent, disposition, run,
    outcomeRefsAfterExit(definition, sourceEvent).successor_dispatch);
}

/** One package-owned address/value derivation shared by the caller and writer. */
export function completionWriteForRun(
  eventKind: string,
  sourceEvent: Readonly<Record<string, unknown>>,
  disposition: ExitDisposition,
  run: ScopedRunIdentity,
  successorDispatch: SuccessorTriggerDispatch | null,
): WalkthroughWrite {

  const scopedRunKey = [
    run.scope_ref,
    run.definition_id,
    run.definition_revision,
    run.run_id,
  ].map((part) => encodeURIComponent(String(part))).join('::');
  const sourceOccurrence = scalar(sourceEvent.occurrence_id ?? sourceEvent.source_occurrence);

  return {
    address: `package::guided-overlay::completion::${encodeURIComponent(eventKind)}::${scopedRunKey}`,
    value_json: {
      kind: eventKind,
      event_kind: eventKind,
      scope_ref: run.scope_ref,
      definition_id: run.definition_id,
      definition_revision: run.definition_revision,
      run_id: run.run_id,
      disposition,
      successor_dispatch: successorDispatch,
      ...(sourceOccurrence === null ? {} : { source_occurrence: sourceOccurrence }),
    },
  };
}
