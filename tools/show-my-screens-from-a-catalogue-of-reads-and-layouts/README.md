# tools/show-my-screens-from-a-catalogue-of-reads-and-layouts/

Show my screens from a catalogue of reads and layouts, page by page, each drawn from the facts its reads answered.

Its rows are catalogue screens the engine's generic screen host answers (`GET /work/api/screens/<id>`): `tool:look` (reads nothing) and `tool:get-started` (one read, `tool:read-setup` in tools/set-up-my-account, for the asking browser and the page's own account; its layout is what that read answered) and `tool:business` (one read, `tool:read-business` in tools/see-what-my-business-took-in-this-month; its layout is old trillion's Business layout, unchanged, drawn from that read's facts; its test and golden are in that folder). Tests: `test/catalogue-screen-look.test.mjs`, `test/catalogue-screen-get-started.test.mjs`.

Before those rows it had none. Its old Trillion files are in `from-old-trillion/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-old-trillion/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## Files

| File | Purpose |
|------|---------|
| `web/src/pursuit-detail-screen.mjs` | `pursuitFacts`: one pursuit opened on Progress (`tool:progress`): the pursuit, the pursuits above and inside it, the setups saved with it and who it is shared with. Moved byte for byte from the web client (`moved-from.json`). |
| `moved-from.json` | The receipt of the move: each moved file's source path and commit and the identity of its bytes there and here. |
