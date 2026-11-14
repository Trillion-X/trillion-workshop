# Browser/Desktop Consumer Contract

The browser/desktop surface consumes only:

- `record-space-home.materialized-view`
- generic owner-action descriptor data
- generic owner-action event receipts

The consumer renders sections, rows, fields, actions, disabled reasons, freshness, and proof from descriptor data. Product-facing text comes from descriptors or decoded records. Raw storage facts, workflow definitions, package addresses, process output, and stale fixed backend records stay out of the visible surface.

