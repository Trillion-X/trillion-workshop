# tools/move-the-public-door/

Where a person's public door runs and the hosting and DNS rows it can move between, read from their Service connections list through the records door; renting and releasing one host lease from a hosting row's own requests; cutting one hostname over to a new address while every other DNS record and route stays as it was; and the move itself, which chains those steps with the host setup and proof. Every receipt (a lease, a cutover, the move's journal) is a row of the person's Public door receipts list, saved before each provider change. Ported one to one from the older owner's door rows reader, host lease, DNS cutover and move (ports/).

## How it runs

The rows read and write only through the records door (`invoke.records`, fd 3):

- `record:service-connection`, the Service connections list (`list:service-connections`). A row carrying `rents_a_host` is a hosting provider; its requests are the row's own `instrument_requests`. A row carrying `points_a_name` is a DNS provider. The `public-door-placement` row with id `current` is where the door runs now. Credentials appear in these rows only as a vault name (`vault_key`).
- `record:public-door-receipt`, the Public door receipts list. Each save is conditioned on the value last read, so a receipt another run changed meanwhile is refused, never written over.

A provider key reaches a run only through its row's credential mount, `{ secret_name: <vault name>, env: <the vault name in capitals, dashes as underscores> }`. The code reads it by the vault name the list row gives (`heldFrom`), sends it only in that provider's own auth header, and never prints, keeps or answers it.

The move (`do-work/move-public-door.mjs` `movePublicDoor`) is a function whose host setup and download steps are handed in. Its row comes with the tools that own those steps: the certificate and public proxy (tools/renew-a-tls-certificate) and the door tunnel (tools/keep-a-door-tunnel-open).

## Files

| File | Purpose |
|------|---------|
| `read-data/public-door-rows.mjs` | The door rows reader over a records door: `hostingProviders`, `dnsProviders`, `hostingProvider(id)`, `dnsProvider(id)`, `currentDoor`, and `saveCurrentDoor`, one write conditioned on the row just read. |
| `read-data/door-receipts.mjs` | `doorReceipts(door)`: `{ read(name), save(name, value) }` over the Public door receipts list. |
| `do-work/portable-host-lease.mjs` | `leaseClient(row, token)`, which sends only the row's declared requests; `provisionHostLease`, `removeHostLease`, `watchHostLease`, `readHostLease`. |
| `do-work/portable-dns-cutover.mjs` | `dnsClient(token, { provider })`, which allows only the exact-host DNS shapes; `prepareCutover`, `changeCutover` (activate or roll back, a plain record or a production Worker domain), `readCutover`. |
| `do-work/move-public-door.mjs` | `movePublicDoor`: rent, set up, publish the download, cut DNS, prove the new address, release the old lease, save the current-door row. A failed proof rolls DNS back and keeps the old lease. |
| `do-work/door-tools.mjs` | The rows' functions (`seeWhereTheDoorRuns`, `rentAHost`, `releaseAHost`, `cutAHostnameOver`) and `heldFrom`/`heldVariable`. |
| `tool-rows.json` | `tool:see-where-the-public-door-runs`, `tool:rent-a-host-for-the-public-door`, `tool:release-a-host-of-the-public-door`, `tool:cut-a-hostname-over-to-a-new-address`. |
| `ports/` | The contracts: each ported file names its older owner, the byte-copy commit and what it keeps. |
| `test/door-world.mjs` | The test world: synthetic Service connections rows in the stand-in records door. |
| `test/public-door.test.mjs`, `test/host-lease.test.mjs`, `test/dns-cutover.test.mjs` | The older owner's tests, carried over with their assertions, on the stand-in door. |
| `test/door-rows.test.mjs` | The rows run as the engine runs them. |

## Dependencies

**Depends on:** `tools/records-door` (the client, `run-an-export.mjs`, and the stand-in door in tests), Node's `fetch`, `node:dns`, `node:net`, and `/usr/bin/curl` for the move's proof.

**Depended on by:** `tool-rows.json`, run on the person's computer by Trillion's local engine (trillion-rust `src/runtime/workshop.rs`); the certificate and tunnel tools import `read-data/public-door-rows.mjs` for the door's rows.
