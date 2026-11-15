# HTTP mechanisms

`http-invocation.mjs` renders request DATA (`buildInvocation`), encodes JSON/form/bytes (`encodeBody`) and executes a request (`httpJson`). Its supporting public exports preserve the original connection field names, credential injections/mounts, query handling and cursor paging. `WorkshopError` retains the original actionable error shape.

`node-public-fetch.mjs` provides `nodePublicFetch` and the opt-in host installer. It uses Node HTTPS, DNS and decompression APIs, and validates the DNS addresses the connection will actually use. `resolved-address.mjs` supplies `NameNotFound`, `inRanges`, `resolvePublic` and `checkedLookup`, with refusal DATA in its adjacent JSON file.

`request-scopes.mjs` supplies `resolveRequest` and `scrubValues` from its adjacent grammar DATA. `same-origin.mjs` supplies host/origin/path comparisons and cookie-domain selection, using `tldts`.

Public destination rules are imported from the existing `../../refuse-requests-to-private-addresses/public-address.mjs` owner. No local duplicate exists. Callers supply a DNS-checked transport and the credential owner's send/keep capabilities; see the parent README for those security contracts. No payload or credential logging and no automatic request retry are added.
