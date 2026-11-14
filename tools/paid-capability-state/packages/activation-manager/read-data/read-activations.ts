import packageContract from '../things-to-store-and-run.json' with { type: 'json' };
import {
  decodeCapabilityStateRecords,
  record,
  type PackageThing,
} from './capability-state-records';
import {
  foldCapabilityState,
  type CapabilityStateProjection,
  type CapabilityStateView,
} from './fold-capability-state';

export type ActivationProjection = CapabilityStateView;

export interface ActivationListProjection extends CapabilityStateProjection {
  activations?: CapabilityStateView[];
}

function packageRecords(): readonly PackageThing[] {
  return Array.isArray(packageContract.things)
    ? packageContract.things.map((thing) => ({ payload: record(thing).payload }))
    : [];
}

export function projectActivationCapabilityState(
  things: readonly PackageThing[] = packageRecords(),
): ActivationListProjection {
  const projection = foldCapabilityState(decodeCapabilityStateRecords(things));
  return { ...projection, activations: projection.views };
}

export function readActivations(
  projection: ActivationListProjection | null | undefined = projectActivationCapabilityState(),
): CapabilityStateView[] {
  return projection?.views ?? projection?.activations ?? [];
}
