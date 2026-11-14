// packages/ui/show/property-control/index.ts
//
// Barrel for the generic PropertyControl primitive — one blind, descriptor-driven
// control renderer that dispatches its widget through a capability map. See
// PropertyControl.tsx for the full contract.

export {
  PropertyControl,
  coercePropertyValue,
  type PropertyControlDescriptor,
  type PropertyControlProps,
} from './PropertyControl';
