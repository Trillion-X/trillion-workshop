# HTTP client

Generic request rendering, body encoding and HTTP execution. Service choices stay in the caller's request DATA; credentials stay behind the connection owner's `send` and `keep` capabilities.

`do-work/http-invocation.mjs` exposes the retained `buildInvocation(template, options)`, `encodeBody(body, encoding)` and `httpJson({ invocation, send, keep }, request)` API. The renderer preserves invoke fills and the typed request grammar, including conditional fields, time windows and credential field names. JSON, bracketed form and base64 byte bodies use the original encoders. Query construction, cursor paging, service errors and reported answers retain their original contract.

The canonical address and redirect rules live in `../refuse-requests-to-private-addresses/public-address.mjs` and its DATA. `nodePublicFetch()` supplies those rules plus connection-time DNS validation, TLS verification, bounded bytes and time for Node. Pass a qualified transport to `httpJson` and `buildInvocation`'s `fetchBytes`; a supplied transport owns its DNS resolution. The default `fetch` remains the existing host contract and must already have equivalent public-network restrictions. The connection owner's `send` must restrict credentials to its allowed HTTPS hosts, avoid uncontrolled redirects and scrub placed values from its reply. This module never reads credential values or retries a failed send.

Declared held reply values are masked before service errors, reports and normal replies, including repeated occurrences. Storage and transport failures do not disclose their underlying exception text. A failure after dispatch does not assert `not_sent`, so an uncertain external effect cannot be treated as a safe retry. Fetched template inputs are bounded while streaming and oversized reads are cancelled.

`request-scopes.mjs` independently resolves the existing ordered `{{name}}` scope grammar and host-bound secrets. `same-origin.mjs` owns host/origin/path comparisons and cookie-domain selection through `tldts`. `resolved-address.mjs` owns resolver/CIDR checks. `sender-config.json` contains sender settings. Public paths are declared in `part.json`.

The three `source-baselines/*.held` files are immutable evidence, not executable runtime copies. `ports/http-invocation.json` names the original commit and ranges, baseline commit, preserved mechanisms and qualified deltas. This is a local, source-qualified `ADAPTED` result; it is not a deployment or provider proof. The original JavaScript host contract is retained; this adaptation does not establish that the broader Rust-core policy has been completed.

Run focused checks from the repository root:

```
node --test tools/http-client/test/*.test.mjs
HTTP_INVOCATION_UNDER_TEST=adapted node --test tools/http-client/test/http-invocation-baseline.test.mjs
node tools/http-client/test/review-invocation-provenance.mjs
```
