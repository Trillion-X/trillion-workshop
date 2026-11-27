# hetzner-dns

The Workshop rows for Hetzner DNS (Hetzner Cloud API, zones). One http row per call. Each row sends the Hetzner token from the vault (`hetzner-api-token`) as a bearer header, to `api.hetzner.cloud` only.

| File | Purpose |
|---|---|
| `what-this-tool-does-and-how-to-run-it.json` | The http rows the engine runs (no code of their own). |
| `kits/*.json` | One kit per tool: how to ask for it and a worked example. |
| `test/hetzner-dns-rows.test.mjs` | Checks that every row holds only `hetzner-api-token`, sent to `api.hetzner.cloud` as a bearer header. |

Tools: `list-hetzner-dns-zones` (read), `read-hetzner-dns-rrsets` (read), `create-a-hetzner-dns-zone`, `set-a-hetzner-dns-rrset` (create one record set), `replace-the-records-of-a-hetzner-dns-rrset` (set the values of an existing one), `delete-a-hetzner-dns-zone` (rollback only).

Routes come from the public spec at https://docs.hetzner.cloud/cloud.spec.json (zones, rrsets, actions/set_records). `provenance.verified_live` is false until a live call is made.
