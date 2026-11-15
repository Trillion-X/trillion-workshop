# Share design libraries

`read-data/design-library.mjs` ports the old `src/design-library.mjs` library rules from
`Trillion-X/trillion` tag `old-trillion-before-worker-retire`. It keeps schema
validation, contributor-bound replacement identities, bulk result positions,
picture signatures and contributor permission, privacy-safe member labels,
word/meaning search routing and mixed pagination, and HTTP refusal behavior.

Content stays in rows. `makeSharedLibrary` receives the current library definition
rows, the admitted maker, a shared pool owner, the account's byte owner and its
file-address resolver. `makeMarketplaceSharedLibrary` reloads those rows through
`readRecords` before every operation and checks `current` before continuing.
It has no bundled content fallback and does not recreate the retired Worker pool.

This is a core port, not an installed shared service. A production shared-pool
adapter, authenticated contributor binding, Namespace file/address owner, public
dependency admission and a runnable tool descriptor remain unverified. Keep the
retirement backlog row held until these owners are connected and exercised.
