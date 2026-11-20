# tools/publish-the-tools-a-space-shares-as-public/

Publish the tools a space shares as public pages and keep their use counts.

This folder has no tool row yet. Its use-count part is here:

- `src/workshop-statistics.mjs` (`workshopStatistics`): the counts a tool reads, with the measured local counts and the shared counts across every account. A shared count that cannot be read, or is not published, is `state: 'unknown'` with a reason and `counts: null`; it is never zero. Only a measured zero is zero. Ported from old trillion `src/native-workshop-telemetry.mjs` `readWorkshopStatistics` (b6ae0ebf81, lines 9-23); its old assertions are `test/workshop-statistics.test.mjs`.
- Not yet wired: no live caller reads this part. The callers that still turn missing counts into zero are listed in the research row `verify-every-port/publish-the-tools-a-space-shares-as-public`.

The files that remain in `from-an-older-version/` are the bytes of the tag made before the Worker retired, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. The shared Marketplace projection (`shared-workshop-projection.mjs`, Cloudflare Worker and KV) is not ported: the Worker is retired (old trillion commit 4ffa1dc4a2). Wiring the remaining files is adapting them, in a commit that names `moved-from.json`.
