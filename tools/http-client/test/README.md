# HTTP checks

`http-invocation-baseline.test.mjs` runs the captured pre-adaptation renderer, encoders and executor through `invocation-baseline.mjs`. The adapter adds only original surrounding helpers needed by the captured ranges. Set `HTTP_INVOCATION_UNDER_TEST=adapted` to run the same assertions against the active owner.

`http-invocation.test.mjs` exercises active public/destination redirects, credential/held-value secrecy, unknown effects, unread replies, bounded template file input and the actual Node connection-time DNS seam. `node-public-fetch.test.mjs` checks public DNS/TLS, private addresses, redirects, decompression limits and timeouts. `http-client-executor.test.mjs` checks ordered scopes and host-bound secret placement. `shared-cookie-domain.test.mjs` checks origin/host/domain behavior and browser bundling.

`review-invocation-provenance.mjs` uses the real repository reader and reference-adaptation validator. It reads the pinned original commit and all three held ranges, checks the genuine baseline commit, checks current target retention and prints source-qualified status. The sibling original repository must be readable; absence fails explicitly. This check neither commits bytes nor certifies deployment.
