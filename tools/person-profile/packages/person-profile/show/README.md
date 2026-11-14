# Person Profile Show

The show layer is a renderer handoff adapter. It consumes `DescribedRecordSurface` materializations and emits section descriptors for UI renderers.

It does not decode raw owner records, map field keys to labels, classify related records, or branch on profile viewer modes.
