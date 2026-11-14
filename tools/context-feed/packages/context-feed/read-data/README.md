# context-feed read-data

This folder owns the package-side pure projection code for `context-feed`.

The JavaScript here is deliberately vocabulary-free: it evaluates data-described
record projection lenses, owner-action handoff descriptors, grouping, labels,
and diagnostics. Package words and source field names live in package records
inside `things-to-store-and-run.json`, not in evaluator branches.
