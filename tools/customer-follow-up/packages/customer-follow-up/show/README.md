# Customer Follow-Up Show

This folder renders customer progress, customer selection, timeline evidence,
and the record follow-up action.

## Reference Lock

The surface is governed by
`dev/bitfield-packages/packages/customer-follow-up/reference-grounded-screen-contract.md`
and its Mobbin proof in
`dev/bitfield-packages/packages/customer-follow-up/proof/mobbin-reference-proof.md`.

## Mount Contract

Runtime Kit invokes package material entries with `{ el, props }`. The mount
keeps that shape and delegates frame, error-boundary, and React root lifecycle
to the shared UI material mount primitive.
