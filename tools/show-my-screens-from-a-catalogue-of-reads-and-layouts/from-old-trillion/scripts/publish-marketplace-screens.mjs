// scripts/publish-marketplace-screens.mjs
//
// Publishes the catalogue screens and their reads (records/marketplace-screens.json) to the Marketplace as the
// Marketplace publisher account (src/marketplace-defaults.json MARKETPLACE_PUBLISHER_ACCOUNT_ID), through the ordinary
// save_tool and publish_tool roads every account uses (POST /mcp/api/tools/save, /mcp/api/tools/publish). It runs as a
// step after a successful release switch (scripts/deploy-worker.mjs), against the version that is serving, never in
// the guard suite or the build.
//
//   node scripts/publish-marketplace-screens.mjs --origin https://app.gettrillion.ai
//
// The publisher's personal key comes from the environment variable MARKETPLACE_PUBLISHER_KEY (the build's secret of
// that name); without it nothing is published and the step says so. Saving the same id again replaces the row, so
// running it after every switch publishes exactly the rows in source. Prints one line per row and exits 1 when any
// row was refused.
import { readFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(new URL('../records/marketplace-screens.json', import.meta.url), 'utf8')).tools;

/** Each row saved then published as the account `key` signs in to: [{ id, saved, published, error? }]. */
export async function publishMarketplaceScreens({ origin, key, fetcher = fetch }) {
  const call = async (path, body) => {
    const response = await fetcher(`${origin}/mcp/api${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(answer.error ?? `${path} answered ${response.status}`);
    return answer;
  };
  const results = [];
  for (const descriptor of rows) {
    try {
      await call('/tools/save', { descriptor, check: false });
      await call('/tools/publish', { tool_id: descriptor.id });
      results.push({ id: descriptor.id, saved: true, published: true });
    } catch (error) { results.push({ id: descriptor.id, saved: false, published: false, error: String(error?.message ?? error).split('\n')[0] }); }
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const at = process.argv.indexOf('--origin');
  const origin = at >= 0 ? process.argv[at + 1] : 'https://app.gettrillion.ai';
  const key = process.env.MARKETPLACE_PUBLISHER_KEY;
  if (!key) { process.stdout.write('marketplace screens: MARKETPLACE_PUBLISHER_KEY is not set, so nothing was published\n'); process.exit(0); }
  const results = await publishMarketplaceScreens({ origin, key });
  for (const row of results) process.stdout.write(`marketplace screens: ${row.id} ${row.published ? 'published' : `refused: ${row.error}`}\n`);
  process.exit(results.every(row => row.published) ? 0 : 1);
}
