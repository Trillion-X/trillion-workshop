# tools/close-a-list-row-when-i-say/

Close a list row when I say in my own message that I already did the thing, but only when the answer is a clear yes.

This folder has no row yet. Its old Trillion files are in `from-an-older-version/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

The decision is ported: `src/said-done.mjs` with its DATA `src/said-done.json` (the same bytes as the old file) and `test/said-done.test.mjs` (the unit outcomes of the old test, 8 pass). Its owners are passed in (`broughtIn`, `read`, `listFor`, `ask`, `settle`, `handOff`), so no caller is named here. Not yet wired: nothing calls `weighSaidDone` on the person's kept messages, so the end-to-end outcome (a message through the door closes the row, and the waiting surfaces drop it) is not running. See the handoff row in the verify-every-port lane.
