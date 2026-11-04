# Public app examples

The entries in `manifest.json` are fictional demonstrations. `sign-up/` is the smallest sign-up page: `publish.json` is the exact `publish_public_app_definition` input an AI sends beside the page's files (one visitor action, one placement with no version, the form's words as `presentation`, and a `source` field filled from `?from=` so each printed code is counted apart); `node scripts/prove-public-app-sign-up.mjs` publishes it from a new proof account, signs up on the live page and reads the answer back. They are public, but none is a site for Alex, Sam, Jo, or Pat. Riverside has no products for sale. The sample form saves test responses only; it makes no coaching request or promise of a reply.

Working client concepts are not kept in this repo: they live in the Spaces of the account that owns them.

The generic public app and Marketplace route has live proof: a signed-out listing, sign-in return, separate account installations, a visitor action saved to the chosen private or Space context, member-only Space readback, idempotent retry, and revocation. The three examples render at their own `*.app.gettrillion.ai` addresses. See `proof/client-examples-2026-10-01/` and `proof/marketplace-public-app/` for exact results and screenshots.

Before installing a real client page, identify the actual client account and current Space membership, collect the exact words, assets, offer, and claims approved for public use, and bind a new published app definition to that client's authorized private account or Space. Read the installed page signed out, submit a real test action if it accepts one, read the resulting record from the intended account or Space, and test access from another account. Use the existing definition and installation mechanism; do not copy a demo's test records or assign an anonymous account to a named client.


