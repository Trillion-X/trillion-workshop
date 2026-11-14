# Read Data

This folder owns pure descriptor projection for `codes-and-rewards`.
`read-record-interaction-surface.ts` consumes a `RecordInteractionContract` and
current rows, then emits records, summaries, available actions, and problems
without branching on package labels.

Domain labels such as visible categories, states, field names, and action copy
come from descriptor data. Missing current records become explicit problem rows;
the reader does not invent sample data.
