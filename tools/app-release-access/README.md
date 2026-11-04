# tools/app-release-access/

Checks with Apple how a released app can be installed right now. It also arranges the beta access a person's setup requires. Both run with the release owner's App Store Connect team key. Both are `container` rows with internet; the client refuses any origin other than `https://api.appstoreconnect.apple.com`. The key is the release owner's held value `app-store-connect-key`, JSON `{key_id, issuer_id, private_key}`, handed to the one process on a private pipe (`credential_mounts` descriptor 4). It is never in a file, argv, the environment, a log or an answer, and nothing reads a Keychain.

## Files

| File | Purpose |
|------|---------|
| `read-data/app-distribution.mjs` | `read(input)`: `tool:read-app-distribution`. Resolves the one app named by `bundle_identifier`, reads its TestFlight availability and answers the safe public observation. |
| `read-data/setup-access.mjs` | `fulfill(input)`: `tool:fulfill-setup-access`. `fulfillAppleSetupAccess` is the provider adapter: public route, enrolment and first invitation, each change behind a checkpoint, an uncertain one read back and never resent. |
| `read-data/setup-access.json` | The one engine setup-access word this tool says (`revoked`). |
| `read-data/app-store-connect.mjs` | The App Store Connect client: an ES256 JWT from the held key, JSON requests on `/v1/` only. Apple's error body (which can name a tester) never reaches an error message. |
| `read-data/testflight-readiness.mjs` | `readTestFlightAvailability`: Apple's current distribution facts for configured groups, read only. |
| `read-data/distribution.mjs` | `distributionObservation`, `distributionSource`: the bounded public projection the engine reads back from `device-distribution:<source>`. |
| `read-data/distribution.json` | The observation bounds and release sources, as the engine's `product/devices.json` `distribution` block holds them. Which app a source is comes from the input, never this file. |
| `tool-rows.json` | `tool:read-app-distribution` and `tool:fulfill-setup-access`, run by `tools/records-door`'s `run-an-export.mjs`. |
| `test/` | The moved tests (TestFlight readiness, the provider adapter and its claim fence, the public projection) and new ones for the read tool and the held-key client. |

## Moved from Trillion

These were old trillion's Mac tool host rows `tool:read-app-distribution` (`computer/app-distribution.mjs`) and `tool:fulfill-setup-access` (`computer/setup-access.mjs`). Their Apple client and readiness reader (`scripts/app-store-connect.mjs`, `scripts/testflight-readiness.mjs`) are copied from the commit before they moved to Trillion-X/trillion-apps. The changes:

- The Keychain read is now the held value.
- The repository listing (bundle identifier, groups) is now the input.
- The account routes `/mcp/api/device-distribution` and `/mcp/api/setup-access` are dropped (see Not yet).
- The client's upload helper, used only by the ship script, is not carried.

## Not yet

- **Publishing availability.** `publish: true` would save the observation to the release owner's `device-distribution:<source>` workspace record, which the engine reads (trillion-rust `src/local_account/setup_distribution/value.rs`). A tool run cannot be granted `workspace:write`: the records door's `run_operations` hold `workspace:read` only (trillion-rust `src/record_value/records-door.json`). It is refused plainly until that operation exists.
- **Setup-access claim, checkpoint and finish.** These are the release owner's operator operations (old trillion `src/setup-access.mjs`, route `/mcp/api/setup-access`). The engine has no such operation at the records door. Its setup screen only names `tool:fulfill-setup-access` (trillion-rust `product/setup-access.json:7`). `fulfill` therefore refuses before any provider call. The adapter and the claim fence are tested with an injected operator.
- The engine's source row (`product/devices.json:212`, `refresh_tool`) does not hold the app's bundle identifier or groups, so a refresh caller must pass them.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library.

**Depended on by:** the engine's device distribution (`refresh_tool`) and setup access (`tool_id`) DATA, which name these tool ids.
