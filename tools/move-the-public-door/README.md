# tools/move-the-public-door/

Where a person's public door runs and the hosting and DNS rows it can move between, read from their Service connections list through the records door (the one tool that reads a list); renting and releasing one host lease from a hosting row's own requests; cutting one hostname over to a new address while every other DNS record and route stays as it was; and the move itself, which chains those steps with the host setup and proof. Nothing is kept: every receipt (a lease, a cutover, the move's journal) is held in the run, saved in memory before each provider change, and answered; the person's AI stores it and hands it back as input to the next step. Ported one to one from the older owner's door rows reader, host lease, DNS cutover and move (ports/).

## How it runs

`tool:see-where-the-public-door-runs` reads the person's Service connections list through the records door (`invoke.records`, fd 3, `records:list` only): `record:service-connection`, the Service connections list (`list:service-connections`). A row carrying `rents_a_host` is a hosting provider; its requests are the row's own `instrument_requests`. A row carrying `points_a_name` is a DNS provider. The `public-door-placement` row with id `current` is where the door runs now. Credentials appear in these rows only as a vault name (`vault_key`).

The other three rows act on a provider and declare no records door. They take what they need as input and answer what they make:

- `connections`: the values of the Service connections rows the tool needs, read by the person's AI from that list (the store's own tool server).
- `lease` (rent, optional; release): the lease an earlier answer of `tool:rent-a-host-for-the-public-door` gave. Rent answers it, release answers it removed.
- `receipt` (cut over: activate, roll back, status): the receipt `prepare` answered. Every cutover answer carries the changed `receipt`.

A run that stops partway keeps nothing; the lease a rent answered is the only record of the host it rented, so the person's AI stores it before it does anything else.

A provider key reaches a run only through its row's credential mount, `{ secret_name: <vault name>, env: <the vault name in capitals, dashes as underscores> }`. The code reads it by the vault name the list row gives (`heldFrom`), sends it only in that provider's own auth header, and never prints, keeps or answers it.

The move (`do-work/move-public-door.mjs` `movePublicDoor`) is a function whose host setup and download steps are handed in. Its row comes with the tools that own those steps: the certificate and public proxy (tools/renew-a-tls-certificate) and the door tunnel (tools/keep-a-door-tunnel-open).

## Files

| File | Purpose |
|------|---------|
| `read-data/public-door-rows.mjs` | The door rows reader over the `connections` values handed in: `hostingProviders`, `dnsProviders`, `hostingProvider(id, connections)`, `dnsProvider(id, connections)` and `currentDoor(connections)`. It reads and writes no list. |
| `read-data/door-receipts.mjs` | `keptReceipts(seed)`: `{ read(name), save(name, value), all() }` held in the run, starting from the receipts of earlier runs handed in by name. |
| `do-work/portable-host-lease.mjs` | Public lease API: `leaseClient`, `provisionHostLease`, `removeHostLease`, `watchHostLease`, `readHostLease`, `readHostState`, `readPrice`, `pointName`, `forgetName`, and `fingerprintOf`. It shares provider request checks, ownership and recovery across callers. |
| `do-work/portable-dns-cutover.mjs` | `dnsClient(token, { provider })`, which allows only the exact-host DNS shapes; `prepareCutover`, `changeCutover` (activate or roll back, a plain record or a production Worker domain), `readCutover`. |
| `do-work/move-public-door.mjs` | `movePublicDoor`: rent, set up, publish the download, cut DNS, prove the new address, release the old lease, answer the new current-door row, the journal and every receipt (`{ door, receipt, receipts }`). A failed proof rolls DNS back and keeps the old lease; a move that stops partway throws with the receipts made so far as `error.receipts`. |
| `do-work/door-tools.mjs` | The rows' functions (`seeWhereTheDoorRuns`, `rentAHost`, `releaseAHost`, `cutAHostnameOver`) and `heldFrom`/`heldVariable`. |
| `tool-rows.json` | `tool:see-where-the-public-door-runs`, `tool:rent-a-host-for-the-public-door`, `tool:release-a-host-of-the-public-door`, `tool:cut-a-hostname-over-to-a-new-address`. |
| `moved-from.json` | The receipt for the door code that read and rewrote the shipped `connect-a-service-and-seal-its-key/records.json`: each now lives in the file named, over the person's list. |
| `ports/` | The contracts: each ported file names its older owner, the byte-copy commit and what it keeps. |
| `test/door-world.mjs` | The test world: synthetic Service connections rows as `connectionValues()`, and `listDoor(t)`, the stand-in records door holding them for `seeWhereTheDoorRuns`. |
| `test/public-door.test.mjs`, `test/host-lease.test.mjs`, `test/dns-cutover.test.mjs` | The older owner's tests, carried over with their assertions, on the stand-in door. |
| `test/door-rows.test.mjs` | The rows run as the engine runs them. |
| `test/shared-lease-extensions.test.mjs` | Synthetic shared-key reuse, exact-location pricing, owned DNS creation/removal, request admission and receipt-conflict controls. |

The public lease API takes provider rows and a receipt store `{ read(name), save(name, value) }`. The door tools hold receipts in the run (`keptReceipts`); another caller can supply private atomic file receipts without copying the provider or recovery loop. Optional `schema` preserves the caller's receipt format. Stored public SSH keys are reused by fingerprint and never removed with a lease that did not create them.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`, which runs each row's function, and the stand-in door in tests), Node's `fetch`, `node:dns`, `node:net`, and `/usr/bin/curl` for the move's proof.

**Depended on by:** `tool-rows.json`, run on the person's computer by Trillion's local engine (trillion-rust `src/runtime/workshop.rs`).
