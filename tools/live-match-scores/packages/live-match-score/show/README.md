# Live Match Score Show

Renders the scorer flow, share link, live score buttons, and compact live board
from package read models.

Positive score taps use the package score-advance input builder so tennis and
pickleball scoring rules stay in the backend source contract. Score events still
write through `action:live-match-score.record-event`.

## Empty And Sparse State

The source surface must show match-level score context even when the latest
event is sparse: sets, games, current point, live board rows, and point/undo
actions. It must not collapse the match back to a game-only `0-0` display.

## Mount Contract

Runtime Kit invokes package material entries with `{ el, props }`. The mount
keeps that shape and delegates frame, error-boundary, and React root lifecycle
to the shared UI material mount primitive.
