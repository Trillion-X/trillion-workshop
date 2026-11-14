export {
  projectActivationCapabilityState,
  readActivations,
} from './read-data/read-activations';
export { decodeCapabilityStateRecords } from './read-data/capability-state-records';
export { foldCapabilityState } from './read-data/fold-capability-state';
export { invokeCapabilityActionDescriptor } from './do-work/invoke-capability-action';
export { deliverDevicePermission } from './do-work/deliver-device-permission';
export { ActivationManager } from './show/ActivationManager';
export type {
  ActivationListProjection,
  ActivationProjection,
} from './read-data/read-activations';
export type { CapabilityStateProjection, CapabilityStateView } from './read-data/fold-capability-state';
