# Match Picks Show

Renders match selection, winner pick controls, community pick split, total picks,
result summary, and personal pick history.

## Empty And Sparse State

When there are no pick prompts, the surface renders the Studio starter card for
opening the first two-choice match pick. Empty copy is not a terminal message;
it exposes the match label, both choices, and the `Open pick` action.

## Mount Contract

Runtime Kit invokes package material entries with `{ el, props }`. The mount
keeps that shape and delegates frame, error-boundary, and React root lifecycle
to the shared UI material mount primitive.
