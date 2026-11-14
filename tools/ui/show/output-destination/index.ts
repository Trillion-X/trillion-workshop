// packages/ui/show/output-destination/index.ts
// Barrel export for the output-destination primitive.

export type { OutputPayload, OutputDeliverCapability, OutputDestination, OutputDeliveryOutcome } from './types';
export { outputDeliveryOutcome } from './types';
export { mergeOutputDestinations, findOutputDestination } from './read';
