# tools/network-people/

A person's Network profile and the searches over it. A person changes how they show (name, handle, what they offer and seek, whether they are findable, their pursuits and their meaning vectors); finds people whose listings are close in meaning to a need; sees people whose shown pursuits are close to their own; and gets another person's contact only once an introduction between them is released.

Ported from an older tag of the old worker tools (`tools/list-and-run-my-tools-for-any-ai/source-baselines/tools.mjs.held` at commit a476dd597): `network_profile` (line 295), `find_people` (line 297), `on_my_path` (line 298). The old ranking is src/network.mjs `find` (lines 2009-2017, cosine at the network settings' `min_similarity`, or a share of the need's words when there is no embedding) and `onPath` (lines 2022-2060, cosine at `on_your_path.min_similarity`). The thresholds are not copied: they are read from `tools/introduce-two-people/src/network-settings.json`, the owner's DATA.

## How a row runs

Every row runs `do-work/network-profile-sql.mjs` with its function named as the first argument. The request is one JSON object on standard input. The connection to the person's pursuit database is a held value handed to the process on descriptor 3 (the row's `credential_mounts`); it is never in the request, argv, a file or the environment. The process makes a `network_records` table when it is missing (`CREATE TABLE IF NOT EXISTS`), reads the Network rows (profiles, labels and introductions), calls one pure function, and writes each row the function changed with the value it read, refusing the write when the row has moved since.

## Egress (open)

These rows declare `internet: true`, because the process must reach the person's pursuit database through the run's proxy. The engine opens that path only to the hosts the held connection's vault entry names, but a row that declares internet true is the exposure c5's fence is meant to close: until it lands, a run of these rows can reach any host the engine allows for that connection. `database` is declared required in each row's input schema, so no run without a named database reaches the process.

## Meaning

A listing carries its own embedding, which the person's AI makes; the caller hands the need's embedding in. This folder does not make embeddings: the Workshop has no text-embedding owner (`tools/form-groups-and-matches` ranks by AI-cited scores, not embeddings, so it is not the source). Without a need embedding, `find` matches by shared words, and the path has no fallback.

## Contact

A contact is kept on the person's own profile row. `tool:read-a-network-contact` answers it only while the introduction between the two people is in a released state. The state is read from `introduction_states` in the person's database, by the pair's key (`record:network-introduction:<first>:<second>`, the two addresses sorted and percent-encoded), the one store introduce-two-people writes through `tool:record-an-introduction-state`. Released: accepted, waiting for AIs, introduced, talked (`RELEASED` in `do-work/network-people.mjs`). Proposed, one yes, sent, declined, passed and expired are refused, and so is a stranger or no row. The tests check each of the ten states both ways through the SQL path.

## What is not ported

- The old credit cost of find and the path (`cost_by_distance`, `stranger_cost`) is not here.
- Open pursuits on the path match by meaning only when the space's own record carries an embedding; nothing here makes one (no run can embed today). Access-based join rows (`{ access }`, `{ invited }`) are not read, so only spaces with a free row are answered.
- Meaning-matching in find and on-my-path is PARTIAL until a run can embed: the vectors come from the caller today.
- `given_name` and `family_name` (private account names from the purchase) are not here.

## Files

| File | Purpose |
|------|---------|
| `read-data/profile-rows.mjs` | The record kinds (profile, label, introduction), ids, the records a run is handed, and `keepRow`. |
| `do-work/network-people.mjs` | The four functions: `networkProfile`, `findNetworkPeople`, `onMyPath`, `readNetworkContact`; the cosine; the released states. |
| `do-work/network-profile-sql.mjs` | The one process the rows run: reads and writes `network_records` through the held connection. |
| `tool-rows.json` | The four rows: `tool:network-profile`, `tool:find-network-people`, `tool:on-my-path`, `tool:read-a-network-contact`. |
| `kits/` | One kit per row. |
| `test/network-people.test.mjs` | Changes, refusals, meaning thresholds both ways, the words fallback, labels, paths, every released and unreleased state, the stranger rule, and the write-if-unchanged rule. |
