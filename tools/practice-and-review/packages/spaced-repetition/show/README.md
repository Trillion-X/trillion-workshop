# Spaced Repetition Surface

Reference-grounded source UI for due review queue, active prompt, answer reveal, and response controls.

## Empty And Sparse State

When no card is due, the surface renders `Review queue is caught up` with
prompt, reveal, and rating slots. The empty state explains the review loop
without leaking scheduler internals.

## Mount Contract

Runtime Kit invokes package material entries with `{ el, props }`. The mount
keeps that shape and delegates frame, error-boundary, and React root lifecycle
to the shared UI material mount primitive.
