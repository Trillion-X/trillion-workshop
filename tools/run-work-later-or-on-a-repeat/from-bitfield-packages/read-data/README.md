# Read Data Boundary

`read-scheduled-action-graph.ts` folds generic scheduled-action graph rows into
a view model. It accepts records, fields, relationships, time windows, action
descriptors, owner evidence, receipts, and view descriptors as data.

It does not import adjacent owner packages, call workflow, interpret provider
transport, or own product-specific states. Owner packages translate their
internals before their evidence reaches this projection.
