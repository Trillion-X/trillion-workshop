# tools/move-the-public-door/

Where a person's public door runs and the hosting rows it can move between, read from their Service connections list, which the person's AI reads from its own store and hands in as `connections`; renting and releasing one host lease from a hosting row's own requests; cutting one hostname over to a new address while every other DNS record and guarded list stays as it was, and keeping one name answering with the front-door computers that pass their health check; and the move itself, which chains those steps with the host setup and proof. Nothing is kept: every receipt (a lease, a cutover, the move's journal) is held in the run, saved in memory before each provider change, and answered; the person's AI stores it and hands it back as input to the next step. Ported one to one from the older owner's door rows reader, host lease, DNS cutover and move (ports/).

## How it runs

`tool:see-where-the-public-door-runs` takes the person's Service connections rows as `connections` (`record:service-connection`, the Service connections list `list:service-connections`), read by the person's AI directly from their own store. It names no records method and declares no records door. A row carrying `rents_a_host` is a hosting provider; its requests are the row's own `instrument_requests`. The `public-door-placement` row with id `current` is where the door runs now. Credentials appear in these rows only as a vault name (`vault_key`).

The other three rows act on a provider and declare no records door either. They take what they need as input and answer what they make:

- `connections`: the values of the Service connections rows the tool needs, read by the person's AI from that list (the store's own tool server).
- `lease` (rent, optional; release): the lease an earlier answer of `tool:rent-a-host-for-the-public-door` gave. Rent answers it, release answers it removed.
- `dns`: the DNS provider description the person keeps (a file of theirs, handed in as its content): base, auth header, vault name, its `requests` and the `zone`, `record` and `binding` parts that say which request does what (see the header of `do-work/portable-dns-cutover.mjs`). The tool names no DNS provider; a new one is a new description.
- `receipt` (cut over: activate, roll back, status): the receipt `prepare` answered. Every cutover answer carries the changed `receipt`.

A run that stops partway keeps nothing; the lease a rent answered is the only record of the host it rented, so the person's AI stores it before it does anything else.

A provider key reaches a run only through its row's credential mount, which names the secret by a path in the run's input: `{ secret_name_from_input: "hosting.rents_a_host.vault_key", env: "HOSTING_API_TOKEN", only_when: { input: "hosting.rents_a_host.vault_key", present: true } }` for a host (the caller hands in the hosting row itself, as it hands the DNS row as `dns`; a box the person already runs has no key and mounts none) and `{ secret_name_from_input: "dns.vault_key", env: "DNS_API_TOKEN" }` for a name. So the key follows the vault name the person's own row gives, never a name in the tool. The code reads it from that fixed variable (`heldFrom`), sends it only in that provider's own auth header, and never prints, keeps or answers it.

The move (`do-work/move-public-door.mjs` `movePublicDoor`) is a function whose host setup and download steps are handed in. Its row comes with the tools that own those steps: the public proxy and the carrier to a meeting point (tools/carry-a-computer-to-a-meeting-point).

## Files

| File | Purpose |
|------|---------|
| `read-data/public-door-rows.mjs` | The door rows reader over the `connections` values handed in: `hostingProviders`, `hostingProvider(id, connections)` and `currentDoor(connections)`. It reads and writes no list. |
| `read-data/door-receipts.mjs` | `keptReceipts(seed)`: `{ read(name), save(name, value), all() }` held in the run, starting from the receipts of earlier runs handed in by name. |
| `do-work/portable-dns-cutover.mjs` | `dnsClient(token, { provider, call })`, which sends only the requests the description declares (a `transport: "engine"` description is sent through the injected engine `call({ address, tool, input })`, holding no credential); `prepareCutover`, `changeCutover` (activate or roll back, a plain record, a record owned by a provider binding, or a name that holds no address record yet, placed new: activate makes its one record, rollback removes it), `readCutover`; `keepHealthyRecords` (the name answers with exactly the front-door computers that pass `check`; adds before removes, never empty) and `probeHealthy` (an HTTPS GET at an address for the name). A provider with `transport: "engine"` is an MCP server reached through the engine: `dnsClient` sends each declared tool as one engine `tools:run` of `<host>/<tool>` and reads its structured result. A provider with `zone.name_relative` names hosts relative to the zone (`{host_label}`, '@' for the apex), and one with `record.id_is_fields` keeps no record ids: a record is removed by its body, and `record.owner_by: "address"` owns a record whose address is one of the row's candidates; any other address record at the name is refused unless adopted. The Namecheap description (`tools/start-a-computer/providers/namecheap.json`) is the example of all three. |
| `do-work/move-public-door.mjs` | `movePublicDoor`: rent, set up, publish the download, cut DNS, prove the new address, release the old lease, answer the new current-door row, the journal and every receipt (`{ door, receipt, receipts }`). A failed proof rolls DNS back and keeps the old lease; a move that stops partway throws with the receipts made so far as `error.receipts`. |
| `do-work/door-tools.mjs` | The rows' functions (`seeWhereTheDoorRuns`, `rentAHost`, `releaseAHost`, `cutAHostnameOver`) and `heldFrom`. |
| `tool-rows.json` | `tool:see-where-the-public-door-runs`, `tool:rent-a-host-for-the-public-door`, `tool:release-a-host-of-the-public-door`, `tool:cut-a-hostname-over-to-a-new-address`. |
| `moved-from.json` | The receipt for the door code that read and rewrote the shipped `connect-a-service-and-seal-its-key/records.json`: each now lives in the file named, over the person's list. |
| `ports/` | The contracts: each ported file names its older owner, the byte-copy commit and what it keeps. |
| `test/read-the-connections-from-a-store.test.mjs` | Proof of the read: the rows kept in a JSON file and in a PostgreSQL database (PGlite, in memory) are read by a direct query and handed in, and the tool answers the same from either. |
| `test/namecheap-world.mjs` | A made-up Namecheap zone behind an injected engine `call` (`namecheapWorld(records)`), reading the published Namecheap description as it is: relative names, paging, and removal by record body. |
| `test/namecheap-dns.test.mjs` | The client against that description: zone lookup, paging, relative names, record-body removal, owned versus foreign address records, adopt, declared tools only, and refusal text. |
| `test/door-world.mjs` | The test world: synthetic Service connections rows as `connectionValues()`, `DNS` (a made-up DNS provider description), and no records door: the rows are handed in. |
| `test/public-door.test.mjs`, `test/dns-cutover.test.mjs` | The older owner's tests, carried over with their assertions, on the stand-in door. |
| `test/door-rows.test.mjs` | The rows run as the engine runs them. |
| `test/door-receipts.test.mjs` | The receipts held in the run, and the `receiptStore` adapter the lease owner reads and saves through. |

The door tools rent and release through the one lease owner, `tools/start-a-computer/do-work/rent-a-machine.mjs` (`rentMachine`, `releaseMachine`, `providerClient`), over a lease store `{ read(), save(lease) }`. The door tools hold receipts in the run: `receiptStore(receipts, name)` makes the store of one named receipt.

## Dependencies

**Depends on:** `tools/records-door` (`run-a-function.mjs`, which runs each row's function), Node's `fetch`, `node:dns`, `node:net`, and `/usr/bin/curl` for the move's proof. Tests only: `@electric-sql/pglite`.

**Depended on by:** `tool-rows.json`, run on the person's computer by Trillion's local engine (trillion-rust `src/runtime/workshop.rs`).
