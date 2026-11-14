# Opponent Game Plan Show

The source surface renders opponent search, profile details, private scouting,
match-plan requests, and tactic result buttons.

It reads human-ready DTOs from `read-data/`; it does not assemble raw generic
records in the component.

The empty report state uses the same compact Studio starter card as record
board/tasks surfaces: opponent name, strengths, weaknesses, worked/failed notes,
scouting notes, and the `Save scouting` action. A blank search plus "No player
reports yet" is not an acceptable product state.

## Mount Contract

Runtime Kit invokes package material entries with `{ el, props }`. The mount
keeps that shape and delegates React root lifecycle to the shared UI mount
primitive.
