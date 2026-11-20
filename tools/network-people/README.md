# tools/network-people/

A person's Network profile and the two searches over it: a person changes how they show (name, handle, what they offer and seek, whether they are findable, their pursuits), finds people by the words of a need, and sees people whose shown pursuits share words with their own.

Ported from an older tag of the old worker tools (`tools/list-and-run-my-tools-for-any-ai/source-baselines/tools.mjs.held` at commit a476dd597): `network_profile` (line 295), `find_people` (line 297) and `on_my_path` (line 298). The old code called the person's store over `/network/...` routes. Here a profile is a `record:network-profile` row the caller reads from its own store and hands in as `records`; a call answers the changed row under `keep` for the caller to store. The run reads and writes no store.

## What is not ported

- `find_people` matched by meaning and charged credits. This port matches by shared words only; a meaning match needs an embedding source, and no one has ruled which to use.
- `on_my_path` answered open pursuits as well as people. Open pursuits are not answered here yet.
- A contact is kept on the person's own row and is never answered by these tools. Release of a contact waits for the introduction tool (not in this folder).
- `given_name` and `family_name` (private account names from the purchase) are not here.

## Files

| File | Purpose |
|------|---------|
| `read-data/profile-rows.mjs` | The record kinds (`record:network-profile`, `record:network-label`), ids, the records a run is handed, and `keepRow`. |
| `do-work/network-people.mjs` | `networkProfile`, `findNetworkPeople`, `onMyPath`. |
| `do-work/network-people-run.mjs` | The command the rows run: one JSON request on standard input, `{ result }` or `{ error }` last. |
| `tool-rows.json` | The three rows: `tool:network-profile`, `tool:find-network-people`, `tool:on-my-path`. |
| `kits/` | One kit per row. |
| `test/network-people.test.mjs` | Changes, refusals, the search, labels and the paths, on made-up people. |
