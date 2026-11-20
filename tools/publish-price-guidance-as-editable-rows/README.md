# tools/publish-price-guidance-as-editable-rows/

Publish price guidance as editable rows, while the offer owner still sets the real prices.

This folder has no row yet and nothing wires it. `src/published-content-source.mjs` is the decision that a published Marketplace item replaces a shipped JSON section, a withdrawn item yields nothing, and a section never published keeps its shipped value; it takes the publication reader and the identity and value checks as parameters. `src/published-price-rules.mjs` reads the price-rule list through that decision and checks each row with the pricing module's `cleanRule`. Tests: `test/published-content-source.test.mjs` (17 pass).

The shipped list itself (`records/service-price-rules.json`, the plan rule) is not copied here: its bytes sit in the parked repository at the path `moved-from.json` names, and the live plan values are kept in the experiment folder's test fixtures. `moved-from.json` names `from-an-older-version/` paths in this folder that the Workshop no longer holds (removed by commit 332230b33, bytes kept in the parked repository at the same paths). Wiring the rule list is an owner's word, in a commit that names `moved-from.json`.
