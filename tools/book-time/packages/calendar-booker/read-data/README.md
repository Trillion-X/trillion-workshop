# Calendar Booker Read Data

This folder owns pure package adapters over calendar-booker descriptor rows.
The live log and generic current-record/projection primitives own truth; these
functions only fold supplied rows into renderer-neutral package models.

The adapter must stay side-effect free. It does not call workflow, network,
browser APIs, local storage, or adjacent package internals.

`read-calendar-booker-work-graph.ts` is the active logic/backend read adapter
for CS-096. It buckets descriptor rows by generic kind, carries source and
receipt rows through as data, and emits proof refs for the renderers and tests.
