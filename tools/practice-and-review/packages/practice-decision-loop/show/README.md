# Practice Decision Loop Show

This folder contains the small generic proof surface for the decision practice
primitive.

The surface reads generic prompt records, shows answer choices, accepts the
reason text, and submits through `action:practice-decision-loop.submit-response`
with the caller-supplied user id.

Product packages own product labels and richer screens. This surface stays
domain-neutral and carries no product-family vocabulary.

## Empty And Sparse State

The generic empty state creates the first two-choice practice decision with a
question title, both choices, question body, and `Open question`. It is the
source-owned starter for packages that do not provide a richer product shell.

## Mount Contract

Runtime Kit invokes package material entries with `{ el, props }`. The mount
keeps that shape and delegates React root lifecycle to the shared UI mount
primitive.
