# Invocation provenance

`http-invocation.json` is the source-adaptation declaration for the generic HTTP renderer, encoder and executor. It names immutable original source ranges and a genuine separate baseline artifact commit. The current state is `ADAPTED` with real tests and qualified deltas, not a claim of deployment or a completed provider action.

The inherited `old_copy.deleted_by` timestamps are historical deadlines, not new claims about when deletion occurred. The repository reader evaluates current retirement. The genuine held captures remain in `../source-baselines`; they must not be erased or presented as the active implementation.

The real consumer is `../test/review-invocation-provenance.mjs`, which uses the shared validator and immutable Git reader without substituting source bytes or history.
