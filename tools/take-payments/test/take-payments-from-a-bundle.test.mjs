// tools/take-payments/test/take-payments-from-a-bundle.test.mjs
// A site bundles take-payments into one file, which has no read-data folder beside it. Listing the completed checkouts with
// no event map passed in used to read webhook-event-map.json from the module's own folder at run time, so from a bundle the
// read failed. Here the module is bundled into a folder of its own and a completed checkout is listed through the bundle.
// No network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, it } from 'node:test';
import { build } from 'esbuild';

const folder = mkdtempSync(join(tmpdir(), 'payments-from-a-bundle-'));
after(() => rmSync(folder, { recursive: true, force: true }));
const here = new URL('..', import.meta.url).pathname;
const entry = join(folder, 'site.mjs');
writeFileSync(entry, `export { listCompletedCheckoutsAsPaymentEvents } from ${JSON.stringify(join(here, 'do-work/take-payments.mjs'))};`);

it('a completed checkout is listed as a payment event through the bundle, its event map read from inside the bundle', async () => {
  const outfile = join(folder, 'dist', 'serve.mjs');
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const site = await import(pathToFileURL(outfile).href);
  const session = {
    id: 'cs_bundle', object: 'checkout.session', status: 'complete', created: 1790000000, amount_total: 4900, currency: 'usd',
    subscription: null, customer_details: { email: 'buyer@example.test' }, metadata: { offer_id: 'offer:course', journey_visitor: 'visitor-bundle-1' },
  };
  const answer = await site.listCompletedCheckoutsAsPaymentEvents({ created_after_unix: 0 }, { send: async () => ({ data: [session], has_more: false }) });
  assert.equal(answer.events.length, 1);
  assert.equal(answer.events[0].attributes.journey_visitor, 'visitor-bundle-1');
});
