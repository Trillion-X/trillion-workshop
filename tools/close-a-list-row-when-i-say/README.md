# tools/close-a-list-row-when-i-say/

Close a list row when I say in my own message that I already did the thing, but only when the answer is a clear yes.

This folder has no row yet. Its old Trillion files are in `from-an-older-version/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

The decision is ported as steps a workflow runs (src/said-done.mjs): `saidDoneAsks` (the question for each open row the message names, pure), `saidDoneVerdict` (what one answer means: settle, leave, or hand on, pure), and `weighSaidDone` chaining them with the owners passed in. DATA is `src/said-done.json`. Tests: `test/said-done.test.mjs` (the 8 old outcomes) and `test/said-done-steps.test.mjs` (6 step tests), 14 pass. Not yet wired: no tool row exposes the steps, no workflow recipe runs them, and no wake on a row change calls them, so a message through the door does not close a row yet (see the verify-every-port handoff rows).
