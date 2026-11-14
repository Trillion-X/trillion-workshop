# Practice Protocol Surface

Reference-grounded source UI for practice plan selection, current step, completion state, and action.

## Empty And Sparse State

The empty surface renders `Practice protocols are waiting for a plan` with
protocol, steps, and launcher slots. It stays visually aligned with the record
board/tasks package style.

## Mount Contract

Runtime Kit invokes package material entries with `{ el, props }`. The mount
keeps that shape and delegates frame, error-boundary, and React root lifecycle
to the shared UI material mount primitive.
