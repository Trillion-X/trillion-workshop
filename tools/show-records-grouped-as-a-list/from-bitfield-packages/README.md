# group-list

Source proposal for the CS-050 group-list logic/backend rebase.

Live app truth is the selected Bitfield root log fold. This folder is the package
source workshop for implementation material that can be imported through the
package implementation path. Editing this folder is not a live data write.

## Contract

The package is a data configuration over the existing generic primitives:

- EEAF/record facts describe fields, filters, relationships, labels, and actions.
- The projection adapter folds open descriptors into derived snapshots.
- The action adapter builds opaque owner-action/workflow/process-session requests.
- Surfaces consume derived rows and action descriptors; they do not own backend
  policy.

Package words may appear in descriptor data and fixtures. Shared mechanics only
read paths, invoke configured methods, and pass raw values through.

## Proof

```bash
cd bitfield-packages
node packages/group-list/tests/boundary.test.mjs
node packages/group-list/tests/projection.test.mjs
node packages/group-list/tests/action-adapter.test.mjs
```
