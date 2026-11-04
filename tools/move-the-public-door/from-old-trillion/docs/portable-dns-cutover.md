# Portable public DNS placement

`scripts/portable-dns-cutover.mjs` owns the exact hostname's move from its former
public owner to the retained direct host. It consumes the existing TLS deployment
configuration and the vault holder `cloudflare-api-token`; no credential enters
argv, environment, source, receipts or provider diagnostics.

```
PRODUCT_DATA_ROOT=/path/to/product node scripts/portable-dns-cutover.mjs prepare CONFIG
PRODUCT_DATA_ROOT=/path/to/product node scripts/portable-dns-cutover.mjs activate CONFIG
node scripts/portable-dns-cutover.mjs status CONFIG
PRODUCT_DATA_ROOT=/path/to/product node scripts/portable-dns-cutover.mjs rollback CONFIG
```

`prepare` reads the full zone's DNS, Worker routes and account custom domains,
then saves an atomic mode-0600 `dns-cutover.json` beside CONFIG. Repeating prepare
retains that original rollback state. An editable A/CNAME record is updated in
place. A production Worker custom domain is removed through its actual owner,
then replaced with a DNS-only A record and a 60-second TTL. Its read-only managed
AAAA record is never edited directly. Other DNS, domains and wildcard Worker
routes are preserved and checked before and after each change. Partial or lost
provider answers reconcile against actual readback on retry. Rollback restores
the original mutable record or custom-domain binding from retained metadata.

Activation requires the installed local engine and selected-account helper to
be healthy, plus ordinary-trust protected-resource and issuer metadata readback
from the candidate host through the existing restricted identity connection.
Native enrollment and WSS use the canonical public hostname and therefore join
after DNS switches. Do not require those public-hostname calls to succeed while
DNS still selects the retired public owner. After switching, verify public DNS,
trusted HTTPS metadata and the actual native/cloud-client authenticated route.
Provider mutation readback alone does not prove customer delivery.
