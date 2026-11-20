# tools/show-my-screens-from-a-catalogue-of-reads-and-layouts/

Show my screens from a catalogue of reads and layouts, page by page, each drawn from the facts its reads answered.

It holds no catalogue screen now. The engine's generic screen host answers a catalogue row at `GET /work/api/screens/<id>`; the last row, `tool:look` (reads nothing, drew its Panes and Feel sections from rows of its own), retired onto `tool:read-pane-and-feel-settings` (tools/arrange-screens-in-panes: the pane sizes and the feel rows, read from their own files). Retired: `tool:get-started`, whose one read `tool:read-setup` (tools/set-up-my-account) draws the setup steps (a missing step is a tool the AI uses, never a setup screen, Nov 18), and `tool:business`, whose reads are `tool:read-business` (tools/see-what-my-business-took-in-this-month) and `tool:add-up-revenue` (tools/revenue-ledger).

Before those rows it had none. Its old Trillion files are in `from-an-older-version/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## Files

| File | Purpose |
|------|---------|
| `web/src/pursuit-detail-screen.mjs` | `pursuitFacts`: one pursuit opened on Progress (`tool:progress`): the pursuit, the pursuits above and inside it, the setups saved with it and who it is shared with. Moved byte for byte from the web client (`moved-from.json`). |
| `moved-from.json` | The receipt of the move: each moved file's source path and commit and the identity of its bytes there and here. |
