# activation-manager/read-data

Readers in this folder translate generic capability-state records into package
state.

The source records are open descriptors: subject references, capability
references, evidence references, action descriptors, requirements, attempts, and
results. Package-specific states and owner behavior are data, then folded into
maintained exact-address projections.

`read-activations.ts` exposes that fold as the browser/desktop and iOS JSCore
contract. Both renderers consume `views[]`; neither receives a closed activation
status enum.
