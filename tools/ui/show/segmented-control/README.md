# segmented-control

Controlled one-of-many choice primitive.

- Caller owns item identity, selected value, and persistence.
- Visuals inherit the active screen look through generic tokens.
- The track is a corner holder (`data-segmented-control`, `data-corner-holder`) and each choice follows it
  (`data-corner-follows`): screen-look `nested-corners.css` gives the track the look's control corner and the
  choices that corner less the line and padding.
- No package, workflow, storage, or target behavior lives here.

Icon-only choices that open their label when chosen use `expandable-tabs/`
(`mode: 'choice'`); this control always shows every label.

## Two-line choices

A choice may carry `note` (a second, quieter line under its label: a change over a range, a count) and `noteTone`
(what the note means, such as `rise` or `fall`). The tone is written as `data-note-tone` on the note and the look
decides its colour; the part never holds one. When any choice has a note the whole track is two lines tall
(`data-noted="true"`) so the choices stay level, and each choice's accessible name reads "label, note".
