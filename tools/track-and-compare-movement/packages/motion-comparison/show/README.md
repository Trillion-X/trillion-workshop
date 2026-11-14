# Motion Comparison Show

Renders comparison setup, latest comparison factor summary, sync window, tradeoff
note, and coaching-note attachment controls.

## Empty And Sparse State

The setup screen accepts human labels and media/source links, then translates
them to internal clip ids at the action boundary. The UI must not ask the user
to type raw clip ids before any comparison exists.

## Mount Contract

Runtime Kit invokes package material entries with `{ el, props }`. The mount
keeps that shape and delegates frame, error-boundary, and React root lifecycle
to the shared UI material mount primitive.
